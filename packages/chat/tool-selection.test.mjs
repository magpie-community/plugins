import { expect, test } from "bun:test";
import { selectTools } from "./lib/tool-selection.mjs";

const tool = (name, description) => ({name: `example_${name}`, rawName: name, description});
const historical = tool("get_historical_patent", "查询企业历史专利信息");
const current = tool("get_current_patent", "查询企业当前专利信息");
const catalog = [...Array.from({length: 184}, (_, i) => tool(`get_record_${i}`, "查询企业基本信息")), current, historical];

test("unspaced Chinese recalls historical tools from a 186 tool catalog", () => {
  const selected = selectTools(catalog, "请查询示例科技股份有限公司的历史专利");
  expect(selected[0]).toBe(historical);
  expect(selected.length).toBeLessThanOrEqual(12);
});
test("current and historical requests rank differently", () => {
  expect(selectTools(catalog, "查询企业当前专利")[0]).toBe(current);
});
test("explicit raw identifier wins over boilerplate", () => {
  expect(selectTools(catalog, "只调用 get_historical_patent 查询企业基本信息")[0]).toBe(historical);
});
test("English keywords still select matching tools", () => {
  const wanted = tool("search_issues", "Search project issues");
  expect(selectTools([...catalog, wanted], "search project issues")[0]).toBe(wanted);
});
test("empty query preserves bounded fallback without duplicate tools", () => {
  const selected = selectTools(catalog, "");
  expect(selected.length).toBe(8);
  expect(new Set(selected).size).toBe(selected.length);
  expect(selectTools([], "历史专利")).toEqual([]);
});

// Adversarial fixtures: each assertion fails if its scoring rule is removed.
test("exact identifier outranks a description matching more query terms", () => {
  const exact = tool("get-patent", "Read patents");
  const distractor = tool("search_records", "get-patent company historical records");
  expect(selectTools([distractor, exact], "get-patent company historical records", 1)).toEqual([exact]);
});
test("rare term outranks two widespread boilerplate terms", () => {
  const common = Array.from({length: 30}, (_, i) => tool(`get_common_${i}`, "company records"));
  const rare = tool("get_special", "patent");
  expect(selectTools([...common, rare], "company records patent", 1)).toEqual([rare]);
});
