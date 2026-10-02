"use strict";

// Shared "owner/repo" resolution for the Buildkite-side scripts
// (post-review-comments-buildkite.js and resolve-review-range.js): both need
// the same derivation from BUILDKITE_REPO / OCR_GITHUB_REPO, so it lives here
// once instead of drifting between two copies.

// BUILDKITE_REPO is a github.com git@ or https:// remote URL
// (git@github.com:owner/repo.git or https://github.com/owner/repo.git).
function deriveRepoSlug(url) {
  if (!url) return null;
  const m = /github\.com[:/]([^/]+)\/(.+?)(\.git)?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// overrideRepo wins (OCR_GITHUB_REPO); otherwise derive from buildkiteRepo
// (BUILDKITE_REPO), which Buildkite always sets for a GitHub-connected
// pipeline. Throws when neither yields an "owner/name" pair.
function resolveRepoSlug({ overrideRepo, buildkiteRepo }) {
  const repoSlug = overrideRepo || deriveRepoSlug(buildkiteRepo);
  if (!repoSlug) {
    throw new Error(
      'Could not determine the GitHub repo: set OCR_GITHUB_REPO to "owner/name", ' +
        `or BUILDKITE_REPO must be a github.com URL (got: ${buildkiteRepo || "(unset)"}).`
    );
  }
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) {
    throw new Error(`Resolved repo slug must be "owner/name", got: ${repoSlug}`);
  }
  return { owner, repo };
}

module.exports = { deriveRepoSlug, resolveRepoSlug };
