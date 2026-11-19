#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import {
  dataDir,
  readConfig,
  saveConfig,
  defaults,
  atomicWrite,
  withLock,
} from "./config.js";
import { setToken, resolveToken } from "./credentials.js";
import { readUsage } from "./usage.js";
import { renderCard, readmeSnippet } from "./renderer.js";
import { sync, readState, localDate } from "./sync.js";
import { startServer } from "./server.js";
import {
  installSchedule,
  uninstallSchedule,
  scheduleFiles,
} from "./scheduler.js";
import type { Stats } from "./types.js";
import { GitHub } from "./github.js";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    out: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    period: { type: "string" },
    "credential-source": { type: "string" },
    due: { type: "boolean" },
    stdin: { type: "boolean" },
    port: { type: "string" },
    file: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.home) process.env.MAGPIE_STATS_HOME = resolve(values.home);
async function main() {
  const cmd = positionals[0] || "help",
    dir = dataDir();
  if (values.help || cmd === "help") {
    console.log(
      `Magpie GitHub Stats\n\n  serve [--port 3498]     打开本地设置服务\n  render [--out DIR]      从真实 Magpie 用量生成深浅 SVG\n  sync [--due]            上传卡片；--due 仅执行到期的每日任务\n  configure --repo owner/repo [--branch main] [--credential-source keychain|github-cli]\n  configure --file FILE  导入非敏感 JSON 配置\n  auth --stdin            从标准输入保存 PAT 到系统凭据库\n  schedule install|remove|show\n  status                  查看上次同步结果\n  readme                  输出 README HTML\n  demo [--out DIR]         生成明确标为示例的数据卡片\n\n所有命令支持 --home DIR 隔离配置。Token 不接受命令行参数。`,
    );
    return;
  }
  if (cmd === "serve") {
    const service = await startServer({
      dir,
      port: Number(values.port) || 3498,
    });
    console.log(`设置页面：${service.url}`);
    return;
  }
  if (cmd === "status") {
    console.log(JSON.stringify(await readState(dir), null, 2));
    return;
  }
  if (cmd === "auth") {
    if (!values.stdin)
      throw new Error("请使用 auth --stdin，通过标准输入提供 Token。");
    let input = "";
    for await (const part of process.stdin) {
      input += part;
      if (input.length > 1024) throw new Error("Token 过长。");
    }
    await setToken(input.trim(), dir);
    console.log("Token 已保存到系统凭据库。");
    return;
  }
  if (cmd === "configure") {
    let c = await readConfig(dir);
    if (values.file)
      c = { ...c, ...JSON.parse(await readFile(resolve(values.file), "utf8")) };
    if (values.repo) c.repository = values.repo;
    if (values.branch !== undefined) c.branch = values.branch;
    if (values.period) c.period = values.period as typeof c.period;
    if (values["credential-source"])
      c.credentialSource = values[
        "credential-source"
      ] as typeof c.credentialSource;
    await withLock(dir, () => saveConfig(c, dir));
    console.log("配置已保存；请使用 schedule install 开启自动同步。");
    return;
  }
  if (cmd === "schedule") {
    if (positionals[1] === "show") {
      console.log(
        JSON.stringify(scheduleFiles(process.platform, dir), null, 2),
      );
      return;
    }
    await withLock(dir, async () => {
      const c = await readConfig(dir);
      if (positionals[1] === "install") {
        if (!c.repository) throw new Error("请先配置 GitHub 仓库和凭据。");
        await saveConfig({ ...c, daily: true }, dir);
        try {
          await installSchedule(dir);
        } catch (e) {
          await saveConfig(c, dir);
          throw e;
        }
      } else if (positionals[1] === "remove") {
        await uninstallSchedule(dir);
        await saveConfig({ ...c, daily: false }, dir);
      } else throw new Error("请指定 schedule install、remove 或 show。");
    });
    console.log("调度设置已更新。");
    return;
  }
  if (cmd === "sync") {
    const result = await sync(dir, values.due);
    if (result.result !== "skipped") console.log(JSON.stringify(result));
    return;
  }
  if (cmd === "readme") {
    const c = await readConfig(dir);
    const branch =
      c.branch ||
      (c.repository
        ? (await new GitHub(await resolveToken(c, dir)).repository(c)).branch
        : "main");
    console.log(readmeSnippet(c, branch));
    return;
  }
  if (cmd === "render" || cmd === "demo") {
    const c = cmd === "demo" ? { ...defaults } : await readConfig(dir);
    let s: Stats;
    if (cmd === "demo") {
      const history = Array.from({ length: 365 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 10, 18) - (364 - i) * 86400000)
          .toISOString()
          .slice(0, 10),
        requests:
          i < 240 ? 0 : Math.round((i - 230) * 3 * Math.sin(i * 0.8) ** 2),
        tokens: i < 240 ? 0 : Math.round(400000 * Math.sin(i * 0.8) ** 2),
        cost: i < 240 ? 0 : +(15 * Math.sin(i * 0.8) ** 2).toFixed(2),
      }));
      const days = history.slice(-30);
      const total = days.reduce((n, d) => n + d.tokens, 0);
      s = {
        period: "30d",
        since: days[0]!.date,
        requests: days.reduce((n, d) => n + d.requests, 0),
        tokens: total,
        activeDays: history.filter((d) => d.requests > 0).length,
        estimatedCost: days.reduce((n, d) => n + d.cost, 0),
        unpriced: 0,
        days,
        heatmap: { asOf: "2026-11-18", days: history },
        models: [
          { name: "Claude Sonnet", requests: 100, tokens: total * 0.48 },
          { name: "GPT", requests: 100, tokens: total * 0.32 },
          { name: "Gemini", requests: 100, tokens: total * 0.2 },
        ],
      };
    } else s = await readUsage(c);
    const out = resolve(values.out || join(dir, "cards"));
    await mkdir(out, { recursive: true });
    for (const mode of ["light", "dark"] as const)
      await atomicWrite(
        join(out, `magpie-${mode}.svg`),
        renderCard(s, c, mode, cmd === "demo" ? "DEMO DATA" : localDate()),
      );
    console.log(
      `已生成 ${out}/magpie-{light,dark}.svg${cmd === "demo" ? "（示例数据）" : ""}`,
    );
    return;
  }
  throw new Error("未知命令，运行 --help 查看用法。");
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "操作失败。");
  process.exitCode = 1;
});
