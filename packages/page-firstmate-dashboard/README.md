# Firstmate Dashboard for MagPie

在 MagPie 中查看 Firstmate 的派工规则、二副下次启动配置、派工记录和额度。大副可以预览、校验和保存派工改动，再单独推送到 Firstmate 已登记的二副。

## 安装

需要已安装并配置的 Firstmate，以及支持 `magpie.page.service` 的 MagPie。每个本机 Firstmate Home 使用自己的 `config/`、`state/` 和 `bin/`。远端配置 CLI 需要 Node.js 或 Bun。

将插件包解压到独立目录，再从 MagPie 安装该目录。下面的路径请替换为解压后的目录。

```sh
magpie plugin add /path/to/firstmate-dashboard
```

在 **插件 → 已安装 → 选项** 粘贴下方一种配置，替换所有示例路径和 SSH 别名，再打开侧栏中的 **First Mate**。也可运行 `magpie plugin options <插件名称或安装路径> '<JSON>'`。首次安装不指定 Home。插件服务绑定本机回环，默认端口为 `35871`。端口占用时可在同一份选项中添加 `"port": 35872`。

## 全本地

一个 MagPie 实例连接同一台机器上的两个 Firstmate Home。Firstmate 在二副目录的 `.fm-secondmate-home` 中记录二副 ID，并在大副 Home 中登记该二副。选择大副页面执行保存和显式推送。二副页面可从同一实例中的大副读取启动配置并请求同步，无需 SSH。

```json
{
  "homes": [
    { "name": "大副", "path": "/path/to/primary" },
    { "name": "二副", "path": "/path/to/secondmate", "parent": { "home": 0 } }
  ],
  "catalogTargets": {
    "primary": { "local": true },
    "reviewer": { "local": true }
  }
}
```

`parent.home` 是大副在此实例 `homes` 数组中的索引，从 0 开始。示例中的 `reviewer` 应替换为实际席位 ID。保留 Firstmate 的原生二副登记，以便推送找到目标。

## 大副本地，二副在远端

在大副所在主机配置本机 Home。可加一个远端二副条目，使用已有 SSH 别名读取远端登记。

```json
{
  "homes": [
    { "name": "大副", "path": "/path/to/primary" },
    {
      "name": "远端二副",
      "remote": { "ssh": "secondmate-host", "path": "/path/to/secondmate" }
    }
  ],
  "catalogTargets": {
    "primary": { "local": true },
    "reviewer": { "ssh": "secondmate-host" }
  }
}
```

大副的显式推送由本机 Firstmate 根据原生登记和 SSH 配置执行。若远端二副也运行 MagPie，可在二副所在主机配置本机二副 Home。通过已有 SSH 转发将二副主机的回环端口 `35874` 连到大副插件服务的 `35871`，再设置 `parent: { "url": "http://127.0.0.1:35874", "servicePort": 35871, "home": 0 }`。这里的 `home` 指大副实例的索引。服务端口一致时可省略 `servicePort`。

## 大副在远端主机

在查看端通过已有 SSH 别名登记大副。省略 `remote.dispatchCli` 时，页面通过 SSH 读取二副启动配置和选定的登记字段。配置 `remote.dispatchCli` 后，派工规则和额度操作在远端大副 Home 执行，二副启动编辑和其他设置仍由大副本机管理。

```json
{
  "homes": [
    {
      "name": "远端大副",
      "machine": "大副主机",
      "remote": {
        "ssh": "primary-host",
        "path": "/path/to/primary",
        "dispatchCli": "/path/to/firstmate-dashboard/firstmate-config.mjs"
      }
    }
  ],
  "catalogTargets": { "primary": { "ssh": "primary-host" } }
}
```

远端 CLI 路径须指向同版插件。默认使用 SSH 命令的 PATH 中的 `node`。可设 `"dispatchRuntime": "bun"`。SSH 要求预先信任主机密钥，并具备非交互认证。如果查看端也是二副，可另加本机二副 Home。它通过独立的 `parent.url` 指向大副主机的回环转发，使用上一节所述格式。

## 编辑、推送和额度

- 派工规则先通过 Firstmate 的 `fm-bootstrap.sh` 校验，再显示差异。确认保存后核对版本、备份并读回。点击 **推送已保存的派工规则** 才调用原生 `fm-config-push.sh` 传播 `config/crew-dispatch.json`。页面分别显示每个二副的文件结果和重读通知回执。
- 默认备份写入 MagPie 配置目录下的 `firstmate-dashboard/backups/`，避免按目录安装时备份触发插件服务重载。默认配置也能读取和恢复旧插件目录中的备份。可用 `backupDir` 指定独立目录。
- 二副启动配置归大副持有，由原生 `fm-harness.sh` 解析。保存启动配置影响下次启动。启动配置页的同步按钮可单独请求推送原生继承项。普通设置页沿用 Firstmate 对各设置的继承规则。
- 每个 Home 有独立的额度来源。默认 `local` 调用该 Home 所在主机的 `bin/fm-quota-source.sh`。如果 Firstmate 已配置受支持的 SSH 额度来源，可在相应 Home 条目添加 `"quotaSshAliases": ["quota-host"]`。选项中的别名只给此 Home 放行。远端读数限于原生 SSH 额度入口支持的 Codex 和 Antigravity，过期或缺失读数显示相应状态。
- `catalogTargets` 按席位选择读取 MagPie Agent 模型目录的位置。尚未配置或目录读取失败时可保留现有模型和强度。远端目录按需使用已配好的 SSH 别名。
- 控制台读取配置和本机已登记的启动记录。它不会重新启动正在运行的席。Home 路径、备份和别名应留在各安装的本地选项中。

## 来源与许可

`LICENSE` 声明插件原创部分采用 MIT。`MAGPIE-LICENSE` 保留 MagPie 上游 MIT 声明，对应页面桥接、模型选择界面的部分代码以及 `native-icons.json` 所列图标。图标用于标识相应工具和供应商。
