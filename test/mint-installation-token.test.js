// Contract test for buildkite/mint-installation-token.js (#601): the
// build-time GitHub App JWT-sign + installation-token-exchange logic the
// pipeline uses so OCR_GITHUB_TOKEN never has to be a long-lived PAT secret.
//
// Most cases inject a fake `request` function (no network, no real RSA key
// needed beyond a throwaway one) to assert the signing/validation/error-
// surfacing contract in isolation. One true end-to-end case drives the real
// `https` request path against a local self-signed HTTPS server to prove the
// wire format (method, path, Authorization header, JSON parsing) really
// works, not just the pure logic around it.
//
// Run: node test/mint-installation-token.test.js

"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { mintInstallationToken, buildAppJwt } = require(path.join(ROOT, "buildkite", "mint-installation-token.js"));

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

function verifyJwtSignature(jwt, publicKey) {
  const [header, payload, signature] = jwt.split(".");
  return crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  );
}

(async () => {
  // 1. Happy path: correct URL/method/headers, JWT verifies against the
  //    matching public key, token+expiry extracted from the response body.
  {
    let captured = null;
    const request = async (url, opts) => {
      captured = { url, opts };
      return { status: 201, body: { token: "ghs_abc", expires_at: "2026-01-01T00:00:00Z" } };
    };
    const result = await mintInstallationToken({
      appId: "123456",
      installationId: "87654321",
      privateKey: PEM,
      request,
    });
    assert.strictEqual(result.token, "ghs_abc");
    assert.strictEqual(result.expiresAt, "2026-01-01T00:00:00Z");
    assert.strictEqual(captured.url, "https://api.github.com/app/installations/87654321/access_tokens");
    assert.strictEqual(captured.opts.method, "POST");
    assert.ok(captured.opts.headers.Authorization.startsWith("Bearer "));
    assert.strictEqual(captured.opts.headers.Accept, "application/vnd.github+json");
    const jwt = captured.opts.headers.Authorization.slice("Bearer ".length);
    assert.ok(verifyJwtSignature(jwt, PUBLIC_KEY_PEM));
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    assert.strictEqual(payload.iss, "123456");
    assert.ok(payload.exp - payload.iat <= 600, "JWT window stays within GitHub's 600s ceiling");
    console.log("✔ happy path: correct request shape, verifiable JWT, token extracted");
  }

  // 2. Custom apiUrl (GHES) is respected and trailing slash is normalized.
  {
    let captured = null;
    const request = async (url) => {
      captured = url;
      return { status: 201, body: { token: "ghs_ghes" } };
    };
    await mintInstallationToken({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      apiUrl: "https://ghe.example.com/api/v3/",
      request,
    });
    assert.strictEqual(captured, "https://ghe.example.com/api/v3/app/installations/2/access_tokens");
    console.log("✔ custom apiUrl (GHES) used verbatim, trailing slash normalized");
  }

  // 3. Non-201 response surfaces the response's own message.
  {
    const request = async () => ({ status: 401, body: { message: "Bad credentials" } });
    await assert.rejects(
      () => mintInstallationToken({ appId: "1", installationId: "1", privateKey: PEM, request }),
      /HTTP 401.*Bad credentials/
    );
    console.log("✔ non-201 response surfaces GitHub's own error message");
  }

  // 4. 201 with no token field is still an error (never returns a falsy token).
  {
    const request = async () => ({ status: 201, body: {} });
    await assert.rejects(
      () => mintInstallationToken({ appId: "1", installationId: "1", privateKey: PEM, request }),
      /no usable token field/
    );
    console.log("✔ HTTP 201 with no token field rejected, not silently returned empty");
  }

  // 5. Required fields.
  {
    await assert.rejects(
      () => mintInstallationToken({ installationId: "1", privateKey: PEM, request: async () => ({}) }),
      /appId is required/
    );
    await assert.rejects(
      () => mintInstallationToken({ appId: "1", privateKey: PEM, request: async () => ({}) }),
      /installationId is required/
    );
    await assert.rejects(
      () => mintInstallationToken({ appId: "1", installationId: "1", request: async () => ({}) }),
      /privateKey is required/
    );
    console.log("✔ missing appId/installationId/privateKey each rejected with a named reason");
  }

  // 6. A key that doesn't parse as PEM fails signing with a clear message,
  //    not an opaque OpenSSL stack trace.
  {
    await assert.rejects(
      () =>
        mintInstallationToken({
          appId: "1",
          installationId: "1",
          privateKey: "not a pem",
          request: async () => ({ status: 201, body: { token: "x" } }),
        }),
      /failed to sign the App JWT/
    );
    console.log("✔ malformed private key rejected with an actionable message");
  }

  // 7. ttl is capped at GitHub's own 600s JWT expiry ceiling.
  {
    await assert.rejects(
      () => mintInstallationToken({ appId: "1", installationId: "1", privateKey: PEM, ttl: 601, request: async () => ({}) }),
      /ttl must be/
    );
    // A valid ttl at the boundary is accepted.
    const jwt = buildAppJwt({ appId: "1", privateKey: PEM, ttl: 600 });
    assert.strictEqual(jwt.split(".").length, 3);
    console.log("✔ ttl > 600 rejected; ttl == 600 (the ceiling) accepted");
  }

  // 8. Network-level failure (connection refused, DNS, etc.) is wrapped with
  //    context, not left as a raw low-level error.
  {
    const request = async () => {
      throw new Error("ECONNREFUSED");
    };
    await assert.rejects(
      () => mintInstallationToken({ appId: "1", installationId: "1", privateKey: PEM, request }),
      /could not reach .* ECONNREFUSED/
    );
    console.log("✔ network failure wrapped with the target URL for context");
  }

  // 9. End-to-end over the real `https` request path (no injected `request`):
  //    a local self-signed HTTPS server receiving the real wire request,
  //    proving the production request path (not just the injected fake)
  //    produces a verifiable JWT and parses a real JSON response.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-https-mock-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    try {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", keyPath, "-out", certPath,
        "-days", "1", "-nodes", "-subj", "/CN=localhost",
      ], { stdio: "pipe" });
    } catch (e) {
      console.log("⚠ skipping end-to-end HTTPS case: openssl unavailable (" + e.message + ")");
      finish();
      return;
    }

    let received = null;
    const server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          received = { method: req.method, url: req.url, authorization: req.headers.authorization };
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token: "ghs_e2e", expires_at: "2026-01-01T00:00:00Z" }));
        });
      }
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    // Self-signed cert: bypass verification for this throwaway local server only.
    const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const result = await mintInstallationToken({
        appId: "999",
        installationId: "888",
        privateKey: PEM,
        apiUrl: `https://127.0.0.1:${port}`,
      });
      assert.strictEqual(result.token, "ghs_e2e");
      assert.strictEqual(result.expiresAt, "2026-01-01T00:00:00Z");
      assert.strictEqual(received.method, "POST");
      assert.strictEqual(received.url, "/app/installations/888/access_tokens");
      assert.ok(received.authorization.startsWith("Bearer "));
      const jwt = received.authorization.slice("Bearer ".length);
      assert.ok(verifyJwtSignature(jwt, PUBLIC_KEY_PEM));
      console.log("✔ end-to-end over real https: correct wire request, verifiable JWT, real JSON parse");
    } finally {
      server.close();
      if (prevReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  finish();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function finish() {
  console.log("\nAll mint-installation-token contract checks passed.");
}
