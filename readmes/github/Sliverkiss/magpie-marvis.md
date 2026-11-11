# magpie-marvis

把 **Marvis**（应用宝 AI 助手）背后的模型接进 [magpie](https://usemagpie.ai) / OpenCode —— 不用 API key，用你的 **QQ 或微信**登录。

> 非官方插件，与 Marvis 及其开发方无关，只是把它的模型网关接到 magpie 上。

- **18 个模型槽位**：DeepSeek V4 Pro、Kimi K2.5、Claude Opus 4.6 / Sonnet 4.6、GPT-5.4、混元、GLM 5V Turbo 等
- **流式、思考、工具调用、系统提示词**全支持
- **额度**：一个号每天 1000 万计费 token（缓存读取免费、输入输出五折，实际可用远超此数），余额直接显示在 magpie 账号卡片上
- **全平台装了就用**：Windows 本地签真设备指纹，macOS / Linux 自动降级，不依赖 Marvis 客户端

## 装

```bash
magpie plugin add Sliverkiss/magpie-marvis
```

装完在 magpie 设置里 **供应商 → 添加 → Marvis**，选 **QQ 登录** 或 **微信登录**（自动开一个隔离浏览器窗口，授权完自动关闭）。装过 Marvis 客户端并登录过的话，也可以直接**从本机导入**。

## 已知边界

- Marvis 随时可能改协议，改了就提 issue。
- 登录态 30 天，插件自动续期；但在 Marvis 客户端登录同一个号会让两边 token 互相作废。
- `/v1/chat/completions` 不需要 UAL 签名，那是 `/v3/*` 业务接口的事。

## 开发

```bash
node --test                 # 语义测试
node tests/e2e-live.mjs     # 真实网关端到端（需要有效登录态）
```

## 许可

MIT。详见 [LICENSE](./LICENSE)，归属说明见 [NOTICE.md](./NOTICE.md)。
