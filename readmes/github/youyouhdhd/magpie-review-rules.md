# Claude Desktop 审核与模型规则

版本：v1.8  
初版时间：2026-11-09 18:52:50（UTC+08:00，Asia/Shanghai）  
最后更新时间：2026-11-10 21:00:24（UTC+08:00，Asia/Shanghai）  
版本修改记录：

<details>
<summary>文档信息</summary>

- v1.8：精简公开使用说明，折叠文档版本信息。
- v1.7：精简发行文件并增加发行检查。
- v1.6：统一 Claude Desktop 显示名称。
- v1.5：缓存规则编译结果，增加规则变更及语法错误恢复测试。
- v1.4：补充公开版本安装验证。
- v1.3：加入社区发现说明。
- v1.2：完善安装与反馈说明。
- v1.1：采用通用默认配置、MIT 许可证和发行文件白名单。
- v1.0：提供审核模型选择、Claude 参数预设和自定义规则页面。

</details>

**Claude Desktop Review & Model Rules** is a Magpie plugin for choosing Claude Desktop's action-review model independently of its conversation model. It also supports explicit model compatibility presets and optional sandboxed JavaScript rules. Fresh installs do not rewrite requests until configured.

为 Claude Desktop 自动模式固定操作审核模型，并为第三方模型指定参数兼容规则。通过 Magpie 原生插件页面配置，复用主题、现有模型目录和配置存储。

## 安装

需要 Magpie 0.1.3371 或更新版本，并已将 Claude Desktop 接入 Magpie。

```sh
magpie plugin add npm:magpie-review-rules
```

也可进入源码目录安装。Magpie 直接引用此目录，安装后请保留它：

```sh
magpie plugin add .
```

Windows 可运行 `install.ps1`；Magpie 不在 PATH 时，用 `-Magpie` 指定可执行文件。

## 配置

打开 **插件 → Claude Desktop 审核与模型规则**：

1. 启用“固定审核模型”，从现有模型列表选择能返回 Claude 审核判定格式的模型。
2. 如需参数适配，添加规则，选择具体供应商模型和对应预设。
3. 保存并应用，新请求立即使用保存的配置。

首次安装默认不固定审核模型，兼容规则为空。升级保留已有配置。固定模型只用于识别到的操作审核请求，普通对话继续使用原请求中的模型。

审核模型选择器支持现有供应商和路由组。兼容规则按最终选中的具体 `provider/model` 精确匹配，不从模型别名推断能力。多条规则按页面顺序执行。

## 参数预设

| 预设 | 行为 |
| --- | --- |
| Claude Sonnet 5.5 | 预算思考转为 adaptive；关闭思考时使用 between_tools；移除采样参数 |
| Claude Opus 5.5 | 使用 adaptive，为短回复增加输出空间，移除采样参数 |
| Claude Haiku 5.5 | 开启思考时使用 adaptive；关闭时使用 disabled；调整 effort 并移除采样参数 |
| Claude Adaptive | 转换思考参数，保留采样参数 |
| 仅运行自定义 JavaScript | 只执行填写的代码 |

按上游接口实际支持的参数选择预设。插件只处理 Claude Desktop 的 Anthropic Messages 请求，Magpie 随后按供应商协议转换和发送。

## 自定义规则

`body` 是请求 JSON。`ctx` 包含 `agent`、`protocol`、`provider`、`model` 和 `review`，不提供供应商密钥。

```javascript
if (ctx.review) {
  body.max_tokens = Math.max(body.max_tokens || 64, 128);
}
return body;
```

可以修改 `body`，也可返回新的请求对象。代码在 Magpie 的 moejs 沙箱中执行，不支持网络、文件或异步 Promise。规则未变化时复用编译结果，缓存不保存请求内容。

格式和语法错误会在路由前返回错误。运行异常或超时时，Magpie 保留钩子执行前的请求并记录错误；单个钩子有 250 ms 时限。请使用自己理解的规则。

审核请求通过提示结构识别：无工具定义、system 包含 `<block>` 或 `<severity>`，并有以 `<transcript>` 开头的 user 消息。

## 数据与打包

- 配置由 Magpie 保存，插件不上传配置或会话，不包含遥测。
- 本机模型目录每 15 秒同步一次，只供配置页面使用；生成的 `page/catalog.js` 不提交、不打包。
- npm 发行包仅包含运行文件、安装脚本、使用说明和许可证。
- Git 忽略本机模型目录、凭据配置、日志和压缩包。请使用 `npm pack` 制作发行包。
- 模型目录写入插件安装目录，该目录需要可写。

## 开发与验证

源码测试需要 Node.js 20+ 和 npm。

```sh
npm test
npm pack
npm run test:install -- --magpie "<magpie-executable>"
```

打包前自动执行发行检查。隔离安装测试使用独立配置和本机模拟接口，日志留在临时测试目录。

## 社区发现与卸载

本插件已被收录到 [Magpie 社区目录](https://github.com/magpie-community/plugins)。在插件页搜索 `Claude Desktop` 或 `magpie-review-rules`。

停用可使用页面顶部开关或插件管理页。卸载：

```sh
magpie plugin rm magpie-review-rules
```

## License

[MIT](LICENSE)
