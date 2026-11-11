# AnyStarX for magpie

[English](#english) · [中文](#中文)

## English

Use [AnyStarX](https://console.anystarx.com) in [magpie](https://usemagpie.ai):

- **AnyStarX as a model provider**: once signed in, every model your AnyStarX account can use shows up in magpie's model list, ready to switch to.
- **Balance at a glance**: see your AnyStarX balance in magpie without opening the console.

### Getting started

1. Create and copy an API key (`sk-…`) on the **API Key** page of the [AnyStarX console](https://console.anystarx.com).
2. Install the plugin and sign in with the key:

```sh
magpie plugin add anystarx-for-magpie
magpie plugin login anystarx     # paste the API key
```

3. Check that it works and see your balance:

```sh
magpie provider test anystarx
magpie quota
```

Or install straight from GitHub: `magpie plugin add github:AnyStarX/AnyStarX-for-magpie`.

You can sign in with more than one key; magpie keeps each as a separate AnyStarX account.

Image, embedding and TTS models are left out of the model list, since they can't be used in a chat.

### FAQ

**Is the balance for the key or for my account?**
It depends on the site's settings. With per-token statistics turned on, you see what is left on that key; otherwise you see your account balance. A key with unlimited quota shows "无限额度" (unlimited).

**Why are model prices missing?**
The pricing API needs a signed-in browser session and can't be read with an API key. See the **Pricing** page in the console instead.

**Can I sign in with a username and password?**
No. Only API keys are supported for now.

### Development

```sh
bun test
```

## 中文

在 [magpie](https://usemagpie.ai) 中使用 [AnyStarX](https://console.anystarx.com)：

- **把 AnyStarX 作为模型供应商**：登录后，AnyStarX 账号可用的模型会出现在 magpie 的模型列表中，可以随时切换过去使用。
- **查看余额**：在 magpie 里直接看到 AnyStarX 账户的余额，不用再打开控制台。

### 开始使用

1. 在 [AnyStarX 控制台](https://console.anystarx.com) 的「API Key」页创建并复制一个 Key（`sk-…`）。
2. 安装插件并登录：

```sh
magpie plugin add anystarx-for-magpie
magpie plugin login anystarx     # 粘贴刚才复制的 API Key
```

3. 检查是否可用、查看余额：

```sh
magpie provider test anystarx
magpie quota
```

也可以直接从 GitHub 安装：`magpie plugin add github:AnyStarX/AnyStarX-for-magpie`。

可以登录多个 Key，magpie 会把它们当作 AnyStarX 下的多个账号。

生图、向量（embedding）和语音（TTS）模型不能用于对话，不会出现在模型列表里。

### 常见问题

**余额显示的是 Key 的额度还是账户的余额？**
取决于站点设置：开启「令牌统计」时显示这个 Key 的剩余额度，否则显示整个账户的余额。无限额度的 Key 显示「无限额度」。

**为什么看不到模型价格？**
价格接口需要在网页上登录才能读取，API Key 读不到，所以插件没有显示价格。请在控制台的「模型定价」页查看。

**能用账号密码登录吗？**
不能，目前只支持 API Key。

### 开发

```sh
bun test
```

## License

[MIT](LICENSE)
