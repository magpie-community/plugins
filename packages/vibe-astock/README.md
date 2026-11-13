# @lee-lipeng/page-vibe-astock

magpie 里的一个说明页：把 [Vibe AStock](https://github.com/simonlin1212/vibe-astock) 接到本网关，四步接完。

```sh
magpie plugin add ./magpie-page                     # 本地
magpie plugin add @lee-lipeng/page-vibe-astock      # 发布后
```

页面给出网关地址 `http://127.0.0.1:3425/v1`、本地 key `magpie`、接入命令，以及该在 Vibe AStock 里选什么。按钮只做复制。

不声明任何 `permissions`，不发网络请求，不引外部字体或图片，深浅色跟随 `prefers-color-scheme`。

发布方式见主仓库 [PUBLISH.md](../PUBLISH.md) 第 3 节。
