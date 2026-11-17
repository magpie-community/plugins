# magpie-middleware-strip-empty-content

Magpie 网关中间件：路由前丢弃 content 为空的 user 消息，防止 vLLM 系严格渠道 400。

> status_code=400, messages: Validation error: message content cannot be empty

覆盖 chat / anthropic / responses / gemini 四种协议，仅过滤 user 角色。

## 安装

```bash
magpie plugin add ./magpie-middleware-strip-empty-content
```

### Docker

容器里 `magpie` 在 PATH，但 `plugin add` 的路径必须是容器内路径。两种方式：

```bash
# 方式一：绑定挂载（compose volumes 加一行，改文件后中间件自动重载）
#   volumes: - ./magpie-middleware-strip-empty-content:/plugins/magpie-middleware-strip-empty-content
docker exec -it magpie magpie plugin add /plugins/magpie-middleware-strip-empty-content

# 方式二：docker cp 塞进 /config 卷
docker cp ./magpie-middleware-strip-empty-content magpie:/config/plugins-src/
docker exec -it magpie magpie plugin add /config/plugins-src/magpie-middleware-strip-empty-content
```

#### Bun 下载卡住（低带宽）

`magpie plugin add` 会触发 magpie 下载 Bun 插件宿主；下载有 10s 超时，带宽低时每次调用都重下重超时，插件（含中间件）永远无法激活，报 `Bun runtime not ready: downloading Bun ... plugins run once it is done`。中间件本身不依赖 Bun，但条目激活被卡住。

绕开办法：用 `MAGPIE_BUN` 指向一个预先放好的 bun，跳过下载。容器是 Debian 12 slim（x64/glibc），用 baseline build：

```bash
# 宿主机下载（走 gh-proxy.com 镜像加速）
curl -fL -o /tmp/bun.zip \
  https://gh-proxy.com/https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64-baseline.zip
cd /tmp && unzip -o bun.zip            # → /tmp/bun-linux-x64-baseline/bun

# 拷进容器卷（持久）
docker compose exec -it magpie mkdir -p /config/cache/mybun
docker compose cp /tmp/bun-linux-x64-baseline/bun magpie:/config/cache/mybun/bun
docker compose exec -u 0 magpie chown 65532:65532 /config/cache/mybun/bun
docker compose exec -it magpie chmod +x /config/cache/mybun/bun
```

#### 权限（容器用户 nonroot）

容器以 `uid/gid=65532(nonroot)` 运行，magpie 以此用户读取插件目录和 `MAGPIE_BUN` 指向的 bun。`docker cp`/`docker compose cp` 从宿主机拷入的文件保留宿主 uid（如 1000），65532 读不到；`docker compose exec` 默认也是 65532，改不动别人所有的文件。落权限要用 `-u 0` 以 root 执行（上面 chown 那行）：

```bash
docker compose exec -u 0 magpie chown -R 65532:65532 /config/cache/mybun
```

绑定挂载的插件目录同理：宿主侧需 `chown -R 65532:65532 <插件目录>` 或 `chmod -R a+rX <插件目录>`，否则 magpie 读不到插件文件、`plugin add` 后中间件不生效。`/config` 卷本身归 65532，magpie 可直接写。

compose 的 `environment:` 加一行后重建：

```yaml
    environment:
      MAGPIE_BUN: /config/cache/mybun/bun
```

```bash
docker compose up -d
docker compose exec -it magpie magpie plugin   # 不再出现 downloading Bun
```

注意：arm64/Apple 容器换 `bun-linux-aarch64.zip`（无 baseline，先 `uname -m` 确认）；bun 必须匹配容器 C 库（glibc，别用 musl build）。

## 测试

```bash
# 构造含空 user 消息的 chat 请求
curl -s http://127.0.0.1:3425/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":""},{"role":"user","content":"hi"}]}' \
  | jq '.choices[0].message.content'
```

正常返回回复即生效（空消息已被丢弃，只剩 "hi"）。
