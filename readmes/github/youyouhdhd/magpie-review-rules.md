# Claude Desktop 审核与模型规则

<details>
<summary>文档信息</summary>

版本：v1.9  
初版时间：2026-11-09 18:52:50（UTC+08:00，Asia/Shanghai）  
最后更新时间：2026-11-12 09:36:32（UTC+08:00，Asia/Shanghai）  
版本修改记录：

- v1.9：补充功能介绍、配置示例、规则执行顺序和常见问题，完善首次使用说明。
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

**为 Claude Desktop 固定自动模式审核模型，并为第三方模型配置请求参数兼容规则。**

Claude Desktop Review & Model Rules 是 Magpie 插件。你可以继续在 Desktop 中切换对话模型，同时让操作审核使用单独指定的模型；也可以为名字不符合 Claude 命名方式的第三方模型，手动选择兼容预设或编写自定义规则。

所有设置都在 Magpie 原生插件页面完成，复用现有供应商、路由组、模型列表、主题和配置存储。**首次安装不固定审核模型，兼容规则为空；保存配置后才开始改写相应请求。**

English: A Magpie plugin that pins Claude Desktop's action-review model and applies per-model request compatibility presets or sandboxed JavaScript rules.

## 可以做什么

| 功能 | 使用效果 |
| --- | --- |
| 固定操作审核模型 | 切换 Desktop 对话模型时，识别到的审核请求仍使用你指定的模型 |
| 按模型配置兼容预设 | 按实际上游能力处理思考、输出和采样参数，不依赖第三方模型名称 |
| 追加自定义规则 | 在预设之后调整请求，或选择只运行自定义 JavaScript |
| 复用现有模型列表 | 搜索模型名称、模型 ID 或供应商，无需重新填写接口地址和密钥 |

两项主要功能可以独立使用：可以只固定审核模型，也可以只启用参数兼容规则。

## 安装

需要 Magpie 0.1.3371 或更新版本，并已将 Claude Desktop 接入 Magpie。先在 Magpie 中配置好要使用的供应商和模型，再安装插件：

```sh
magpie plugin add npm:magpie-review-rules
```

也可进入源码目录安装。Magpie 直接引用此目录，安装后请保留它：

```sh
magpie plugin add .
```

Windows 可运行 `install.ps1`；Magpie 不在 PATH 时，用 `-Magpie` 指定可执行文件。

安装后，在 **插件 → Claude Desktop 审核与模型规则** 中打开设置页。也可在 [Magpie 社区目录](https://github.com/magpie-community/plugins) 搜索 `Claude Desktop` 或 `magpie-review-rules`。

## 快速配置

### 1. 固定操作审核模型

1. 保持页面顶部“启用插件规则”开启。
2. 开启“固定审核模型”。
3. 从模型列表中选择审核模型，可以选择具体供应商模型或路由组。
4. 点击“保存并应用”。

审核模型应能理解操作审核提示，并返回 Claude 所要求的判定格式。保存后，新识别到的操作审核请求会改用它；普通对话继续使用 Desktop 中选择的模型，无需重启 Desktop。

### 2. 为第三方模型添加兼容规则

1. 在“模型兼容规则”中点击“＋ 添加规则”。
2. 填写规则名称，选择一个或多个具体供应商模型。
3. 在“按哪种模型规则处理？”中选择与上游实际能力匹配的预设。
4. 如需进一步调整，开启“追加自定义 JavaScript”，填写代码。
5. 点击“保存并应用”。

例如，某个第三方模型在列表中的名称是 `example-provider/review-model`，实际接口要求使用 Sonnet 5.5 的思考参数：将它选为目标模型，再选择“Claude Sonnet 5.5”预设即可。这里的模型 ID 是示例；配置时直接从自己的现有模型列表中选择。

兼容规则使用最终供应商的 `provider/model` 精确匹配。使用路由组时，需要把可能实际选中的供应商模型加入规则。模型名称相似或包含 `claude` 都不会自动触发预设。

### 请求如何经过规则

操作审核请求先切换到固定审核模型，再由 Magpie 选择具体供应商，最后执行匹配该供应商模型的兼容规则。普通对话跳过审核模型切换，仍可执行匹配的兼容规则。

多条规则按页面顺序执行；每条规则先应用预设，再运行自定义代码。后面的规则可以继续修改前面规则的结果。用上移、下移按钮调整顺序。

## 参数预设

| 预设 | 行为 |
| --- | --- |
| Claude Sonnet 5.5 | 预算思考转为 adaptive；关闭思考时使用 between_tools；移除采样参数 |
| Claude Opus 5.5 | 使用 adaptive，为短回复增加输出空间，移除采样参数 |
| Claude Haiku 5.5 | 预算思考转为 adaptive；关闭或未指定思考时使用 disabled；移除采样参数 |
| Claude Adaptive | 预算思考转为 adaptive；关闭或未指定思考时也启用 adaptive；保留采样参数 |
| 仅运行自定义 JavaScript | 只执行填写的代码 |

“移除采样参数”指删除 `temperature`、`top_p`、`top_k`。预算思考转为 adaptive 时会移除 `budget_tokens`，并在未指定 effort 时按预算设置 effort。Opus 和通用 Adaptive 预设在原输出上限较小时还会增加输出空间。

这些名称表示插件内置的参数处理方式。按上游接口实际支持的参数选择预设；预设不会改变第三方供应商实际提供的模型能力。插件处理 Claude Desktop 的 Anthropic Messages 请求，Magpie 随后按供应商协议转换和发送。

## 自定义规则

先选择目标模型，再开启“追加自定义 JavaScript”。如果需要完全自己控制参数，选择“仅运行自定义 JavaScript”预设。

`body` 是请求 JSON。`ctx` 包含 `agent`、`protocol`、`provider`、`model` 和 `review`，不提供供应商密钥。`ctx.model` 是最终的 `provider/model`；`ctx.review` 表示是否识别为操作审核请求。

仅为审核请求增加输出上限：

```javascript
if (ctx.review) {
  body.max_tokens = Math.max(body.max_tokens || 64, 128);
}
return body;
```

按上游要求启用 adaptive 并移除采样参数：

```javascript
body.thinking = { type: "adaptive" };
delete body.temperature;
delete body.top_p;
delete body.top_k;
return body;
```

可以修改 `body`，也可返回新的请求对象。代码在 Magpie 的 moejs 沙箱中执行，不支持网络、文件或异步 Promise。规则未变化时复用编译结果，缓存不保存请求内容。

格式和语法错误会在路由前返回错误。运行异常或超时时，Magpie 保留钩子执行前的请求并记录错误；单个钩子有 250 ms 时限。请使用自己理解的规则。

## 常见问题

### 切换对话模型后，审核还是跟着变了？

确认页面顶部开关和“固定审核模型”均已开启，并点击过“保存并应用”。该功能只改写识别到的操作审核请求。

识别条件为：请求没有工具定义、system 包含 `<block>` 或 `<severity>`，并有以 `<transcript>` 开头的 user 消息。若 Desktop 更改了审核提示结构，需要同步调整插件的识别逻辑。

### 出现 `Configured model not available` 怎么办？

先看错误的 Details 或上游响应。若模型未配置、已移除或没有访问权限，在 Magpie 中检查目标供应商模型；若上游明确提示 `thinking`、`adaptive` 或 `between_tools` 参数不兼容，为实际选中的供应商模型配置对应预设。固定审核模型和参数兼容规则可以同时启用。

### 模型列表为空，或刚添加的模型没出现？

确认 Magpie 网关正在运行，且模型已在 Magpie 中启用。列表每 15 秒同步一次；等待同步后点击“刷新模型列表”，或重新打开插件页。安装目录需要可写，页面才能读取生成的模型目录。

### 规则没有生效？

检查规则开关、目标模型和执行顺序。规则匹配实际供应商模型；路由组名称不能代替最终模型。兼容规则会作用于该模型的审核和普通对话请求；若只想修改审核请求，在自定义代码中使用 `if (ctx.review)`。

### 如何恢复默认行为？

关闭“固定审核模型”并停用兼容规则，或关闭页面顶部“启用插件规则”，然后“保存并应用”。“放弃未保存修改”只撤销尚未保存的编辑。升级保留已有配置。

## 数据与打包

- 配置由 Magpie 保存。插件没有独立的遥测或配置上传服务；模型请求仍由 Magpie 发送给你配置的供应商。
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

停用可使用页面顶部开关或插件管理页。卸载：

```sh
magpie plugin rm magpie-review-rules
```

## License

[MIT](LICENSE)
