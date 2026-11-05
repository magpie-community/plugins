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
token_type = "Bearer"
created_at = 1700000000
expires_in = 3600
future_field = "keep-me"

[user]
id = "123456"
username = "alice"
name = "Alice"
email = "alice@example.com"
avatar_url = "https://example.com/a.png"
`;

test("parseAuthFile maps the CLI file without exposing raw text", () => {
  const auth = parseAuthFile(SAMPLE);
  assert.equal(auth.access, "access-old");
  assert.equal(auth.refresh, "refresh-old");
  assert.equal(auth.uid, "123456");
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
    user: { id: "123456", name: "Alice 2" },
  });
  assert.match(rendered, /# AtomCode credentials/);
  assert.match(rendered, /future_field = "keep-me"/);
  assert.match(rendered, /token_type = "Bearer"/);
  assert.match(rendered, /access_token = "access-new"/);
  assert.match(rendered, /refresh_token = "refresh-new"/);
  assert.match(rendered, /created_at = 1800000000/);
  assert.match(rendered, /expires_in = 7200/);
  assert.match(rendered, /id = "123456"/);
  assert.doesNotMatch(rendered, /id = 123456/);
  assert.match(rendered, /name = "Alice 2"/);
  assert.match(rendered, /email = "alice@example.com"/);
});

test("auth.toml parser preserves scalar types and appends id as a string", () => {
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
  assert.match(rendered, /id = "42"/);
  assert.match(rendered, /name = "Alice"/);

  const quoted = renderAuthFile(text, {
    access: "next",
    refresh: "next-refresh",
    createdAt: 1800000000,
    expiresIn: 7200,
    user: { id: "42" },
  });
  assert.match(quoted, /created_at = "1800000000"/);
  assert.match(quoted, /expires_in = "7200"/);
  assert.match(quoted, /id = "42"/);
});

test("auth.toml renderer preserves a legacy integer id when rewriting it", () => {
  const rendered = renderAuthFile(
    'access_token = "old"\ncreated_at = 1700000000\nexpires_in = 3600\n[user]\nid = 42\n',
    {
      access: "new",
      createdAt: 1800000000,
      expiresIn: 7200,
      user: { id: "99" },
    },
  );
  assert.match(rendered, /\[user\]\nid = 99/);
  assert.doesNotMatch(rendered, /\[user\]\nid = "99"/);
});

test("auth.toml renderer preserves float and boolean value types", () => {
  const rendered = renderAuthFile(
    'access_token = "old"\ncreated_at = 1.0\nexpires_in = true\n[user]\nid = "42"\n',
    {
      access: "new",
      createdAt: 1800000000,
      expiresIn: false,
      user: { id: "42" },
    },
  );
  assert.match(rendered, /created_at = 1800000000\.0/);
  assert.match(rendered, /expires_in = false/);
});

test("inline comments survive parsing and credential renewal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomcode-comments-"));
  const file = join(dir, "auth.toml");
  const input = `access_token = "old#token" # access
refresh_token = 'old#refresh' # refresh
created_at = 1.0 # time
expires_in = true # duration
[user]
id = "123456" # c
username = "a\\\"#b" # username
name = 'Alice # Smith' # name
`;
  await writeFile(file, input, { mode: 0o600 });
  const before = await readAuthFile(file);
  assert.equal(before.access, "old#token");
  assert.equal(before.refresh, "old#refresh");
  assert.equal(before.uid, "123456");
  assert.equal(before.accountId, 'a"#b');
  assert.equal(before.name, "Alice # Smith");

  await writeAuthFile(file, { access: "new#token", refresh: "new#refresh", createdAt: 2, expiresIn: 60 });
  const text = await readFile(file, "utf8");
  assert.match(text, /^access_token = "new#token" # access$/m);
  assert.match(text, /^refresh_token = "new#refresh" # refresh$/m);
  assert.match(text, /^created_at = 2\.0 # time$/m);
  assert.match(text, /^expires_in = false # duration$/m);
  assert.match(text, /^id = "123456" # c$/m);
  assert.equal((await readAuthFile(file)).uid, "123456");
  const integer = renderAuthFile('access_token = "old"\n[user]\nid = 42  # integer\n', {
    access: "new", user: { id: "99" },
  });
  assert.match(integer, /^id = 99  # integer$/m);
  assert.equal(parseAuthFile('access_token = "a\\\\" # comment\n[user]\nid = "42"\n').access, "a\\");
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
    user: { id: "123456", username: "alice" },
  });
  const text = await readFile(file, "utf8");
  assert.match(text, /access_token = "access-new"/);
  assert.match(text, /token_type = "Bearer"/);
  assert.match(text, /id = "123456"/);
  assert.doesNotMatch(text, /id = 123456/);
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
