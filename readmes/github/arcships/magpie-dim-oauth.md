<p align="center">
  <img src="page/icon.png" width="72" height="72" alt="Dim">
</p>

<h1 align="center">在 Magpie 里用 Dim</h1>

<p align="center">登录 Dim 账号，在 Magpie 里用模型、看额度、管理套餐。</p>

<p align="center">
  <a href="https://dimagent.cn/console/subscription">购买 / 续期套餐</a> ·
  <a href="https://dimagent.cn/console/pricing">查看价格</a>
</p>

## 开始使用

需要 [Magpie](https://github.com/yetone/magpie) **0.1.2818 或更新版本**。

### 怎么安装？

打开 **Plugins（插件） → Add a plugin（添加插件）**，填入下面的仓库名，确认后等它装好就行：

```text
arcships/magpie-dim-oauth
```

<details>
<summary>想用终端安装？</summary>

直接执行：

```sh
magpie plugin add arcships/magpie-dim-oauth
```

</details>

### 装好以后，怎么开始用？

1. 在服务商列表里找到 **DimAgent**，点击 **国内站登录**。
2. 在打开的浏览器里登录 Dim 账号，并同意授权。
3. 回到 Magpie，等模型列表出来，给正在用的 Agent 选一个 Dim 模型。

套餐里开通了哪些模型，列表里就会显示哪些，选好就可以开始用了。

## 套餐与用量

### 在哪里看额度，或者续期套餐？

打开侧栏的 **DimAgent**，就能看到套餐到期时间、已用额度，以及用量窗口还要多久重置。想看最新情况，点右上角的 **刷新**。

想买套餐或续期，点页面里的 **购买套餐** 或 **续期套餐**，浏览器就会打开 Dim 官网。买好后回来点一下 **刷新** 就行。

### 额度用完了，可以手动重置吗？

可以，只要账号里还有对应的重置次数。在 **DimAgent** 里选你需要的操作：

| 操作 | 会发生什么 |
| --- | --- |
| **重置用量窗口** | 把当前套餐的用量窗口清零 |
| **恢复月度额度** | 把当前计费月的套餐额度恢复到满额 |

两种操作各用各的次数。点进去后，先看看要重置哪个套餐、还剩几次、什么时候到期。确认没问题，再点 **消耗 1 次并重置**；点取消不会扣次数。

## 常见问题

<details>
<summary>登录没完成，或者登录后没看到模型，怎么办？</summary>

还没完成授权的话，回到 Magpie 再点一次 **国内站登录**，跟着浏览器里的提示完成登录。

已经登录了的话，先刷新一下 DimAgent 的用量，再打开 **DimAgent** 看看。

</details>

<details>
<summary>为什么重置按钮点不了？</summary>

看看当前有没有可重置的套餐，以及对应的次数是不是用完了。窗口重置和月度额度恢复各用各的次数。

</details>

<details>
<summary>重置时网络出了问题，再试一次会重复扣次数吗？</summary>

在原来的确认框里点重试就好，同一次操作不会因为重试而重复扣次数。

</details>
