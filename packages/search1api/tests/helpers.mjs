import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "magpie-search1api-test-"));
  const calls = [];
  const state = {
    refreshes: 0,
    grants: 0,
    decline: false,
    rejectRefresh: false,
    rejectAccess: false,
    refreshDelay: 0,
  };
  let registration;
  let authorization;
  let baseUrl;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const json = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    calls.push({
      path: url.pathname,
      method: req.method,
      headers: req.headers,
      raw,
    });
    if (url.pathname === "/.well-known/oauth-protected-resource")
      return json({ authorization_servers: [baseUrl] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/register") {
      registration = JSON.parse(raw);
      return json({
        client_id: "test-public-client",
        token_endpoint_auth_method: "none",
      });
    }
    if (url.pathname === "/authorize") {
      authorization = url;
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("state", url.searchParams.get("state"));
      redirect.searchParams.set("iss", baseUrl);
      redirect.searchParams.set(
        state.decline ? "error" : "code",
        state.decline ? "access_denied" : "test-authorization-code",
      );
      res.writeHead(302, { location: redirect.href }).end();
      return;
    }
    if (url.pathname === "/token") {
      if (form.get("grant_type") === "authorization_code") {
        if (
          form.get("client_id") !== "test-public-client" ||
          form.get("code") !== "test-authorization-code" ||
          form.get("redirect_uri") !== registration.redirect_uris[0] ||
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") !==
            authorization.searchParams.get("code_challenge")
        ) {
          return json({ error: "invalid_grant" }, 400);
        }
        state.grants++;
        return json({
          access_token: "test-access-0",
          refresh_token: "test-refresh-0",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (state.refreshDelay)
        await new Promise((r) => setTimeout(r, state.refreshDelay));
      if (
        state.rejectRefresh ||
        form.get("client_id") !== "test-public-client" ||
        form.get("refresh_token") !== `test-refresh-${state.refreshes}`
      ) {
        return json(
          { error: "invalid_grant", private: "must-not-appear-in-errors" },
          400,
        );
      }
      state.refreshes++;
      return json({
        access_token: `test-access-${state.refreshes}`,
        refresh_token: `test-refresh-${state.refreshes}`,
        expires_in: 3600,
      });
    }
    if (
      state.rejectAccess &&
      req.headers.authorization === "Bearer test-access-0"
    )
      return json({ message: "expired" }, 401);
    return json({
      query: "fixture",
      intent: { sources: ["github"], time_range: "week" },
      results: [
        {
          title: "Example",
          link: "https://example.com",
          snippet: "Result",
          published_date: "2026-10-23",
          source: "github",
          relevance: 0.9,
          metadata: { stars: 0 },
        },
      ],
      errors: [],
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const authPath = join(directory, "plugin-auth.json");
  const readAuth = async () => {
    try {
      return JSON.parse(await readFile(authPath, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  };
  const save = async (auth) => {
    const all = await readAuth();
    all.search1api = auth;
    await writeFile(authPath, JSON.stringify(all), { mode: 0o600 });
  };
  const input = {
    directory,
    client: {
      auth: {
        set: async ({ path, body }) => {
          const all = await readAuth();
          all[path.id] = body;
          await writeFile(authPath, JSON.stringify(all), { mode: 0o600 });
          return { data: true };
        },
      },
    },
  };
  return {
    directory,
    input,
    calls,
    state,
    baseUrl,
    authPath,
    save,
    readAuth,
    oauth: () => ({
      type: "oauth",
      access: "test-access-0",
      refresh: "test-refresh-0",
      expires: Date.now() + 3600_000,
      clientId: "test-public-client",
      tokenEndpoint: `${baseUrl}/token`,
      issuer: baseUrl,
    }),
  };
}

export const context = (signal) => ({
  sessionID: "test",
  messageID: "test",
  agent: "test",
  directory: "",
  worktree: "",
  abort: signal ?? new AbortController().signal,
  metadata() {},
  async ask() {},
});
