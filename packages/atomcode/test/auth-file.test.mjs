import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAuthFile,
  renderAuthFile,
  readAuthFile,
  resolveAuthFilePath,
  writeAuthFile,
} from "../auth-file.mjs";

const SAMPLE = `# AtomCode credentials
access_token = "access-old"
refresh_token = "refresh-old"
created_at = 1700000000
expires_in = 3600
future_field = "keep-me"

[user]
id = 42
username = "alice"
name = "Alice"
email = "alice@example.com"
avatar_url = "https://example.com/a.png"
`;

test("parseAuthFile maps the CLI file without exposing raw text", () => {
  const auth = parseAuthFile(SAMPLE);
  assert.equal(auth.access, "access-old");
  assert.equal(auth.refresh, "refresh-old");
  assert.equal(auth.uid, "42");
  assert.equal(auth.accountId, "alice@example.com");
  assert.equal(auth.name, "Alice");
  assert.equal(auth.expires, 1700003600_000);
});

test("resolveAuthFilePath expands only the current user's home and absolute paths", () => {
  const env = { HOME: "/home/alice" };
  assert.equal(
    resolveAuthFilePath(undefined, env),
    "/home/alice/.atomcode/auth.toml",
  );
  assert.equal(resolveAuthFilePath("", env), "/home/alice/.atomcode/auth.toml");
  assert.equal(resolveAuthFilePath("~", env), "/home/alice");
  assert.equal(
    resolveAuthFilePath("~/.atomcode/custom.toml", env),
    "/home/alice/.atomcode/custom.toml",
  );
  assert.equal(
    resolveAuthFilePath("/var/lib/atomcode/auth.toml", env),
    "/var/lib/atomcode/auth.toml",
  );
});

test("resolveAuthFilePath rejects relative, NUL, oversized and other-user paths", () => {
  const env = { HOME: "/home/alice" };
  assert.throws(() => resolveAuthFilePath("auth.toml", env), /absolute/);
  assert.throws(() => resolveAuthFilePath("~bob/auth.toml", env), /another-user/);
  assert.throws(() => resolveAuthFilePath("~/a\0b", env), /NUL/);
  assert.throws(() => resolveAuthFilePath(`~/${"a".repeat(4096)}`, env), /too long/);
});

test("renderAuthFile updates only credential fields and preserves unknown content", () => {
  const rendered = renderAuthFile(SAMPLE, {
    access: "access-new",
    refresh: "refresh-new",
    expiresIn: 7200,
    createdAt: 1800000000,
    user: { id: 42, name: "Alice 2" },
  });
  assert.match(rendered, /# AtomCode credentials/);
  assert.match(rendered, /future_field = "keep-me"/);
  assert.match(rendered, /access_token = "access-new"/);
  assert.match(rendered, /refresh_token = "refresh-new"/);
  assert.match(rendered, /created_at = 1800000000/);
  assert.match(rendered, /expires_in = 7200/);
  assert.match(rendered, /name = "Alice 2"/);
  assert.match(rendered, /email = "alice@example.com"/);
});

test("auth.toml parser tolerates CLI scalar quoting and adds a missing user section", () => {
  const text = `access_token = "access\\q"
refresh_token = 'refresh-single'
created_at = "1700000000"
expires_in = "3600"
[user]
id = "42"
`;
  const auth = parseAuthFile(text);
  assert.equal(auth.access, "access\\q");
  assert.equal(auth.refresh, "refresh-single");
  assert.equal(auth.uid, "42");

  const rendered = renderAuthFile('access_token = "old"\n', {
    access: "new",
    refresh: "refresh",
    createdAt: 1700000000,
    expiresIn: 3600,
    user: { id: 42, name: "Alice" },
  });
  assert.match(rendered, /\[user\]/);
  assert.match(rendered, /id = 42/);
  assert.match(rendered, /name = "Alice"/);
});

test("readAuthFile and writeAuthFile use private permissions and atomic replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomcode-auth-"));
  const file = join(dir, "auth.toml");
  await writeFile(file, SAMPLE, { mode: 0o600 });

  const before = await readAuthFile(file);
  assert.equal(before.refresh, "refresh-old");

  await writeAuthFile(file, {
    access: "access-new",
    refresh: "refresh-new",
    expiresIn: 60,
    user: { id: 42, username: "alice" },
  });
  const text = await readFile(file, "utf8");
  assert.match(text, /access_token = "access-new"/);
  assert.match(text, /future_field = "keep-me"/);
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test("readAuthFile rejects symlinks, loose permissions, and account-less files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomcode-auth-"));
  const real = join(dir, "real.toml");
  const link = join(dir, "link.toml");
  await writeFile(real, SAMPLE, { mode: 0o600 });
  await symlink(real, link);
  await assert.rejects(() => readAuthFile(link), /regular file|symlink/i);

  if (process.platform !== "win32") {
    await chmod(real, 0o644);
    await assert.rejects(() => readAuthFile(real), /0600|permissions/i);
    await chmod(real, 0o600);
  }

  const noUser = join(dir, "no-user.toml");
  await writeFile(noUser, 'access_token = "a"\n', { mode: 0o600 });
  await assert.rejects(() => readAuthFile(noUser), /user id/i);
  await assert.rejects(
    () => readAuthFile(join(dir, "missing.toml")),
    /not signed in/i,
  );
  await assert.rejects(
    () =>
      writeAuthFile(real, {
        access: "",
        expiresIn: 0,
      }),
    /incomplete.*credentials/i,
  );
});
