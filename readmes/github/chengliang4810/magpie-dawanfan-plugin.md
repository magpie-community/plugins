# dawanfan

在 magpie 中使用你的[大碗饭](https://dawan.fan)账号，调用套餐内的模型，并查看本月用量、剩余额度和到期时间。

## 安装

在 magpie 的「插件 → 添加插件」中填写 `github:chengliang4810/magpie-dawanfan-plugin`，或运行：

```sh
magpie plugin add github:chengliang4810/magpie-dawanfan-plugin
magpie plugin login dawanfan
```

也可从 [Releases](https://github.com/chengliang4810/magpie-dawanfan-plugin/releases) 下载插件包，解压后添加 `dawanfan` 文件夹的完整路径。

## 登录

选择「网页登录」，在打开的大碗饭官网窗口中完成登录即可。插件会自动连接账号，无需填写 API Key 或复制会话令牌。

已有名为 `magpie` 的有效 API Key 会直接复用，没有时自动创建。连接成功后，登录窗口自动关闭，账号可用的模型和套餐用量会显示在 magpie 中。

## 更换 API Key

登录成功后，再次打开大碗饭的登录选项，选择「更换 API Key」，选中已有账号并填写新的 Key。验证通过后更新原账号，保留官网会话和套餐用量，不新增账号。

新 Key 需要属于所选账号且处于有效状态。更换后，再次网页登录也会保留你设置的 Key。

## 使用须知

- 网页登录需要本机安装 Chrome 或 Microsoft Edge。
- 官网登录过期后，再次选择「网页登录」即可恢复用量显示。

账号密码只在大碗饭官网登录页输入，插件不保存密码。此插件独立发布，与大碗饭及 magpie 官方无隶属关系。

登录信息由 magpie 保存在本机配置目录的 `plugin-auth.json`。模型按账号套餐自动获取，客户端使用 `dawanfan/<模型名称>`。

支持 OpenCode 供应商插件格式；OpenCode 可使用模型调用，套餐用量展示由 magpie 提供。官方 Logo 及商标归大碗饭权利人所有。

[开发与接口说明](docs/development.md)
