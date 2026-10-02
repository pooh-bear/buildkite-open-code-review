"use strict";

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Build-time GitHub App installation token minting (#601): signs a JWT with
// the App's private key and exchanges it for a short-lived (<=1 hour)
// installation token, using only Node's built-in `crypto`/`https` — no
// `openssl`/`curl`/`jq` shelling out, so this runs on whatever base image the
// queue's agents happen to have Node installed on (pipeline.yml already
// bootstraps Node for `ocr`/the posting adapter; this reuses that).
//
// This supersedes scripts/mint-github-app-token.sh for the pipeline's own
// use: that script stays as a standalone CLI for a human minting a token by
// hand (see README "Posting identity"), but the pipeline itself calls this
// module directly so OCR_GITHUB_TOKEN never has to be a long-lived PAT
// stored as a Buildkite secret — only GH_APP_ID / GH_APP_INSTALLATION_ID /
// GH_APP_PRIVATE_KEY need to be secrets, and the installation token is
// minted fresh every build and never persisted anywhere.
//
// isCheckpointAuthorOurs (post-review-comments.js) rejects any comment from a
// user.type "User" account, which is exactly what a PAT posts as — so this is
// also what OCR_CHECKPOINT_RANGE requires to narrow anything (see README,
// "Parity gaps" -> checkpoint/range narrowing).

const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// now/ttl are injectable for tests; production always uses the real clock and
// the default 570s TTL (GitHub's own JWT expiry ceiling is 600s; 570 leaves a
// 30s margin after the 60s-in-the-past `iat` so the token never expires
// mid-exchange on a slow connection).
function buildAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000), ttl = 570 }) {
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 600) {
    throw new Error(`ttl must be an integer in (0, 600] (GitHub's own JWT expiry ceiling), got ${ttl}`);
  }
  // iat 60s in the past absorbs clock skew between this machine and GitHub's,
  // per GitHub's own recommendation. exp is capped at ttl from iat (not from
  // now), so the total validity window never exceeds the 600s ceiling even
  // after the skew adjustment.
  const iat = now - 60;
  const exp = iat + ttl;
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({ iat, exp, iss: String(appId) })));
  const signingInput = `${header}.${payload}`;
  let signature;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  } catch (e) {
    throw new Error(
      `failed to sign the App JWT with the provided private key (${e.message}); ` +
        "check that GH_APP_PRIVATE_KEY holds a complete, valid PEM private key"
    );
  }
  return `${signingInput}.${base64url(signature)}`;
}

// Minimal POST-JSON over node:https, no dependency on an HTTP client library.
// Injectable as `request` for tests.
function requestJson(url, { method, headers }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || 443,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let body = null;
          try {
            body = data ? JSON.parse(data) : {};
          } catch (e) {
            // Non-JSON response body: body stays null, raw carries it for the
            // caller's error message.
          }
          resolve({ status: res.statusCode, body, raw: data });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Signs a JWT and exchanges it for an installation token via
// POST /app/installations/{id}/access_tokens. Returns { token, expiresAt }.
// Throws with a message safe to log (never includes the private key or the
// signed JWT itself) on any failure — missing fields, a key that doesn't
// parse, a non-201 response, or a 201 with no usable token field.
async function mintInstallationToken({
  appId,
  installationId,
  privateKey,
  apiUrl = "https://api.github.com",
  ttl = 570,
  now,
  request = requestJson,
}) {
  if (!appId) throw new Error("appId is required (GH_APP_ID)");
  if (!installationId) throw new Error("installationId is required (GH_APP_INSTALLATION_ID)");
  if (!privateKey) throw new Error("privateKey is required (GH_APP_PRIVATE_KEY)");

  const jwt = buildAppJwt({ appId, privateKey, now, ttl });
  const url = `${apiUrl.replace(/\/+$/, "")}/app/installations/${installationId}/access_tokens`;

  let response;
  try {
    response = await request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "open-code-review-buildkite",
      },
    });
  } catch (e) {
    throw new Error(`could not reach ${apiUrl} to exchange the App JWT: ${e.message}`);
  }

  const { status, body, raw } = response;
  if (status !== 201) {
    const message = (body && body.message) || raw || `HTTP ${status}`;
    throw new Error(`installation token exchange failed (HTTP ${status}): ${message}`);
  }
  if (!body || typeof body.token !== "string" || body.token === "") {
    throw new Error("installation token exchange returned HTTP 201 but no usable token field");
  }
  return { token: body.token, expiresAt: body.expires_at || "" };
}

module.exports = { mintInstallationToken, buildAppJwt };
