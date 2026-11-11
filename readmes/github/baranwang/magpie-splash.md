# magpie-splash

把 Splash 本地推理服务接入 Magpie，供 Pi、Claude Code、Codex 等通过 Magpie 网关使用。OpenCode provider 插件，无 npm 依赖。需要 macOS、Apple Silicon、已安装的 Splash；插件宿主使用 Magpie 自带的 Bun。

## 安装

先安装 Splash：

```sh
brew install incoai/tap/splash
```

在此项目目录执行：

```sh
magpie plugin add "$PWD"
magpie plugin options magpie-splash '{"context":262144,"idleMs":300000}'
magpie plugin login splash
```

应用中点击“启用本地 Splash”。插件扫描 `~/Library/Application Support/Splash/models/` 中已安装的模型；没有本地安装时列表为空。先运行 `splash serve --model <模型 ID>` 完成安装，停止服务后在 Magpie 点击“重新获取模型”。

在 Magpie 的 agent 页面选择 `splash/<model>`，之后直接运行原来的 `pi` 等命令；Magpie 网关须保持运行。也可以用 `magpie pi splash/mlx-community/Qwen3.8-27B-4bit` 配置 Pi。

应用中修改选项后关闭再开启插件；CLI 命令每次加载当前配置。用 `magpie provider test splash` 发起真实推理检查。

## 进程何时启动、释放

- 加载插件、查看模型和登录不启动 Splash。
- 首次推理请求按所选模型的本地文件启动 `splash serve --offline`，默认最多等待 10 分钟。
- 同一宿主只驻留一个模型。同模型并发共用服务；切换模型时排队等待旧请求的流结束或取消，再退出旧进程、启动新模型。
- 最后一个请求结束后空闲 5 分钟，向自己启动的进程组发送 SIGTERM；5 秒后仍未退出则 SIGKILL。下一次请求重新启动。
- 监护进程持有宿主的 stdin 管道。宿主退出或被 SIGKILL 时管道关闭，监护进程终止 Splash 和其子进程。不会扫描进程名，也不会杀掉用户自己启动的服务。
- 每个宿主使用独立动态回环端口。Magpie 重载新旧宿主短暂共存时可能同时加载两份模型；内存紧张或需要 CLI 与应用共享实例时，使用下面的外部服务模式。
- 托管模式传 `--idle-release off`，由插件的空闲退出统一回收整个服务。Splash 自己的 `--idle-release` 则只卸载权重、释放内存，HTTP 服务仍存在；这是两个不同的生命周期策略。

## 配置

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `modelsDir` | `~/Library/Application Support/Splash/models/` | 本地安装目录，支持 `~/`；源码安装填仓库的 `install/models/` |
| `model` | 无 | 仅外部服务模式使用的模型 ID |
| `context` | `262144`（256K） | 上下文上限，不超过安装模型配置中的窗口 |
| `vision` | `false` | 仅外部模式；本地模型从安装元数据读取图片能力 |
| `idleMs` | `300000` | 最后一个请求结束后的进程退出等待，毫秒，正数 |
| `startupMs` | `600000` | 启动的最长等待，毫秒，正数 |
| `command` | `splash` | Splash 可执行文件；GUI 的 PATH 找不到时填绝对路径 |
| `args` | `[]` | 额外 serve 参数，例如 `["--max-memory","28G"]` |
| `baseURL` | 无 | 外部服务的完整 API 基地址，含 `/v1` |
| `apiKey` | 外部模式 `local` | 外部服务密钥的备用值；Magpie 登录账号密钥优先 |

不要在 args 中重复 model、host、port、max-context、idle-release、api-key 等插件管理的选项。启动使用参数数组，不执行 shell 命令。

模型列表读取 Splash selection 链接及其 `model.json`，检查记录的文件路径和大小，跳过旧 package、断链和缺失文件。刷新只读取磁盘，不启动模型或访问网络；不校验整份权重哈希，最终兼容性由 Splash 启动检查。同一模型 ID 的多个安装只列一个。外部模式的上下文和图片能力必须与服务实际配置一致。输出上限是 `min(32768, context / 4)`。

## 连接已经运行的 Splash

```sh
splash serve --model mlx-community/Qwen3.8-27B-4bit --max-context 262144 --idle-release 5m
magpie plugin options magpie-splash '{"model":"mlx-community/Qwen3.8-27B-4bit","context":262144,"baseURL":"http://127.0.0.1:8000/v1"}'
magpie plugin login splash
```

未启用服务鉴权时输入 `local`；启用了则输入真实密钥。此模式插件从不启动、终止或释放外部服务。多账号凭据独立，服务生命周期由用户或 launchd 管理。

## 验证

```sh
npm test
```

测试运行真实 HTTP fixture 子进程，覆盖并发流共享进程、流完成前不回收、空闲退出及再次启动、取消释放、启动失败、Node/Bun 宿主 SIGKILL 后清理，以及外部进程不被回收。

开发环境已验证 Magpie 隔离目录加载和 Bun provider fetch 路径。没有安装 Splash 的环境无法验证真实模型、Metal 推理和其启动耗时；fixture 不是模型推理验证。
