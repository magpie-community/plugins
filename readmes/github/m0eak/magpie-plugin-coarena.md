# CoArena provider plugin

This plugin adds CoArena as an OpenAI-compatible provider, with a dynamic model list and an account daily-quota view.
The packaged CoArena wordmark is a small, self-made text icon and is not presented as official brand artwork.

## 配置与数据说明

配置时会先显示数据使用说明。CoArena 会保存发送的请求和模型回复（包括推理内容及工具调用），并可能将数据用于其对外授权的数据集；`store: false` 也不能阻止保存。选择“同意并继续”后才会出现 API key 密码框。拒绝或取消会结束配置；配置时不会发送认证请求。插件把同意版本存入账号 metadata，不会把 API key 复制到 metadata。

完成配置后，额度卡片默认显示中文。可在 CoArena 供应商选项中开启 **英文用量文案 / English usage text**。额度显示账户每日美元上限、已用、处理中占用、服务端返回的剩余金额和重置时间；这不是充值钱包余额。历史拒绝次数不代表当前额度耗尽。

## 安装与开发

从宿主仓库的父目录进行本地开发加载：

```sh
magpie plugin add ./magpie-plugin-coarena
```

运行离线测试：

```sh
npm test
bun test test/plugin.test.mjs
```

## 验证状态

用户已在实际环境中测试，并反馈插件可用。该反馈未细分具体模型、流式响应或工具调用场景的验证结果。

自动化测试只使用合成数据和假 `fetch`，不使用真实 API key、不调用 CoArena API 或模型推理。原生 CLI/GUI 的提示顺序已按宿主源码契约核对，并用宿主相同的条件判断逻辑做回归测试。

The provider uses `https://coarena.ai/api/v1`, reads models from `/models`, and reads daily quota from `/limits`. The model hook returns the host's `Model` structure and preserves user overrides. On empty, invalid, cancelled, or failed model reads it marks the previous model list as a fallback; HTTP 401 still marks the sign-in expired.

The host contract was checked against commit `90932ed1fa9d49dac052841006a77e90a249bb9a`: `internal/plugin/host.js` runs prompts in order, treats `when.op: "eq"` as equality, and saves select answers separately from the API key. The GUI and CLI use the host's shared prompt flow. A user has tested the plugin in a live environment and reported that it works. The feedback does not specify which models, streaming modes, or tool-call scenarios were tested. Automated tests remain fully offline.
