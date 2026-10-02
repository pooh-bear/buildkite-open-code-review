// Contract test for cross-push checkpoints (#476) on Buildkite: exercises
// buildkite/resolve-review-range.js's computeRange (the resolver) and
// buildkite/post-review-comments-buildkite.js's checkpointOptionsFromEnv (the
// adapter's env->options translation) as pure functions, then drives one full
// two-run cycle through the real runPostReviewComments (advance a checkpoint
// on run 1, narrow to it on run 2) to prove the two halves compose.
//
// Run: node test/checkpoint-range.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { makeStubServer } = require("./stub-github.js");
const { computeRange } = require(path.join(ROOT, "buildkite", "resolve-review-range.js"));
const { checkpointOptionsFromEnv } = require(path.join(ROOT, "buildkite", "post-review-comments-buildkite.js"));
const helper = require(path.join(ROOT, "buildkite", "post-review-comments.js"));

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const BASE_ENV = {
  OCR_CHECKPOINT_RANGE: "true",
  BUILDKITE_PULL_REQUEST: "7",
  OCR_GITHUB_TOKEN: "tok",
  BUILDKITE_REPO: "git@github.com:acme/widget.git",
  BUILDKITE_COMMIT: SHA_B,
  BASE_BRANCH: "main",
  MERGE_BASE: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  OCR_STICKY_SUMMARY: "true",
  OCR_VERSION_ACTUAL: "open-code-review v1.10.0",
  OCR_LLM_URL: "https://llm.example/v1",
  OCR_LLM_MODEL: "glm-5",
};

// A no-network isAncestor stub: SHA_A is an ancestor of SHA_B and nothing
// else, so tests can assert real ancestry decisions without shelling to git.
function makeIsAncestor(edges) {
  return (a, b) => (edges.has(`${a}..${b}`) ? 0 : 1);
}

(async () => {
  // 1. Feature off: zero GitHub calls, full-range shape, no fingerprint.
  {
    let githubCalled = false;
    const github = new Proxy(
      {},
      {
        get() {
          githubCalled = true;
          throw new Error("should not be called");
        },
      }
    );
    const vars = await computeRange({ github, env: { ...BASE_ENV, OCR_CHECKPOINT_RANGE: "false" } });
    assert.strictEqual(githubCalled, false, "disabled mode makes no GitHub calls");
    assert.deepStrictEqual(
      vars,
      {
        RANGE_MODE: "full",
        RANGE_REASON: "disabled",
        RANGE_FROM: "",
        RANGE_TO: SHA_B,
        CHECKPOINT_BEFORE: "",
        ANCESTRY: "",
        SOURCE_RUN: "",
        CHECKPOINT_CARRY: "",
        CONFIG_FINGERPRINT: "",
      },
      "disabled shape matches the pre-checkpoint pipeline exactly"
    );
    console.log("✔ checkpoint disabled: no API calls, full-range shape");
  }

  // 2. Enabled, no existing summary comment (first review on a PR): full
  //    range, reason no_summary_comment, but a real fingerprint IS computed
  //    (this run may still advance the checkpoint for the next one).
  {
    const { github } = makeStubServer();
    const vars = await computeRange({
      github,
      env: BASE_ENV,
      isAncestor: makeIsAncestor(new Set()),
      ruleFileExists: () => false,
    });
    assert.strictEqual(vars.RANGE_MODE, "full");
    assert.strictEqual(vars.RANGE_REASON, "no_summary_comment");
    assert.strictEqual(vars.RANGE_FROM, "");
    assert.ok(/^[0-9a-f]{16}$/.test(vars.CONFIG_FINGERPRINT), "fingerprint computed even on a cold start");
    console.log("✔ checkpoint enabled, cold start: full range, fingerprint still computed");
  }

  // 3. A valid prior checkpoint (SHA_A, ancestor of SHA_B, same base/merge-base
  //    /fingerprint) narrows the range to SHA_A..SHA_B.
  {
    const { github, state } = makeStubServer();
    // Compute the fingerprint the same way run 1 would, so it matches.
    const cold = await computeRange({ github, env: BASE_ENV, isAncestor: makeIsAncestor(new Set()), ruleFileExists: () => false });
    const marker = helper.buildCheckpointMarker({
      v: helper.CHECKPOINT_VERSION,
      pr: 7,
      head: SHA_A,
      base_ref: "main",
      merge_base: BASE_ENV.MERGE_BASE,
      terminal_state: "complete",
      fingerprint: cold.CONFIG_FINGERPRINT,
      run: "41",
    });
    state.issueComments.push({
      id: 1,
      body: `<!-- ocr-summary -->\nprevious run\n\n${marker}`,
      user: { login: "ocr-bot[bot]", type: "Bot" },
    });

    const vars = await computeRange({
      github,
      env: BASE_ENV,
      isAncestor: makeIsAncestor(new Set([`${SHA_A}..${SHA_B}`])),
      ruleFileExists: () => false,
    });
    assert.strictEqual(vars.RANGE_MODE, "checkpoint");
    assert.strictEqual(vars.RANGE_REASON, "ok");
    assert.strictEqual(vars.RANGE_FROM, SHA_A);
    assert.strictEqual(vars.RANGE_TO, SHA_B);
    assert.strictEqual(vars.ANCESTRY, "ancestor");
    assert.strictEqual(vars.CONFIG_FINGERPRINT, cold.CONFIG_FINGERPRINT);
    console.log("✔ checkpoint enabled, valid prior marker: narrows to checkpoint..head");
  }

  // 4. Base changed since the checkpoint was taken: falls back to full, even
  //    though the marker itself is otherwise well-formed and the head is a
  //    real ancestor.
  {
    const { github, state } = makeStubServer();
    const marker = helper.buildCheckpointMarker({
      v: helper.CHECKPOINT_VERSION,
      pr: 7,
      head: SHA_A,
      base_ref: "main",
      merge_base: "0000000000000000000000000000000000000000", // different from BASE_ENV.MERGE_BASE
      terminal_state: "complete",
      fingerprint: "irrelevant",
      run: "41",
    });
    state.issueComments.push({
      id: 1,
      body: `<!-- ocr-summary -->\n${marker}`,
      user: { login: "ocr-bot[bot]", type: "Bot" },
    });
    const vars = await computeRange({
      github,
      env: BASE_ENV,
      isAncestor: makeIsAncestor(new Set([`${SHA_A}..${SHA_B}`])),
      ruleFileExists: () => false,
    });
    assert.strictEqual(vars.RANGE_MODE, "full");
    assert.strictEqual(vars.RANGE_REASON, "base_changed");
    console.log("✔ checkpoint enabled, base moved: falls back to full range");
  }

  // 5. A checkpoint written by a plain User account (what a classic PAT
  //    posts as) is never trusted, regardless of its content — the documented
  //    reason OCR_CHECKPOINT_RANGE defaults to false in pipeline.yml.
  {
    const { github, state } = makeStubServer();
    const marker = helper.buildCheckpointMarker({
      v: helper.CHECKPOINT_VERSION,
      pr: 7,
      head: SHA_A,
      base_ref: "main",
      merge_base: BASE_ENV.MERGE_BASE,
      terminal_state: "complete",
      fingerprint: "whatever",
      run: "41",
    });
    state.issueComments.push({
      id: 1,
      body: `<!-- ocr-summary -->\n${marker}`,
      user: { login: "a-human", type: "User" },
    });
    const vars = await computeRange({
      github,
      env: BASE_ENV,
      isAncestor: makeIsAncestor(new Set([`${SHA_A}..${SHA_B}`])),
      ruleFileExists: () => false,
    });
    assert.strictEqual(vars.RANGE_MODE, "full");
    assert.strictEqual(vars.RANGE_REASON, "author_unverified");
    console.log("✔ checkpoint written by a User (PAT) account: rejected, full range");
  }

  // 6. Missing PR number / token / repo: fails closed to full range without
  //    throwing (mirrors the Action's "nothing in here may fail the job").
  {
    for (const env of [
      { ...BASE_ENV, BUILDKITE_PULL_REQUEST: "" },
      { ...BASE_ENV, OCR_GITHUB_TOKEN: "" },
      { ...BASE_ENV, BUILDKITE_REPO: "not-a-github-url" },
    ]) {
      const vars = await computeRange({ github: {}, env });
      assert.strictEqual(vars.RANGE_MODE, "full");
      assert.strictEqual(vars.RANGE_REASON, "resolver_error");
    }
    console.log("✔ missing PR/token/repo: fails closed, never throws");
  }

  // 7. checkpointOptionsFromEnv (the adapter side): off by default, and wires
  //    through resolve-review-range.js's variable names when enabled.
  {
    const off = checkpointOptionsFromEnv({});
    assert.strictEqual(off.checkpointEnabled, false);
    assert.strictEqual(off.checkpointCarry, "");
    assert.strictEqual(off.rangeMode, "");

    const on = checkpointOptionsFromEnv({
      OCR_CHECKPOINT_RANGE: "true",
      CHECKPOINT_CARRY: "<!-- ocr-checkpoint:v1 xyz -->",
      BASE_REF: "unused", // not a field checkpointOptionsFromEnv reads
      BASE_BRANCH: "main",
      MERGE_BASE: "deadbeef",
      CONFIG_FINGERPRINT: "abc123",
      RANGE_REASON: "same_head_noop",
      RANGE_MODE: "checkpoint",
      RANGE_FROM: SHA_A,
      RANGE_TO: SHA_B,
    });
    assert.deepStrictEqual(on, {
      checkpointEnabled: true,
      checkpointCarry: "<!-- ocr-checkpoint:v1 xyz -->",
      checkpointBaseRef: "main",
      checkpointMergeBase: "deadbeef",
      checkpointFingerprint: "abc123",
      checkpointNoop: true,
      rangeMode: "checkpoint",
      rangeFrom: SHA_A,
      rangeTo: SHA_B,
    });
    console.log("✔ checkpointOptionsFromEnv: off is inert, on wires every field through");
  }

  // 8. End-to-end: run 1 (full range, complete) advances the checkpoint into
  //    its sticky summary; run 2's resolver reads that exact summary back and
  //    narrows to it. Proves the resolver and runPostReviewComments agree on
  //    the marker's wire format without either side hand-waving the other.
  {
    const { github, state } = makeStubServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-checkpoint-test-"));
    const context = { repo: { owner: "acme", repo: "widget" }, runId: 41, runAttempt: 1, eventName: "x", payload: {} };
    const core = { info: () => {}, warning: () => {}, error: () => {}, setOutput: () => {} };

    const runOnce = async (env, manifestHead) => {
      const vars = await computeRange({ github, env, isAncestor: makeIsAncestor(new Set([`${SHA_A}..${SHA_B}`])), ruleFileExists: () => false });
      const resultPath = path.join(dir, `result-${manifestHead}.json`);
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          manifest: { terminal_state: "complete", input: { resolved_head: manifestHead } },
          comments: [],
        })
      );
      await helper.runPostReviewComments({
        github,
        context,
        core,
        fs,
        prNumber: 7,
        resultPath,
        stderrPath: path.join(dir, "stderr.log"),
        stickySummary: true,
        ...checkpointOptionsFromEnv({ ...env, ...vars }),
      });
      return vars;
    };

    // Run 1: cold start, reviews the full range, completes -> advances
    // checkpoint to SHA_A.
    const run1 = await runOnce({ ...BASE_ENV, BUILDKITE_COMMIT: SHA_A }, SHA_A);
    assert.strictEqual(run1.RANGE_MODE, "full");
    assert.strictEqual(state.issueComments.length, 1, "run 1 posts one summary");
    assert.ok(state.issueComments[0].body.includes("ocr-checkpoint:v1"), "run 1 stamps a checkpoint marker");

    // Run 2: same fingerprint axes, head advanced to SHA_B (an ancestor edge
    // of SHA_A per the isAncestor stub) -> resolver narrows to SHA_A..SHA_B.
    const run2 = await runOnce({ ...BASE_ENV, BUILDKITE_COMMIT: SHA_B }, SHA_B);
    assert.strictEqual(run2.RANGE_MODE, "checkpoint", `expected checkpoint mode, got full (${run2.RANGE_REASON})`);
    assert.strictEqual(run2.RANGE_FROM, SHA_A);
    assert.strictEqual(run2.RANGE_TO, SHA_B);
    assert.strictEqual(state.issueComments.length, 1, "run 2 updates the same sticky summary, no duplicate");
    const advancedMarker = helper.parseCheckpointMarker(state.issueComments[0].body);
    assert.strictEqual(advancedMarker && advancedMarker.head, SHA_B, "advanced checkpoint now stamps the new head");
    console.log("✔ end-to-end: run 1 advances checkpoint, run 2 narrows to it via the same sticky summary");
  }

  console.log("\nAll checkpoint-range contract checks passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
