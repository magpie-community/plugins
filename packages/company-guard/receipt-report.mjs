#!/usr/bin/env node
import {getReceiptReport} from "./src/receipt-report.mjs";
import {stateRoot} from "./src/grant-store.mjs";
const arg = key => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined;
const result = await getReceiptReport({day:arg("--date"),root:stateRoot(arg("--state-dir")),task:arg("--task"),appLog:arg("--app-log")});
result.rows = result.rows.slice(0,Math.max(1,Math.min(100,Number(arg("--limit")) || 20)));
const rows = result.rows;
if (process.argv.includes("--json")) console.log(JSON.stringify(result,null,2));
else {
  console.log("| 时间（北京时间） | 任务 | 请求编号 | 状态 | 名称 / 替换处数 | 已还原名称 | 本地处理 ms |\n|---|---|---|---|---|---|---|");
  for(const r of rows) console.log(`| ${new Date(r.at).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai"})} | ${r.task || "未知"} | ${r.id} | ${r.statusLabel || r.status} | ${r.replacedNames ?? "?"} / ${r.replacements ?? "?"} | ${r.restoredNames ?? "?"} | ${r.processingMs ?? "?"} |`);
  if (!rows.length) console.log("\n没有匹配的回执，不能据此判断请求已受保护。");
  console.log("\n"+result.limits.join("；")+"。");
}
