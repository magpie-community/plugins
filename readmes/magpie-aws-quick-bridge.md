<p align="center"><img src="assets/logo.png" width="120" alt="magpie-AWS-Quick-bridge"></p>

# magpie-AWS-Quick-bridge

<p align="center">
  作者：<a href="https://github.com/DaBinBinah">DaBinBinah</a> ·
  <a href="https://x.com/yedabinbinah">X / Twitter @yedabinbinah</a> ·
  <a href="https://www.npmjs.com/package/magpie-aws-quick-bridge">npm</a>
</p>

这是我做的一个小工具：把 **AWS Quick（Amazon Quick / QuickWork）** 账号接到 Claude Code、Codex、OpenCode 这些编程 agent 上用。

**同一个包，[Magpie](https://usemagpie.ai) 和 [CC Switch](https://github.com/farion1231/cc-switch) 都支持：**

| 你在用 | 怎么接 |
|---|---|
| **Magpie** | 装成 Magpie 插件，在 Magpie 里登录，模型是 `aws-quick/smart` 这样的名字 |
| **CC Switch** | 在本机起一个 API 服务，一条命令导入 CC Switch，切过去就能用 |

两种用法互不影响，可以同时用。

> 非官方项目，和 Amazon / AWS 没有关系。请只用你自己的、或者得到授权的账号，并遵守 Amazon Quick 的服务条款。

## 用在 Magpie 里

```sh
magpie plugin add magpie-aws-quick-bridge     # 安装
magpie plugin login aws-quick                 # 登录：浏览器里登 Amazon Quick，看到 Login complete 就好了
```

在 Magpie 应用里也一样：**插件 → 添加插件** 填 `magpie-aws-quick-bridge`，然后在 **Amazon Quick** 那一行点登录。个人账号和企业账号（IAM Identity Center / SSO）都可以，登多个账号就重复登录几次。

装好以后所有 agent 都能用 `aws-quick/smart`、`aws-quick/fast`、`aws-quick/balanced`、`aws-quick/auto`，`magpie quota` 能看到剩余额度。

## 用在 CC Switch 里

CC Switch 没有插件，它只管给 agent 换「API 地址 + Key」。所以我在这个包里带了一个本机 API 服务，CC Switch 指向它就行。需要 Node.js 20 以上。

```sh
npx magpie-aws-quick-bridge login             # 1. 登录（企业账号加 --enterprise --region <区域>）
npx magpie-aws-quick-bridge serve             # 2. 启动本机 API，这个窗口要一直开着
npx magpie-aws-quick-bridge ccswitch --open   # 3. 另开一个终端，导入 CC Switch，每个应用点一次确认
```

然后在 CC Switch 里切到 **Amazon Quick**。第 3 步会给 Claude Code、Codex、OpenCode 各加一个；只要其中一个就加 `--app claude`（或 `codex`、`opencode`）。

想手动填也行，任何能填「地址 + Key」的工具都能这么接：

| 应用 | API 地址 | 接口格式 | 模型 |
|---|---|---|---|
| Claude Code | `http://127.0.0.1:18765` | Anthropic Messages | `smart` |
| Codex | `http://127.0.0.1:18765/v1` | OpenAI Responses | `smart` |
| OpenCode 等 | `http://127.0.0.1:18765/v1` | OpenAI Chat Completions | `smart` |

Key 用 `npx magpie-aws-quick-bridge status` 看。

几件要知道的事：

- **`serve` 得一直开着**，关了 agent 就连不上。macOS 上可以先 `npm install -g magpie-aws-quick-bridge`，再 `magpie-aws-quick-bridge service install` 让它在后台常驻。
- CC Switch 里**不用开「本地路由」**，每个应用拿到的已经是它自己的接口格式。
- token 快到期会自己续；真过期了请求会报 401，重新 `login` 一次就行，不用重启 `serve`。
- 登录时浏览器提示 **`Your session has expired`**：多半是浏览器里留着一份过期的 AWS 登录状态。换个无痕窗口打开登录地址，或者清掉 `signin.aws` 的 Cookie 再登（在 Magpie 里登录也一样）。这一条我自己没碰到过，是别人遇到后这样解决的。
- 服务只听 `127.0.0.1`，每个请求都要带 Key。别把它放到公网上。
- Claude Code 启动时会提示不认识 `smart` 这个模型名，不影响使用。
- Gemini CLI 用的是另一种接口，暂时不支持。

其他命令：`status`（地址、Key、账号、额度）、`serve --port <端口>`、`key --new`（换 Key）、`service uninstall`、`logout`。

## 模型

| 模型 | 说明 |
|---|---|
| `smart` | 最强的一档，默认用它 |
| `balanced` | 中间档 |
| `fast` | 最快的一档 |
| `auto` | 让 Amazon Quick 自己选 |
| `advanced` | 账号开通了才有 |

在 Magpie 里前面加 `aws-quick/`。在我的账号上 fast、balanced、smart 背后分别是 Claude Haiku、Sonnet、Opus，别的账号可能不一样。

## 能做什么

- 流式回复、思考过程、token 用量
- 工具调用：读写文件、跑命令这些 agent 的工具都能用；回复写到上限、工具调用的结尾标记被截掉时，只要调用本身完整就照常执行；漏填必填参数或参数类型不对时，下一轮会告诉模型错在哪里；长对话里每 6 轮重发一次完整的工具说明，模型回了工具结果却没再调用工具时，下一轮也重发
- 在 Magpie 的模型选择器里选的推理档位（low / medium / high）会传给 Amazon Quick
- 多轮对话接着上一轮的线程走，只发新增的内容；客户端用 `x-session-id`、`x-session-affinity` 这类请求头标出的会话各走各的线程，开头相同的两个对话不会串
- 每个账号带一个固定的设备 ID 连接 Amazon Quick，而不是空值（`stable_device_id` 设为 `false` 可关）
- Amazon Quick 每条消息最多 64 KB：工具很多、提示词很长时会自动压缩工具说明和系统提示词，很长的对话内容和图片转成附件，保证发得出去
- 图片、PDF 会作为附件发给 Amazon Quick：包括 Claude Code 读到的截图和 PDF（工具结果和 `document` 块）、Codex 和 OpenCode 发的文件，以及 `https://…` 形式的图片地址（先下载，最大 10 MB，不下载本机和内网地址）。只有个人账号支持，Gateway 企业账号仍然只发占位文字
- 额度查询，模型列表按账号实际开通的来
- 额度用完时返回 429，并带上额度恢复还要多久（最长按 6 小时算，到点再问一次），Magpie 会让这个账号休息到那时，先用别的账号；报错里也写明是哪种额度、多久恢复（写成 Magpie 能识别的 “try again in 3h 32m”）；Amazon Quick 不说什么时候恢复时，按 30 分钟后再问一次算
- 额度用完时 Amazon Quick 有时不报错，只回一句 “You've reached your usage limit. Check your profile for details.”：我把它当成额度用完返回 429，不当回答交给客户端
- token 用量按实际上下文算：Amazon Quick 一轮里每调用一次模型就报一次用量，我只取最后一次的输入，不会把上下文算成几倍，Claude Code 不会因此问两三句就自动压缩
- 按停止或请求超时的时候，会告诉 Amazon Quick 停止生成，不让它在后台把回复写完
- Amazon Quick 跑它自带的工具（联网搜索等）时，思考内容里会显示一行 `[Quick: 工具名]`；流式请求最多等 10 秒就先回应，长任务不会看起来像卡死；Amazon Quick 2 分钟没有任何输出（它对 ping 的应答和状态通知不算）就按超时结束，不会一直等到 5 分钟的总超时
- 请模型只输出纯文本和 Markdown，不输出只有 Amazon Quick 自己界面能显示的选项卡片和来源标记
- 用中文（或日文、韩文）提问时，会让模型用同一种语言思考，文件名、日志、搜索词照原文用，不会被翻成英文

## 我验证到了哪一步

- **真实账号（我自己的个人账号）**：Magpie 插件的登录、对话、工具调用、线程复用、附件、额度；CC Switch 模式下 Claude Code、Codex、OpenCode 经本机 API 读文件、写文件。
- **只用模拟服务测过**：企业账号、`advanced` 模型、图片和 PDF 附件、下载图片地址、额度用完后的休息时间（我没把额度用完过）。
- 企业账号的租户地址是 `….enterprise.quick.aws.com` 时，走的是 Amazon Quick 的 Gateway 线路：登录时自动识别，账号名和 AWS 账号 ID 取自令牌，令牌里没有时再问租户一次，都取不到就显示租户地址。这条线路的登录和对话我都只用模拟服务测过，登录或对话失败请把报错发到 issue。
- 工具调用是靠提示词约定的文本协议做的，模型偶尔会不按约定来，重试一下通常就好。
- Amazon Quick 每轮会带上它自己的一大段系统提示词，所以 token 数看起来很大；额度按它的 credits 算。

更多细节（全部选项、远程登录、工作方式、测试、已知限制）在 [docs/DEVELOPMENT.md](https://github.com/DaBinBinah/magpie-AWS-Quick-bridge/blob/main/docs/DEVELOPMENT.md)。

## 找我

用着有问题或者有想法，直接提 [issue](https://github.com/DaBinBinah/magpie-AWS-Quick-bridge/issues)，或者在 X 上找我：[@yedabinbinah](https://x.com/yedabinbinah)。

## License

[GNU General Public License v3.0](LICENSE)。

这个项目（`index.mjs`、`plugin/`、`gateway/`、`bin/`、`test/`）© 2026 DaBinBinah。

`opencode2.mjs` 是 [magpie-community/plugins](https://github.com/magpie-community/plugins) 提供的 OpenCode 2.x 适配器，原样收录（社区收录的检查要求逐字节一致），MIT 许可证，见 [LICENSES/opencode2-MIT.txt](LICENSES/opencode2-MIT.txt)。
