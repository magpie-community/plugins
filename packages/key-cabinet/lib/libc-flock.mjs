/**
 * 打开 libc 并暴露 flock。Bun FFI 的 dlopen 需要具体库名：Bun 的 suffix 在
 * Linux 上是 "so"，但 libc 的 soname 是 libc.so.6，没装 libc6-dev 时
 * libc.so 并不存在。先试真实 soname，再退回带 suffix 的通用名。
 */
export async function openLibc() {
  const { dlopen, FFIType, suffix } = await import("bun:ffi");
  const names =
    process.platform === "linux"
      ? ["libc.so.6", "libc.so", `libc.${suffix}`]
      : [`libc.${suffix}`, "libc.dylib"];
  let last;
  for (const name of [...new Set(names)]) {
    try {
      return dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
