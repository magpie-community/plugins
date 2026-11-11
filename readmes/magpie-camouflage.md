# 伪装 (Magpie Camouflage)

[![GitHub](https://img.shields.io/badge/GitHub-zrtzrt%2Fmagpie--camouflage-blue?logo=github)](https://github.com/zrtzrt/magpie-camouflage)
[![npm](https://img.shields.io/npm/v/magpie-camouflage?color=red&logo=npm)](https://www.npmjs.com/package/magpie-camouflage)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

专为 [Magpie](https://github.com/yetone/magpie) 设计的全解耦**提示词伪装与特征过滤中间件及控制面板 (Page & Gateway Middleware)**。

发往指定供应商的请求自动加上伪装提示词；由指定客户端发出的请求自动屏蔽其专有特征词。

<p align="center">
  <img src="docs/images/screenshot.png" alt="Magpie Camouflage 控制面板预览" width="720" />
</p>

---

## ⚠️ 重要声明与风险警示 (Risk Warning & Disclaimer)

> [!CAUTION]
> **本插件仅在应用层（Application Layer）对请求体中的提示词（System Prompt、Messages）进行文本附加与特征词剔除。**
>
> **请务必知悉：大模型供应商依然可以通过诸多底层网络协议指纹和行为特征识别非官方客户端，包括但不限于：**
> 1. **TLS / 网络传输层指纹（JA3 / JA4 / ClientHello）**：官方客户端（基于特定版本的 Electron、Chromium、Node 或 Go BoringSSL 编译构建）拥有不可篡改的加密套件序列（Cipher Suites）、扩展序列（Extensions）、ALPN 顺序与握手特征，这些传输层指纹无法单纯通过代理或修改请求头伪造。
> 2. **HTTP/2 协议栈特征**：SETTINGS 帧的协商顺序、初始窗口大小（WINDOW_UPDATE）、HPACK 标头压缩字典等由底层网络库直接决定的指纹。
> 3. **HTTP Header 矛盾与顺序**：客户端专属标头排序、大小写形态、缺失必要私有鉴权头，或 Header 声称的客户端版本与 TLS 握手底层特征存在直接矛盾。
> 4. **行为交互指纹**：Token 流式消费时序、心跳包时延、自动化工具调用的固定模板与上下文长度突变。
>
> **使用本插件并不代表能规避供应商风控与封号检测。由此产生的一切账号受限、封禁或服务终止等后果由使用者自行承担，风险自担。本项目仅供技术探索与个人学习交流使用，严禁用于任何违反各模型服务商服务协议（Terms of Service）的用途。**

---

## 🌟 核心功能

* **全解耦伪装机制**：
  * **供应商附加规则**：所有发往指定供应商（渠道）的请求，自动在系统最前端附加上目标供应商要求的身份、格式及工作流指令。
  * **客户端屏蔽规则**：所有由本机指定客户端（如 DeepSeek Harness、Antigravity 等）发出的请求，自动清洗抹除自带的系统提示词特征（留空即自动剔除，亦可替换）。
* **对标 Magpie 官方体验**：
  * 深色/浅色主题自适应（支持 Magpie 设计系统 Token 与 PostMessage 协议联动）；
  * 多语言国际化（i18n）适配（支持中文、繁体、英文、日文）；
  * 本地真实 Agent 自动检测，拒绝展示无关或未安装的冗余项。
* **从真实会话一键划选提取**：
  * 提取本机真实运行的 Agent 上下文；
  * 支持鼠标框选任意特征词段，一键转为屏蔽规则。
* **实时拦截与替换历史对比**：
  * 提供完整的替换前后（Before / After）文本对比；
  * 准确显示发往的真实供应商渠道及命中的脱敏特征数。

---

## 📦 安装方式

### 方式 1：Magpie 插件市场直接安装（推荐）
在 Magpie 桌面端的 **「插件」->「发现」** 页面搜索 `伪装` 或 `camouflage`，点击一键安装。

### 方式 2：通过 GitHub 安装
打开终端执行：
```bash
magpie plugin add github:zrtzrt/magpie-camouflage
```

### 方式 3：通过 npm 安装
打开终端执行：
```bash
magpie plugin add magpie-camouflage
```

---

## 🛠️ 本地开发与调试

```bash
# 克隆仓库
git clone https://github.com/zrtzrt/magpie-camouflage.git
cd magpie-camouflage

# 以本地源码形式挂载至 Magpie
magpie plugin add .

# 启动实时历史与 Agent 同步守护进程
node daemon.mjs
```

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
