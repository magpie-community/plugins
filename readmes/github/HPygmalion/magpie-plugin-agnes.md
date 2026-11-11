# magpie-plugin-agnes

> **Agnes AI 国内与国际双版 API 插件，专为 Magpie 设计。轻量免登录浏览器，支持图像模型专属单列抽离与一键「只选免费」。**

---

### 🌟 四大核心亮点

1. **🇨🇳 支持国内与国际双版 API 直连**  
   * **国内版**（`https://api.agnes-ai.cn/v1` · ID: `agnes-cn`）与**国际版**（`https://apihub.agnes-ai.com/v1` · ID: `agnes-ai`）双入口独立管理。  
   * 直接填入对应站点的 API Key 即可使用，无需后台无头 Chrome 抓 Cookie 流程，网络、代理与账号互相隔离，稳定不打架。

2. **🎨 独立「图像模型」抽离展示（对标 Loomy / Antigravity）**  
   * **专属单列抽离**：针对 Agnes 的生图模型（如 `agnes-image-2.5-flash`、`agnes-image-2.1-flash`），通过标准白名单别名（`-imagen` 后缀），使其能被 Magpie 底层 `gateway.Drawers` 精准捕获并自动放置在弹窗底部的**「图像模型」**专属栏目中。  
   * **对话防误选**：生图模型不标记对话免费属性，点击「只选免费」**绝不会误选生图模型**。勾选纯文本模型后切换到「仅所选」视图保存，日常对话列表中只有干净的文本对话模型；生图模型在 Magpie 的「设置 → 图像」中作为主力出图模型勾选使用。  
   * **协议透明还原**：发出请求前自动还原为官方真实 ID（`agnes-image-2.5-flash`），将 `response_format` 规范化放入 `extra_body`，严格保持多图参考图顺序，智能补全尺寸并过滤非标参数。

3. **🌟 标记免费模型与「只选免费」一键过滤**  
   * **免费模型标记**：根据 Agnes 官方定价文档，`agnes-2.5-flash` 与 `agnes-3.0-flash` 当前针对默认（`default`）试用账号提供限时免费体验（¥0 / M），已标记 `free: true`。  
     *注：Agent Plan 用户按刊例价折算 Credits，活动有效期及规则以官方公告和账单为准。*  
   * **一键过滤**：在 Magpie 弹窗中**自动激活并展示绿色的「只选免费」按钮**，点击即可一键勾选全部免费文本对话模型。

4. **⚡️ 512K / 1.0M 大上下文与 64K 单次最大输出**  
   * **真实上下文窗口**：Flash 系列配置 524,288 tokens（512K），Pro 系列配置 1,048,576 tokens（1.0M，药丸右侧显示 `1.0M` 角标）。  
   * **最大回复上限**：全系列文本模型准确配置 **65,536 tokens（64K）** 单次最大输出上限，完整透传给 Agent。  
   * **思考档位齐全**：两站点全系对话模型均默认支持 **`不思考 / 高`**。

5. **🚫 彻底排除视频模型**  
   * 自动且严格过滤掉所有 `agnes-video-*` 视频模型，即使上游后续发布新视频模型也绝不混入对话或出图清单。

---

## 插件概览

| 入口 | Provider ID | API Base URL | 默认预填核心模型 |
| --- | --- | --- | --- |
| 国际版 API | `agnes-ai` | `https://apihub.agnes-ai.com/v1` | 4 个核心文本模型 + 2 个生图模型 |
| 国内版 API | `agnes-cn` | `https://api.agnes-ai.cn/v1` | 4 个核心文本模型 + 2 个生图模型 |

两个入口各自独立管理 API Key。密钥由 Magpie 统一保存，插件不另写凭据文件。

---

## 安装

在 Magpie「扩展 → 插件 → 发现」底部安装框中输入：

```text
github:HPygmalion/magpie-plugin-agnes
```

或使用 Magpie 命令行：

```bash
magpie plugin add github:HPygmalion/magpie-plugin-agnes
```

安装后进入「模型 → 供应商」，点击添加对应入口并填入对应站点的 API Key 即可。

---

## 上游模型动态更新与安全边界

当在供应商界面点击「重新获取模型」时，插件根据上游最新数据安全解析：
* **图像模型**：符合 `agnes-image-*` 或明确输出 image 的模型，自动归入底部的「图像模型」独立区域，别名转换与生图适配器自动生效；
* **对话模型**：已文档化验证的型号附带准确规格；未建档的全新模型将根据上游实际返回的参数进行校验解析，不盲目凭模型名字臆测免费或虚报上下文；
* **视频模型**：自动拦截过滤丢弃，绝不污染列表。

---

## 离线测试

项目自带完整的单元测试套件，使用 Node.js / Bun 原生测试运行器，不发起任何收费或外部网络请求：

```bash
# Node.js
npm test

# 或 Bun
bun test
```

测试覆盖：
- 国际与国内双 Provider 配置与官方 Logo 属性
- 初始预填模型与动态拉取过滤
- 严格排除视频模型，生图模型独立别名与抽离标记
- 免费标志只作用于文本对话模型（确保「只选免费」只选中对话模型）
- 512K/1M 上下文窗口与 64K 输出上限校验，两站点均支持「不思考 / 高」
- 图像生成与编辑的协议转换（`extra_body`、尺寸补全、Data URI 格式化、参考图原序保持）
- 嵌套 mask 拒绝、嵌套图片绕过防御及非法 response_format 校验
- 对话请求透传与跨站隔离拦截

---

## 参考

- [Agnes 国内 API 文档](https://www.agnes-ai.cn/zh-Hans/docs/overview)
- [Agnes 国际 API 文档](https://www.agnes-ai.com/en/docs/overview)
- [Agnes 定价与免费政策](https://wiki.agnes-ai.cn/zh-Hans/docs/pricing.md)
- [Magpie 插件开发参考](https://github.com/yetone/magpie)

MIT License.
