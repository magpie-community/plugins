# 第三方代码

`vendor/trae-client-codec.mjs` 复用 `magpie-community/plugins` 中 `packages/trae/index.mjs` 的本地登录信息解码实现。

来源版本：`bc9f611e346a29d92e4ef96f225b8f73c2abbfca`。原始许可证见 `vendor/LICENSE-magpie-community`。

这里只读取本机 Trae 已有的登录会话，调用 Trae 自身的模型管理接口。插件不修改登录信息，不发起登录或续期流程。
