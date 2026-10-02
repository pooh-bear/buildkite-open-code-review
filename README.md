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
| `buildkite/resolve-review-range.js` | Cross-push checkpoint resolver (opt-in, `OCR_CHECKPOINT_RANGE`). Buildkite port of the upstream Action's "Resolve review range" step: calls the same vendored `resolveCheckpointRange`/`readCheckpointComment`, and prints `export VAR=...` lines that `pipeline.yml` `eval`s into the job shell (no per-step outputs in a single-script pipeline). |
| `buildkite/repo-slug.js` | Shared `BUILDKITE_REPO`/`OCR_GITHUB_REPO` → `owner/repo` resolution used by both the posting adapter and the range resolver. |
| `buildkite/mint-installation-token.js` | Build-time GitHub App token minting: signs a JWT with the App's private key (Node's built-in `crypto`, no `openssl`/`curl` shelling out) and exchanges it for a 1-hour installation token. Pipeline-internal — `pipeline.yml` calls this (via the CLI veneer below) every run when `GH_APP_ID`/`GH_APP_INSTALLATION_ID`/`GH_APP_PRIVATE_KEY` secrets are present, so `OCR_GITHUB_TOKEN` is never a long-lived stored secret. |
| `buildkite/mint-installation-token-cli.js` | Thin CLI veneer over the above: reads the `GH_APP_*` env vars, prints the minted token alone to stdout. What `pipeline.yml` actually invokes (`OCR_GITHUB_TOKEN=$(node buildkite/mint-installation-token-cli.js)`). |
| `scripts/mint-github-app-token.sh` | Standalone CLI for a human to run by hand (e.g. to spot-check a new App's credentials, or mint one manually without wiring the pipeline-internal path below) — same JWT-sign-and-exchange logic as `buildkite/mint-installation-token.js`, reimplemented in `bash`+`openssl`+`curl`+`jq` since it has no reason to assume Node or this repo's other files are present. The pipeline itself uses `buildkite/mint-installation-token.js` instead (see "Posting identity" below for which one to reach for). |
| `test/adapter-dryrun.test.js` | Contract test: stubs the GitHub API, feeds a synthetic OCR result through the real upstream helper via the adapter's exact call shape, and asserts batching/sticky/error-path behavior. |
| `test/checkpoint-range.test.js` | Contract test for `OCR_CHECKPOINT_RANGE`: the resolver's cold-start/narrow/fail-closed decisions, the adapter's env→options translation, and a full two-run advance-then-narrow cycle through the real posting helper. |
| `test/mint-installation-token.test.js` | Contract test for `buildkite/mint-installation-token.js`: JWT shape/signature, error surfacing (bad key, non-201, missing token field), and one true end-to-end case against a local self-signed HTTPS server. |
| `test/stub-github.js` | Shared fake Octokit-shaped GitHub API surface used by the three test files above. |

Run every suite: `npm test`.

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

This pipeline posts to GitHub as either a classic PAT (simplest) or a
GitHub App installation token minted fresh at build time (distinct bot
identity, required for `OCR_CHECKPOINT_RANGE` to narrow anything, and no
long-lived token stored anywhere — see §5 for the App's one-time setup).
Create **either** set of secrets, scoped to just this pipeline via an
[access policy](https://buildkite.com/docs/pipelines/security/secrets/buildkite-secrets/access-policies):

**Option A — PAT** (2 secrets):

```bash
curl -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  -X POST "https://api.buildkite.com/v2/organizations/$ORG/clusters/$CLUSTER_ID/secrets" \
  -d '{"key":"OCR_LLM_TOKEN","value":"...","policy":"- pipeline_slug: your-pipeline"}'

curl -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  -X POST "https://api.buildkite.com/v2/organizations/$ORG/clusters/$CLUSTER_ID/secrets" \
  -d '{"key":"OCR_GITHUB_TOKEN","value":"...","policy":"- pipeline_slug: your-pipeline"}'
```

`OCR_GITHUB_TOKEN` needs `pull-requests:write` (and `contents:write` if you
later enable `resolve_outdated`) on the target repo. A classic PAT or
`gh auth token` works.

**Option B — GitHub App** (3 secrets, plus `OCR_LLM_TOKEN` above):

```bash
curl -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  -X POST "https://api.buildkite.com/v2/organizations/$ORG/clusters/$CLUSTER_ID/secrets" \
  -d '{"key":"GH_APP_ID","value":"123456","policy":"- pipeline_slug: your-pipeline"}'

curl -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  -X POST "https://api.buildkite.com/v2/organizations/$ORG/clusters/$CLUSTER_ID/secrets" \
  -d '{"key":"GH_APP_INSTALLATION_ID","value":"87654321","policy":"- pipeline_slug: your-pipeline"}'

curl -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  --data-urlencode value@app-private-key.pem \
  -d 'key=GH_APP_PRIVATE_KEY' -d 'policy=- pipeline_slug: your-pipeline' \
  -X POST "https://api.buildkite.com/v2/organizations/$ORG/clusters/$CLUSTER_ID/secrets"
```

(The third call splits `value` into `--data-urlencode` because the PEM's
newlines need preserving — `-d` on a multi-field JSON body with embedded
newlines is easy to mangle from a shell one-liner; adjust for how you
actually script secret creation.) See §5 for how to obtain all three values
and set every permission the App needs.

When both sets of secrets exist, Option B wins: `pipeline.yml` checks
`GH_APP_ID`/`GH_APP_INSTALLATION_ID`/`GH_APP_PRIVATE_KEY` first and only
falls back to reading `OCR_GITHUB_TOKEN` directly when any of the three is
absent.

Both options need at least `OCR_LLM_TOKEN`; the two are otherwise
independent, so pick one.

**Secret keys are unique per cluster**, so if another pipeline in the same
cluster already defines any of these key names, creating them fails with
`422 ... Key already_exists`. Store this pipeline's own key names and remap
them — the fix differs by which secret collided:

- `OCR_LLM_TOKEN` is read declaratively via the step's `secrets:` hash,
  which supports a prefixed key name directly:

  ```yaml
  secrets:
    OCR_LLM_TOKEN: YOURPREFIX_OCR_LLM_TOKEN
  ```

  Only the secret *key* needs prefixing; `post-review-comments-buildkite.js`
  still reads the `OCR_LLM_TOKEN` env var name and stays unmodified.

- `OCR_GITHUB_TOKEN` / `GH_APP_ID` / `GH_APP_INSTALLATION_ID` /
  `GH_APP_PRIVATE_KEY` are read imperatively (`buildkite-agent secret get
  <name>`) inside `pipeline.yml`'s command, not through the `secrets:` hash
  — see the comment above those four lines in `pipeline.yml`. A collision
  there means editing those four literal key names directly (equivalent
  cost to editing the YAML hash above, just not expressed as one).

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

The dashboard is the only place that can set these — **the REST and GraphQL
APIs cannot**. `env` in the body of `POST`/`PATCH
/v2/organizations/{org}/pipelines` is silently ignored (the response reports
`env: null` with no error), and neither `PipelineCreateInput` nor
`PipelineUpdateInput` exposes an `env` field. For an API- or
infrastructure-as-code setup, put `env` in the pipeline **configuration**
instead, where Buildkite lifts it into the pipeline's environment:

```yaml
env:
  OCR_LLM_URL: "https://your-llm-gateway/v1"
  OCR_LLM_MODEL: "your-model-name"
steps:
  - command: "buildkite-agent pipeline upload"
```

### 3. GitHub trigger settings (pipeline Settings → GitHub)

- **Build when pull request is opened or updated** — covers `opened` +
  `synchronize`; also enable **reopened** if you want re-reviews there.
- **Skip when pull request has existing build for commit and branch**
  (`skip_pull_request_builds_for_existing_commits`, **enabled by default**):
  leave this **off** if you want a review the moment a PR is opened. On an
  in-repo PR the branch `push` build already carries the PR details, so with
  this on the `opened` webhook is treated as a duplicate of that same
  commit+branch and **no second build is created** — the PR then only gets
  reviewed on the next push. Symptom: a freshly opened PR shows no build (and
  so no review) until something is pushed to it, while re-review-on-comment
  still works. Turn it off with:

  ```bash
  curl -X PATCH -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"provider_settings":{"skip_pull_request_builds_for_existing_commits":false}}' \
    "https://api.buildkite.com/v2/organizations/$ORG/pipelines/$SLUG"
  ```

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

The step is gated on `if: build.pull_request.id != null`, so on **branch**
builds it does not run and Buildkite reports it as `broken` (a false
conditional is the documented `broken` case, distinct from `skipped`). That is
expected, not a failure — the build itself still passes.

### 4. Copy the step into the target repo

Merge `buildkite/pipeline.yml`'s `:mag: OpenCodeReview` step into the target
repo's own `buildkite/pipeline.yml` (alongside whatever build/test steps
already exist), and commit `post-review-comments.js` +
`post-review-comments-buildkite.js` next to it. The step resolves both by
relative path (`$PWD/buildkite/...`) at runtime.

### 5. (Optional) Use a GitHub App instead of a PAT for `OCR_GITHUB_TOKEN`

Skip this if a PAT is fine for now (see "Posting identity" under "Parity
gaps" below for the tradeoff). Needed for `OCR_CHECKPOINT_RANGE` to actually
narrow anything — see that section too.

`pipeline.yml` mints its own installation token at the start of every run
(`buildkite/mint-installation-token.js`, called via
`buildkite/mint-installation-token-cli.js`) whenever the three
`GH_APP_*` secrets below exist — there is no `pre-checkout` hook or other
wiring to set up beyond creating those secrets; §1's "Option B" already
covers that.

**5.1. Create the App**

1. GitHub → your avatar → **Settings** (use an org's Settings instead if the
   App should belong to the org, not your personal account) → **Developer
   settings** → **GitHub Apps** → **New GitHub App**.
2. **GitHub App name**: anything unique on GitHub (e.g.
   `yourorg-opencodereview`). **Homepage URL**: anything valid, e.g. the
   target repo's URL — it's not used by this integration.
3. **Webhook**: uncheck **Active**. This integration reacts to Buildkite's
   own GitHub webhook, not the App's; an active webhook with no configured
   URL just fails delivery attempts for no benefit.
4. **Permissions** → **Repository permissions**, set:
   - **Pull requests**: Read and write (review creation, `listReviews`,
     `listReviewComments`, `listFiles`).
   - **Issues**: Read and write (the sticky summary and sticky-marker reads
     go through the issue-comments API — GitHub files PR conversation
     comments under Issues, not Pull requests, in the App permission model).
   - **Contents**: Read and write, only if you plan to enable
     `OCR_RESOLVE_OUTDATED` (thread resolution needs repository write access;
     `pull-requests:write` alone returns FORBIDDEN for that mutation).
   - **Metadata**: mandatory, fixed at Read-only — GitHub grants this to
     every App regardless of what you pick and the form won't let you
     change it.
   - Leave **Actions** and every other unlisted permission at **No
     access** — nothing here calls the Actions API.
5. **Where can this GitHub App be installed?**: **Only on this account**,
   unless you specifically want it installable on other accounts/orgs too.
6. **Create GitHub App**.

**5.2. Note the App ID and generate a private key**

On the App's settings page (Developer settings → GitHub Apps → your app):

1. **App ID** is shown near the top — this is `--app-id` /
   `GH_APP_ID`.
2. Scroll to **Private keys** → **Generate a private key**. This downloads a
   `.pem` file — GitHub does not keep a copy; store it somewhere you control
   (a password manager, a Buildkite cluster secret, etc.), not in the repo.

**5.3. Install the App on the target repo**

1. On the same settings page, click **Install App** in the left sidebar (or
   visit `https://github.com/settings/apps/<your-app-slug>/installations`).
2. Pick the account, then **Only select repositories** → choose the repo(s)
   this pipeline reviews → **Install**.
3. After installing, the URL you land on is
   `https://github.com/settings/installations/<installation_id>` — that
   number is `--installation-id` / `GH_APP_INSTALLATION_ID`. (Alternatively,
   list installations programmatically with `GET /app/installations`,
   authenticated as the App with a signed JWT — circular for a first setup,
   so reading it off the URL is simplest.)

**5.4. Store the three values as Buildkite secrets**

See §1 "Option B" for the exact `curl` calls:
`GH_APP_ID` (plain number), `GH_APP_INSTALLATION_ID` (plain number),
`GH_APP_PRIVATE_KEY` (the full `.pem` file contents, newlines intact).

That's the entire setup. The next run of this pipeline:

1. Reads all three secrets (`buildkite-agent secret get`, guarded so a
   missing key never fails job startup).
2. Mints a fresh ≤1-hour installation token
   (`buildkite/mint-installation-token-cli.js`) — no network tooling beyond
   Node's own `crypto`/`https`, so it rides the same Node install the step
   already bootstraps for `ocr`/the posting adapter.
3. Registers the minted token with `buildkite-agent redactor add`, so it
   cannot leak into this job's own logs even though it never passed through
   `secret get` itself (the thing Buildkite's own automatic redaction
   covers).
4. Uses it for both the posting adapter and (if enabled)
   `OCR_CHECKPOINT_RANGE`'s range resolver.

Confirm it worked by checking the posted summary comment's author avatar —
it should show the App's bot identity, not whatever `OCR_GITHUB_TOKEN`
PAT (if any) used to post before.

If any of the three secrets is missing, the step logs
`Using the static OCR_GITHUB_TOKEN secret` and falls back to §1 "Option A"
unchanged — so adding the three App secrets to a pipeline that already has
`OCR_GITHUB_TOKEN` is purely additive, no two-phase migration needed.

For minting a token by hand instead (debugging, or using the App outside
this pipeline entirely), use `scripts/mint-github-app-token.sh` — see its
own `--help`.

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

7. **A newly opened PR gets no review if `skip_pull_request_builds_for_existing_commits`
   is on (the default).** On an in-repo PR, the branch `push` build already
   carries the PR details, so Buildkite treats the `opened` webhook as a
   duplicate of an existing commit+branch build and creates nothing — the PR
   only gets reviewed on the next push. `synchronize` behaves the same way by
   design (`push` covers it), so this is specifically about `opened`. See
   §3 for the fix.

8. **Neither the REST nor the GraphQL API can set pipeline environment
   variables.** `POST`/`PATCH /v2/organizations/{org}/pipelines` with an
   `env` body field returns `env: null` and no error; `PipelineCreateInput`
   and `PipelineUpdateInput` have no `env` field. Put `env` in the pipeline
   *configuration* instead (see §2) — the dashboard's Environment Variables
   page is editing the same thing.

## Parity gaps vs. the GitHub Action

- **Checkpoint/range narrowing** (`OCR_CHECKPOINT_RANGE`, off by default):
  narrows a run that follows a complete previous review to
  `<checkpoint>..<new head>` instead of `<merge-base>..<new head>`, via
  `buildkite/resolve-review-range.js` — a Buildkite port of the upstream
  Action's "Resolve review range" step, calling the same vendored
  `resolveCheckpointRange`/`readCheckpointComment` (`buildkite/post-review-comments.js`).
  Fail-closed on any doubt (missing/corrupt marker, moved base, changed
  config, unprovable ancestry) — falls back to today's full range, never a
  narrower-than-safe one. `OCR_INCREMENTAL=true` still prevents duplicate
  *postings* independently of this; this is what stops duplicate *token
  spend* on repeated pushes.

  **Off by default here** (unlike upstream, where it's also opt-in but for a
  different reason): the checkpoint marker's author check
  (`isCheckpointAuthorOurs`) rejects any comment from a `user.type: "User"`
  account, which is exactly what a PAT posts as. With a PAT, turning this on
  reads back `author_unverified` every time and always falls back to a full
  review — one extra `listComments` call per run for no narrowing. Flip
  `OCR_CHECKPOINT_RANGE: "true"` in `pipeline.yml` only after adding the
  `GH_APP_*` secrets (see §5 and the posting-identity gap below) so the
  pipeline mints a Bot/App-identity token the check accepts, instead of
  posting as whatever `OCR_GITHUB_TOKEN` PAT might also be configured.
- **No `resolve_outdated`** thread cleanup wired up (the helper supports it;
  the adapter doesn't expose it via env yet — add `OCR_RESOLVE_OUTDATED` to
  the adapter call and pipeline env if wanted).
- Posting identity is a GitHub App installation token, minted fresh at
  build time (`buildkite/mint-installation-token.js`, §5), whenever
  `GH_APP_ID`/`GH_APP_INSTALLATION_ID`/`GH_APP_PRIVATE_KEY` secrets exist;
  otherwise `OCR_GITHUB_TOKEN` (a PAT, posting as a human account) is used
  as-is. The App path is what `OCR_CHECKPOINT_RANGE` needs to narrow
  anything (see above) — a PAT's `user.type: "User"` always fails the
  checkpoint marker's author check. `scripts/mint-github-app-token.sh`
  remains available for minting a token by hand outside the pipeline.


# Contributions
All contributions welcome. Please create a PR and tag @pooh-bear; all human reviews and merges are done on a best effort basis.

# License
MIT
