# magpie-haoyue

<div align="center">

# 皓悦 API · Magpie 供应商插件

**针对 [皓悦 API (1pkapi.com)](https://1pkapi.com) 定制的一站式多分组聚合供应商插件**

[![GitHub Repo](https://img.shields.io/badge/GitHub-Jiao77%2Fmagpie--haoyue-181717?style=flat-square&logo=github)](https://github.com/Jiao77/magpie-haoyue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue?style=flat-square)](https://usemagpie.ai)

</div>

---

## 📖 简介与背景

[皓悦 API (1pkapi.com)](https://1pkapi.com) 是定位为“订阅转 API 平台”（Subscription to API Conversion Platform）的高可用 AI 网关服务。在皓悦 API 控制台中，为了保障路由隔离与并发性能，平台将可用模型划分为了四大核心分组：

1. **Anthropic**：Claude 系列专属分组（如 `claude-3-5-sonnet`, `claude-opus-5-5` 等）
2. **OpenAI**：ChatGPT / GPT 系列专属分组（如 `gpt-4o`, `o1`, `gpt-5.5`, `gpt-6.1` 等）
3. **国产模型**：DeepSeek、通义千问 Qwen、智谱 GLM、月之暗面 Kimi、MiniMax 等
4. **其他模型**：xAI Grok、Google Gemini、Composer、Llama 等

在皓悦 API 中，**每个分组通常生成并使用独立的 API Key**。

### 为什么需要本插件？

如果使用通用的 sub2api 插件接入，每个分组 Key 都必须在 Magpie 中录入为一个独立账号：
- ❌ **卡片冗余刷屏**：在 Magpie 的“额度 (Quota)”面板中会同时堆叠 4~5 张重复显示相同钱包余额的卡片；
- ❌ **模型调用割裂**：不同分组的模型分散在不同的账户或插槽下，无法在单一供应商下自由调用全部分组模型。

**`magpie-haoyue` 插件专为解决此痛点而设计**：
- ✅ **单账号聚合全部分组**：一个“皓悦API”账号即可同时绑定四大分组的所有密钥；
- ✅ **按模型智能分发路由**：客户端发起请求时，插件通过 `chat.headers` 钩子自动识别目标模型所属厂商，动态注入对应分组的鉴权密钥；
- ✅ **清爽单卡片额度面板**：Magpie 额度面板仅展示一张整洁的统一卡片，直观显示中转站总钱包余额；
- ✅ **全模型一览可用**：自动聚合所有 54+ 模型，统一挂载在 `haoyue/<model_id>` 命名空间下。

---

## 🚀 安装方法

在终端中执行以下命令直接从 GitHub 安装：

```bash
magpie plugin add github:Jiao77/magpie-haoyue
```

或者打开 Magpie 客户端，进入 **插件 › Discover (发现)**，搜索 `haoyue` 或 `皓悦` 即可一键安装。

---

## 🔑 登录与配置指南

### 1. 命令行快速登录

运行以下登录命令：

```bash
magpie plugin login haoyue
```

命令行将提供友好的交互式引导，依次录入：
1. **皓悦 API Key**：主密钥（填入任一分组的有效 Key，作为默认鉴权）
2. **Anthropic / Claude 分组 API Key**（选填，无则按回车跳过）
3. **OpenAI / ChatGPT 分组 API Key**（选填，无则按回车跳过）
4. **国产模型 分组 API Key**（选填，无则按回车跳过）
5. **其他模型 (Gemini/Grok) 分组 API Key**（选填，无则按回车跳过）
6. **账号备注名称**（可选，默认为“皓悦主账号”）

> **提示**：如果在主密钥中直接粘贴了多个以逗号或换行分隔的 Key，插件也会自动提取并解析！

### 2. 在 Magpie 客户端界面中配置

打开 Magpie 桌面应用，在 **Providers（供应商）** 列表中找到 **皓悦API** 卡片，点击后即可在弹出的表单中直观填入或修改各分组密钥。

---

## 📊 支持的模型分类与路由示例

| 分组类别 | 包含模型示例 | 自动路由规则 |
|---|---|---|
| **Anthropic / Claude** | `claude-3-5-sonnet`, `claude-opus-5-5`, `claude-fable-5`... | 优先使用 Claude 分组密钥，走 Anthropic 协议 |
| **OpenAI / ChatGPT** | `gpt-4o`, `o1-preview`, `gpt-5.5`, `gpt-6.1-sol`... | 优先使用 OpenAI 分组密钥，走 OpenAI Responses 协议 |
| **国产模型** | `deepseek-v4.1-flash`, `qwen3.8-max`, `glm-5.3`, `kimi-k3`... | 优先使用国产模型分组密钥，走 OpenAI Compatible 协议 |
| **其他模型** | `grok-4.5`, `grok-build-latest`, `composer-2.5`... | 优先使用其他模型分组密钥，走 OpenAI Compatible 协议 |

---

## 🛠 本地开发与测试

运行内置的自动化单元测试：

```bash
node test/test.mjs
```

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
