import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTitle } from "../src/session-titles.ts";
import { getSession, keyFor, listSessions, recordSession } from "../src/store.ts";

let root: string;
let codexHome: string;
let previousHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "magpie-cam-titles-"));
  codexHome = join(root, "codex");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(join(codexHome, "session_index.jsonl"), [
    JSON.stringify({ id: "thread-test", thread_name: "原始标题", updated_at: "2026-01-01" }),
    JSON.stringify({ id: "thread-test", thread_name: "重命名标题", updated_at: "2026-01-02" }),
  ].join("\n") + "\n");
  previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe("session titles", () => {
  test("uses the latest Codex title instead of a hash or old fallback", () => {
    expect(sessionTitle("codex", "thread-test", "first user query").title).toBe("重命名标题");
    const key = keyFor("codex", "thread-test");
    recordSession(root, { key, platform: "codex", named: "thread-test", protocol: "responses", model: "m", title: "first user query", titleSource: "query" });
    expect(listSessions(root)[0].title).toBe("重命名标题");
    expect(getSession(root, key)?.title).toBe("重命名标题");
  });

  test("uses a concise first user message when no original title exists", () => {
    expect(sessionTitle("codex", "missing", "  first\n user message  ").title).toBe("first user message");
    expect(sessionTitle("claude", "missing", "hello world").titleSource).toBe("query");
    expect(sessionTitle("claude", "missing", "").title).toBeNull();
  });
});
