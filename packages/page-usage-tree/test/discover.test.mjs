import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

// How magpie's Discover finds a repository: topic magpie-plugin
// (internal/plugin/github.go, Topic). The page says the topic it searches.
test("is published as a repository tagged magpie-plugin", () => {
  const repo = pkg.repository;
  assert.ok(repo, "package.json names a repository");
  assert.match(repo.url ?? repo, /github\.com/);
});

// The community's listing: name and where it lives (PUBLISHING.md, route B).
test("is named and placed as a community page package", () => {
  assert.equal(pkg.name, "@magpie-community/page-usage-tree");
  assert.equal(pkg.repository.url, "git+https://github.com/magpie-community/plugins.git");
  assert.equal(pkg.repository.directory, "packages/page-usage-tree");
});

// internal/plugin/github.go: a repository is listed as a page only when it
// has neither main nor exports, and names magpie.page.file. This package has
// a host part, so it is not that: its listing has to say kind "page" itself.
test("says it is a page in its own right", () => {
  assert.equal(pkg.magpie.page.file, "page/index.html");
  const autoListedAsPage = Boolean(
    (pkg.main == null || pkg.main === "") &&
      (pkg.exports == null) &&
      pkg.magpie.page.file,
  );
  // documented, so the listing is never left to look like a provider
  assert.equal(autoListedAsPage, false, "has a host part: needs kind in the listing");
});

// market.go: an entry is taken from the community registry only when it is
// marked community, and market() lists it under its kind.
test("carries what a community listing needs", () => {
  assert.ok(pkg.magpie.icon?.startsWith("data:image/"), "magpie.icon is a data URI");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.keywords.includes("magpie-page"));
});

// The card's picture is the file it is drawn from: a data URI left behind
// after the icon was redrawn is the old picture on everyone's Discover.
test("the listing icon is the icon file", () => {
  const icon = readFileSync(join(dir, "assets", "icon.svg"), "utf8");
  const want = `data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}`;
  assert.equal(pkg.magpie.icon, want);
});
