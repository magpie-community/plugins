// 构建脚本：Bun.build 两次 + 复制静态页。
// - src/plugin.ts → dist/plugin.js（target bun，宿主加载入口）
// - web/app.ts   → dist/ui/app.js（target browser，界面逻辑）
// - web/index.html、web/style.css → dist/ui/（服务从 dist/ui 提供静态资源）
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** 从包根构建全部产物；测试与服务端 beforeAll 也复用入口 */
export async function buildAll(root: string = resolve(import.meta.dir, "..")): Promise<void> {
  const dist = resolve(root, "dist");
  await rm(dist, { recursive: true, force: true });
  await mkdir(resolve(dist, "ui"), { recursive: true });
  await Bun.build({
    entrypoints: [resolve(root, "src/plugin.ts")],
    outdir: dist,
    target: "bun",
  });
  await Bun.build({
    entrypoints: [resolve(root, "web/app.ts")],
    outdir: resolve(dist, "ui"),
    target: "browser",
  });
  await cp(resolve(root, "web/index.html"), resolve(dist, "ui/index.html"));
  await cp(resolve(root, "web/style.css"), resolve(dist, "ui/style.css"));
}

if (import.meta.main) await buildAll();
