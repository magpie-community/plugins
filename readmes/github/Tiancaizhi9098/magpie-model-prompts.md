# 模型提示词 · Magpie 插件

自动读取本机 Magpie 当前开放的模型。选择模型、粘贴提示词、选择头部或末尾、点击“保存全部”，后续发给该模型的请求就会加入对应内容。无需写 JSON，无需 API Key，无运行时 npm 依赖。页面跟随 Magpie 自带的主题、字体与配色。

## 从 GitHub 安装（推荐）

先安装并启动 Magpie，配置好你自己的模型供应商。建议 Magpie 0.1.3225 或更新版本。

终端运行：

```sh
magpie plugin add github:Tiancaizhi9098/magpie-model-prompts
```

Windows 上如果终端找不到 `magpie`，可使用默认安装路径：

```powershell
& "$env:LOCALAPPDATA\Programs\magpie\magpie.com" plugin add github:Tiancaizhi9098/magpie-model-prompts
```

也可以在 Magpie → 插件 → 添加插件中输入 `github:Tiancaizhi9098/magpie-model-prompts`。装好后，在侧栏插件区打开“模型提示词”。如果页面没有出现，退出并重新打开 Magpie。

插件会识别当前这台电脑上 Magpie 开放的模型。每台电脑保存自己的提示词，不会从 GitHub 下载或上传你的个人提示词。无需另装 Node.js，Magpie 会管理插件所用的 Bun。

后续可在 Magpie 的已安装插件页面更新。使用上面的地址安装，保持跟随主分支；不要额外加固定版本标签，除非需要锁定版本。

## Windows 本地安装包

解压到任意目录后双击 `install.cmd`。安装器会复制到 `%USERPROFILE%\.config\magpie\plugins\magpie-model-prompts`，并通过 Magpie 的 CLI 注册插件；不需要管理员权限。Magpie 不在默认位置时，在终端运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -MagpiePath "D:\Apps\magpie.exe"
```

也可以直接在 Magpie → 插件 → 添加插件中，选择这个包含 `package.json` 的文件夹。通过本地目录安装后请保留该目录。

更新后，关闭并重新打开“模型提示词”页面。仍显示旧版时，退出并重新打开 Magpie。旧版保存失败的草稿请先复制保留。

**2.0.0 更改了保存方式，不读取、不兼容迁移 1.x 的已保存内容。首次更新后，请重新粘贴各模型的提示词。** 后续的 2.x 更新会继续使用独立文件中的内容。

## 使用

1. 打开 Magpie 侧栏插件区的“模型提示词”。首次安装若没有出现，关闭并重新打开 Magpie 窗口。
2. 左侧选择模型，右侧粘贴它专用的提示词。
3. 在“插入位置”选择“头部 · 原提示词之前”或“末尾 · 原提示词之后”。每个模型单独保存位置，默认末尾。
4. 点击“保存全部”，或按 Ctrl+S。切换模型时会保留尚未保存的草稿；关闭页面前请保存。
5. 确保 Claude Code、Codex 等客户端的模型连接经过 Magpie。新发出的请求开始使用保存的规则。

绿色圆点代表已配置；每个模型可以单独暂停。清空某个模型的内容并保存即可移除该模型的追加规则。顶部开关暂停全部规则，保存后生效。

## 匹配和兼容

- 使用 Magpie 路由完成后的供应商 ID 和模型 ID 精确匹配，不会把同名的不同供应商混在一起。
- 路由组和备用供应商重试使用实际选中的模型提示词；各次尝试不会互相污染。
- 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini。
- 保留原有系统指令、缓存标记、工具定义、对话、模型和推理参数，仅按所选位置加入内容。头部插入会改变原提示前缀，可能影响上游提示缓存的命中。
- 空提示词和暂停的规则不修改请求。Magpie 自己生成标题、路由分类等内部请求不在作用范围。
- 列表来自 Magpie 的 `/v1/models`：显示当前开放的模型。暂时关闭的模型会保留其已保存规则，并标记为“当前未开放”。路由组不单独列出。
- 提示词仍受模型和上游服务的指令优先级影响；保存不等于保证模型遵循每条文字。

页面每 5 秒刷新一次模型目录，只访问本机 HTTP 网关，不发送推理请求，不消耗模型额度。目录仅包含模型名称和供应商 ID，不包含供应商密钥。自定义本机网关端口时，可在插件 Options 增加 `gatewayAddress`，例如 `127.0.0.1:3499`。

## 提示词保存与容量

2.0.0 通过插件自带的本机编辑服务保存，绕开 Magpie 页面设置接口的 64 KB 限制。**全部模型合计支持接近 8 MiB 的 JSON 数据**（预留少量元数据空间；按 UTF-8 字节计算）。超出时会提示，不会覆盖之前保存的内容。保存后通常约 1 秒内用于新请求，不需要重启。

Windows 默认保存位置：

```text
%USERPROFILE%\.config\magpie\model-prompts\prompts.json
```

其他系统默认 `~/.config/magpie/model-prompts/prompts.json`；设置 `XDG_CONFIG_HOME` 时改用该目录下的 `magpie/model-prompts/`。备份时复制这个文件即可。提示词保持在本机，不上传到 GitHub。卸载插件会保留此文件，便于之后重新安装使用。

服务仅监听 `127.0.0.1:34931`，由 Magpie 自带的 Bun 启动，页面仍在 Magpie 内打开。保存接口使用本机随机访问凭证校验。端口冲突时在插件 Options 设置 `servicePort`，例如 `34932`，并重新打开页面。

为实现热更新，插件目录还会生成 `runtime.middleware.js` 和 `page/launch.generated.js`；它们含有本机私有数据，已被 Git 忽略。不要上传这些生成文件或本地 `prompts.json`、`service.key`。更新插件会从独立文件重新生成所需缓存。

## 卸载

在 Magpie 的已安装插件中移除“模型提示词”，或运行 `magpie plugin rm magpie-model-prompts`。卸载会停止追加，不会修改客户端的规则文件。

## 开发验证

Node.js 20+：`npm test`。中间件为原生 JavaScript，直接在 Magpie 的 moejs 中执行；本机编辑服务使用 Magpie 自带的 Bun。

## License

MIT。
