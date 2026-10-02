#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 alibaba/open-code-review Contributors
#
# Mints a short-lived (1 hour) GitHub App installation token: signs a JWT with
# the App's private key, then exchanges it for an installation token via the
# GitHub API. Run this whenever OCR_GITHUB_TOKEN needs refreshing (it is NOT
# stored anywhere by this script; you decide where the printed token goes —
# see USAGE below).
#
# Why: posting review comments as a GitHub App instead of a personal access
# token gets you a distinct bot identity, AND is what buildkite/pipeline.yml's
# cross-push checkpoint feature (OCR_CHECKPOINT_RANGE) requires to work at
# all — its author check (isCheckpointAuthorOurs in
# buildkite/post-review-comments.js) rejects any comment posted by a
# user.type "User" account, which is exactly what a classic PAT posts as.
#
# This script is standalone: it has no dependency on anything else in this
# repo and does not touch buildkite/. Run it from your own machine or CI to
# produce a token, then feed that token into OCR_GITHUB_TOKEN however you
# already manage secrets (Buildkite secret, env var, whatever) — it does not
# assume Buildkite.
#
# Prerequisites: bash, openssl, curl, jq.
#
# USAGE
#   scripts/mint-github-app-token.sh \
#     --app-id 123456 \
#     --installation-id 87654321 \
#     --private-key-file ./my-app-private-key.pem
#
#   # Or pipe the key on stdin instead of a file:
#   cat my-app-private-key.pem | scripts/mint-github-app-token.sh \
#     --app-id 123456 --installation-id 87654321 --private-key-file -
#
#   # Or via environment variables (handy for CI, no argv secrets):
#   GH_APP_ID=123456 GH_APP_INSTALLATION_ID=87654321 \
#     GH_APP_PRIVATE_KEY_FILE=./my-app-private-key.pem \
#     scripts/mint-github-app-token.sh
#
# On success, prints ONLY the installation token to stdout (nothing else —
# safe to capture directly: `TOKEN=$(scripts/mint-github-app-token.sh ...)`).
# Diagnostics go to stderr. Exits non-zero on any failure.
#
# Finding --app-id / --installation-id:
#   App ID:          the App's settings page (Developer settings > GitHub
#                     Apps > your app), field "App ID".
#   Installation ID: Settings > Integrations > <your app> > Configure, then
#                     read the numeric ID from the resulting URL
#                     (.../installations/<this number>), or list them via
#                     `GET /app/installations` authenticated as the App (JWT).

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: mint-github-app-token.sh --app-id ID --installation-id ID [--private-key-file PATH|-]
                                 [--api-url URL] [--ttl SECONDS]

  --app-id ID            GitHub App ID (or GH_APP_ID env var).
  --installation-id ID   Installation ID for the target repo/org
                          (or GH_APP_INSTALLATION_ID env var).
  --private-key-file PATH
                          Path to the App's PEM private key, or "-" to read
                          from stdin (or GH_APP_PRIVATE_KEY_FILE env var;
                          GH_APP_PRIVATE_KEY env var supplies the PEM content
                          directly instead of a path).
  --api-url URL           GitHub API base URL (default: https://api.github.com;
                          set for GitHub Enterprise Server, e.g.
                          https://ghe.example.com/api/v3).
  --ttl SECONDS           JWT validity window in seconds, max 600 per GitHub's
                          own limit (default: 570, leaving clock-skew margin).
  -h, --help              Show this help.
EOF
  exit "${1:-0}"
}

APP_ID="${GH_APP_ID:-}"
INSTALLATION_ID="${GH_APP_INSTALLATION_ID:-}"
PRIVATE_KEY_FILE="${GH_APP_PRIVATE_KEY_FILE:-}"
PRIVATE_KEY_INLINE="${GH_APP_PRIVATE_KEY:-}"
API_URL="${GH_APP_API_URL:-https://api.github.com}"
TTL=570

while [ $# -gt 0 ]; do
  case "$1" in
    --app-id) APP_ID="$2"; shift 2 ;;
    --installation-id) INSTALLATION_ID="$2"; shift 2 ;;
    --private-key-file) PRIVATE_KEY_FILE="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --ttl) TTL="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *)
      echo "error: unrecognized argument: $1" >&2
      usage 1
      ;;
  esac
done

for cmd in openssl curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: required command '$cmd' not found on PATH" >&2; exit 1; }
done

[ -n "$APP_ID" ] || { echo "error: --app-id (or GH_APP_ID) is required" >&2; usage 1; }
[ -n "$INSTALLATION_ID" ] || { echo "error: --installation-id (or GH_APP_INSTALLATION_ID) is required" >&2; usage 1; }
if [ -z "$PRIVATE_KEY_FILE" ] && [ -z "$PRIVATE_KEY_INLINE" ]; then
  echo "error: --private-key-file (or GH_APP_PRIVATE_KEY_FILE / GH_APP_PRIVATE_KEY) is required" >&2
  usage 1
fi
case "$TTL" in
  ''|*[!0-9]*) echo "error: --ttl must be a positive integer, got '$TTL'" >&2; exit 1 ;;
esac
if [ "$TTL" -gt 600 ]; then
  echo "error: --ttl must be <= 600 (GitHub's own JWT expiry limit), got '$TTL'" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

KEY_FILE="$WORKDIR/key.pem"
if [ -n "$PRIVATE_KEY_INLINE" ]; then
  printf '%s\n' "$PRIVATE_KEY_INLINE" > "$KEY_FILE"
elif [ "$PRIVATE_KEY_FILE" = "-" ]; then
  cat > "$KEY_FILE"
else
  [ -r "$PRIVATE_KEY_FILE" ] || { echo "error: cannot read private key file: $PRIVATE_KEY_FILE" >&2; exit 1; }
  cp "$PRIVATE_KEY_FILE" "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"

# base64url per RFC 7515 §2: standard base64, then '+'->'-', '/'->'_', strip
# '=' padding. openssl's own base64 always emits standard alphabet with
# padding, hence the tr/tr -d pipeline.
b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

NOW="$(date +%s)"
# iat 60s in the past absorbs clock skew between this machine and GitHub's;
# GitHub itself recommends this. exp is capped at TTL (<=600s) from iat, not
# from now, so the token's total validity window never exceeds the
# documented 10-minute ceiling even after the skew adjustment.
IAT=$((NOW - 60))
EXP=$((IAT + TTL))

JWT_HEADER="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
JWT_PAYLOAD="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$IAT" "$EXP" "$APP_ID" | b64url)"
SIGNING_INPUT="${JWT_HEADER}.${JWT_PAYLOAD}"
SIGNATURE="$(printf '%s' "$SIGNING_INPUT" | openssl dgst -sha256 -sign "$KEY_FILE" -binary | b64url)"
JWT="${SIGNING_INPUT}.${SIGNATURE}"

# Exchange the JWT for an installation token. This endpoint is POST-only and
# takes no body for the default (all-permissions, all-repos) case; the
# installation's own configured repo/permission scope already limits what
# the returned token can do, so nothing further needs restricting here.
RESPONSE_FILE="$WORKDIR/response.json"
HTTP_STATUS="$(
  curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $JWT" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API_URL%/}/app/installations/${INSTALLATION_ID}/access_tokens"
)"

if [ "$HTTP_STATUS" != "201" ]; then
  echo "error: token exchange failed (HTTP $HTTP_STATUS):" >&2
  jq -r '.message // .' "$RESPONSE_FILE" >&2 2>/dev/null || cat "$RESPONSE_FILE" >&2
  exit 1
fi

TOKEN="$(jq -r '.token' "$RESPONSE_FILE")"
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "error: response had HTTP 201 but no .token field:" >&2
  cat "$RESPONSE_FILE" >&2
  exit 1
fi

EXPIRES_AT="$(jq -r '.expires_at // "unknown"' "$RESPONSE_FILE")"
echo "installation token expires at: $EXPIRES_AT" >&2

printf '%s\n' "$TOKEN"
