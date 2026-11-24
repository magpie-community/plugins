# index-translate

把哔哩哔哩 Index-Translate 翻译模型接入 magpie / OpenCode。

零 npm 依赖，纯 ESM。7 个模型，150 语种，支持术语表、格式约束、长文档、音节受控；35B 能直接翻图片。公网接口免费，不用填 key。

## 安装

```bash
magpie plugin add github:Qelvoria/magpie-index-translate
magpie plugin login index-translate
magpie provider test index-translate
```

本地开发才需要先 clone：`git clone https://github.com/Qelvoria/magpie-index-translate`，再 `magpie plugin add ./magpie-index-translate`。

## 页面

装上后 magpie 侧边栏会多一个「翻译」页：选模型、改选项（目标语言、翻译约束、术语表），直接在对话框里翻译，流式出字，支持公式渲染。页面基于 magpie-chat 裁剪，翻译请求和 agent 走同一条改写路径。

## 模型

| 模型 | 上下文 | 图片 | 适合 |
| --- | --- | --- | --- |
| Index-Translate-35B-A3B | 24K | ✅ | 默认，质量最好 |
| Index-Translate-9B | 32K | — | 均衡 |
| Index-Translate-2B | 32K | — | 最快 |
| Index-Nailong-9B | 224K | — | 整篇文档 |
| Index-Nailong-2B | 256K | — | 整篇文档 |
| Index-Homura-9B | 32K | — | 配音字幕，音节受控 |
| Index-Homura-2B | 32K | — | 配音字幕，音节受控 |

## 选项

选项可以在 magpie 侧边栏的「翻译」页面里改。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| base | https://index-translate.bilibili.com/v1 | 上游地址，也可填自建 vLLM |
| target | auto | 固定目标语言，或 auto 自动识别 |
| instruction | 空 | 额外的翻译约束 |
| glossary | 空 | 术语表，`原文：译名`，一行一条 |

也可以直接在命令行翻译：`bun bin/cli.mjs "文本" -t zh`

## 浏览器桥

不用 magpie 也能用：双击 `bridge/serve.bat` 起本地网桥（默认 127.0.0.1:8080），给沉浸式翻译这类浏览器插件直连公网接口用。magpie 里不需要它。

## 注意

- 翻译模型不调用工具，也没有通用对话能力。
- 公网接口没有 SLA，别把敏感内容交给它。
- 改完插件代码要 `magpie plugin off` 再 `on`，或重启 magpie。

## 许可

Unlicense。第三方许可见仓库内说明。
