// Minimal Octokit-shaped stub shared by test/adapter-dryrun.test.js and
// test/checkpoint-range.test.js: both drive the real upstream helper
// (post-review-comments.js) against a fake GitHub API surface, so the same
// stub — including the checkpoint-relevant comment.user shape — belongs in
// one place instead of two copies drifting apart.

"use strict";

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
          const c = {
            id: nextId++,
            body,
            html_url: `https://github.example/c/${nextId - 1}`,
            // A Bot-typed author so isCheckpointAuthorOurs
            // (buildkite/post-review-comments.js) accepts this comment as
            // ours in checkpoint tests; non-checkpoint tests never read
            // comment.user.
            user: { login: "ocr-bot[bot]", type: "Bot" },
          };
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

module.exports = { makeStubServer };
