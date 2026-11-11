# Magpie Panel

<img src="preview.gif" alt="Magpie Panel 預覽" width="360">

一個常駐的懸浮面板，復刻 Magpie 點擊 tray icon 後彈出的面板，並加上「形象」頁：用自訂 GIF／PNG／WebP 隨著 Magpie 的路由狀態變化。

- 浮窗可自由縮放、拖曳、記住位置與大小（含多螢幕）
- 預設永遠置頂、開機自動啟動、全域快捷鍵 `Alt+Shift+M`
- 五個頁籤：用量、Agents、快速操作、形象、設定
- 形象支援 7 種狀態、依 Agent 分套、預設套 fallback、Agent 優先序
- Magpie 未執行時顯示離線，不崩潰；資料只讀 `127.0.0.1`
- 支援 Windows 11 amd64、macOS（universal）、Linux amd64／arm64

## 架構

Magpie 的插件只能提供沙箱頁面，不能建立原生視窗或 tray。因此本專案分成兩塊：

```text
plugin/   Magpie 插件（npm 套件）：在 Magpie 裡提供入口、狀態與設定，
          必要時從 GitHub Releases 下載並啟動浮窗程式
app/      MyGo 桌面程式：tray、浮窗、Magpie 本機 API、形象狀態機
```

插件不是必需的：浮窗程式可以獨立執行，插件只是讓 Magpie 使用者更容易找到與啟動它。

## 安裝

### 浮窗程式

從 [Releases](https://github.com/owogametools/magpie-statusP/releases) 下載對應平台的檔案：

| 平台 | 檔案 | 說明 |
|---|---|---|
| Windows amd64 | `magpie-panel-setup-<version>-amd64.exe` | NSIS 安裝檔（建議） |
| Windows amd64 | `magpie-panel-windows-amd64.zip` | 免安裝版，解壓後執行 `magpie-panel.exe` |
| macOS universal | `magpie-panel-macos-universal.dmg` | 拖到「應用程式」 |
| Linux amd64 | `magpie-panel_<version>_amd64.deb` | Debian／Ubuntu 套件 |
| Linux arm64 | `magpie-panel_<version>_arm64.deb` | Debian／Ubuntu 套件 |
| Linux amd64／arm64 | `magpie-panel-linux-<arch>.tar.gz` + `magpie-panel-install.sh` | 免安裝腳本 |

每個 release 都附 `SHA256SUMS`。校驗方式：

```bash
sha256sum -c SHA256SUMS              # Linux
shasum -a 256 -c SHA256SUMS          # macOS
```

Windows 未簽章，首次啟動會有 SmartScreen 警告，選擇「仍要執行」。

macOS 目前只做 ad-hoc 簽章、沒有 notarization：從瀏覽器下載的 dmg 可能被 Gatekeeper 隔離。右鍵 →「打開」，或執行：

```bash
xattr -dr com.apple.quarantine "/Applications/Magpie Panel.app"
```

Linux 執行時需要 GTK／WebKitGTK；deb 已宣告依賴，`install.sh` 在缺少時會印出對應發行版的安裝指令。手動安裝：

```bash
sh magpie-panel-install.sh magpie-panel-linux-amd64.tar.gz
```

會裝到 `~/.local/magpie-panel.app/`，並提供 `~/.local/bin/magpie-panel` 指令連結。

### Magpie 插件

```bash
magpie plugin add github:owogametools/magpie-statusP
```

插件使用 GitHub topic `magpie-plugin`，因此會出現在 Magpie 的 **Discover → Unofficial**。目前尚未發佈到 npm，也還不在 curated registry。

Magpie 的 GitHub 安裝只抓 repo 根目錄；根目錄的 `package.json` 會把入口與頁面指向 `plugin/`。

在本機開發時，直接安裝 `plugin/` 資料夾：

```bash
magpie plugin add ./plugin
```

若之前從舊的 private repo 安裝過插件，先移除再重新安裝（舊安裝的依賴名可能是 `magpie-status`）：

```bash
magpie plugin remove magpie-panel
magpie plugin remove magpie-status
magpie plugin add github:owogametools/magpie-statusP
```

在 Magpie 的 Settings → Plugins 開啟「Magpie Panel」頁面，即可看到狀態、binary 路徑與自動啟動選項。插件會依平台優先使用手動安裝的程式；找不到時從 Releases 下載對應 asset：

| 平台 | 下載的 asset | 解壓後的執行檔 |
|---|---|---|
| Windows amd64 | `magpie-panel-windows-amd64.zip` | `magpie-panel.exe` |
| macOS universal | `magpie-panel-macos-universal.zip` | `Magpie Panel.app` |
| Linux amd64 | `magpie-panel-linux-amd64.tar.gz` | `magpie-panel` |
| Linux arm64 | `magpie-panel-linux-arm64.tar.gz` | `magpie-panel` |

下載後以 `SHA256SUMS` 驗證，解壓到 `<資料目錄>/bin/<version>/`。

## 使用

- **左鍵 tray icon**：顯示／隱藏浮窗
- **右鍵 tray icon**：顯示浮窗並跳到設定頁
- **Alt+Shift+M**：顯示／隱藏浮窗（可在設定頁更改）
- **拖曳視窗邊緣**：縮放；位置與大小會記住
- **關閉**：只隱藏，程式常駐；從設定頁的「離開」結束程式

### 形象

到「形象」頁為每個 Agent 的 7 種狀態選圖：

| 狀態 | 意義 |
|---|---|
| `idle` | 待機 |
| `routing` | 請求已開始，尚未送出 attempt |
| `waiting` | 等待首 token |
| `streaming` | 正在串流輸出 |
| `fallback` | 切換備援模型／帳號（顯示 2 秒） |
| `failed` | 請求失敗（顯示 3 秒） |
| `offline` | Magpie 未連線 |

圖片解析順序：**該 Agent 的圖 → 預設套的圖 → 內建佔位圖**。多個 Agent 同時活躍時，只顯示優先序最高的那個；全部待機時顯示最後活躍的 Agent。

支援 GIF／PNG／WebP，單檔上限 20 MB。圖片會複製到 `<資料目錄>/avatars/`，原始檔移動不影響。

程式內建 `claude` 預設套（蜜塔），首次啟動且 `avatar.sets` 還是空的時候會自動安裝到 `<資料目錄>/avatars/claude/`。已有的套組或同名檔案不會被覆寫。

## 設定與資料位置

程式資料目錄依平台放在：

| 平台 | 目錄 |
|---|---|
| Windows | `%APPDATA%\MagpiePanel` |
| macOS | `~/Library/Application Support/MagpiePanel` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/MagpiePanel` |

| 路徑（相對資料目錄） | 內容 |
|---|---|
| `config.json` | 設定（寫入前保留 `.bak`） |
| `avatars/` | 形象圖片 |
| `bin/` | 插件下載的程式版本 |
| `window-state.json` | MyGo 記住的視窗位置與大小 |

Magpie 的 port 會自動從各平台的 Magpie 設定檔讀取，讀不到時用 `3425`。程式只連 `127.0.0.1`，不帶 gateway key，也不記錄 prompt、帳號或金鑰。

Agent 的模型與 reasoning 切換走 Magpie 官方 CLI（`magpie <agent> <model>`），不碰 Magpie 的內部視窗 API。

## 從原始碼建置

需求：Go 1.27+、Bun，以及平台的 WebView（Windows 的 WebView2、macOS 內建、Linux 的 GTK／WebKitGTK）。

```bash
cd app
bun install
bun run dev          # 開發模式
bun run build        # 目前平台（Windows 產出 build/windows-amd64/）
go test ./...
```

交叉編譯：

```bash
cd app
bun run build -- -platform linux/amd64,linux/arm64
bun run build -- -platform darwin/universal   # dmg 只在 macOS 主機上產生
```

`bun run build` 在 Windows 會產出 `Magpie Panel.exe` 與 NSIS 安裝檔；在 macOS 會產出 `.app` 與 dmg；在 Linux 會產出 tar.gz、deb、`.desktop` 與 `install.sh`。

## 限制

- Windows 未簽章，SmartScreen 會警告。
- macOS 僅 ad-hoc 簽章、未經 notarization；首次開啟需右鍵或移除 quarantine。
- Linux 需要 GTK／WebKitGTK。
- Windows arm64 尚未建置。
- 手動安裝的程式優先於插件下載的版本：用 NSIS 安裝的使用者要自行安裝新版 setup exe，插件不會覆蓋。
- 插件的宿主 API 隨 Magpie 版本演進；若 Magpie 改變插件格式，請更新插件版本。
- 形象的狀態來自 Magpie 的 `route-events` SSE；極短的請求可能只看到一瞬。

## 授權

本專案為 MIT。視覺設計參考 [Magpie](https://github.com/yetone/magpie)（MIT，Copyright (c) 2026 yetone），未直接複製其程式碼。詳見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。
