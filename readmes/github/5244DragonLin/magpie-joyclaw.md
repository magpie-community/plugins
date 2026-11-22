# magpie-joyclaw：京东 JoyClaw 模型接入插件

把京东 JoyClaw 桌面端的每日免费积分接到 magpie，纯 Node.js 实现，登录一次即可直连 DeepSeek V4、Kimi K2.5、JoyAI 1.3T 等官方模型，无需自行申请密钥。

## ⭐亮点

- **免费额度**：登录即用京东每日赠送的积分，按模型倍率抵扣，DeepSeek V4 Pro 可跑百万上下文
- **免密钥**：不用去控制台申请密钥，京东账号登录一次即可长期使用
- **模型齐全**：DeepSeek V4 Pro、DeepSeek V4 Flash、Kimi K2.5、JoyAI 1.3T 与官方目录实时同步
- **签到领积分**：每日积分一键领取，领取前后余额对比如实呈现，不虚报成功

## 🚀快速开始

### 1. 克隆项目

```bash
# Gitee 镜像（国内访问快）
git clone https://gitee.com/yhl5244/magpie-joyclaw.git

# GitHub 原仓库
git clone https://github.com/5244DragonLin/magpie-joyclaw.git

cd magpie-joyclaw
```

### 2. 安装依赖

```bash
bun install
```

### 3. 登录京东账号

magpie 用户直接安装插件并登录：

```bash
magpie plugin add magpie-joyclaw
magpie plugin login joyclaw
```

登录方式二选一：选「浏览器登录」会打开京东官方登录页，手机验证码登录即可；已装 JoyClaw 桌面端并登录过的机器，也可以直接把本机保存的登录票据粘贴进来。

### 4. 开始使用

在 magpie 里选择 joyclaw 提供的模型对话即可。

Agent2API 用户在管理面板的插件页选择安装，指向本目录或打包后的 tgz 包。

## 📁项目结构

```text
magpie-joyclaw/
├── index.mjs            # 插件实现（供应商声明 / 登录 / 请求转发 / 用量 / 签到）
├── opencode.mjs         # magpie 宿主的加载入口
├── joyclaw.test.mjs     # 单元测试
├── assets/              # README 图片资源
├── package.json
├── LICENSE
└── README.md
```

`opencode.mjs` 只有一行转发，负责把插件交给 magpie 宿主加载；真正的逻辑都在 `index.mjs`。

## ❓️FAQ

**Q：需要自己去申请密钥吗？**

A：不需要。插件用你的京东账号登录票据换取模型访问凭证，换取过程全自动，按账号稳定复用，你只要登录一次。

**Q：积分是哪里来的，会用完吗？**

A：JoyClaw 桌面端每天登录赠送积分，插件会自动完成签到并显示余额。积分按模型倍率抵扣，倍率高的模型消耗更快，余额不足时用量页会提示。

**Q：没装 JoyClaw 桌面端能用吗？**

A：可以。浏览器登录走的是京东官方登录页，和桌面端同一套回跳流程，不依赖本机安装桌面端。只有「粘贴票据」这种方式需要机器上已装并登录过桌面端。

**Q：登录多久会失效？**

A：票据失效（异地登录、清理登录状态等）时会标记为已过期，重新登录一次即可，已保存的配置不用重填。

## 📝已知问题 / 待改进点

- [ ] 尚未掌握登录票据的有效期与自动续期机制：期望票据过期后能自动恢复，不必手动重新登录

## 🤝贡献

欢迎提 Issue 和 PR。流程如下：

1. Fork 本仓库
2. 新建分支（`git checkout -b feat/xxx`）
3. 提交改动（`git commit -m "feat: xxx"`）
4. 发起 Pull Request

## 📋更新日志

### v0.1
- 首个版本：magpie-JoyClaw 插件，直连 DeepSeek、Kimi、JoyAI 模型，每日积分自动签到领取并显示余额

## ☕捐赠

如果这个插件帮你省下了买模型的钱，欢迎请我喝杯咖啡。

| 支付宝 | 微信 |
|--------|------|
| ![支付宝](assets/donate_alipay.jpg) | ![微信](assets/donate_wechat.jpg) |

## ⚠️免责声明

本插件通过非官方接口接入 JoyClaw，仅供个人学习与自用，请勿用于商业转售或大规模分发。
因使用本插件产生的一切后果由使用者自行承担，作者不承担任何法律责任。

## 📃许可证

本项目基于 [MIT](LICENSE) 协议开源。
