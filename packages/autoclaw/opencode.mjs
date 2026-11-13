// OpenCode 1.x 只接受插件函数；2.x 通过 opencode2.mjs 加载这里。
import { AutoclawAuthPlugin as basePlugin, AutoclawCnAuthPlugin as cnPlugin } from "./index.mjs";
import { createLoginMethod, LOGIN_PORT } from "./login-panel.mjs";

// 宿主会并行调用本文件导出的两个插件函数。共享同一个启动 Promise：
// 面板只监听一次，且绑定失败不会让整包 auth hooks 从宿主消失。
let loginMethod;
function magpieLoginMethod(options) {
  if (!loginMethod) loginMethod = createLoginMethod({ port: Number(options?.loginPort ?? LOGIN_PORT) });
  return loginMethod;
}

export async function AutoclawAuthPlugin(input, options) {
  const hooks = await basePlugin(input, options);
  // magpie.page.service 只在 Magpie 提供；OpenCode 沿用已有登录方式。
  if (input?.magpie) {
    const panel = magpieLoginMethod(options);
    await panel.warm();
    hooks.auth.methods = [panel.method];
  }
  return hooks;
}

export async function AutoclawCnAuthPlugin(input, options) {
  const hooks = await cnPlugin(input, options);
  // 国内短信登录本身不需要面板；只确保共享面板被预热，不因端口失败阻断注册。
  if (input?.magpie) await magpieLoginMethod(options).warm();
  return hooks;
}
