# magpie-marvis

把 **马维斯反代 marvis-proxy**（https://github.com/yy158358/Marvis-proxy-public）
包成 magpie 的一个 provider。装好后 magpie 里出现 `marvis/…` 的模型，
Claude Code / Codex / OpenCode 等 agent 通过 magpie 网关就能用腾讯马维斯。

```
agent ──► magpie 网关 :3425 ──► 本插件 ──► marvis-proxy :8088/v1 ──► 腾讯马维斯
          (协议翻译/路由/多账号)  (provider=marvis)  (账号池/出票/风控)      云端
```

## 前提：marvis-proxy 必须在马维斯 App 所在设备上

出票依赖客户端自带的 `libqimei.so` / `beacon_wrapper.dll`（见该仓库 README「出票通道」），
Linux VPS 上跑不了公开版的出票。所以：

- **Android 手机**：Termux/PRoot 里 `sh run.sh start`（或从 App 里取 `libqimei.so`）
- **Windows**：`python tools\extract_marvis_dll.py` 后 `run.bat`

## 让 VPS 上的 magpie 够到它：SSH 反向隧道

magpie 容器是 `network=host`，容器里的 `127.0.0.1` 就是 VPS 的回环。在手机/PC 上：

```sh
ssh -N -R 127.0.0.1:18088:127.0.0.1:8088 root@52.77.244.89
# 断线自动重连用：autossh -M 0 -N -o ServerAliveInterval=30 -R 127.0.0.1:18088:127.0.0.1:8088 root@52.77.244.89
```

插件默认 baseURL 就是 `http://127.0.0.1:18088/v1`。若两端都在 Tailscale 里，
也可让 marvis-proxy 监听 `0.0.0.0`（config.json 的 `host`），然后：

```sh
docker exec magpie magpie plugin options magpie-marvis '{"baseURL":"http://<tailscale-ip>:8088/v1"}'
```

> 无论哪种，先在 marvis-proxy 里建一把 `mvk_` key（`python tools/admin.py key new`），
> 有了 key 之后 `/v1/*` 就不再是无鉴权的裸口子。

## 安装（VPS 上）

```sh
# 0) 把插件目录放到 /config 卷里（宿主机路径）
docker exec magpie mkdir -p /config/plugins-src
docker cp magpie-marvis magpie:/config/plugins-src/
docker exec magpie chown -R 65532:65532 /config/plugins-src

# 1) 以路径安装（改文件后 magpie 自动重载宿主，不用重启容器）
docker exec -u nonroot magpie magpie plugin add /config/plugins-src/magpie-marvis

# 2) 登录：粘贴 mvk_ 开头的 key
docker exec -it magpie magpie plugin login marvis

# 3) 验证
docker exec magpie magpie plugin list
docker exec magpie magpie provider marvis
```

之后 agent 里选 `marvis/deepseek-v4-1-flash-261017`、`marvis/hy3` 等即可；
或任何客户端直接连 magpie 网关（OpenAI：`http://<vps>:3425/v1`，
Anthropic：`http://<vps>:3425`，key 用 magpie 的 gateway key）。

## 模型

静态表来自 marvis-proxy 仓库 `models.json` 的 7 个对外 id（含上下文长度与能力位）。
要加自定义条目：

```sh
docker exec magpie magpie plugin options magpie-marvis \
  '{"models":[{"id":"main-auto","name":"主档自动","limit":{"context":1000000,"output":32000},"tool_call":true,"reasoning":true}]}'
```

## 已知边界

- 马维斯上游有风控（`403 4100404` = 指纹/出票通道问题，`5104002` = RPC 依赖失败），
  这类错误由 marvis-proxy 侧处理；magpie 里只会看到上游失败。
- 额度卡片只显示 key 是否有效；真实余量看 marvis-proxy 控制台（`http://手机IP:8088/`）。
- 本插件不做任何出票、不碰马维斯 App 的登录态——它只是把一个本机 OpenAI 接口注册进 magpie。
