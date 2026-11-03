#!/usr/bin/env node
/**
 * 钥匙柜 QA 冒烟：功能 / 性能 / 协议 / 稳定性。
 * 不把 secret 打到 stdout。需要本机已有 Magpie Gateway（默认 127.0.0.1:3425）。
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../lib/server.mjs";
import { loadStore } from "../lib/store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const results = [];
function pass(name, detail = "") {
  results.push({ ok: true, name, detail });
  console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
}
function fail(name, detail = "") {
  results.push({ ok: false, name, detail });
  console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
}
function info(msg) {
  console.log(`INFO  ${msg}`);
}

async function extractToken(port) {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const m = html.match(/__MAGPIE_PROJECTS_TOKEN__="([^"]+)"/);
  if (!m) throw new Error("HTML 未注入页面口令");
  return m[1];
}

async function api(port, token, path, opts = {}) {
  const headers = {
    "content-type": "application/json",
    "x-magpie-projects-token": token,
    origin: "null",
    ...(opts.headers || {}),
  };
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, ms: Date.now() - t0, headers: res.headers };
}

async function gatewayProbe(secret, kind) {
  const base = "http://127.0.0.1:3425";
  if (kind === "openai" || kind === "responses") {
    const res = await fetch(base + "/v1/models", {
      headers: { Authorization: "Bearer " + secret, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  }
  if (kind === "anthropic") {
    const res = await fetch(base + "/v1/models", {
      headers: { "x-api-key": secret, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  }
  if (kind === "gemini") {
    // Magpie Gemini 口：优先 x-goog-api-key；Bearer 也应可用
    const res = await fetch(base + "/v1/models", {
      headers: { "x-goog-api-key": secret, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const res2 = await fetch(base + "/v1/models", {
      headers: { Authorization: "Bearer " + secret, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res2.ok, status: res2.status, via: "bearer-fallback" };
  }
  throw new Error("unknown kind");
}

async function main() {
  const port = 3499; // dedicated QA port, don't collide with live 3491
  process.env.MAGPIE_PROJECT_KEYS_PORT = String(port);

  // Ensure port free
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  }).catch(() => {
    throw new Error(`QA 端口 ${port} 已被占用`);
  });

  const started = await startServer({ options: { port } });
  if (started.reused) throw new Error("意外复用了已有监听，QA 结果不可靠");
  info(`service on :${port}`);

  let token = "";
  let tempKeyId = null;
  try {
    // —— 功能：健康 / CORS / 口令 ——
    {
      const t0 = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = await res.json();
      if (res.ok && body.ok) pass("health", `${Date.now() - t0}ms`);
      else fail("health", JSON.stringify(body));
    }
    {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: { origin: "null" },
      });
      const body = await res.json();
      if (res.status === 403) pass("token_required", body.error || "403");
      else fail("token_required", `status ${res.status}`);
    }

    token = await extractToken(port);
    if (token.length >= 32) pass("token_injected", `len=${token.length}`);
    else fail("token_injected", `len=${token.length}`);

    {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-headers": "content-type, x-magpie-projects-token",
        },
      });
      const allow = res.headers.get("access-control-allow-origin");
      if (res.status === 204 && allow === "null") pass("cors_preflight_null_origin");
      else fail("cors_preflight_null_origin", `status=${res.status} allow=${allow}`);
    }

    // —— 性能：首屏路径 ——
    {
      const meta = await api(port, token, "/api/meta");
      const list = await api(port, token, "/api/projects");
      if (meta.status === 200 && list.status === 200 && meta.ms < 3000 && list.ms < 1000) {
        pass("first_paint_meta_projects", `meta=${meta.ms}ms projects=${list.ms}ms n=${list.data.projects?.length ?? 0}`);
      } else {
        fail("first_paint_meta_projects", `meta=${meta.ms} projects=${list.ms} status=${meta.status}/${list.status}`);
      }
      if (Array.isArray(meta.data?.models) && meta.data.models.some((m) => m.id === "")) {
        pass("meta_has_auto_model");
      } else fail("meta_has_auto_model");
    }
    {
      const u1 = await api(port, token, "/api/usage?period=today");
      if (u1.status === 200 && u1.ms <= 1800) {
        pass("usage_soft_timeout", `${u1.ms}ms pending=${Boolean(u1.data.pending)}`);
      } else {
        fail("usage_soft_timeout", `${u1.ms}ms status=${u1.status}`);
      }
      // 等后台填充
      await new Promise((r) => setTimeout(r, 8000));
      const u2 = await api(port, token, "/api/usage?period=today&softMs=0");
      if (u2.status === 200 && !u2.data.pending && u2.ms < 500) {
        pass("usage_cache_hit", `${u2.ms}ms calls=${u2.data.totals?.calls ?? 0}`);
      } else {
        fail("usage_cache_hit", `${u2.ms}ms pending=${u2.data?.pending} err=${u2.data?.error || ""}`);
      }
    }

    // —— 稳定性：并发 ——
    {
      const n = 8;
      const t0 = Date.now();
      const outs = await Promise.all(
        Array.from({ length: n }, () => api(port, token, "/api/projects"))
      );
      const allOk = outs.every((o) => o.status === 200);
      const maxMs = Math.max(...outs.map((o) => o.ms));
      if (allOk) pass("concurrent_projects", `${n} parallel, max=${maxMs}ms wall=${Date.now() - t0}ms`);
      else fail("concurrent_projects", outs.map((o) => o.status).join(","));
    }

    // —— 品牌文案 ——
    {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      if (html.includes("钥匙柜") && !html.includes(">项目管理<")) pass("ui_title_钥匙柜");
      else fail("ui_title_钥匙柜", "页面标题未更新");
      if (html.includes("data-flavor=\"gemini\"") && html.includes("data-flavor=\"responses\"")) {
        pass("ui_all_protocol_tabs");
      } else fail("ui_all_protocol_tabs");
    }

    // —— 协议：用本地已有 secret 探测（不打印） ——
    {
      const store = await loadStore();
      const withSecret = (store.projects || []).find((p) => p.secret && p.secret.startsWith("sk-magpie-key-"));
      if (!withSecret) {
        fail("protocol_probe_skipped", "本地无可用 secret；请先在页内创建/重置一把 Key");
      } else {
        for (const kind of ["openai", "responses", "anthropic", "gemini"]) {
          try {
            const r = await gatewayProbe(withSecret.secret, kind);
            if (r.ok) pass(`protocol_${kind}`, `HTTP ${r.status}${r.via ? " via " + r.via : ""}`);
            else fail(`protocol_${kind}`, `HTTP ${r.status}`);
          } catch (e) {
            fail(`protocol_${kind}`, e.message);
          }
        }
      }
    }

    // —— CRUD：创建 → 列表 → reveal → 删除（真实 Magpie Key） ——
    {
      const slug = "qa-" + randomBytes(3).toString("hex");
      info(`CRUD 尝试创建 project:${slug}`);
      const created = await api(port, token, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "QA Temp", slug, model: "" }),
      });
      if (created.status === 201 && created.data?.project?.secret?.startsWith("sk-magpie-key-")) {
        pass("crud_create", `${created.ms}ms id=${created.data.project.id.slice(0, 8)}…`);
        const id = created.data.project.id;
        tempKeyId = id;
        const listed = await api(port, token, "/api/projects");
        if ((listed.data.projects || []).some((p) => p.id === id)) pass("crud_list_contains");
        else fail("crud_list_contains");

        const revealed = await api(port, token, `/api/projects/${encodeURIComponent(id)}/reveal`, {
          method: "POST",
          body: "{}",
        });
        if (revealed.status === 200 && revealed.data?.secret?.startsWith("sk-magpie-key-")) {
          pass("crud_reveal");
        } else fail("crud_reveal", `status=${revealed.status}`);

        // 协议抽检新建 Key
        try {
          const r = await gatewayProbe(created.data.project.secret, "openai");
          if (r.ok) pass("crud_key_works_openai", `HTTP ${r.status}`);
          else fail("crud_key_works_openai", `HTTP ${r.status}`);
        } catch (e) {
          fail("crud_key_works_openai", e.message);
        }

        const deleted = await api(port, token, `/api/projects/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (deleted.status === 200 && deleted.data?.ok) {
          tempKeyId = null;
          pass("crud_delete", `${deleted.ms}ms`);
        } else fail("crud_delete", `status=${deleted.status} ${deleted.data?.error || ""}`);
      } else {
        fail(
          "crud_create",
          `status=${created.status} err=${created.data?.error || ""} ms=${created.ms}`
        );
        info("CRUD 后续跳过（创建失败时常见原因：magpie CLI 慢/拒绝，或同名 Key）");
      }
    }

    // package title
    {
      const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
      if (pkg.magpie?.page?.titles?.zh === "钥匙柜" && pkg.magpie?.page?.title === "Key Cabinet") {
        pass("package_titles");
      } else fail("package_titles", JSON.stringify(pkg.magpie?.page?.titles));
    }
  } finally {
    // 中途失败也要清掉临时 Key，别在真实 Magpie 里留垃圾。
    if (tempKeyId && token) {
      try {
        const cleanup = await api(port, token, `/api/projects/${encodeURIComponent(tempKeyId)}`, {
          method: "DELETE",
        });
        if (cleanup.status === 200) info("已清理 QA 临时 Key");
      } catch (e) {
        info(`清理 QA 临时 Key 失败：${e.message}`);
      }
    }
    if (started.server) {
      await new Promise((resolve) => started.server.close(resolve));
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n——");
  console.log(`QA ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("QA aborted:", e.message || e);
  process.exitCode = 1;
});
