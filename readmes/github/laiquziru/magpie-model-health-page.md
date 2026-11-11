# Magpie 模型体检中心

在 Magpie 窗口中筛选模型、手动发起短消息测试，并查看首字延迟、总耗时和异常原因；支持收藏、最近 20 次历史及 Markdown 报告导出。

![模型体检结果](screenshots/preview-result.png)

## 安装

在终端执行：

```bat
magpie plugin add github:laiquziru/magpie-model-health-page
```

然后重启 Magpie，在侧栏「插件」分组里打开「模型体检」。

也可以从本地目录安装：`magpie plugin add ./magpie-model-health-page`。若 `magpie` 不在 PATH 中，请换成可执行文件的完整路径（Windows 上通常是 `Y:\PAPP\magpie-windows-amd64.exe`）。

## 使用

1. 按供应商、搜索词或收藏筛选模型。
2. 勾选需要测试的模型，或点「全选当前」。页面默认不选模型，不会自动测试。
3. 点击「开始体检」。每个模型发送一条极短消息 `Reply with exactly: OK`，`max_tokens=8`，流式读取首个正文 token。
4. 查看可用性、TTFT（首字延迟）和总耗时；异常可直接看错误详情。
5. 「导出报告」可复制或下载 Markdown，「历史」可回看最近 20 次。

可配置单模型超时（3–120 秒）和并发（1–8），默认 20 秒、3 并发。停止会取消尚未开始的模型并中止正在读取的请求。

> 只有手动点击「开始体检」才会调用模型。每个模型会实际产生一次短请求，可能消耗额度；不建议一次全选所有付费模型。可用性测试只说明能否正常返回内容，不代表模型的推理质量。

## 独立预览

```bat
node serve.mjs
```

浏览器访问 `http://127.0.0.1:3486`。Node 18+；没有 npm 运行时依赖，不需要 `npm install`。

## 数据与安全

- 设置和历史存放在 `~/.config/magpie/magpie-model-health/`，不使用浏览器 localStorage、Cookie 或 IndexedDB。
- 服务只监听 `127.0.0.1`，端口候选 3486–3489；浏览器不能直连网关，也读不到密钥。
- 网关默认 `http://127.0.0.1:3425`；可用 `MAGPIE_HEALTH_GATEWAY` 或 `MAGPIE_ADDR` 覆盖。独立预览可用 `MAGPIE_HEALTH_PORT`、`MAGPIE_HEALTH_DATA`。
- 界面不显示 API key；错误信息在保存和导出前会清理常见的 Bearer / key / token 片段。
- 插件声明 `permissions` 为空（`reads nothing`），不会读取用量、供应商账号或请求内容。

## 开发

```bat
npm run check
npm test
```

测试覆盖流式分片与 TTFT 计算、并发上限、停止与取消、失败隔离、设置裁剪、历史条数上限与错误脱敏。

页面桥接遵循 Magpie 页面插件契约：初始 sandbox 页面直接导航到本机服务，真实页面只走自己的本地 API。模块加载只启动 HTTP 服务，不进行任何模型调用。

## 许可

MIT
