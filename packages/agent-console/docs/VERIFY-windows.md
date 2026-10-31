# Windows Verification Checklist

Already run on Linux: `npm run check`, `npm test`, `npm run build` + `verify:build`, e2e 19/19 (Chrome + Mock),
and a real `magpie web` (isolated HOME + Mock). The items below can only be confirmed on Windows (and Mac).

## 1. One-command self-check

From the repository directory (a path containing non-ASCII characters is ideal for covering encoding issues):

```bat
cd /d D:\workwork\magpie插件\agent-console
git checkout main
node scripts\verify-windows.mjs
```

Add `--quick` (skips `npm ci` and `npm test`) when dependencies are already installed and you just want a fast re-run.
The report is also written to `_tmp\verify-windows.log`; the exit code is 1 if anything FAILs. Just send that file back.

The script checks, in order:

| Item | What |
|---|---|
| Node / npm | Node ≥ 20, npm available; prints the console code page (usually 936 on Chinese Windows) |
| Install and build | `npm ci` → `npm run build` → `npm run verify:build` (committed bundle is byte-identical to a fresh build) → `npm run check` → `npm test` (including the Windows-only real powershell CP936 case) |
| node-pty | Loads the prebuilt module, starts a PTY with the default shell (pwsh → powershell → cmd), echoes a marker containing Chinese text |
| Agent CLI resolution | Resolves the 8 providers in the catalog with the same code the daemon uses (PATH order, PATHEXT, .cmd / .ps1 shims), runs `--version` on those found (no config is changed); also resolves npx |
| Shims + argument escaping | In a temp directory with spaces and Chinese characters, creates a `.cmd` (pointing to a .js), a plain `.cmd` and a `.ps1`, passes `a b`, `x&y`, `中文`, `q"t`, `100%`, and checks the received arguments |
| Process tree kill | Starts a child that spawns a grandchild; after `killTree` (`taskkill /T /F`) the grandchild must be gone |
| Encoding | A static GBK sample and a Chinese path printed by real powershell in CP936 are both decoded correctly |
| Paths | The same path with different case / separators is equal after normalization |
| daemon | Temp data directory (with Chinese characters and spaces) + Mock: ready line → `/api/ping` (wrong token gives 403) → exits after stdin closes and removes daemon.json |
| Plugin host finds node | When the host is `bun.exe`, `node.exe` can be found on PATH |

WARN is not a failure: e.g. a CLI's `--version` exits non-zero, or `.cmd` / PowerShell parse embedded quotes slightly differently from what is expected (the actually received arguments are printed).

## 2. Manual check in real Magpie (about 5 minutes)

1. Quit Magpie. From the repository directory run `magpie plugin add D:\workwork\magpie插件\agent-console` (or update the plugin the way you usually do), then open Magpie.
2. Open the "Agent Console" page: the UI shows, and the light/dark theme follows Magpie.
3. New project (clicking "Browse" should open the system folder picker; pick a directory with Chinese characters) → new conversation → send a message with an installed Agent; it replies.
4. Typing with a Chinese IME, pressing Enter to pick a candidate must **not** send the message.
5. Attachments: drag an image into the composer and send; the message shows a thumbnail.
6. Terminal panel: open a terminal, run `echo 中文` and `dir`, output is correct; after resizing the panel, wrapping is correct.
7. Changes panel: create a file in the project, its diff shows; discarding moves the file to the Recycle Bin (also works with the project on D: and the data directory on C:).
8. After quitting Magpie, Task Manager should show no leftover `node.exe` (daemon) or Agent processes:
   ```bat
   powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'agent-console' } | Select-Object ProcessId,Name,CommandLine"
   ```
   No output means pass.
9. On a machine without Node (optional): the page should show a "Node.js not found" notice, not a blank page.

## 3. Mac-only checks

- In the Magpie desktop window (`wails://`), the plugin page can navigate to `http://127.0.0.1:<port>` (ATS allows IP addresses by default and Magpie's Info.plist has no ATS config; needs confirmation on real hardware).
- When Magpie is launched from the Dock (GUI's minimal PATH), Homebrew-installed `node` / `claude` / `codex` are found.
- The terminal uses zsh; if `node-pty`'s `spawn-helper` loses its executable bit it is repaired automatically (`logs/` gets an entry saying the node-pty spawn-helper executable bit was repaired).
- "Browse" opens the macOS folder picker; pressing Enter to confirm a Chinese IME candidate does not send (WebKit keyCode 229).
