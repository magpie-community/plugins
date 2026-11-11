# magpie-zcode-start

独立维护的 Magpie 第三方插件，把 ZCode Start Plan 和活动赠送额度作为 **`zcode-start` 独立供应商**参与模型路由。

**0.3.0 的包入口只注册 `zcode-start`。** 常规 `zcode` 继续由已有 ZCode 插件提供，安装本插件无需切换常规 Pro 套餐入口。

## 安装与登录复用

公开仓库：<https://github.com/cat-xierluo/magpie-zcode-start>。Magpie Discover 通过仓库的 `magpie-plugin` topic 发现此插件，将其列在 **Unofficial, on GitHub**。

```sh
magpie plugin add github:cat-xierluo/magpie-zcode-start
```

先在 Magpie 的常规 `zcode` provider 下完成 OAuth 登录，再安装本插件。插件从宿主传入的配置目录读取 `plugin-auth.json` 中的 ZCode 账号，并通过 Magpie 的 `client.auth.set` 保存独立 Start 账号引用。

- 不接管或写入常规 `zcode` provider，也不修改其账号、路由组和并发设置。
- Start 账号只保存来源引用，不另存 JWT、付费 API key 或桌面解密材料；请求前读取对应源账号的最新会话。
- 仅 API key 的账号无法访问 Start Plan。缺少可识别用户 ID 或 JWT subject 的来源也不会自动导入。
- 账号身份按站点和用户 ID 区分；个人与团队记录属于同一主体时使用一个 Start 账号，绑定选定的来源记录。
- 已有源账号更新登录态后，请求直接读取新会话。源账号删除、改绑他人或配置损坏时，该 Start 账号停止请求，不借用其他账号。
- 来源标记为 ZCode 桌面登录时，校验桌面会话的站点和稳定主体后跟随续期；桌面换人、换站点或无法识别主体时不借用该会话。
- 新增账号后刷新 provider；宿主本轮列表已取过账号快照时，再刷新一次，或运行 `magpie plugin list` 使 CLI 重新加载插件。

源账号删除后保留的 Start 引用没有凭证，也无法发起请求；可在 Magpie 中手动删除。只删除 Start 引用而保留来源时，下次同步会重新创建；需要停用时使用 Magpie 的账号或 provider 开关。

## 调度与额度边界

`zcode-start` 只列出当前真实可用 gift bucket 对应的 `<model>-Trial` 模型。没有有效额度时不暴露静态模型；未生效额度只在用量卡展示，不会被提前当作可用余额。周末和工作日的可用时间由服务端赠送计划决定，不写死为 23:00–09:00。

普通 GLM 模型的 Trial 入口也按 bucket 动态发现，例如 `GLM-5.3-Trial`；实际账号是否可用取决于服务端提供的额度。

独立 provider 使 Start 账号拥有自己的休息状态、队列、并发和路由位置。并发默认值为 `3`，可在 Magpie 内单独调整。Start 请求不会回落到付费 Coding Plan，本插件不领取额度，也不替用户调整常规 ZCode 的使用顺序。

## 来源与独立维护

实现复用了 [Magpie 社区 ZCode 插件](https://github.com/magpie-community/plugins/tree/main/packages/zcode) 的 MIT 代码，相关提交和作者信息保留在历史中。共享的兼容代码位于 `zcode-core.mjs`，运行入口 `index.mjs` 只导出 Start 插件；没有对官方插件 npm 包的运行依赖。

保留上游历史是来源追踪，不要求安装或替换上游的 provider。Start 的入口、账号复用、版本和发布在本仓库独立维护。原始许可见 [LICENSE](LICENSE)，来源说明见 [NOTICE](NOTICE)。

本插件未经 Magpie、Z.ai、BigModel 或 ZCode 官方审阅，安装前请检查代码。

## 开发验证

```sh
npm test
```

该命令建立临时 `HOME`，运行使用合成数据的离线测试。不要在真实 `HOME` 下直接运行 `bun test`。兼容实现的回归与独立入口、登录复用的回归分别验证；测试不使用真实账号或模型额度。
