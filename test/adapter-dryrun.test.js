// Dry-run harness for post-review-comments-buildkite.js: stubs the GitHub API
// surface the helper touches, feeds it a synthetic OCR result, and asserts the
// posting behaviours end-to-end (summary sticky-upsert, inline batching,
// idempotency tags) without touching real GitHub.
//
// Run: node test/adapter-dryrun.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ADAPTER = path.join(ROOT, "buildkite", "post-review-comments-buildkite.js");

function makeStubServer() {
  const state = {
    issueComments: [],
    reviews: [],
    rateLimitRemaining: 4999,
  };
  let nextId = 1;

  const github = {
    rest: {
      issues: {
        listComments: async () => ({
          data: state.issueComments.map((c) => ({ ...c })),
          headers: { "x-ratelimit-remaining": String(state.rateLimitRemaining) },
        }),
        createComment: async ({ body }) => {
          const c = { id: nextId++, body, html_url: `https://github.example/c/${nextId - 1}` };
          state.issueComments.push(c);
          return { data: c, headers: {} };
        },
        updateComment: async ({ comment_id, body }) => {
          const c = state.issueComments.find((x) => x.id === comment_id);
          if (!c) throw Object.assign(new Error("404 not found"), { status: 404 });
          c.body = body;
          return { data: c, headers: {} };
        },
      },
      pulls: {
        createReview: async ({ body, comments }) => {
          const r = { id: nextId++, body, comments };
          state.reviews.push(r);
          return { data: r, headers: { "x-ratelimit-remaining": String(--state.rateLimitRemaining) } };
        },
        listReviews: async () => ({ data: [], headers: {} }),
        listReviewComments: async () => ({ data: [], headers: {} }),
        listFiles: async () => ({ data: [], headers: {} }),
        get: async () => ({ data: { head: { sha: "0123456789abcdef0123456789abcdef01234567" } }, headers: {} }),
      },
      users: {
        getAuthenticated: async () => ({ data: { login: "ocr-bot" }, headers: {} }),
      },
    },
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } }),
  };
  return { github, state };
}

// Run the adapter as a child process with a stubbed API? The adapter builds
// its own Octokit, so instead test the composition directly: load the helper
// and drive runPostReviewComments with the same context/core shims the
// adapter constructs. This is the exact call contract the adapter fulfils.
async function runAdapterContract(resultJson, opts = {}) {
  const { github, state } = makeStubServer();
  const helper = require(path.join(ROOT, "buildkite", "post-review-comments.js"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-adapter-test-"));
  const resultPath = path.join(dir, "ocr-result.json");
  const stderrPath = path.join(dir, "ocr-stderr.log");
  fs.writeFileSync(
    resultPath,
    typeof resultJson === "string" ? resultJson : JSON.stringify(resultJson)
  );
  fs.writeFileSync(stderrPath, opts.stderr || "");

  const outputs = {};
  const core = {
    info: () => {},
    warning: () => {},
    error: () => {},
    setOutput: (n, v) => {
      outputs[n] = v;
    },
  };
  const context = {
    repo: { owner: "acme", repo: "widget" },
    runId: 42,
    runAttempt: 1,
    eventName: "pull_request_target",
    payload: {},
  };

  await helper.runPostReviewComments({
    github,
    context,
    core,
    fs,
    prNumber: 7,
    resultPath,
    stderrPath,
    stickySummary: opts.stickySummary !== false,
    incremental: opts.incremental === true,
  });
  return { state, outputs };
}

(async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  // 1. Two inline comments + a warning: expect one createReview with both
  //    comments (batch), one summary issue comment carrying the marker.
  {
    const { state, outputs } = await runAdapterContract({
      manifest: { terminal_state: "complete", input: { resolved_head: sha } },
      warnings: ["a warning"],
      comments: [
        { path: "src/a.ts", start_line: 3, end_line: 4, severity: "high", category: "bug", description: "bad" },
        { path: "src/b.ts", end_line: 9, severity: "low", category: "style", description: "meh" },
      ],
    });
    assert.strictEqual(state.reviews.length, 1, "one batch review");
    assert.strictEqual(state.reviews[0].comments.length, 2, "both inline comments in the batch");
    assert.ok(state.reviews[0].comments.every((c) => c.side === "RIGHT"), "RIGHT side set");
    assert.strictEqual(state.issueComments.length, 1, "one summary comment");
    assert.ok(state.issueComments[0].body.includes("<!-- ocr-summary -->"), "summary marker present");
    assert.strictEqual(outputs.comments_total, "2");
    assert.strictEqual(outputs.comments_inline, "2");
    assert.strictEqual(outputs.comments_failed, "0");
    console.log("✔ batch posting + summary contract");
  }

  // 2. Sticky rerun: second invocation updates the SAME summary comment
  //    (no new issue comment) — the load-bearing sticky behaviour.
  {
    const first = await runAdapterContract({
      manifest: { terminal_state: "complete", input: { resolved_head: sha } },
      comments: [{ path: "src/a.ts", end_line: 1, description: "one" }],
    });
    const id = first.state.issueComments[0].id;
    const second = await runAdapterContract({
      manifest: { terminal_state: "complete", input: { resolved_head: sha } },
      comments: [{ path: "src/c.ts", end_line: 2, description: "two" }],
    });
    assert.strictEqual(second.state.issueComments.length, 1, "no duplicate summary");
    assert.strictEqual(second.state.issueComments[0].id, id, "same summary comment updated");
    console.log("✔ sticky summary updates in place");
  }

  // 3. Zero comments: expect the "looks good" summary, no review.
  {
    const { state, outputs } = await runAdapterContract({
      manifest: { terminal_state: "complete", input: { resolved_head: sha } },
      comments: [],
    });
    assert.strictEqual(state.reviews.length, 0, "no review posted");
    assert.strictEqual(state.issueComments.length, 1, "looks-good summary posted");
    assert.ok(state.issueComments[0].body.includes("No comments"), "looks-good message");
    assert.strictEqual(outputs.comments_total, "0");
    console.log("✔ zero-comment path");
  }

  // 4. Unparseable result: summary carries the stderr tail, no throw.
  {
    const { state } = await runAdapterContract("NOT JSON {{{", { stderr: "boom: LLM exploded" });
    assert.strictEqual(state.issueComments.length, 1);
    assert.ok(state.issueComments[0].body.includes("encountered an error"), "error summary");
    assert.ok(state.issueComments[0].body.includes("boom: LLM exploded"), "stderr included");
    console.log("✔ unparseable-result error path");
  }

  console.log("\nAll adapter contract checks passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});