#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Thin CLI veneer over mint-installation-token.js, for pipeline.yml to call
// as `OCR_GITHUB_TOKEN=$(node buildkite/mint-installation-token-cli.js)`.
// All the signing/exchange logic lives in mint-installation-token.js; this
// file only reads the environment contract and prints the result in the
// shape a shell `$(...)` capture wants: the token alone on stdout on
// success, nothing else, so `set -e` plus a non-zero exit on failure is
// enough for the caller to detect trouble without parsing output.
//
// Environment contract (set by pipeline.yml from Buildkite secrets):
//   GH_APP_ID                   GitHub App ID (required).
//   GH_APP_INSTALLATION_ID      Installation ID for the target repo (required).
//   GH_APP_PRIVATE_KEY          The App's PEM private key, full contents (required).
//   GH_APP_API_URL              GitHub API base URL (optional; default
//                               https://api.github.com — set for GHES).
//   GH_APP_TOKEN_TTL            JWT validity window in seconds, max 600
//                               (optional; default 570).

"use strict";

const { mintInstallationToken } = require("./mint-installation-token.js");

async function main() {
  const appId = process.env.GH_APP_ID || "";
  const installationId = process.env.GH_APP_INSTALLATION_ID || "";
  const privateKey = process.env.GH_APP_PRIVATE_KEY || "";
  const apiUrl = process.env.GH_APP_API_URL || "https://api.github.com";
  const ttlRaw = process.env.GH_APP_TOKEN_TTL;
  const ttl = ttlRaw ? parseInt(ttlRaw, 10) : 570;

  const { token } = await mintInstallationToken({ appId, installationId, privateKey, apiUrl, ttl });
  process.stdout.write(token);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}

module.exports = { main };
