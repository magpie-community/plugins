# magpie-agent-eagle

v0.3.5 为 Magpie 的 Agent 条目补上官方 Eagle 图标，并修正视觉模型被重置后的
“重新同步”恢复；插件显示名仍为 **magpie-agent-eagle**，原安装 ID 和本机配置目录不变。

An unofficial **Magpie agent plugin + companion Eagle plugin**. Choose Eagle's
language model in Magpie; choose its vision model from a dropdown in the Eagle
bridge. The dropdown reads Magpie's image-capable model catalog. Disconnecting
restores the Eagle provider and defaults that the bridge replaced.

非官方的 **Magpie Agent 插件 + Eagle 配套桥接插件**。语言模型在 Magpie 选择，
视觉模型在 Eagle「magpie-agent-eagle」下拉框选择，不需要手填模型名。

> macOS · Eagle AI 模型套件 1.0.0 · Magpie tested with 0.1.3734
>
> v0.3.3 automatically refreshes the vision catalog after connecting.
> In v0.3.2, live vision dropdown and five consecutive Eagle cold restarts passed.
> Targeted startup recovery restored the saved vision model in every round.
> See [ACCEPTANCE.md](ACCEPTANCE.md) for test scope and remaining limitations.

## 安装前准备

需要在**同一台 Mac** 上安装 Eagle 和 Magpie，并保持两者运行。
当前验证环境为 Eagle AI 模型套件 1.0.0、Magpie 0.1.3734。

1. 在 Eagle 安装并启用官方「AI 模型套件」。
2. 打开 Eagle **偏好设置 → AI 模型套件**。如果是全新安装，先添加一个可用的模型服务商，
   填好该服务需要的地址和密钥，再分别选择语言和视觉默认模型。
   已有配置的用户只需确认两个默认值都不为空。
   桥接会记录这些设置，供断开时恢复；任意一项为空都会阻止首次连接。
3. 在 Magpie 配好准备使用的模型服务。要选择独立视觉模型，Magpie 的模型目录中
   需要有标记为支持图片输入的模型。

普通安装不需要克隆源码、安装 Node.js、Python 或执行开发构建命令；
后面的“开发”章节仅供修改插件源码时使用。

## 第一步：安装 Eagle 配套插件

1. 打开 [v0.3.5 下载页](https://github.com/double2tea/magpie-agent-eagle/releases/tag/v0.3.5)。
2. 下载 `magpie-agent-eagle-0.3.5.eagleplugin`，双击文件并按 Eagle 提示完成安装。
3. 从 Eagle 顶部菜单 **插件 → magpie-agent-eagle** 打开面板。
   此时显示“等待 Magpie”是正常的，继续下一步即可。

下载页中的文件用途：

| 文件 | 用途 |
| --- | --- |
| `magpie-agent-eagle-0.3.5.eagleplugin` | 安装到 Eagle，必需 |
| `magpie-agent-eagle-0.3.5.tgz` | Magpie 插件包；按下面的 GitHub 安装方式操作时，无需另外下载 |
| `SHA256SUMS.txt` | 两个安装包的 SHA-256 校验值，可选 |
| `Source code` | 开发用源码，普通安装无需下载 |

## 第二步：安装 Magpie Agent 插件

在 Magpie 的插件页添加仓库地址：

```text
https://github.com/double2tea/magpie-agent-eagle
```

如果已配置 Magpie 命令行，也可以在终端运行以下命令；两种方式任选一种：

```sh
magpie plugin add github:double2tea/magpie-agent-eagle
```

完成后打开 Magpie 的 **Agents** 页面，找到 **magpie-agent-eagle** 条目。
两端插件都要安装：只装 Eagle 插件会一直等待连接，只装 Magpie 插件无法把配置应用到 Eagle。
如果找不到 magpie-agent-eagle，先在 Magpie 插件页确认此插件已经安装并启用，再重新打开 Agents 页面。

## 第三步：连接并选择模型

1. 在 **Magpie → Agents → magpie-agent-eagle** 选择语言模型。
2. 回到 **Eagle → 插件 → magpie-agent-eagle**，等待显示 **“已连接 Magpie”**。
3. 等待视觉模型列表加载。v0.3.3 在连接成功后会自动刷新列表；
   如果仍使用 v0.3.2，先打开面板、后连接 Magpie 时需点击一次 **“重新同步”**。
4. 在同一面板的 **视觉模型** 下拉框选择支持图片的模型，或选择 **“跟随语言模型”**。
   选择后自动应用，不需要手填模型名或额外保存。
5. 确认面板上方显示的语言模型、视觉模型与自己的选择一致。仅 Magpie 显示连接成功，
   不代表 Eagle 已经应用配置，**以 Eagle 桥接面板为准**。

首次未保存独立视觉选择时，视觉默认跟随语言模型。若语言模型不支持图片，
请完成第 4 步后再使用 Eagle 的图片 AI 功能。

例如：在 Magpie 选择 `group/expert`，在 Eagle 桥接下拉框选择 `group/multimodal`，
就分别作为 Eagle 的语言和视觉默认模型。这两个名称仅为示例，以自己的 Magpie 模型列表为准。
选择“跟随语言模型”时，两种用途使用同一模型，因此该语言模型也应支持图片输入。

## 连接后在哪里改模型？

| 想调整的内容 | 操作位置 |
| --- | --- |
| Eagle 的语言模型 | **Magpie → Agents → magpie-agent-eagle** |
| Eagle 的视觉模型 | **Eagle → 插件 → magpie-agent-eagle → 视觉模型** |
| 模型服务地址、密钥及可用模型 | Magpie 中对应的模型服务配置 |
| 恢复为 Eagle 自己管理 | 先按下一节在 Magpie 断开，再到 Eagle 官方设置修改 |

**连接 Magpie 期间，请通过上面的位置改模型。** Eagle 官方「AI 模型套件」可以用来查看设置，
但不要同时在里面修改受桥接管理的 **OpenAI 兼容** 服务商、语言默认模型或视觉默认模型。
这些修改可能触发冲突并停止同步；启动时把视觉改成语言模型的特定情况还会被恢复为桥接保存的选择。
其他服务商不受桥接管理。

视觉下拉框来自 Magpie 的图片输入模型目录，切换语言模型后会保留独立视觉选择。
Magpie 中只有一个 magpie-agent-eagle 条目，视觉选择在 Eagle 桥接面板中完成。
正常连接后，关闭桥接窗口仍会后台同步；重新启动 Eagle 会自动启动桥接服务。

## 怎样确认装好了？

- Magpie 的 Agents 页面能找到 magpie-agent-eagle，并能选择语言模型。
- Eagle 桥接显示“已连接 Magpie”，上方两个模型与选择一致，视觉下拉框可用。
- 完整退出并重新启动 Eagle 后，不点击“重新同步”，打开桥接面板仍显示连接成功和预期模型。

以上确认的是配置与自动连接。若还要确认模型能实际处理图片，请在自己使用的 Eagle AI 插件中，
用一张允许发送给所选模型服务的测试图片发起一次任务；这可能上传图片并产生上游服务费用。
桥接自身不会自动发起推理，也不会自动安装其他 AI 功能插件。

## 断开、恢复与卸载

1. 在 **Magpie → Agents → magpie-agent-eagle** 断开连接。
2. 保持 Eagle 运行，在「magpie-agent-eagle」面板确认已经恢复连接前的配置。
   如果断开时 Eagle 未运行，恢复会在下次启动桥接时执行。
3. 确认恢复后，可以到官方「AI 模型套件」自行修改设置，或卸载两端插件。

Eagle 面板的 **“恢复原配置并暂停”** 只暂停本次插件运行；
点击“重新同步”或重启 Eagle 后仍会继续接收 Magpie 配置。
如果想持续断开，应在 Magpie 操作。

## 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 一直显示“等待 Magpie” | 确认两端插件均已安装，并已在 Magpie 的 magpie-agent-eagle 条目选择语言模型 |
| Magpie 的 Agents 页面找不到 magpie-agent-eagle | 确认已安装并启用 Magpie 端插件，且 Eagle 配套插件已安装，再重新打开 Agents 页面 |
| 提示官方 AI 模型套件未就绪 | 在 Eagle 启用官方「AI 模型套件」，待其启动后点击“重新同步” |
| 提示缺少原语言或视觉默认模型 | 首次连接前，先在官方「AI 模型套件」设置好两个默认值，再重新同步 |
| 视觉下拉框为空或读取失败 | 确认 Magpie 正在运行，模型目录包含支持图片输入的模型，再点击“重新同步”刷新列表 |
| 显示“配置已被其他操作修改” | 先点击“重新同步”。仅视觉默认值被改为上次语言模型、且连接输入和其他受管理配置完全一致时，会恢复已保存的视觉选择；其他冲突仍停止同步，需核对官方设置并按提示使用本机 `provider.eac` 备份恢复，不要删除状态文件强行重连 |
| 面板模型正确，但其他 Eagle 插件仍使用旧模型 | 重新打开使用模型的插件；第三方插件可能缓存了原设置 |

## English quick start

1. On the same Mac, run Eagle and Magpie. Enable Eagle's official AI model suite
   1.0.0 and set both language and vision defaults before connecting.
2. Download `magpie-agent-eagle-0.3.5.eagleplugin` from
   [Releases](https://github.com/double2tea/magpie-agent-eagle/releases/tag/v0.3.5),
   install it in Eagle, then open **Plugins → magpie-agent-eagle**.
3. Add this repository on Magpie's plugins page, or run
   `magpie plugin add github:double2tea/magpie-agent-eagle`.
4. Select the language model at **Magpie → Agents → magpie-agent-eagle**. Select the vision
   model in the **Eagle bridge's vision dropdown**, or choose to follow language.
   v0.3.3 refreshes the dropdown automatically on connection. In v0.3.2,
   click **重新同步** (re-sync) if the panel was opened before connecting.
5. Confirm the Eagle bridge shows connected and both expected models.
   While connected, change models in those two locations; editing the managed
   OpenAI-compatible provider or defaults in Eagle's official settings can
   cause a conflict or trigger startup recovery.
6. To return control to Eagle or uninstall, disconnect Eagle in Magpie first,
   then confirm the bridge has restored the original settings.

## 行为与边界 / Behavior

- 语言／视觉选择对应 Eagle 的 `chat` / `image` 默认模型。视觉选择保存在本机，
  切换语言模型时独立保留。启动时若只有视觉默认值被改成原语言默认值，
  且其他受管理配置与上次记录一致，桥接会恢复保存的视觉选择。这个特征也可能
  来自用户手动修改，因此启动时符合条件的手动修改同样会被恢复。
  跟随语言模型时，应选支持图片的语言模型。
- Magpie 显示接入成功，只表示已写入连接配置；**以 Eagle 桥接面板为准**。
  模型目录的图片标记不构成对上游推理能力或路由组每个成员的实测保证。
- 只管理 `openai-compatible` provider 和语言／视觉默认模型；连接期间该 provider
  会指向 Magpie。其他 provider 保留。原 provider 配置使用 Eagle 加密导出备份，
  断开后恢复原默认模型和自定义模型列表。
- 正在连接时手动修改受管理 provider 或默认模型，会停止同步和自动恢复。
  配置操作异常退出也会停止自动重写，需核对状态后处理加密备份。
- Eagle「恢复原配置并暂停」只暂停当前插件运行；重新同步或重新启动桥接会继续连接。
  长期断开在 Magpie 操作。卸载前先断开，并确认 Eagle 已恢复原配置。
- 不上传素材，不发起推理，不新增 HTTP 服务；模型列表读取访问本机 Magpie 网关，
  配置后通过本机 Eagle AI 模型套件服务刷新缓存并核对语言／视觉默认值。
  第三方 Eagle 插件可能缓存设置，需要重新打开。
- 使用已安装官方 SDK 的配置方法，不直接编辑加密 `config.bin`。
  写入方法尚无公开稳定合同，升级 Eagle AI 模型套件后需重新验证。

## 数据位置 / Local data

All runtime data stays outside this repository:

| File under `~/Library/Application Support/Eagle/MagpieBridge/` | Purpose |
| --- | --- |
| `connection.json` | Magpie-managed language model, gateway URL and API key; do not share |
| `vision.json` | Saved vision model choice; no API key |
| `state.json` | Original defaults, managed-state fingerprints and operation phase |
| `provider.eac` | Eagle-encrypted backup of the managed provider |

目录权限为 `0700`，连接、状态和备份文件为 `0600`。请勿把运行数据附在 issue 中。

## 开发 / Development

零新增依赖。原生 HTML、CSS、JavaScript；不打入共享运行时或依赖目录。
构建需要 Python 3，测试使用支持 `node:test`、`fetch` 和 `AbortSignal.timeout`
的现代 Node.js（建议 Node.js 22+）。

```sh
git clone https://github.com/double2tea/magpie-agent-eagle.git
cd magpie-agent-eagle
npm test
python3 build.py
```

Build outputs:

- `dist/magpie-agent-eagle-0.3.5.eagleplugin` — Eagle companion runtime
- `dist/magpie-agent-eagle-0.3.5.tgz` — Magpie agent plugin package

SDK tests load the separately installed
`~/Library/Application Support/Eagle/Plugins/ai-sdk/ai-sdk.cjs`, but use temporary
configurations and a local test HTTP endpoint. They do not change your real
Eagle settings. Without that SDK, those tests are skipped; the agent contract,
input validation and simulated panel tests still run. A green run with skips
does not establish SDK integration.

## License and attribution

Project code: [MIT](LICENSE). Eagle's official icon and marks are excluded from
the MIT license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The official
SDK is not redistributed. This is not an official Eagle or Magpie project.

本方案已优先最短路径 + 未添加未要求兜底/扩展。
