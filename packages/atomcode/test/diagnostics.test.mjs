import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MASTER_KEY_HEX } from "../sign.mjs";
import { createStateStore } from "../state.mjs";
import {
  DIAGNOSTICS_TOKEN_HEADER,
  diagnosticsPort,
  diagnosticsSnapshot,
  hostAllowed,
  originAllowed,
  runSelfCheck,
  startDiagnosticsService,
} from "../diagnostics.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function rawRequest(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("diagnostics port, Host and Origin rules are loopback-only", () => {
  assert.equal(diagnosticsPort(3478), 3478);
  assert.equal(diagnosticsPort("4567"), 4567);
  assert.equal(diagnosticsPort(80), 3478);
  assert.equal(diagnosticsPort("bad"), 3478);
  assert.equal(hostAllowed("127.0.0.1:3478", 3478), true);
  assert.equal(hostAllowed("localhost:3478", 3478), true);
  assert.equal(hostAllowed("127.0.0.1:3479", 3478), false);
  assert.equal(hostAllowed("evil.example:3478", 3478), false);
  assert.equal(originAllowed(undefined, 3478), true);
  assert.equal(originAllowed(undefined, 3478, { required: true }), false);
  assert.equal(originAllowed("null", 3478, { required: true }), true);
  assert.equal(originAllowed("http://127.0.0.1:3478", 3478, { required: true }), true);
  assert.equal(originAllowed("https://127.0.0.1:3478", 3478, { required: true }), false);
});

test("diagnostics page uses flat backgrounds without decorative gradients", async () => {
  const css = await readFile(new URL("../page/app.css", import.meta.url), "utf8");
  const html = await readFile(
    new URL("../page/diagnostics.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(css, /(?:radial|linear)-gradient/i);
  assert.doesNotMatch(css, /\.ambient\b/);
  assert.doesNotMatch(html, /class="ambient"/);
});

test("offline self-check exercises signing without network access", () => {
  const ok = runSelfCheck({ clientVersion: "5.2.3", masterKeyHex: MASTER_KEY_HEX });
  assert.equal(ok.ok, true);
  assert.equal(ok.checks.signature, true);
  assert.equal(ok.checks.version, true);
  assert.equal(ok.checks.configuration, true);

  const failed = runSelfCheck({ clientVersion: "", masterKeyHex: "bad" });
  assert.equal(failed.ok, false);
  assert.equal(failed.checks.version, false);
  assert.equal(failed.checks.configuration, false);
});

test("snapshot exposes only redacted persisted account data", async () => {
  const snapshot = await diagnosticsSnapshot({
    state: {
      version: 1,
      accounts: {
        abcdef0123456789: {
          digest: "abcdef0123456789",
          loginSource: "atomcode-cli",
          models: [{ id: "model-a" }, { id: "model-b" }],
          modelSource: "live",
          modelUpdatedAt: new Date(1000).toISOString(),
          quota: {
            plan: "Plan",
            windows: [{ name: "5h", used: 10, unit: "calls" }],
          },
          quotaUpdatedAt: new Date(2000).toISOString(),
          lastError: { category: "network", message: "masked" },
        },
      },
    },
    version: { version: "5.2.3", source: "manifest" },
    config: { locale: "en", diagnosticsPort: 3478 },
  });
  assert.equal(snapshot.account.digest, "abcdef0123456789");
  assert.equal(snapshot.models.count, 2);
  assert.equal(snapshot.quota.stale, true);
  assert.equal(snapshot.config.readOnly, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /access|refresh|email/i);
});

test("loopback service serves a read-only page and token-gated APIs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-diagnostics-"));
  const stateStore = createStateStore({ directory });
  await stateStore.recordLogin("42", "atomcode-cli");
  await stateStore.recordQuota("42", {
    plan: "CodingPlan Lite",
    windows: [{ name: "5h", used: 12, unit: "calls" }],
  });

  const port = await freePort();
  const versionSource = { status: () => ({ version: "5.2.3", source: "manifest" }) };
  const service = startDiagnosticsService({
    port,
    stateStore,
    versionSource,
    locale: "en",
    config: { locale: "en", diagnosticsPort: port, autoClaim: true, autoVersion: false },
    selfCheckConfig: { clientVersion: "5.2.3", masterKeyHex: MASTER_KEY_HEX },
  });
  try {
    assert.equal(await service.ready, service);
    assert.equal(startDiagnosticsService({ port }), service);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const policy = page.headers.get("content-security-policy");
    const loopback = `http://127.0.0.1:${port} http://localhost:${port}`;
    for (const directive of ["style-src", "script-src", "img-src", "connect-src"]) {
      assert.ok(
        policy.includes(`${directive} 'self' ${loopback}`),
        `${directive} names both loopback origins: ${policy}`,
      );
    }
    assert.ok(
      policy.includes(
        "frame-ancestors 'self' wails://localhost http://wails.localhost",
      ),
      policy,
    );
    const nonceMatch = policy.match(/'nonce-([^']+)'/);
    assert.ok(nonceMatch, `script-src has a nonce: ${policy}`);
    assert.match(nonceMatch[1], /^[A-Za-z0-9+/]+={0,2}$/);
    assert.doesNotMatch(
      policy,
      /frame-ancestors 'none'|'unsafe-inline'|'unsafe-eval'|\*/,
    );
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(
      page.headers.get("cross-origin-resource-policy"),
      "cross-origin",
    );
    const html = await page.text();
    assert.match(html, /name="atomcode-token" content="[a-f0-9]{64}"/);
    assert.ok(html.includes(`<script nonce="${nonceMatch[1]}" src="./app.js"></script>`));
    assert.doesNotMatch(html, /\{\{CSP_NONCE\}\}/);
    assert.match(html, /Read-only/);
    assert.match(html, /<html lang="en" data-theme="">/);
    assert.match(html, /href="\.\/icon\.svg"/);
    assert.match(html, /href="\.\/app\.css"/);
    assert.match(html, /src="\.\/app\.js"/);
    assert.doesNotMatch(html, /person@example\.com|Bearer/);

    // Every reference stays relative, so the same page works at the origin root
    // and behind a reverse proxy that mounts it under a prefix.
    const proxyBase = `http://127.0.0.1:${port}/plugins/atomcode/`;
    for (const [, reference] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      assert.ok(!reference.startsWith("/"), `${reference} must stay relative`);
      assert.ok(
        new URL(reference, proxyBase).pathname.startsWith("/plugins/atomcode/"),
        `${reference} resolves under the proxy prefix`,
      );
    }
    assert.equal(
      new URL("api/state", proxyBase).pathname,
      "/plugins/atomcode/api/state",
    );

    const css = await fetch(`http://127.0.0.1:${port}/app.css`);
    assert.equal(css.status, 200);
    assert.equal(
      css.headers.get("cross-origin-resource-policy"),
      "cross-origin",
    );
    assert.match(await css.text(), /--accent/);
    const app = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(app.status, 200);
    assert.equal(
      app.headers.get("cross-origin-resource-policy"),
      "cross-origin",
    );
    const script = await app.text();
    assert.match(script, /api\("api\/state"\)/);
    assert.match(script, /api\("api\/self-check"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/icon.svg`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/missing`)).status, 404);

    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 403);

    const statePreflight = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "GET",
        "access-control-request-headers": DIAGNOSTICS_TOKEN_HEADER,
      },
    });
    assert.equal(statePreflight.status, 204);
    assert.equal(statePreflight.headers.get("access-control-allow-origin"), "null");
    assert.match(statePreflight.headers.get("access-control-allow-methods"), /GET/);
    assert.equal(
      statePreflight.headers.get("access-control-allow-headers"),
      DIAGNOSTICS_TOKEN_HEADER,
    );
    assert.match(statePreflight.headers.get("vary"), /Origin/i);

    const checkPreflight = await fetch(
      `http://127.0.0.1:${port}/api/self-check`,
      {
        method: "OPTIONS",
        headers: {
          origin: `http://127.0.0.1:${port}`,
          "access-control-request-method": "POST",
          "access-control-request-headers": DIAGNOSTICS_TOKEN_HEADER,
        },
      },
    );
    assert.equal(checkPreflight.status, 204);
    assert.equal(
      checkPreflight.headers.get("access-control-allow-origin"),
      `http://127.0.0.1:${port}`,
    );
    assert.match(
      checkPreflight.headers.get("access-control-allow-methods"),
      /POST/,
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/state`, {
        method: "OPTIONS",
        headers: {
          origin: "http://evil.example",
          "access-control-request-method": "GET",
        },
      })).status,
      403,
    );

    const state = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: {
        [DIAGNOSTICS_TOKEN_HEADER]: service.token,
        origin: "null",
      },
    });
    assert.equal(state.status, 200);
    assert.equal(state.headers.get("access-control-allow-origin"), "null");
    assert.match(state.headers.get("vary"), /Origin/i);
    assert.doesNotMatch(state.headers.get("access-control-allow-origin"), /\*/);
    const snapshot = await state.json();
    assert.equal(snapshot.account.loginSource, "atomcode-cli");
    assert.equal(snapshot.quota.plan, "CodingPlan Lite");
    assert.equal(snapshot.config.autoVersion, false);

    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: {
          [DIAGNOSTICS_TOKEN_HEADER]: service.token,
          origin: "http://evil.example",
        },
      })).status,
      403,
    );

    const wrongOrigin = await fetch(`http://127.0.0.1:${port}/api/self-check`, {
      method: "POST",
      headers: {
        [DIAGNOSTICS_TOKEN_HEADER]: service.token,
        origin: "http://evil.example",
      },
    });
    assert.equal(wrongOrigin.status, 403);

    const checked = await fetch(`http://127.0.0.1:${port}/api/self-check`, {
      method: "POST",
      headers: {
        [DIAGNOSTICS_TOKEN_HEADER]: service.token,
        origin: `http://127.0.0.1:${port}`,
      },
    });
    assert.equal(checked.status, 200);
    assert.equal(
      checked.headers.get("access-control-allow-origin"),
      `http://127.0.0.1:${port}`,
    );
    assert.equal((await checked.json()).ok, true);
    const stateAfterCheck = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: {
        [DIAGNOSTICS_TOKEN_HEADER]: service.token,
        origin: "null",
      },
    });
    assert.equal(stateAfterCheck.status, 200);
    assert.equal((await stateAfterCheck.json()).selfCheck.ok, true);

    const withBody = await fetch(`http://127.0.0.1:${port}/api/self-check`, {
      method: "POST",
      body: "{}",
      headers: {
        [DIAGNOSTICS_TOKEN_HEADER]: service.token,
        origin: `http://127.0.0.1:${port}`,
      },
    });
    assert.equal(withBody.status, 400);

    const forbiddenHost = await rawRequest(port, "/", {
      headers: { host: `evil.example:${port}` },
    });
    assert.equal(forbiddenHost.status, 403);

    const localized = await fetch(
      `http://127.0.0.1:${port}/?lang=zh-CN&theme=dark`,
    );
    assert.equal(localized.status, 200);
    assert.match(await localized.text(), /<html lang="zh" data-theme="dark">/);
    const localizedPolicy = localized.headers.get("content-security-policy");
    assert.notEqual(localizedPolicy, policy);
  } finally {
    await service.stop();
  }
});

test("a foreign listener fails with an actionable port-conflict error", async () => {
  const port = await freePort();
  const blocker = createServer((_req, res) => res.end("blocked"));
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  const service = startDiagnosticsService({ port });
  try {
    await assert.rejects(
      service.ready,
      (error) =>
        error.code === "EADDRINUSE" &&
        new RegExp(`127\\.0\\.0\\.1:${port}`).test(error.message),
    );
  } finally {
    await service.stop();
    await new Promise((resolve) => blocker.close(resolve));
  }
});
