// 构建脚本：Bun.build 两次 + 复制静态页。
// - src/plugin.ts → dist/plugin.js（target bun，宿主加载入口）
// - web/app.ts   → dist/ui/app.js（target browser，界面逻辑）
// - web/index.html、web/style.css → dist/ui/（服务从 dist/ui 提供静态资源）
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** 从包根构建全部产物；默认写回 dist/，测试用 outDir 构建到临时目录做一致性比对 */
export async function buildAll(
  root: string = resolve(import.meta.dir, ".."),
  outDir: string = resolve(root, "dist"),
): Promise<void> {
  const dist = resolve(outDir);
  await rm(dist, { recursive: true, force: true });
  await mkdir(resolve(dist, "ui"), { recursive: true });
  // Bun 产物里的源文件注释相对当前工作目录：固定以包根为 cwd，从仓库根或别处调用都得到同一份输出
  const prev = process.cwd();
  process.chdir(resolve(root));
  try {
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
  } finally {
    process.chdir(prev);
  }
  await cp(resolve(root, "web/index.html"), resolve(dist, "ui/index.html"));
  await cp(resolve(root, "web/style.css"), resolve(dist, "ui/style.css"));
}

if (import.meta.main) await buildAll();
