# Magpie Fingerprint

[English](README.md) · [Magpie](https://github.com/yetone/magpie) · [lm-detector](https://github.com/Ikaleio/lm-detector)

在 Magpie 内检查疑似模型替换：比较不同渠道的同名模型，或在服务变化后重新采样。复用已有登录与网关配置，基于 `lmfpd-sdk` 的数字指纹展示参考库中的相近候选，为核查保留证据。候选排名不能单独证明模型身份。

![检测界面，图中为明确标识的示例数据](docs/preview.png)

- 一批最多选择 24 个模型，共用三个挑战，便于横向比较。
- 实时显示采样数量与状态，支持取消、总超时和并发设置。
- 保存实际路由、原始回答、推理参数与参考库版本。
- 展示候选排名、模型家族和部分样本等状态。
- 复用 Magpie 原生页面桥接、控件样式与设计变量，主题和语言跟随宿主。
- 本地历史、JSON 导出与复制；紧凑列表、键盘切换与窄屏布局。

## 安装

在 Magpie 的 **Plugins → Discover** 中安装 **Fingerprint**，也可执行：

```sh
magpie plugin add @magpie-community/page-fingerprint
```

需要支持 `page.service` 的当前 Magpie 版本和 Bun 1.4.2+。启用后，从侧栏「模型指纹」或 provider 菜单「检测指纹」进入。点击开始会为每个模型发送三条采样请求，消耗对应通道的额度。

## 开发

在 `packages/fingerprint/` 中运行以下命令。源码、测试和可安装的 `dist/` 均纳入版本控制；MIT SDK 0.2.0 固定在 `vendor/lmfpd-sdk/`。安装插件及运行离线测试无需下载包，仅重建 UI、执行类型检查需要开发依赖。直接构建依赖在 `package.json` 中固定为精确版本，`bun.lock` 锁定完整依赖树并使用 `registry.npmjs.org`，构建使用 Bun 1.4.4；源码更新后重建并提交 `dist/`，不依赖安装或打包时执行脚本。

独立项目及发布记录见 [KaranocaVe/magpie-fingerprint](https://github.com/KaranocaVe/magpie-fingerprint)。

```sh
bun run rebuild
bun start
```

`rebuild` 在隔离副本中使用 `--frozen-lockfile --ignore-scripts` 安装，完成类型检查、测试和构建，再复制 `dist/` 回来并清理临时目录，避免 Bun 使用父级 monorepo 的 workspace 配置。

页面服务默认监听 `4388`，通过 `http://127.0.0.1:3425` 使用 Magpie 网关。打开、刷新页面不会下载参考库，也没有后台刷新。点击「下载参考数据」会下载新快照；启动检测时仅在没有可用缓存时下载。主源为 `https://lm.ikale.io/data/`，备用源为 `https://cdn.jsdmirror.com/npm/lmfpd-data@latest/`。这两个域名会看到客户端 IP；下载请求不携带 provider 凭证、模型标识、提示词或回答。仅主动开始任务才会通过网关发送采样提示。网关认证、`magpie web`、环境变量和离线数据源见 [integration.md](integration.md)。

## 范围与限制

首版实现数字指纹，分词器探测留待后续。每批任务保留其已加载的数据快照并记录 `builtAt`；远程参考库没有固定发布版本，也没有本地预置的哈希校验，备用源使用 `@latest`。概率只在参考库候选中分配，不能当成模型身份的证明。Magpie 的 middleware 和协议适配仍会生效；检测到实际 provider/model 变化时，该目标停止评分。固定账号可选，支持填写账号标识；已缓存的订阅账号可供补全。

`bun start --demo` 提供独立的示例模式，不调用真实模型。任务被宿主重启打断后会标为「已中断」，保留已收到的回答。

采用 MIT 许可证。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
