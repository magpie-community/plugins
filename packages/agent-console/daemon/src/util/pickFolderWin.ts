import { execFile } from "node:child_process";

/** Parse PowerShell stdout into a folder path (handles Base64 and CP936 consoles) */
export function decodePickFolderStdout(stdout: string | Buffer): string | null {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8");
  const line = buf.toString("utf8").trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (!line) return null;

  // New format: Base64 of the UTF-8 path, so a GBK-encoded Chinese Windows console isn't garbled when Node decodes it as UTF-8
  if (/^[A-Za-z0-9+/]+=*$/.test(line)) {
    const decoded = Buffer.from(line, "base64").toString("utf8");
    if (decoded && !decoded.includes("\uFFFD")) return decoded;
  }

  if (!line.includes("\uFFFD")) return line;

  const gbkLine = new TextDecoder("gbk").decode(buf).trim().split(/\r?\n/).pop()?.trim() ?? "";
  return gbkLine || null;
}

export function pickFolderWindows(initial?: string): Promise<{ available: boolean; path: string | null }> {
  return new Promise((resolvePromise) => {
    if (process.platform !== "win32") return resolvePromise({ available: false, path: null });
    const init = (initial ?? "").replace(/'/g, "''");
    const script =
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog;" +
      "$d.Description = '选择项目文件夹';" +
      "$d.ShowNewFolderButton = $true;" +
      (init ? `$d.SelectedPath = '${init}';` : "") +
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { " +
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.SelectedPath)) " +
      "}";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-NonInteractive", "-Command", script],
      { timeout: 120000, windowsHide: false, encoding: "buffer" },
      (e, stdout) => {
        if (e) return resolvePromise({ available: true, path: null });
        resolvePromise({ available: true, path: decodePickFolderStdout(stdout ?? Buffer.alloc(0)) });
      },
    );
  });
}
