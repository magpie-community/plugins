# WPS Comate for magpie

一个非官方的 magpie 供应商插件，用你自己的 WPS Comate 账号调用套餐内的模型。支持按账号加载模型列表、流式对话和查询额度。上游接口可能随 Comate 更新而变化。

## 1. 安装插件

从 GitHub 安装。

```sh
magpie plugin add github:Sn1derhere/opencode-wps-comate-auth
```

如果已经下载或克隆仓库，在包含 `package.json` 的仓库根目录执行 `magpie plugin add .`。

图形界面也可以在 **插件 → 添加插件** 中填入仓库地址或本地目录。安装方式见 [magpie 插件文档](https://usemagpie.ai/docs/zh/plugins)。

## 2. 准备自己的会话凭据

添加账号前需要准备有 Comate 使用权限的 WPS 账号的 `wps_sid`。凭据由用户自行提供。

1. 在 Chrome 打开 WPS Comate 官网，点击 **在线使用**，登录自己有 Comate 使用权限的 WPS 账号。[WPS Comate 官网](https://comate.wps.cn/)
2. 按 `F12`，打开 **应用（Application）→ 存储 → Cookie**，选择当前 Comate 网页的站点。如果看到 `wps_sid`，只复制其 **Value**。[Chrome Cookie 面板说明](https://developer.chrome.com/docs/devtools/application/cookies)
3. 把值粘贴到下一步的 Magpie 登录提示框。网页会话能否用于 Comate，以登录和供应商测试的结果为准。

## 3. 登录、验证和使用

在 Magpie 的 **插件 → WPS Comate → 登录** 中粘贴 `wps_sid`，或运行下面的登录命令。命令会提示输入且隐藏内容。

```sh
magpie plugin login wps-comate
magpie provider test wps-comate
magpie quota
```

在 magpie 的供应商页面查看账号可用的模型，在 agent 中使用 `wps-comate/<模型名>`，例如 `wps-comate/glm-5.3`（以实际列表为准）。如果模型列表暂时无法加载，插件会保留现有列表。

## 凭据与请求

- `wps_sid` 是账号会话凭据。只在登录提示框中输入，避免把它放进命令参数、仓库、截图或 Issue。
- magpie 将登录信息保存在本地配置目录的 `plugin-auth.json` 中。插件登录时只保存规范化的 `wps_sid` 和校验状态。若以前用过会保存账号资料的旧版本，可在 magpie 中退出该账号后重新登录。
- 模型列表、额度和对话请求发往 `https://comate.wps.cn`。对话正文会发送给 WPS Comate 处理，并按账号套餐计入用量。插件会阻止请求重定向。
- 自动化环境可以由运行环境安全注入 `WPS_SID`。已保存的 magpie 登录优先。旧版若通过插件选项填写凭据或指定凭据文件，请改用登录提示框，并从旧配置中删除敏感值。

## 排错

| 现象 | 处理 |
| --- | --- |
| 登录被拒绝（401 或 403） | 确认账号会话仍有效，重新登录。 |
| 对话返回 403 或找不到模型 | 从该账号的可用列表中选择模型，并检查套餐或组织权限。 |
| 对话返回 429 | 查看额度和并发使用情况，稍后重试。 |
| 网络异常或登录未校验 | 插件默认直连。确认网络能访问 WPS Comate 后重试。需要代理时，可在插件选项中设置 `proxy`。 |

`timeoutMs` 可调整登录校验、模型列表和额度请求的超时，默认 15 秒。

## 仓库目录

```text
opencode-wps-comate-auth/
├── package.json         # Magpie 安装所需的插件信息
├── index.mjs            # 插件入口
├── icon.png             # Magpie 插件图标源文件
├── README.md            # 安装和使用说明
├── LICENSE              # MIT 许可证
├── .gitignore           # 排除本机配置、凭据和日志
└── test/
    └── plugin.test.mjs  # 离线测试
```

## 开发

```sh
npm test
```

开发测试需要 Node.js 22 或更新版本。测试使用模拟响应，运行时无需真实账号或网络。插件面向 magpie，使用其隐藏输入能力。
