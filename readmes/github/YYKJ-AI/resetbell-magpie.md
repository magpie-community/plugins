<p align="center"><img src="page/icon.svg" width="64" height="64" alt="Reset"></p>

# Reset 雷达 · Reset Radar

在 Magpie 里，关注你正在使用的 AI 厂商。

GPT、Claude、Kimi、Grok、DeepSeek，五选一关注公开额度重置、发卡与规则变化。
无需注册，不读取个人账户，也不需要提供 API Key。

显示最近已收录且核验通过的重置／发卡公告；没有记录不代表从未发生。
官方文档权益展示核对时间、适用条件和证据，不当成一次新发卡，也不补发历史提醒。

## 界面预览

![Reset 雷达桌面版](https://raw.githubusercontent.com/YYKJ-AI/resetbell-magpie/main/docs/screenshots/dashboard-zh-1200.png)

![服务管理页](https://raw.githubusercontent.com/YYKJ-AI/resetbell-magpie/main/docs/screenshots/manage-zh-1200.png)

## 安装

适用于 macOS 和 Magpie 0.1.2181 及以上版本。

打开 **Magpie → 插件 → 发现**，在 GitHub 社区插件列表搜索 **Reset**、
**Reset 雷达** 或 **Reset Radar**，选择 **Reset 雷达** 安装。
社区索引可能延迟；搜索不到时，在插件安装入口粘贴：

```text
github:YYKJ-AI/resetbell-magpie
```

也可使用一条安装命令：

```sh
magpie plugin add github:YYKJ-AI/resetbell-magpie
```

安装后，从侧栏打开 **Reset 雷达**，选择一家厂商即可。
不需要下载网站项目，也不需要自行配置服务。

## 使用

- **只关注一家**：随时切换 GPT、Claude、Kimi、Grok 或 DeepSeek；GPT 统一使用与网站相同的 ChatGPT 图标。
- **服务管理**：主页点击「更换」进入二级页面；管理页是唯一厂商选择入口，切换成功后自动回到主页。
- **一体监控**：厂商品牌、上次公开重置、近 30 天刻度和最近五条已确认公开重置集中展示；记录可展开适用范围与原文，预告、付费重置和第三方观测不计为公开完成。
- **精简布局**：品牌图标与名称居中对齐，左右面板标题统一字级和高度；移除通知与同步设置区，最近记录填充左侧空间。滚动条隐藏但仍可正常滚动，手机及短窗口自然纵向浏览。
- **分类变化**：按额度重置、额度权益、规则变化筛选，先筛选类型，再显示最近 5 条；保留适用范围、状态与原文入口，不展示模型发布新闻。
- **统一品牌**：交互使用 Reset 官网青绿主题色，背景与文字适配 Magpie 明暗模式，保留彩色厂商图标。
- **持续更新**：默认每 5 分钟检查，保留手动刷新；已有安装保留此前保存的检查频率。失败时自动退避，服务端重试提示优先；本机检查频率不改变上游采集速度。
- **离线可看**：连接中断时保留上次内容，并明确提示未更新。

Magpie 运行时持续关注，关闭插件页面不影响监控；退出 Magpie 或电脑休眠时，
首次安装的插件不能继续检查。重新打开后恢复。
1.4.1 起界面不再提供通知、测试提醒或检查频率设置；既有后台偏好与兼容接口保留，
更新不会自动修改通知开关或系统权限。

公开公告不证明个人额度到账。预告、第三方观察与官方完成状态会分别展示。

## 隐私

此客户端只读取 Reset 已公开的信息，不读取 Magpie 的账号、供应商密钥、
聊天记录或个人额度。选择和缓存保存在你自己的电脑上。
通知默认关闭，不自动更改系统权限。

## 网站与支持

- [Reset 网站](https://resetbell.dev)
- [报告问题](https://github.com/YYKJ-AI/resetbell-magpie/issues)

---

Follow public AI quota and usage changes inside Magpie; model launch news is excluded.
Install `github:YYKJ-AI/resetbell-magpie`, open **Reset Radar**, and choose
GPT, Claude, Kimi, Grok or DeepSeek. No login or personal API key required.
Manage five providers, view the latest five updates, filter by category and read original posts,
review the latest five completed public resets with original evidence in a balanced monitoring panel,
and refresh manually or use automatic checks (every five minutes by default).
The simplified interface has no notification or refresh-rate settings; existing background preferences are preserved.
macOS / Magpie 0.1.2181+.
