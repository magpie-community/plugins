// magpie-files 的单元测试：目录推导、providers.json 读目录（key 指纹）、模型缓存读取。
// 夹具一律放临时目录，绝不读真实用户的 Magpie 配置；夹具里的 key 都是假的（sk-test-…），
// 并断言它们不出现在任何返回值与错误信息里。
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path, { join, posix, win32 } from "node:path";
import { magpieDirs, readKeyDirectory, readModelCache, xdgConfigHome } from "../src/magpie-files";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ww-files-test-"));
  dirs.push(dir);
  return dir;
}

/** 与 magpie internal/provider/keys.go keyID 同一算法：sha256(原文 UTF-8) 前 5 字节的小写 hex */
const fp = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex").slice(0, 10);

// 夹具专用假 key：只存在于测试里，断言它们绝不外泄
const K_GLM = "sk-test-AAAA11";
const K_FREE = "sk-test-BBBB22";
const K_OTHER = "sk-test-CCCC33";
const K_BROKEN = "sk-test-EEEE55";
const ALL_FAKE_KEYS = [K_GLM, K_FREE, K_OTHER, K_BROKEN];

describe("magpieDirs", () => {
  test("安装版（作用域包名）：按安装路径上溯到配置目录，缓存用安装版缓存目录", () => {
    const d = magpieDirs(
      { XDG_CONFIG_HOME: "/tmp/ww-cfg", XDG_CACHE_HOME: "/tmp/ww-cache" },
      "/tmp/ww-cfg/magpie/plugins/node_modules/@magpie-community/page-window-warmup/dist",
      posix,
    );
    expect(d).toEqual({ config: "/tmp/ww-cfg/magpie", cache: "/tmp/ww-cache/magpie" });
  });

  test("安装版（XDG 为空）：回退 ~/.config/magpie 与 ~/.cache/magpie", () => {
    const home = homedir();
    const d = magpieDirs(
      {},
      posix.join(home, ".config", "magpie", "plugins", "node_modules", "@magpie-community", "page-window-warmup", "dist"),
      posix,
    );
    expect(d).toEqual({
      config: posix.join(home, ".config", "magpie"),
      cache: posix.join(home, ".cache", "magpie"),
    });
  });

  test("便携版：配置 = data 目录，缓存 = <data>/cache（XDG 不参与）", () => {
    const d = magpieDirs(
      { XDG_CONFIG_HOME: "/tmp/ww-cfg", XDG_CACHE_HOME: "/tmp/ww-cache" },
      "/data/magpie-portable/plugins/node_modules/@magpie-community/page-window-warmup/dist",
      posix,
    );
    expect(d).toEqual({ config: "/data/magpie-portable", cache: "/data/magpie-portable/cache" });
  });

  test("安装版（win32）：反斜杠与正斜杠混用都能识别", () => {
    const env = { XDG_CONFIG_HOME: "C:\\Users\\me\\cfg", XDG_CACHE_HOME: "C:\\Users\\me\\cache" };
    const back = magpieDirs(
      env,
      "C:\\Users\\me\\cfg\\magpie\\plugins\\node_modules\\@magpie-community\\page-window-warmup\\dist",
      win32,
    );
    expect(back).toEqual({ config: "C:\\Users\\me\\cfg\\magpie", cache: "C:\\Users\\me\\cache\\magpie" });
    const mixed = magpieDirs(
      env,
      "C:/Users/me/cfg/magpie/plugins\\node_modules\\@magpie-community\\page-window-warmup/dist",
      win32,
    );
    expect(mixed).toEqual(back);
  });

  test("便携版（win32）：缓存跟 data 目录走", () => {
    const d = magpieDirs(
      { XDG_CONFIG_HOME: "C:\\Users\\me\\cfg" },
      "D:\\portable\\plugins\\node_modules\\@magpie-community\\page-window-warmup\\dist",
      win32,
    );
    expect(d).toEqual({ config: "D:\\portable", cache: "D:\\portable\\cache" });
  });

  test("旧独立包名（≤0.3.7）的安装路径同样识别，升级后不会读错目录", () => {
    const d = magpieDirs(
      { XDG_CONFIG_HOME: "/tmp/ww-cfg", XDG_CACHE_HOME: "/tmp/ww-cache" },
      "/tmp/ww-cfg/magpie/plugins/node_modules/magpie-window-warmup/dist",
      posix,
    );
    expect(d).toEqual({ config: "/tmp/ww-cfg/magpie", cache: "/tmp/ww-cache/magpie" });
  });

  test("非插件目录：用安装版两个目录", () => {
    const d = magpieDirs(
      { XDG_CONFIG_HOME: "/tmp/ww-cfg", XDG_CACHE_HOME: "/tmp/ww-cache" },
      "/opt/somewhere/else",
      posix,
    );
    expect(d).toEqual({ config: "/tmp/ww-cfg/magpie", cache: "/tmp/ww-cache/magpie" });
  });

  test("xdgConfigHome：插件数据目录与旧包迁移共用，相对路径同样不算数", () => {
    expect(xdgConfigHome({ XDG_CONFIG_HOME: " /tmp/ww-cfg " }, posix)).toBe("/tmp/ww-cfg");
    expect(xdgConfigHome({ XDG_CONFIG_HOME: "relative/cfg" }, posix)).toBe(posix.join(homedir(), ".config"));
    expect(xdgConfigHome({}, posix)).toBe(posix.join(homedir(), ".config"));
  });

  test("XDG 变量是相对路径时不算数（对齐 magpie 的 rooted）", () => {
    const home = homedir();
    const d = magpieDirs(
      { XDG_CONFIG_HOME: "relative/cfg", XDG_CACHE_HOME: "relative/cache" },
      "/opt/somewhere/else",
      posix,
    );
    expect(d).toEqual({
      config: posix.join(home, ".config", "magpie"),
      cache: posix.join(home, ".cache", "magpie"),
    });
  });
});

describe("readKeyDirectory", () => {
  test("列启用的 key（指纹去重），off 的不列，accountModels 与 models 原样带出", async () => {
    const dir = await fixtureDir();
    await writeFile(
      join(dir, "providers.json"),
      JSON.stringify({
        providers: [
          {
            id: "remote-magpie",
            key: K_GLM,
            keyName: "GLM",
            keys: [
              { name: "免费flash", key: K_FREE, off: true },
              { name: "除GLM外其他", key: K_OTHER },
              { name: "重复", key: K_GLM },
            ],
            accountModels: { [fp(K_GLM)]: ["group/glm-5.3"], yang: ["group/glm-5.3"] },
            models: ["group/glm-5.3", "group/glm-5.3-flash"],
          },
          { id: "no-keys", key: "", keyName: "", keys: [] },
        ],
      }),
    );
    const map = await readKeyDirectory(dir);
    expect([...map.keys()].sort()).toEqual(["no-keys", "remote-magpie"]);
    const entry = map.get("remote-magpie")!;
    // 第一把 key + keys[] 里启用的；off 的免费flash 不列；与第一把重复的按指纹合并
    expect(entry.keys).toEqual([
      { fingerprint: fp(K_GLM), name: "GLM" },
      { fingerprint: fp(K_OTHER), name: "除GLM外其他" },
    ]);
    expect(entry.accountModels).toEqual({ [fp(K_GLM)]: ["group/glm-5.3"], yang: ["group/glm-5.3"] });
    // chosen 启用清单（models 字段）：模型被路由组藏出 /v1/models 时的兜底来源
    expect(entry.models).toEqual(["group/glm-5.3", "group/glm-5.3-flash"]);
    expect(map.get("no-keys")).toEqual({ keys: [], accountModels: {}, models: [] });

    // 红线：key 原文不出现在任何返回值里
    const serialized = JSON.stringify([...map.entries()]);
    for (const key of ALL_FAKE_KEYS) expect(serialized).not.toContain(key);
  });

  test("文件不存在 → 空 Map", async () => {
    const dir = await fixtureDir();
    const map = await readKeyDirectory(dir);
    expect(map.size).toBe(0);
  });

  test("损坏文件 → 抛固定文案，错误信息不含 key 原文", async () => {
    const dir = await fixtureDir();
    await writeFile(
      join(dir, "providers.json"),
      `{"providers":[{"id":"p","key":"${K_BROKEN}","keyNa`,
    );
    let message = "";
    try {
      await readKeyDirectory(dir);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe("Magpie 的供应商配置文件读不出来");
    for (const key of ALL_FAKE_KEYS) expect(message).not.toContain(key);
  });
});

describe("readModelCache", () => {
  test("正常读取：ID 与 Keys（缺省为空）", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, "models"), { recursive: true });
    await writeFile(
      join(dir, "models", "remote-magpie.json"),
      JSON.stringify({
        fetched: "2026-11-01T00:00:00Z",
        base: "https://x.test",
        models: [
          { ID: "group/glm-5.3", Keys: [fp(K_GLM)] },
          { ID: "qwen-token-plan/qwen3.8-flash" },
        ],
      }),
    );
    expect(await readModelCache(dir, "remote-magpie")).toEqual([
      { id: "group/glm-5.3", keys: [fp(K_GLM)] },
      { id: "qwen-token-plan/qwen3.8-flash", keys: [] },
    ]);
  });

  test("文件缺失 / 坏 JSON / 形状不对 → null", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, "models"), { recursive: true });
    expect(await readModelCache(dir, "absent")).toBeNull();
    await writeFile(join(dir, "models", "broken.json"), "{oops");
    expect(await readModelCache(dir, "broken")).toBeNull();
    await writeFile(join(dir, "models", "shape1.json"), JSON.stringify({ models: "x" }));
    expect(await readModelCache(dir, "shape1")).toBeNull();
    await writeFile(join(dir, "models", "shape2.json"), JSON.stringify({ models: [{ id: "x" }] }));
    expect(await readModelCache(dir, "shape2")).toBeNull();
    await writeFile(
      join(dir, "models", "shape3.json"),
      JSON.stringify({ models: [{ ID: "x", Keys: "y" }] }),
    );
    expect(await readModelCache(dir, "shape3")).toBeNull();
  });

  test("路径穿越 id → null，不读盘", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, "models"), { recursive: true });
    await writeFile(join(dir, "models", "evil.json"), JSON.stringify({ models: [] }));
    for (const bad of ["a/b", "..", "a\\b", "a/../b", ""]) {
      expect(await readModelCache(dir, bad)).toBeNull();
    }
  });
});
