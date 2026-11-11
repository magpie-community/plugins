# Gemini-web-all

把Gemini官网对话、官网原图生图、原有AI Studio接入和登录管理整合为一个Magpie供应商插件。基于 magpie-gemini-web 0.8.0；详见[致谢](NOTICE.md)。

## 能力

- Magpie Settings → Images → Image generation 中选择 `gemini-web/gemini-web-pro-image`（Gemini 官网生图 · Pro）。
- 使用Magpie原有generate_image，支持参考图；生成后台运行；会话续用和原图下载按需启动无界面浏览器，完成后关闭。
- 原图必须经官网完整尺寸RPC下载，不回退预览图，不本地放大。已验证2752×1536；不承诺4K，quality不映射为官网质量档位。
- 保留 `gemini-web` / `ai-studio` 供应商ID与原数据目录，已有登录无需重新复制Cookie。
- 新增“自动登录（独立持久化账号）”：用户完成Google登录后保留独立浏览器目录，并按账号身份绑定；日常无窗口运行。不会读取日常浏览器，也不会自动填写密码或绕过验证码。Google可能拒绝自动化浏览器；原Cookie导入入口保留作为回退。

## 安装

```sh
magpie plugin add github:yumi233/Gemini-web-all
```

Magpie按package.json入口加载供应商；首次生图或自动登录时按需初始化Python运行环境（需安装uv）。后续可用 `magpie plugin update` 获取仓库更新。本项目未发布到npm或公共插件目录。

### 本地安装

本版实测macOS，要求Magpie、uv、Python3.12运行环境。运行 `sh install.sh`，安装固定Python依赖并通过 `magpie plugin add` 注册当前目录。登录与原图下载需要浏览器；优先复用本机Chrome或Playwright缓存，找不到时可安装 `playwright install chromium`。

Runtime：`~/.local/share/gemini-web-all/venv`，可通过GEMINI_WEB_ALL_RUNTIME指定。官网对话账号数据库仍由原生后端维护于 `~/.local/share/magpie-gemini-web`；AI Studio数据目录沿用原插件。凭据不打包、不进入Git。

原插件迁移：先安装并确认模型和账号工作，再停用旧magpie-gemini-web，保留账号目录。旧gemini-web-images MCP登记可移除。禁止先删除账号数据库或退出Google登录。

## 限制

- 模型名是官网Pro档位别名，不证明底层图片模型的具体版本。
- 单账号图片任务单并发；失败不自动跨账号重试。进程中断先核查官网历史，避免重复生成。
- 官网协议可能变化；依赖固定版本，升级需再次验收。
- 首次绑定完整浏览器环境需用户在独立窗口登录；旧Cookie和账号记录保留。旧版已删除的临时浏览器环境不能由Cookie完整恢复。
- 首版仅验证macOS，非跨平台承诺。

## 鸣谢

感谢BUKOWSKIREAL、HanaokaYuzu、zexadev、Mag1cFall及各项目贡献者，以及Magpie作者yetone。保留上游源码和许可证，见[NOTICE.md](NOTICE.md)。

## 本机验收

2026-10-31：在Magpie原生generate_image工具中，gemini-web/gemini-web-pro-image已出现，使用既有登录上传家具参考图生成成功；官网原图2752×1536，经Magpie保存。流式响应兼容已验证。Google自动登录端到端未重做，仅测试隔离浏览器启动与合成Cookie获取，避免要求现有用户重新登录。

## 登录状态说明

若官网返回 UNAUTHENTICATED，插件会明确提示重新登录，不将访客模式的Flash Lite列表解释成订阅权限或Pro额度耗尽。账号卡片存在、数据库状态enabled并不能证明官网会话仍有效。

仓库已设置 `magpie-plugin` GitHub主题，符合Magpie社区仓库发现条件；是否立即出现取决于GitHub索引与Magpie缓存，不代表官方精选或审核背书。

## 0.1.1 状态

自动登录现在返回官网识别的账号邮箱，防止共用本地后端API Key时多个账号被合并。已有本地会话可通过“添加本地后端里已有的 Google 账号”重新关联，无需获取新Cookie。已使用三个现有会话验证能够识别三个不同账号；未重新执行密码登录。

最新生图回归中，官网生成阶段通过，但完整尺寸下载返回HTTP 403，尚未修复；不应将本版描述为生图链路已恢复。错误记录已区分失败阶段和HTTP状态。

## 0.2.0 持久化登录与原图下载

- 每个账号使用独立持久化浏览器目录及锁；身份不匹配时拒绝使用，不跨账号回退。
- 登录后保留浏览器存储；优先保留旧账号库中有效的生成会话；确认失效后才尝试对应浏览器Cookie，不覆盖旧账号数据库。
- HTTP原图下载失败后，从同一账号的浏览器会话读取完整尺寸RPC结果；仍不回退预览图。
- 已生成图片的恢复信息仅保存在本机私有runtime中；`python/recover.py` 接受标准输入 `{"job_id":"..."}`，只重试下载，不再次生图。
- 2026-10-31：用户真实登录一个已有账号后，家具参考图生成及持久化浏览器原图下载成功，实测2752×1536、2881855字节，总耗时66.92秒。多账号隔离通过本地测试；第二账号端到端按用户要求暂缓。
- 私有浏览器目录：`~/.local/share/gemini-web-all/profiles`。不要提交或分享其中内容。

上面的0.1.1下载403状态为旧版记录；0.2.0增加已实测的浏览器下载路径，并不保证Google未来协议不变。

## 0.2.1 参考图格式

Magpie内联参考图按真实文件格式保存扩展名，保证上游上传使用图片MIME类型；官网无图片回复保存到本机私有诊断目录，禁止盲目自动重试。

## 0.2.2 保留有效生成会话

修正0.2.0/0.2.1总是替换生成Cookie的回归：有效的原会话继续用于生成，持久化浏览器用于原图下载；仅在确认原会话失效时读取对应浏览器Cookie。完整JS适配层实测通过：上传家具参考图，生成36.03秒，原图下载33.95秒，总耗时约75秒，2752×1536。8项本地测试通过。
