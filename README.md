# OpenCodeReview on Buildkite

Wires [OpenCodeReview](https://open-codereview.ai) (`ocr`, upstream:
[alibaba/open-code-review](https://github.com/alibaba/open-code-review)) into
a Buildkite pipeline connected to a GitHub repo: reviews every pull request
on creation/update and again whenever someone comments a trigger word,
posting a sticky summary plus inline review comments back to the PR.

There's no upstream Buildkite example (the repo ships GitHub Actions, GitLab
CI, GitFlic CI, Gerrit, Bitbucket Pipelines, and Codeup CI under `examples/`);
this directory ports the same posting contract to Buildkite.

## Layout

| File | Purpose |
|---|---|
| `buildkite/pipeline.yml` | The review step. Copy into (or merge with) the target repo's own `buildkite/pipeline.yml`. |
| `buildkite/post-review-comments.js` | Vendored **unmodified** from `alibaba/open-code-review@main` (`scripts/github-actions/post-review-comments.js`). All load-bearing posting behavior — sticky summary, incremental dedup, batched `createReview` with idempotency reconciliation, the 422 line-resolution fallback, rate-limit pacing — lives here. |
| `buildkite/post-review-comments-buildkite.js` | The adapter: builds the `github`/`context`/`core` objects the upstream helper expects (normally injected by `actions/github-script`) from the Buildkite job environment, then calls `runPostReviewComments`. |
| `test/adapter-dryrun.test.js` | Contract test: stubs the GitHub API, feeds a synthetic OCR result through the real upstream helper via the adapter's exact call shape, and asserts batching/sticky/error-path behavior. `npm test`. |

## Setup

### 1. Buildkite cluster + secrets

**Buildkite secrets are cluster-scoped.** Unclustered agents get
`Error setting up job executor: failed to fetch secrets for job` — there is
no workaround short of migrating the agents (or the pipeline) into a
cluster. If your org still has unclustered agents:

1. Agents page → Clusters → create/pick a cluster → **Agent tokens** → create
   a token.
2. Point your agents at it (`BUILDKITE_AGENT_TOKEN=bkct_...`) and restart
   them. Their `queue=<name>` meta-data tag gets rewritten to match the
   cluster queue's key (commonly `default-queue`, not `default` — check
   `GET /clusters/{id}/queues` and use that key in `agents: {queue: ...}`
   below, or rename the queue to match your agents' existing tag).
3. Move the pipeline into the same cluster: `PATCH /pipelines/{slug}` with
   `{"cluster_id": "..."}`.

Then create two secrets, scoped to just this pipeline via an [access
policy](https://buildkite.com/docs/pipelines/security/secrets/buildkite-secrets/access-policies):

```bash
curl -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  -X POST "https://api.buildkite.com/v2/organizations/$ORG/clusters/$CLUSTER_ID/secrets" \
  -d '{"key":"OCR_LLM_TOKEN","value":"...","policy":"- pipeline_slug: your-pipeline"}'

curl -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  -X POST "https://api.buildkite.com/v2/organizations/$ORG/clusters/$CLUSTER_ID/secrets" \
  -d '{"key":"OCR_GITHUB_TOKEN","value":"...","policy":"- pipeline_slug: your-pipeline"}'
```

`OCR_GITHUB_TOKEN` needs `pull-requests:write` (and `contents:write` if you
later enable `resolve_outdated`) on the target repo. For now a classic PAT or
`gh auth token` works; swap in a dedicated GitHub App installation token
later without touching the pipeline (same env var name).

### 2. Pipeline environment variables

Non-secret, so plain pipeline `env` (Settings → Environment Variables) is
fine:

```
OCR_LLM_URL   = https://your-llm-gateway/v1     # base URL; /chat/completions is appended
OCR_LLM_MODEL = your-model-name
```

`OCR_GITHUB_REPO` is optional — the adapter derives `owner/repo` from
`BUILDKITE_REPO` automatically for any `github.com` remote. Set it only if
your pipeline's repo URL isn't a plain `github.com` URL.

### 3. GitHub trigger settings (pipeline Settings → GitHub)

- **Build when pull request is opened or updated** — covers `opened` +
  `synchronize`; also enable **reopened** if you want re-reviews there.
- **Issue comments** (under Additional Webhooks): command word
  `open-code-review`, match mode **contains** (so `@open-code-review` or
  `/open-code-review` both work, like the upstream Action).
- The repo's GitHub webhook needs both **Issue comments** and **Pull
  requests** events — Buildkite uses the `pull_request` event to record the
  PR↔branch/commit mapping that a later `issue_comment` event resolves
  against:

  ```bash
  gh api repos/OWNER/REPO/hooks/HOOK_ID -X PATCH \
    -f 'events[]=pull_request' -f 'events[]=push' -f 'events[]=issue_comment'
  ```

- Leave **Build the test merge commit** off — it's a private-preview feature
  that checks out the GitHub-computed merge ref while `BUILDKITE_COMMIT`
  stays the PR head, which confuses `git merge-base`.
- Fork PRs: `Allow builds from third-party forked repositories` defaults
  off, which is the safe default here — the pipeline definition lives in the
  repo (`buildkite/pipeline.yml`), so an untrusted fork PR that can edit it
  should never get a build in the first place.

### 4. Copy the step into the target repo

Merge `buildkite/pipeline.yml`'s `:mag: OpenCodeReview` step into the target
repo's own `buildkite/pipeline.yml` (alongside whatever build/test steps
already exist), and commit `post-review-comments.js` +
`post-review-comments-buildkite.js` next to it. The step resolves both by
relative path (`$PWD/buildkite/...`) at runtime.

## Gotchas hit building this
  
(all fixed in `pipeline.yml`, documented here so
they don't get silently reintroduced)
  
1. **`if: build.pull_request != null` fails at upload**, not at parse time —
   `build.pull_request` isn't itself a field; use
   `if: build.pull_request.id != null`. The error only surfaces on a fresh
   webhook build (`pipeline upload rejected: ...`); a straight `--dry-run`
   locally won't catch it.

2. **Every `$VAR` in a step's `command:` is interpolated by
   `buildkite-agent pipeline upload` before the shell ever sees it** —
   including ones meant to be resolved by the *running job's* shell later
   (`$MERGE_BASE`, `$BUILDKITE_COMMIT`, `$?`, loop variables). An
   un-escaped runtime variable silently becomes empty (or, worse, whatever
   the *upload job's* environment happens to hold). Escape every one of them
   as `$$VAR` / `$${VAR:-default}`. This also applies **inside comments** —
   `# ${VAR:+...}` in a comment can still fail interpolation
   (`Unable to parse offset`), because the scanner doesn't know it's a
   comment.

3. **Shell arrays don't survive interpolation** (`Expected an operator, got
   [`) — build argument lists as a plain string and rely on word-splitting
   instead of `ARGS=(--flag "$val")` / `"${ARGS[@]}"`.

4. **`set -euo pipefail` + an optional, never-set env var == hard failure**
   — `set -u` isn't reset by `set +e`; `[ -n "$OCR_BACKGROUND" ]` under `-u`
   throws "unbound variable" when the var was never exported. Use
   `"${OCR_BACKGROUND:-}"`.

5. **`ocr config set llm.url/model` with no token is an *incomplete* config
   block, and OCR discards the whole block** — not just the token. That
   silently drops `protocol`/`use_anthropic` too, and OCR falls back to the
   **Anthropic Messages API** by default (`POST /v1/messages` with
   `Anthropic-Version` headers), which 405s against an OpenAI-compatible
   gateway. The error OCR reports (`all N file review(s) failed — check your
   LLM configuration and API key`) doesn't name the protocol mismatch.
   Always set `llm.auth_token_cmd 'printf "%s" "$OCR_LLM_TOKEN"'` (not a
   static `llm.auth_token`, so the secret never touches disk) alongside
   `url`/`model`/`protocol` so the block is complete.

6. **Agent images may not have Node.js.** Detected here with
   `apk add`/`apt-get`/`yum`/`brew` per job rather than assumed baked into
   the image, so the step is portable across whatever base image a queue's
   agents happen to run (Alpine's musl libc also rules out the prebuilt
   glibc tarballs from nodejs.org — `apk add nodejs npm` is the only zero-
   config option there).

## Parity gaps vs. the GitHub Action

- **No checkpoint/range narrowing** (`checkpoint_range`): every run reviews
  the full merge-base range, not just commits since the last reviewed head.
  `OCR_INCREMENTAL=true` still prevents duplicate *postings*, just not
  duplicate *token spend*. Porting `resolveCheckpointRange` from the
  upstream helper (already vendored, just unused here) is the natural next
  step if LLM cost on repeated pushes becomes a problem.
- **No `resolve_outdated`** thread cleanup wired up (the helper supports it;
  the adapter doesn't expose it via env yet — add `OCR_RESOLVE_OUTDATED` to
  the adapter call and pipeline env if wanted).
- Posting identity is whatever `OCR_GITHUB_TOKEN` is — a PAT for now, per
  the user's own tightening timeline. A dedicated GitHub App (JWT →
  installation token exchanged in a `pre-checkout` hook, key from a
  Buildkite secret) gets you a distinct bot identity instead of posting as a
  human account; swapping it in only touches the `OCR_GITHUB_TOKEN` secret
  value plus a small hook, not this pipeline.


# Contributions
All contributions welcome. Please create a PR and tag @pooh-bear; all human reviews and merges are done on a best effort basis.

# License
MIT
