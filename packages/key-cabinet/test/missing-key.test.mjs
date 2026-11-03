import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEnv } from "./env.mjs";

test("Magpie 中消失的 Key：reveal 标记、删除可自愈、重置给出指引", async () => {
  const restoreEnv = saveEnv(["MAGPIE_BIN", "MAGPIE_CONFIG_DIR", "MAGPIE_PROJECT_KEYS_GATEWAY"]);
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-missing-"));
  const bin = join(dir, "magpie");
  await writeFile(
    bin,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'gateway-key') process.exit(1);
if (args[1] === 'add') console.log('id: deadbeefdeadbeefdeadbeef\\nsk-magpie-key-abcdef123456');
else if (args[1] === 'list') console.log('ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS\\nabcdefabcdefabcdefabcdef  other  enabled  -  -  all  all  full');
else if (args[1] === 'remove' || args[1] === 'rotate' || args[1] === 'models') { console.error('magpie: Key not found'); process.exit(1); }
else process.exit(1);
`,
    { mode: 0o700 }
  );
  process.env.MAGPIE_BIN = bin;
  process.env.MAGPIE_CONFIG_DIR = dir;
  process.env.MAGPIE_PROJECT_KEYS_GATEWAY = "http://127.0.0.1:1"; // 快速失败，别碰真实网关
  const { createProject, deleteProject, getProject, listProjects, resetProjectKey, revealSecret } =
    await import("../lib/projects.mjs");
  try {
    const project = await createProject({ name: "Gone", slug: "gone" });

    const revealed = await revealSecret(project.id);
    assert.equal(revealed.secret, "sk-magpie-key-abcdef123456");
    assert.equal(revealed.exists, false);

    // 重置要给出可执行的指引，而不是一句 Magpie 原始报错。
    await assert.rejects(resetProjectKey(project.id), /已找不到这把 Key/);
    assert.ok(await getProject(project.id));

    // 删除必须能自愈：Magpie 里没有也能清掉本地记录。
    assert.deepEqual(await deleteProject(project.id), { ok: true, id: project.id });
    assert.equal((await listProjects()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    restoreEnv();
  }
});
