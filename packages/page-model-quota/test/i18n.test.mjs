import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..");
const read = (file) => readFileSync(join(dir, file), "utf8");

// 报表里只放语言无关的值，词由页面按语言给出。中文出现在报表里，
// 英文页面就会显示中文。
test("the report carries no prose for the page to print", () => {
  const source = read("lib/report.mjs");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  const literals = [...code.matchAll(/"([^"\\\n]*[\u4e00-\u9fff][^"\\\n]*)"/g)].map((m) => m[1]);
  // 只有识别窗口名字用的正则里允许中文，字符串字面量一个都不该有。
  assert.deepEqual(literals, []);
});

test("an unassigned model and an account with no user have no words in them", () => {
  const source = read("lib/report.mjs");
  assert.match(source, /addModel\(models, "", tokens, poolKey, ""\)/);
  assert.doesNotMatch(source, /未分模型/);
  assert.doesNotMatch(source, /无账号/);
  assert.match(source, /group\.user \? `\$\{group\.provider\}\/\$\{group\.user\}·\$\{p\.label\}` : `\$\{group\.provider\}·\$\{p\.label\}`/);
});

test("the low-confidence word brings its own brackets", () => {
  const app = read("ui/app.js");
  assert.match(app, /historical: "\(from past rounds\)"/);
  assert.match(app, /historical: "（按历史轮次估）"/);
  assert.match(app, /fmtTokens\(pool\.tokens\) \+ t\.historical/);
  assert.doesNotMatch(app, /"（" \+ t\.historical/);
});

test("the page declares its own language", () => {
  const app = read("ui/app.js");
  assert.match(app, /document\.documentElement\.lang = lang === "zh" \? "zh-CN" : "en"/);
});
