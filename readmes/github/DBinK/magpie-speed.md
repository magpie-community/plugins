# Magpie Speed

[Magpie](https://github.com/yetone/magpie) 页面插件：通过 Magpie 网关实测模型速度，对比不同模型与思考深度（reasoning effort）下的首字延迟和输出吞吐。

![测速界面，图中为明确标识的示例数据](docs/preview.png)

- 从 `/v1/models` 读取当前启用的模型与 `reasoning_levels`，按提供商分组，按模型 ID 列出；思考深度在每行右侧平铺直选，点选即同时选中该模型，可多选对比。每行还有 `None`，向网关发 `reasoning_effort: "none"`，可对比同一模型开关思考的差别。
- 流式计时，记录首字延迟（TTFT）、首答时间、思考耗时、输出 tokens/s、整体 tokens/s、token 数与总耗时；输出速度带横向条形便于对比。
- 每个目标重复 1/3/5 次取中位数；同一时间只跑一条流，避免并发争用额度扭曲读数。
- 预制 Prompt（短文 / 代码 / 推理）可一键切换，也可自由编辑；自定义 Prompt 保存在本地。
- 底部固定运行栏放重复次数、输出上限、超时与开始/停止；历史记录收进右上角抽屉，实时进度、取消、JSON 导出按需出现。
- 复用 Magpie 原生页面桥接、控件样式与设计变量，主题和语言跟随宿主。

## 安装

仓库包含可直接安装的 `dist/` 构建文件。在 Magpie 的 **Plugins** 中添加本仓库，或执行：

```sh
magpie plugin add github:DBinK/magpie-speed
```

需要支持 `page.service` 的当前 Magpie 版本和 Bun 1.4.2+。启用后从侧栏「模型测速」进入，或在 provider 菜单选择「测速」。开始测量会向所选模型发送真实请求并消耗对应额度。

## 指标定义

| 指标        | 含义                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| 首字 TTFT   | 从请求发出到收到第一个流式 token（含思考 token）                                |
| 首答        | 从请求发出到第一个正式回答 token；思考型模型明显晚于首字                        |
| 思考        | 首答减首字，仅当响应先输出 reasoning 内容时有值                                 |
| 输出 tok/s  | `completion_tokens / (最后一个 token − 第一个 token)`，只反映生成阶段           |
| 整体 tok/s  | `completion_tokens / 总耗时`，包含排队、首字与生成                              |
| 输出 tokens | 优先取响应 `usage.completion_tokens`；提供商不返回 usage 时按流式块数估算并标注 |

表中数值为重复测量的中位数；展开任意目标可查看每次重复的原始读数。

## 开发

```sh
bun install --frozen-lockfile
bun run check
bun start
```

页面服务默认监听 `45890`，网关默认 `http://127.0.0.1:3425`。可用环境变量覆盖：

- `MAGPIE_SPEED_GATEWAY`（或 `MAGPIE_ADDR`）
- `MAGPIE_SPEED_API_KEY`（仅远程共享网关需要）
- `MAGPIE_SPEED_PORT`
- `MAGPIE_SPEED_DATA_DIR`（默认 `~/.config/magpie/speed`）

`bun start --demo` 提供独立示例模式，不调用真实网关或模型。

版本号只写在 `package.json` 的 `version`。构建时（`src/version.ts`）读入并打进产物，页面顶栏、`/_speed/health`、`/api/bootstrap` 与 `bun start --version` 都取自这一处；发版只需要改 `package.json` 并重新构建。

## 测量说明

- 计时以网关返回的流为准，包含 Magpie 的路由开销；上游排队时间计入 TTFT。
- Magpie 的 middleware 和协议适配照常生效；实际路由可能因 provider 故障转移而变化。
- 提供商若对相同 Prompt 命中缓存，首字延迟会偏低；需要干净读数时请更换 Prompt 或隔一段时间再测。
- 只有收到 `finish_reason` 或流结束标记的响应才计入结果；流被截断、返回 200 错误页或非 SSE 内容时，该次测量标记为失败，不会产生速度数字。
- 服务只绑定回环地址，浏览器端通过一次性 bearer token 访问；历史记录保存在本地数据目录，最多 100 条。

采用 MIT 许可证。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
