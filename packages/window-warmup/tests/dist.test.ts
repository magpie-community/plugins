// 入库的 dist/ 必须等于源码构建结果：宿主直接加载它，发布流程也不构建。
// 测试只读已提交的 dist/，构建产物写到临时目录，跑测试不会改写工作区。
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll } from "../scripts/build";

const ROOT = join(import.meta.dir, "..");
const FILES = ["plugin.js", "ui/app.js", "ui/index.html", "ui/style.css"];

test(
  "dist/ 与源码构建结果逐字节一致（不一致就先 bun run build 再提交）",
  async () => {
    const out = await mkdtemp(join(tmpdir(), "ww-dist-"));
    try {
      await buildAll(ROOT, out);
      for (const rel of FILES) {
        const [built, committed] = await Promise.all([
          readFile(join(out, rel)),
          readFile(join(ROOT, "dist", rel)),
        ]);
        expect(built.equals(committed), `dist/${rel} 与构建结果不一致`).toBe(true);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  },
  60_000,
);
