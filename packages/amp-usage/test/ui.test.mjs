import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const scope = {};
new Function("globalThis", await read("../ui/words.js"))(scope);
const { words, error } = scope.AmpUsage;

test("every error code the service can send reads in each language", async () => {
  // The codes as the service writes them: fail("…"), errors.push("…") and
  // the server's { code: "…" }; plus the page's own two.
  const codes = new Set(["unreachable", "unexpected"]);
  for (const f of await readdir(new URL("../lib/", import.meta.url))) {
    const src = await read(`../lib/${f}`);
    for (const re of [
      /\bfail\(\s*"(\w+)"/g,
      /errors\.push\("(\w+)"\)/g,
      /\bcode: "(\w+)"/g,
    ])
      for (const m of src.matchAll(re)) codes.add(m[1]);
  }
  for (const c of [
    "ampFailed",
    "localDirMissing",
    "magpieRefused",
    "reconnect",
  ])
    assert.ok(codes.has(c), `the scan above no longer finds ${c}`);
  for (const lang of ["en", "zh"])
    for (const c of codes) {
      assert.equal(typeof words[lang].err[c], "string", `${lang}: ${c}`);
      assert.equal(error(words[lang], c), words[lang].err[c]);
    }
  assert.deepEqual(
    Object.keys(words.zh.err).sort(),
    Object.keys(words.en.err).sort(),
  );
});

test("an unknown code reads as the generic message, never as the code", () => {
  for (const lang of ["en", "zh"])
    assert.equal(
      error(words[lang], "fromANewerService"),
      words[lang].err.unexpected,
    );
});

test("the page loads its words before its script", async () => {
  const html = await read("../ui/index.html");
  assert.ok(html.indexOf('src="words.js"') < html.indexOf('src="app.js"'));
});
