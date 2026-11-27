<div align="center">

<img src="https://raw.githubusercontent.com/LUMOGRESS/magpie-agent-Tianshu-harness/master/assets/hero-banner.jpg" alt="Magpie × Tianshu 4.1.54+ Bridge" width="100%" />

# 天枢 Tianshu × Magpie 插件

**将天枢（Tianshu / rivet harness 4.1.54+）桌面端与 CLI 无缝桥接至 Magpie 网关**

*在 Magpie 中自由挑选模型 · 按订阅软件自动分渠道 · 原子同步与一键无损回滚*

<p>
  <a href="https://www.npmjs.com/package/magpie-agent-tianshu-harness">
    <img src="https://img.shields.io/npm/v/magpie-agent-tianshu-harness?color=4f7fff&label=npm&style=flat-square" alt="npm version" />
  </a>
  <img src="https://img.shields.io/badge/Tianshu-%E2%89%A5%204.1.54-38bdf8?style=flat-square" alt="Tianshu 4.1.54+" />
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2020-34d399?style=flat-square" alt="Node 20+" />
  <img src="https://img.shields.io/badge/Dependencies-0-818cf8?style=flat-square" alt="Zero Dependencies" />
  <a href="https://github.com/LUMOGRESS/magpie-agent-Tianshu-harness/blob/master/LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-64748b?style=flat-square" alt="MIT License" />
  </a>
</p>

[快速上手](#30-秒快速上手) · [核心能力](#核心能力一览) · [架构图解](#架构与同步原理) · [分渠道机制](#按订阅自动分渠道与无损回滚) · [排查工具](#诊断与运维命令) · [常见问题](#常见问题)

</div>

---

## 为什么做 2.5.0？

天枢在 **4.1.54+** 中升级了多端数据目录结构（Windows 桌面端便携目录 `TianshuData\.rivet`、桌面端 `launcher.json` 与平台默认目录）、引入了 `provider-keys.json` 缓存层与凭据迁移机制，并增强了本地回环/私网地址访问策略。传统单文件写入插件在 4.1.54+ 下会出现**路径不匹配、模型列表被旧缓存遮蔽、本地网关探测被拦截**等问题。

本插件基于 Magpie 官方双模块规范全新重构，专为 **Tianshu 4.1.54+ 桌面端与 CLI** 打造，实现真正开箱即用的实时双向友好同步。

---

## 核心能力一览

| 能力维度 | 2.5.0 带来的体验 |
| :--- | :--- |
| **全形态自动发现** | 同步覆盖 Windows 桌面便携模式 `TianshuData\.rivet`、桌面端存储设置 `launcher.json`、`RIVET_HOME` 以及平台默认目录，**只装桌面端、没装 CLI 也能自动检出**。 |
| **保留选模型 + 按软件分渠道** | 在 Magpie **Agents** 页和 `magpie tianshu <model>` 均可直接选模型；同步进天枢时自动按订阅前缀拆分为独立 `*-magpie` 渠道，条理清晰、绝不抢占用户手配的 `magpie` 键。 |
| **彻底解决缓存遮蔽与私网拦截** | 联动刷新 `config.json` 与 `provider-keys.json`，严格保证 `provider.name === key` 并自动为本地回环 / 局域网网关注入 `endpointNetworkPolicy`；完整收敛 4.1.54 凭据迁移，不触发死循环重写。 |
| **完整元数据 + 原子无损回滚** | 透传上下文窗口、钳制后 `maxTokens`、视觉能力、推理档位与每百万 token 定价；支持断电恢复日志与跨进程锁重试；取消接入或停用插件时一键恢复原有默认供应商与配置。 |

---

## 架构与同步原理

插件由 **moejs 沙盒入口（`tianshu.agent.js`）** 与 **Magpie Bun 伴生桥接（`index.mjs` + `bridge.mjs`）** 协同工作：

<p align="center">
  <img src="https://raw.githubusercontent.com/LUMOGRESS/magpie-agent-Tianshu-harness/master/assets/architecture.svg" alt="双模块实时桥接架构图" width="100%" />
</p>

1. **意图采集**：在 Magpie 选中或切换模型时，`tianshu.agent.js` 将网关地址、密钥、模型清单与选中模型写入 `~/.config/magpie-tianshu/connection.json`。
2. **多根原子同步**：Magpie 内置的伴生桥接实时监听该控制文件，自动发现所有活跃的天枢 4.1.54+ 数据根并原子写入 `config.json`，同时清理陈旧的托管 `provider-keys.json` 快照，让天枢热加载立即可见最新模型。
3. **迁移零循环**：天枢 4.1.54 加载后会将内联 `apiKey` 自动加密迁移至 `secrets.json`（改写为 `keyRef`）并重建 `provider-keys.json`；桥接层识别该收敛状态后保持 `up_to_date`，不再重复覆写磁盘。

---

## 按订阅自动分渠道与无损回滚

Magpie 聚合的多个订阅源会按模型前缀自动归类到独立渠道，同时完整守护你在天枢里维护的所有自有供应商与个性化配置：

<p align="center">
  <img src="https://raw.githubusercontent.com/LUMOGRESS/magpie-agent-Tianshu-harness/master/assets/channel-sync.svg" alt="按订阅分渠道与无损还原示意图" width="100%" />
</p>

| Magpie 中的模型示例 | 写入天枢的渠道键 | 说明 |
| :--- | :--- | :--- |
| `provider-a/model-pro` | `provider-a-magpie` | 按首个 `/` 前的订阅前缀规范化生成 |
| `provider-b/model-fast` | `provider-b-magpie` | 各订阅独立分组，在天枢设置页一目了然 |
| `auto/default` / 无前缀模型 | `auto-magpie` | 统一归入自动路由分组 |
| 你手配的 `custom-api` / `magpie` / `preset-x: null` | **原样保留** | 绝不占用 `magpie` 键，不覆盖自有供应商、不复活已删除的预设墓碑 |

---

## 30 秒快速上手

### 1. 安装插件

确认已安装 **Magpie** 与 **天枢 Tianshu 4.1.54+**（桌面端或 CLI 均可），运行：

```bash
magpie plugin add magpie-agent-tianshu-harness
```

### 2. 在 Magpie 中选定模型

- **图形界面**：打开 Magpie → 左侧 **Agents** 页 → 找到 **天枢 Tianshu** → 选择任意模型即可自动同步。
- **命令行**：

```bash
magpie models tianshu                  # 查看当前可选模型清单
magpie tianshu provider-a/model-pro    # 选定默认模型并同步到天枢全部数据根
magpie tianshu                         # 查看当前绑定状态
magpie tianshu default                 # 断开接入并无损恢复天枢原有配置
```

### 3. 在天枢中使用

保持 Magpie 运行；在天枢桌面端打开「**设置 → 供应商**」或重新展开模型选择器，即可立即看到最新同步的 `*-magpie` 渠道与默认模型（无需重启天枢后端，新开会话即刻生效）。

---

## 数据目录发现优先级

插件严格复刻天枢 4.1.54+ 的配置定位顺序，同时兼容多安装并存：

| 优先级 | 来源 | 典型路径 |
| :---: | :--- | :--- |
| **1** | 插件显式覆写 | `MAGPIE_TIANSHU_CONFIG` / `MAGPIE_TIANSHU_HOMES`（支持多路径分隔） |
| **2** | 天枢环境变量 | `RIVET_CONFIG_PATH` / `RIVET_HOME` |
| **3** | Windows 桌面端便携模式 | `<安装目录>\TianshuData\.rivet`（自动扫描默认目录与注册表自定义目录，排除受限 `Program Files`） |
| **4** | 桌面端存储设置 | `app.tianshu.desktop/launcher.json` 中配置的 `rivetHome` |
| **5** | 平台默认目录 | Windows：`%LOCALAPPDATA%\.rivet` · macOS / Linux：`~/.rivet` |

<details>
<summary><strong>点击展开：写入天枢 <code>config.json</code> 的 4.1.54 标准结构示例</strong></summary>

```json
{
  "provider": {
    "default": "provider-a-magpie",
    "providers": {
      "auto-magpie": {
        "name": "auto-magpie",
        "baseUrl": "http://127.0.0.1:4321/v1",
        "endpointNetworkPolicy": {
          "origin": "http://127.0.0.1:4321",
          "allowPrivateNetwork": true
        },
        "protocol": "openai",
        "apiKey": "<magpie-gateway-key>",
        "models": [
          {
            "id": "auto/default",
            "contextWindow": 1048576,
            "maxTokens": 65536
          }
        ],
        "userSaved": true
      },
      "provider-a-magpie": {
        "name": "provider-a-magpie",
        "baseUrl": "http://127.0.0.1:4321/v1",
        "endpointNetworkPolicy": {
          "origin": "http://127.0.0.1:4321",
          "allowPrivateNetwork": true
        },
        "protocol": "openai",
        "apiKey": "<magpie-gateway-key>",
        "capabilities": {
          "effortFormat": "reasoning_effort",
          "reasoningSplit": true
        },
        "models": [
          {
            "id": "provider-a/model-pro",
            "contextWindow": 262144,
            "maxTokens": 65536,
            "supportsVision": true,
            "capabilities": {
              "effortFormat": "reasoning_effort",
              "effortLevels": ["low", "medium", "high"],
              "reasoningSplit": true
            }
          }
        ],
        "userSaved": true
      }
    }
  },
  "agent": {
    "defaultModel": "provider-a-magpie:provider-a/model-pro"
  }
}
```

</details>

---

## 诊断与运维命令

随包附带零密钥泄露的 `magpie-tianshu` 命令行工具，便于随时查看多端同步状态：

```bash
magpie-tianshu status     # 只读查看检出的数据根、文件状态与当前托管渠道
magpie-tianshu sync       # 手动立即执行一次全目标同步
magpie-tianshu restore    # 强制移除全部托管渠道并恢复天枢原配置
```

---

## 常见问题

- **为什么在天枢里切换了自己的内置模型，Magpie 后台刷新目录时没有把我改回去？**
  当你在 Magpie 中没有更换选中模型、仅发生订阅模型列表增删时，桥接会尊重你在天枢内手动切换的模型（除非你所选的托管模型已从 Magpie 下线）。
- **绿色便携版解压在非标准盘符下检测不到怎么办？**
  设置环境变量 `MAGPIE_TIANSHU_HOMES`（例如 `<自定义安装目录>\TianshuData\.rivet`）或天枢自带的 `RIVET_HOME`，插件会优先同步该路径。
- **能否与其他天枢 Magpie 插件同时安装？**
  不能。所有天枢插件共用 Agent ID `tianshu`，请在同一台机器上仅保留一个天枢插件。

---

## 开发与校验

```bash
npm run check   # 全模块语法校验
npm test        # 运行单元与多根生命周期集成测试（Node >= 20）
```

## 许可与致谢

本项目采用 [MIT](https://github.com/LUMOGRESS/magpie-agent-Tianshu-harness/blob/master/LICENSE) 开源协议。应用图标源自 [Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness)（`docs/brand/assets/app-icon.svg`），详见 [NOTICE](https://github.com/LUMOGRESS/magpie-agent-Tianshu-harness/blob/master/NOTICE)。
