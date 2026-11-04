/**
 * DPAPI 密封：Windows 用户态加密（CryptProtectData / CryptUnprotectData）。
 *
 * 落盘形状：plugin-auth.json 里的 refresh_token / access_token / API Key
 * 以 "dpapi:<base64>" 存放——密文只有**当前 Windows 用户**能解开。
 * 别的用户、别的机器、拷走的文件都解不开；插件也不存账号密码。
 *
 * 平台策略：
 *   - Windows：密封失败就报错（宁可不登录，不静默降级明文）。
 *   - 非 Windows：回退明文并保持原样可读（README 有说明；目标平台是 Windows）。
 *   - 不带 "dpapi:" 前缀的值一律按明文处理，方便手改/迁移。
 *
 * 用 bun:ffi 调 crypt32.dll——magpie 的插件宿主就是 Bun，所以插件里可用；
 * 动态 import 让本模块在 Node 下也能加载（只是密封会报错）。
 */

const PREFIX = "dpapi:";

/**
 * FFI 用的常驻缓冲区。
 *
 * 关键：Bun 的 ptr() 只给地址、不阻止 GC。任何"短命临时对象"（输入数据本体、
 * DATA_BLOB 结构体、输出结构体）都可能在系统调用期间被回收，让 DPAPI 读到
 * 已释放的内存——实测在内存压力下会返回失败或解出 4 字节乱码。这里把三个
 * 缓冲区全部放在模块级（生命周期与进程一致），held.data 在每次调用前指向输入。
 * 两个函数各自同步完成 FFI，不会交错，所以一组缓冲区就够。
 */
const held = {
  data: null,
  inBlob: new Uint8Array(16),
  outBlob: new Uint8Array(16),
};

/** 填 DATA_BLOB { DWORD cbData; BYTE *pbData; }（x64 下含 4 字节对齐填充）。 */
function fillBlob(target, buf, ptr) {
  const dv = new DataView(target.buffer);
  dv.setUint32(0, buf.length, true);
  dv.setBigUint64(8, BigInt(ptr(buf)), true);
  return target;
}

/**
 * 读 DATA_BLOB 的输出，并交还系统分配的内存。
 *
 * 关键：`toArrayBuffer()` 返回的是**视图**，不是拷贝——LocalFree 之后那块内存
 * 就可能被堆复用/覆盖（实测大尺寸密文的头部会被堆元数据改写，看起来像"魔数
 * 位移 8 字节"）。所以必须先把字节拷出来，再 LocalFree。
 */
function readBlob(target, toArrayBuffer, localFree) {
  const dv = new DataView(target.buffer);
  const size = dv.getUint32(0, true);
  const p = dv.getBigUint64(8, true);
  if (!p || !size) return null;
  const out = Buffer.from(new Uint8Array(toArrayBuffer(Number(p), 0, size))); // new Uint8Array(arrayBuffer) 是拷贝
  localFree(Number(p));
  return out;
}

let apiPromise = null;
let testApi;

/** Tests force a working or a failing DPAPI; call with null to restore. */
export function _setCryptoForTests(api) {
  testApi = api;
  apiPromise = null;
}

/** 惰性初始化 crypt32/kernel32；非 Windows 返回 null。 */
function crypt32() {
  if (testApi !== undefined) {
    if (testApi?.loadError) throw new Error(testApi.loadError);
    return Promise.resolve(testApi);
  }
  if (!apiPromise) {
    apiPromise = (async () => {
      if (process.platform !== "win32") return null;
      const { dlopen, FFIType, ptr, toArrayBuffer } = await import("bun:ffi");
      const { symbols } = dlopen("crypt32.dll", {
        CryptProtectData: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
          returns: FFIType.bool,
        },
        CryptUnprotectData: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
          returns: FFIType.bool,
        },
      });
      const { symbols: k32 } = dlopen("kernel32.dll", {
        LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
      });

      return {
        protect(plain) {
          held.data = Buffer.from(plain, "utf8");
          fillBlob(held.inBlob, held.data, ptr);
          const ok = symbols.CryptProtectData(ptr(held.inBlob), null, null, null, null, 0, ptr(held.outBlob));
          const out = ok ? readBlob(held.outBlob, toArrayBuffer, k32.LocalFree) : null;
          held.data = null;
          if (!ok) throw new Error("CryptProtectData 调用失败");
          if (!out) throw new Error("CryptProtectData 没有返回密文");
          return out;
        },
        unprotect(sealed) {
          held.data = Buffer.from(sealed);
          fillBlob(held.inBlob, held.data, ptr);
          const ok = symbols.CryptUnprotectData(ptr(held.inBlob), null, null, null, null, 0, ptr(held.outBlob));
          const out = ok ? readBlob(held.outBlob, toArrayBuffer, k32.LocalFree) : null;
          held.data = null;
          if (!ok) throw new Error("CryptUnprotectData 调用失败");
          if (!out) throw new Error("CryptUnprotectData 没有返回明文");
          return out;
        },
      };
    })().catch((e) => {
      throw new Error(`Windows DPAPI 初始化失败: ${e?.message ?? e}`);
    });
  }
  return apiPromise;
}

/** 是否为 DPAPI 密封值。 */
export function isSealed(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * 密封一个字符串。空值原样返回（空串没有密封的意义）。
 *
 * Windows 上 DPAPI 不可用时回退明文并记录原因：0.1.3 的用户 profile 里本来
 * 就是明文，硬抛错会让他们的每次刷新都失败、而且被永久重试。非 Windows 同样
 * 回退明文（与 0.1.3 行为一致）。
 */
export async function seal(value, { log } = {}) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!text) return "";
  let api = null;
  try {
    api = await crypt32();
  } catch (e) {
    log?.(
      "warn",
      `sensenova: DPAPI could not be loaded (${e?.message ?? e}); storing the credential in plaintext, as 0.1.x did`,
    );
    return text;
  }
  if (!api) return text; // non-Windows: plaintext, same as 0.1.3
  try {
    return PREFIX + api.protect(text).toString("base64");
  } catch (e) {
    log?.(
      "warn",
      `sensenova: DPAPI cannot seal in this Windows session (${e?.message ?? e}); ` +
        `storing the credential in plaintext, as 0.1.x did`,
    );
    return text;
  }
}

/**
 * 解开一个密封值。明文（无前缀）原样返回，方便手改过的 auth 文件继续可用。
 */
export async function unseal(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!text || !text.startsWith(PREFIX)) return text;
  const api = await crypt32();
  if (!api) throw new Error("这是 Windows DPAPI 密封的凭据，但当前环境没有 DPAPI，无法解开");
  try {
    return api.unprotect(Buffer.from(text.slice(PREFIX.length), "base64")).toString("utf8");
  } catch {
    throw new Error("凭据解密失败：DPAPI 密文不属于当前 Windows 用户（换机器/换用户后需要重新登录）");
  }
}
