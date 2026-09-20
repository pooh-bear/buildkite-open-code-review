#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Buildkite adapter for the OpenCodeReview GitHub posting helper.
//
// The upstream helper (post-review-comments.js, vendored next to this file)
// was written for actions/github-script, which injects three objects: `github`
// (an Octokit instance), `context` (repo/PR/run identity) and `core`
// (logging + outputs). This script builds equivalents from the Buildkite job
// environment and a GitHub token, then calls runPostReviewComments with them —
// so the load-bearing posting behaviours (sticky summary, incremental dedup,
// batch createReview with idempotency reconciliation, 422 line-resolution
// fallback, rate-limit pacing) are inherited from upstream rather than
// reimplemented.
//
// Environment contract (set by pipeline.yml, sourced from Buildkite env vars
// and cluster secrets):
//   OCR_GITHUB_TOKEN            GitHub token with pull-requests:write on the
//                               target repo (required).
//   BUILDKITE_PULL_REQUEST      PR number (required; empty means this is not
//                               a PR build and the script exits 0 as a no-op).
//   BUILDKITE_REPO              Used to derive "owner/name" (any github.com
//                               git@ or https:// remote URL) unless
//                               OCR_GITHUB_REPO overrides it explicitly.
//   OCR_GITHUB_REPO             "owner/name" override; only needed when
//                               BUILDKITE_REPO isn't a github.com URL.
//   OCR_STICKY_SUMMARY          "true"/"false" (default true).
//   OCR_INCREMENTAL             "true"/"false" (default false).
//   OCR_INCREMENTAL_OVERLAP_THRESHOLD  IoU threshold (default 0.6).
//   OCR_REVIEW_COMMENT_BATCH_SIZE      Batch size (default 50).
//   OCR_ROUTE_SEVERITY_BELOW / OCR_ROUTE_CATEGORIES / OCR_RESOLVE_OUTDATED
//                               Publication policies, passed through.
//   OCR_RESULT_PATH / OCR_STDERR_PATH  Where pipeline.yml staged the review
//                               outputs (default .ocr/ocr-result.json).
//   BUILDKITE_BUILD_NUMBER / BUILDKITE_RETRY_COUNT
//                               Stand-ins for the Actions runId/runAttempt
//                               that build the per-run idempotency tags.

"use strict";

const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");

const { runPostReviewComments } = require("./post-review-comments.js");

function parseBool(val, defaultVal) {
  if (val === undefined || val === "") return defaultVal;
  return String(val).toLowerCase() === "true";
}

function parseNumber(val, defaultVal) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : defaultVal;
}

async function main() {
  const prNumber = parseInt(process.env.BUILDKITE_PULL_REQUEST || "", 10);
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    console.log("No pull request context (BUILDKITE_PULL_REQUEST empty); nothing to post.");
    return 0;
  }

  const token = process.env.OCR_GITHUB_TOKEN;
  if (!token) {
    throw new Error("OCR_GITHUB_TOKEN is not set; cannot post review comments.");
  }

  // OCR_GITHUB_REPO overrides; otherwise derive "owner/repo" from
  // BUILDKITE_REPO (git@github.com:owner/repo.git or
  // https://github.com/owner/repo.git), which Buildkite always sets for a
  // GitHub-connected pipeline — mirroring how actions/github-script derives
  // context.repo from the job's own checkout instead of a hardcoded value.
  const deriveRepoSlug = (url) => {
    if (!url) return null;
    const m = /github\.com[:/]([^/]+)\/(.+?)(\.git)?$/.exec(url.trim());
    return m ? `${m[1]}/${m[2]}` : null;
  };
  const repoSlug = process.env.OCR_GITHUB_REPO || deriveRepoSlug(process.env.BUILDKITE_REPO);
  if (!repoSlug) {
    throw new Error(
      "Could not determine the GitHub repo: set OCR_GITHUB_REPO to \"owner/name\", " +
        `or BUILDKITE_REPO must be a github.com URL (got: ${process.env.BUILDKITE_REPO || "(unset)"}).`
    );
  }
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) {
    throw new Error(`Resolved repo slug must be "owner/name", got: ${repoSlug}`);
  }

  const resultPath = process.env.OCR_RESULT_PATH || ".ocr/ocr-result.json";
  const stderrPath = process.env.OCR_STDERR_PATH || ".ocr/ocr-stderr.log";

  // Octokit with retry-friendly defaults. The helper reads rate-limit headers
  // off error.response.headers, which the Octokit REST client preserves.
  const github = new Octokit({ auth: token, userAgent: "open-code-review-buildkite" });

  // context: the helper reads repo.owner, repo.repo, runId, runAttempt, and —
  // only when the OCR result has no manifest — payload.pull_request.head.sha.
  // The manifest is always present for ocr review --format json, so the
  // payload branch is a dead path here; runId/runAttempt keep per-run HTML
  // idempotency tags unique per Buildkite build.
  const context = {
    repo: { owner, repo },
    runId: Number(process.env.BUILDKITE_BUILD_NUMBER) || 0,
    runAttempt: (Number(process.env.BUILDKITE_RETRY_COUNT) || 0) + 1,
    eventName: "pull_request_target",
    payload: {},
  };

  // The helper reports stats through core.setOutput (it returns undefined),
  // so capture them from the output callback into a mutable bag.
  const outputs = {};
  // core: log to the build log; surface stats via buildkite-agent meta-data so
  // downstream steps and annotations can consume them.
  const { spawnSync } = require("child_process");
  const setMetaData = (key, value) => {
    if (!key) return;
    const r = spawnSync("buildkite-agent", ["meta-data", "set", `ocr_${key}`, String(value)], {
      stdio: "ignore",
    });
    if (r.status !== 0) {
      console.log(`(meta-data set ocr_${key} failed with status ${r.status}; continuing)`);
    }
  };
  const core = {
    info: (m) => console.log(m),
    warning: (m) => console.log(`⚠️ ${m}`),
    error: (m) => console.log(`❌ ${m}`),
    setOutput: (name, value) => {
      outputs[name] = value;
      setMetaData(name, value);
    },
  };

  await runPostReviewComments({
    github,
    context,
    core,
    fs,
    prNumber,
    resultPath: path.resolve(resultPath),
    stderrPath: path.resolve(stderrPath),
    stickySummary: parseBool(process.env.OCR_STICKY_SUMMARY, true),
    incremental: parseBool(process.env.OCR_INCREMENTAL, false),
    incrementalOverlapThreshold: parseNumber(process.env.OCR_INCREMENTAL_OVERLAP_THRESHOLD, 0.6),
    reviewCommentBatchSize: parseNumber(process.env.OCR_REVIEW_COMMENT_BATCH_SIZE, 50),
    routeSeverityBelow: process.env.OCR_ROUTE_SEVERITY_BELOW || "",
    routeCategories: process.env.OCR_ROUTE_CATEGORIES || "",
    resolveOutdated: process.env.OCR_RESOLVE_OUTDATED || "",
  });

  // Persist the posting stats for the pipeline's job summary/annotation.
  const statsFile = process.env.OCR_STATS_PATH || ".ocr/ocr-stats.json";
  fs.mkdirSync(path.dirname(statsFile), { recursive: true });
  fs.writeFileSync(statsFile, JSON.stringify(outputs, null, 2));

  const failed = parseInt(outputs.comments_failed, 10) || 0;
  const total = parseInt(outputs.comments_total, 10) || 0;
  const inline = parseInt(outputs.comments_inline, 10) || 0;
  console.log(`Posting complete: total=${total} inline=${inline} failed=${failed}`);
  if (outputs.summary_comment_url) {
    console.log(`Summary: ${outputs.summary_comment_url}`);
  }
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });