/**
 * 保存并恢复测试改过的环境变量。`bun test` 会让同一进程里依次运行的测试
 * 文件共享 process.env：本文件不恢复，下一个包（或下一个测试文件）就会
 * 读到指向已被删除临时目录的 MAGPIE_* 变量。
 */
export function saveEnv(names) {
  const saved = new Map(names.map((key) => [key, process.env[key]]));
  return function restore() {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
