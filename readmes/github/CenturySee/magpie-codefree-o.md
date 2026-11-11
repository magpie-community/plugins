# CodeFree-O provider for magpie

非官方插件，复用**本机已经登录的 CodeFree-O CLI 账号**，让 magpie 将其模型提供给其他客户端。参考 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的插件结构与 OpenCode 2.x 适配器，以及 [magpie 插件接口](https://usemagpie.ai/docs/plugins)。

协议适配基于 Windows 版 `@srdcloud/codefree-o 1.10.1`。没有依赖其他 npm 包，不启动额外代理服务。

## 安装

先安装 CodeFree-O CLI，运行 `codefree-o` 并用自己的研发云账号完成登录。插件需要读取当前用户本机的登录文件，不附带账号或额度。

如果终端中可以直接运行 `magpie`，执行：

```powershell
magpie plugin add github:CenturySee/magpie-codefree-o
magpie plugin login codefree-o
magpie plugin
```

Windows 默认安装目录下也可以这样调用：

```powershell
$magpieBin = "$env:LOCALAPPDATA\Programs\magpie\magpie.com"
& $magpieBin plugin add github:CenturySee/magpie-codefree-o
& $magpieBin plugin login codefree-o
& $magpieBin plugin
```

也可以在 magpie 插件页面的“添加插件”中输入 `github:CenturySee/magpie-codefree-o`，再选择“读取本机 CodeFree-O CLI 登录态”。若终端提示选择登录方式，选择该项即可。初次安装后，插件加载或目录未刷新时，重启 magpie。

从 GitHub 下载 ZIP 的用户，需先解压，再添加包含 `package.json` 的文件夹，例如 `magpie plugin add ./magpie-codefree-o-main`。本地目录会被原地加载，安装后请保留该目录。

仓库：[CenturySee/magpie-codefree-o](https://github.com/CenturySee/magpie-codefree-o)。当前通过 GitHub 分发，尚未发布 npm 包。仅验证过 Windows 11；其他系统尚未验证。

连接成功后，模型以 `codefree-o/<modelName>` 出现在 magpie 的模型列表中。在 magpie 的 Agents 页面为目标客户端选择模型，并启动新会话。例如：

```text
codefree-o/GLM-5.3
codefree-o/GLM-5.2
codefree-o/DeepSeek-V4-Flash-0731
codefree-o/Qwen3.8-27B
```

以上是本机账号实测快照；插件以服务器实时目录为准，不保证所有账号拥有相同模型。其他客户端也可以连接 magpie 的 `http://127.0.0.1:3425/v1`，使用上述模型 ID。网关认证按 magpie 的设置配置。

## 登录文件和令牌

默认读取：

```text
%USERPROFILE%\.codefree-o\.local\share\codefree.json
```

可在启动 magpie 前用 `MAGPIE_CODEFREE_AUTH_FILE` 指定绝对路径；也兼容 CLI 的 `OPENCODE_CODEFREE_AUTH_FILE`。文件需要 v2 格式、`encryptedRefreshCfToken`、有效的到期时间和 `userId`。

magpie 保存的 key 仅包含**文件路径与账号 ID**，不包含访问令牌或刷新令牌。访问令牌仅缓存在插件进程内。刷新令牌轮换后，插件按 CLI 原有 AES-256-GCM 格式原子写回登录文件，以避免 CLI 下次启动拿到失效令牌。因此该文件必须可写。加密格式是 CLI 的本地存储格式，不是操作系统密钥库。

插件锁可协调多个插件进程，但 CLI 本身不使用这把锁。插件会检查文件变化，并在服务器拒绝旧令牌时重读；CLI 与插件恰好同时刷新仍可能冲突。若遇到此情况，先退出 CLI、重新登录，再连接插件。CLI 切换为另一账号时，插件会拒绝静默切换，需重新连接。

异常退出可能留下同目录的 `codefree.json.magpie.lock`。确认没有其他插件进程刷新后，可删除该锁再重试。插件不会自动删除来源不明的锁，也不会因鉴权失败删除 CLI 登录文件。

## 支持范围

- 动态模型目录、OpenAI Chat Completions、流式 SSE、工具调用与工具结果消息透传。
- 自动刷新、并发刷新合并、401 后最多重试一次；429 等上游错误保持原状态码。
- 模型的思考、图片能力从目录映射；具体可用性仍由上游决定。
- 官方生产、dev、test 站点；拒绝向其他站点发送凭据，拒绝 HTTP 重定向。
- 不实现独立网页登录、SRDCLOUD 环境托管登录、额度查询或每日签到。
- 模型 API 使用 Chat Completions；Responses、Anthropic 等客户端协议由 magpie 转换。
- 不伪造免费价格；实际额度和计费沿用研发云账号，调用会消耗账号额度。

`MAGPIE_CODEFREE_VERSION` 可以覆盖请求中的 CLI 版本，默认 `1.10.1`。此值参与模型目录地址与 clientVersion 请求头；上游协议变化仍需更新插件。

## 验证

```powershell
node --test
node scripts/smoke.mjs         # 实际刷新登录态并获取模型目录
node scripts/smoke.mjs --chat  # 额外进行一次最小流式模型调用，消耗少量额度
node scripts/smoke.mjs --tools # 另验证一次工具调用和工具结果回传，消耗少量额度
node scripts/magpie-smoke.mjs  # 临时配置目录安装、登录、启动网关并调用；使用端口 13425
```

模拟测试不读取真实登录文件。实际验证只输出模型名、HTTP 状态及短回复，不输出凭据。集成测试使用临时 magpie 配置目录，但令牌轮换仍会写回真实 CLI 登录文件。

2026-11-11 本机验证环境：Windows 11、CodeFree-O 1.10.1、magpie 0.1.3699。已通过 8 项模拟测试、社区 `scripts/check.mjs` 插件结构检查、实际模型目录与 SSE 调用、真实 `echo` 工具调用与结果回传，以及独立 magpie 配置中的安装/登录/网关转发验证。验证期间未在用户日常使用的 magpie 中安装或启用此插件。

## 卸载

```powershell
magpie plugin logout codefree-o
magpie plugin rm opencode-codefree-o-auth
```

插件与研发云、CodeFree-O、magpie 项目无官方关联。公共客户端协议常量来源于已安装 CLI，不包含用户凭据。OpenCode 2.x 适配文件沿用社区仓库的 MIT 许可。

反馈问题请提交到 [GitHub Issues](https://github.com/CenturySee/magpie-codefree-o/issues)，附上操作系统、magpie / CodeFree-O 版本和脱敏后的错误信息。请勿上传登录文件、令牌或个人账号信息。
