#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Buildkite port of the upstream Action's "Resolve review range" step
// (action.yml, step id `range`): cross-push checkpoints (#476), ported here
// instead of reimplemented — resolveCheckpointRange and readCheckpointComment
// are the same functions the Action calls, vendored unmodified in
// post-review-comments.js and merely unused until now (see README's former
// "Parity gaps" entry).
//
// Unlike the Action, this pipeline has no per-step outputs: pipeline.yml runs
// as one continuous bash script, so instead of `core.setOutput` this prints
// `export KEY='value'` lines to stdout. The caller does
// `eval "$(node resolve-review-range.js)"`, which sets the variables directly
// in the running shell — they then stay in scope for both the `ocr review`
// invocation and the later posting step in the same script, with no file
// handoff needed.
//
// Design mirrors the Action step exactly: nothing in here may fail the job.
// Every failure path (missing token, API outage, corrupt marker, git missing)
// has the same safe answer — review the whole merge-base range — so the CLI
// entrypoint always exits 0 and always emits a complete, consistent set of
// variables.
//
// Environment contract (set by pipeline.yml):
//   OCR_GITHUB_TOKEN            GitHub token (required; same one the posting
//                               adapter uses).
//   OCR_GITHUB_REPO / BUILDKITE_REPO   "owner/name" resolution, same as the
//                               posting adapter (see repo-slug.js).
//   BUILDKITE_PULL_REQUEST      PR number (required; empty emits an
//                               all-disabled set of variables and exits 0).
//   OCR_CHECKPOINT_RANGE        "true" to enable; anything else short-circuits
//                               before any GitHub API or git call is made,
//                               exactly like the Action's `if:` step gate.
//   OCR_FULL_REVIEW             "true" forces one full review without
//                               disabling checkpointing (reason
//                               'manual_full_review'); the run still records a
//                               new checkpoint.
//   OCR_STICKY_SUMMARY          Must match the posting step's value: a
//                               non-sticky run posts a fresh summary each
//                               time, so no checkpoint marker can persist.
//   BUILDKITE_GITHUB_ACTION     The GitHub webhook action ("opened",
//                               "synchronize", "reopened",
//                               "ready_for_review", ...). "reopened" and
//                               "ready_for_review" always force a full range.
//   BASE_BRANCH / MERGE_BASE / BUILDKITE_COMMIT
//                               This run's base ref, merge-base, and head —
//                               computed by pipeline.yml before this script
//                               runs.
//   OCR_LLM_URL / OCR_LLM_MODEL / OCR_LANGUAGE / OCR_BACKGROUND /
//   OCR_REVIEW_TASK_TIMEOUT / OCR_ROUTE_SEVERITY_BELOW / OCR_ROUTE_CATEGORIES
//                               Fingerprint axes: anything that changes what
//                               a review would say or where its findings
//                               land invalidates a stored checkpoint.
//   OCR_VERSION_ACTUAL          The resolved (not spec) OCR version, captured
//                               by pipeline.yml right after `npm install -g`;
//                               an OCR upgrade invalidates checkpoints taken
//                               by the previous version.
//
// Emitted variables (always all nine, so the caller never has to test for
// existence): RANGE_MODE, RANGE_REASON, RANGE_FROM, RANGE_TO,
// CHECKPOINT_BEFORE, ANCESTRY, SOURCE_RUN, CHECKPOINT_CARRY,
// CONFIG_FINGERPRINT.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const { resolveRepoSlug } = require("./repo-slug.js");
const { resolveCheckpointRange, readCheckpointComment } = require("./post-review-comments.js");

// The disabled/short-circuit shape: every downstream variable present but
// empty, so `${RANGE_FROM:-$MERGE_BASE}` and friends behave exactly as they
// did before this script existed.
function fullVars(reason, headSha, extra) {
  return Object.assign(
    {
      RANGE_MODE: "full",
      RANGE_REASON: reason,
      RANGE_FROM: "",
      RANGE_TO: headSha || "",
      CHECKPOINT_BEFORE: "",
      ANCESTRY: "",
      SOURCE_RUN: "",
      CHECKPOINT_CARRY: "",
      CONFIG_FINGERPRINT: "",
    },
    extra
  );
}

// The testable core: given a `github` client and an environment bag, returns
// the variables the CLI entrypoint prints. Never throws — every failure path
// (missing token/PR, unreadable repo, resolver error) has the fail-closed
// "full" answer, matching resolveCheckpointRange's own contract.
//
// `readRuleFile` and `isAncestor` are injected so tests can avoid touching the
// real filesystem/git: default to the real implementations in production.
async function computeRange({
  github,
  env,
  log = () => {},
  readRuleFile = (p) => fs.readFileSync(p),
  ruleFileExists = (p) => fs.existsSync(p),
  cwd = process.cwd(),
  isAncestor = (a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b]).status,
}) {
  const headSha = env.BUILDKITE_COMMIT || "";

  if (env.OCR_CHECKPOINT_RANGE !== "true") {
    // Mirrors the Action's `if: inputs.checkpoint_range == 'true'` step gate:
    // feature off makes zero API calls and zero git calls.
    return fullVars("disabled", headSha);
  }

  const prNumber = parseInt(env.BUILDKITE_PULL_REQUEST || "", 10);
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    return fullVars("resolver_error", headSha);
  }

  if (!env.OCR_GITHUB_TOKEN) {
    return fullVars("resolver_error", headSha);
  }

  let owner, repo;
  try {
    ({ owner, repo } = resolveRepoSlug({
      overrideRepo: env.OCR_GITHUB_REPO,
      buildkiteRepo: env.BUILDKITE_REPO,
    }));
  } catch (e) {
    return fullVars("resolver_error", headSha);
  }

  try {
    const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

    // .opencodereview/rule.json is auto-loaded from the repo by OCR itself
    // whenever present (independent of any --rule flag, which this pipeline
    // does not expose); a commit that edits it changes what a review says and
    // must invalidate the checkpoint the same way a config change does.
    let ruleUnverified = false;
    let localRuleDigest = "none";
    const localRulePath = path.resolve(cwd, ".opencodereview/rule.json");
    if (ruleFileExists(localRulePath)) {
      try {
        localRuleDigest = sha256(readRuleFile(localRulePath));
      } catch (e) {
        ruleUnverified = true;
        log(`[checkpoint] cannot read .opencodereview/rule.json (${e.message}); forcing a full review.`);
      }
    }

    // No resolved version means this run cannot say which OCR version it is
    // about to use, so no stored fingerprint can be trusted to mean "same
    // version" and none of this run's own findings can be fingerprinted
    // either. Empty fingerprint matches no stored one (-> config_changed,
    // full review) and the posting step refuses to advance the checkpoint
    // without one.
    const versionActual = env.OCR_VERSION_ACTUAL || "";
    if (!versionActual) {
      log("[checkpoint] OCR_VERSION_ACTUAL is empty; reviewing the full range and not recording a checkpoint.");
    }

    // JSON array, not a joined string: length-delimited, so no input value can
    // shift a field boundary and make two different configurations hash
    // alike.
    const fingerprint = !versionActual
      ? ""
      : crypto
          .createHash("sha256")
          .update(
            JSON.stringify(
              [
                env.OCR_LLM_URL,
                env.OCR_LLM_MODEL,
                env.OCR_LANGUAGE,
                env.OCR_BACKGROUND,
                env.OCR_REVIEW_TASK_TIMEOUT,
                env.OCR_ROUTE_SEVERITY_BELOW,
                env.OCR_ROUTE_CATEGORIES,
                versionActual,
                localRuleDigest,
              ].map((v) => v || "")
            )
          )
          .digest("hex")
          .slice(0, 16);

    const common = {
      github,
      owner,
      repo,
      prNumber,
      // Empty: no known App identity for an arbitrary Buildkite-supplied
      // token (a classic PAT posts as a User, which isCheckpointAuthorOurs
      // always rejects regardless of appSlug — see README, checkpoint gap).
      appSlug: "",
      log,
    };
    const existing = await readCheckpointComment(common);
    const range = await resolveCheckpointRange(
      Object.assign({}, common, {
        read: existing,
        enabled: true,
        sticky: env.OCR_STICKY_SUMMARY === "true",
        fullReview: env.OCR_FULL_REVIEW === "true",
        eventAction: env.BUILDKITE_GITHUB_ACTION || "",
        headSha,
        baseRef: env.BASE_BRANCH || "",
        mergeBase: env.MERGE_BASE || "",
        fingerprint,
        isAncestor,
      })
    );

    // Last gate, applied after the ordered ones inside the resolver: the
    // rules this run will apply could not be read, so no stored fingerprint
    // can be trusted to mean "same rules". Widening is always safe; narrowing
    // is not.
    if (ruleUnverified && range.mode === "checkpoint") {
      range.mode = "full";
      range.reason = "rule_unreadable";
    }

    log(
      `[checkpoint] reviewing ${
        range.mode === "checkpoint" ? `checkpoint (${range.reason}): ${range.from}..${range.to}` : `full (${range.reason})`
      }`
    );

    return {
      RANGE_MODE: range.mode,
      RANGE_REASON: range.reason,
      RANGE_FROM: range.mode === "checkpoint" ? range.from : "",
      RANGE_TO: range.to || headSha,
      CHECKPOINT_BEFORE: range.checkpointBefore || "",
      ANCESTRY: range.ancestry || "",
      SOURCE_RUN: range.sourceRun || "",
      CHECKPOINT_CARRY: existing.raw || "",
      CONFIG_FINGERPRINT: fingerprint,
    };
  } catch (e) {
    log(`checkpoint: could not resolve a range (${e.message}); reviewing the full range.`);
    return fullVars("resolver_error", headSha);
  }
}

// Quote a value for safe embedding in a POSIX single-quoted shell string:
// close the quote, emit an escaped literal quote, reopen it. Every value this
// script emits is either an enum member, a hex sha/digest, or the checkpoint
// marker (base64 + fixed delimiters, so it can still be quoted this way even
// though it may contain "-->"; single quotes don't treat "-->" specially).
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function printExports(vars) {
  const lines = Object.entries(vars).map(([k, v]) => `export ${k}=${shQuote(v == null ? "" : v)}`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function main() {
  const { Octokit } = require("@octokit/rest");
  const github = process.env.OCR_GITHUB_TOKEN
    ? new Octokit({ auth: process.env.OCR_GITHUB_TOKEN, userAgent: "open-code-review-buildkite" })
    : null;
  const vars = await computeRange({ github, env: process.env, log: (m) => console.error(m) });
  printExports(vars);
}

if (require.main === module) {
  main().catch((e) => {
    // computeRange already catches every awaited failure; this is only
    // unreachable synchronous-throw defense. Same rule applies: never fail
    // the job.
    console.error(e && e.stack ? e.stack : e);
    printExports(fullVars("resolver_error", process.env.BUILDKITE_COMMIT || ""));
  });
}

module.exports = { computeRange, fullVars };
