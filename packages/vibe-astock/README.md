# @magpie-community/page-vibe-astock

magpie 里的一个说明页：把 [Vibe AStock](https://github.com/simonlin1212/vibe-astock) 接到本网关，四步接完。

安装：**Plugins › Discover** 搜 “Vibe AStock”，或

```sh
magpie plugin add @magpie-community/page-vibe-astock
magpie plugin
```

## 页面做什么

1. 网关地址 `http://127.0.0.1:3425/v1` 与本地 key `magpie`，一键复制。
2. 给出接 Vibe AStock 的命令：`npx vibe-astock-magpie install`。
3. 说明在 Vibe AStock 的「接入 AI」下拉里选一个 `Magpie · …` 模型，Base URL、Model、API Key 会自动带出。
4. 提醒点「测试并保存」，并写明已知边界：服务端 JSON Schema 不生效（走提示词）、图片输入不支持。

## 权限与网络

- 不声明任何 `permissions`：不读用量、模型、账号，不碰会话与资料库。
- 不发任何网络请求：页面里没有 `fetch`。按钮只做复制。
- 不引入外部字体、图片或脚本，深浅色跟随 `prefers-color-scheme`。

配套的 Vibe AStock 侧插件（provider 模板、模型清单、兼容性实测）在
[vibe-astock-magpie](https://github.com/lee-lipeng/vibe-astock-magpie)。
