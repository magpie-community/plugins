import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm } from "node:fs/promises";
import { dataDir, atomicWrite, jsonFile } from "./config.js";
import { escapeXml } from "./renderer.js";
import { run } from "./process.js";
const label = "ai.magpie.github-stats";
export function scheduleFiles(
  platform: string,
  dir: string,
  runtime = process.execPath,
  cli = fileURLToPath(new URL("cli.js", import.meta.url)),
  home = homedir(),
) {
  const args = [runtime, cli, "sync", "--due", "--home", dir];
  const envPath = [
    join(runtime, ".."),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    process.env.PATH || "",
  ].join(delimiter);
  if (platform === "darwin")
    return [
      {
        path: join(home, "Library", "LaunchAgents", `${label}.plist`),
        content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${escapeXml(a)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(envPath)}</string>${process.env.XDG_CONFIG_HOME ? `<key>XDG_CONFIG_HOME</key><string>${escapeXml(process.env.XDG_CONFIG_HOME)}</string>` : ""}</dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict><key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${escapeXml(join(dir, "scheduler.log"))}</string><key>StandardErrorPath</key><string>${escapeXml(join(dir, "scheduler.log"))}</string></dict></plist>`,
      },
    ];
  if (platform === "linux") {
    const quote = (s: string) =>
      '"' +
      s
        .replace(/%/g, "%%")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\$/g, "$$")
        .replace(/\n/g, "\\n") +
      '"';
    const root = join(home, ".config", "systemd", "user");
    return [
      {
        path: join(root, `${label}.service`),
        content: `[Unit]\nDescription=Magpie GitHub Stats sync\n[Service]\nType=oneshot\nEnvironment=${quote("PATH=" + envPath)}\n${process.env.XDG_CONFIG_HOME ? `Environment=${quote("XDG_CONFIG_HOME=" + process.env.XDG_CONFIG_HOME)}\n` : ""}ExecStart=${args.map(quote).join(" ")}\n`,
      },
      {
        path: join(root, `${label}.timer`),
        content: `[Unit]\nDescription=Daily Magpie sync with hourly catch-up\n[Timer]\nOnCalendar=*-*-* *:00:00\nOnStartupSec=90\nPersistent=true\nUnit=${label}.service\n[Install]\nWantedBy=timers.target\n`,
      },
    ];
  }
  if (platform === "win32") {
    const quote = (s: string) =>
      '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
    return [
      {
        path: join(dir, "schedule.xml"),
        content: `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><CalendarTrigger><Repetition><Interval>PT1H</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T02:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT30M</ExecutionTimeLimit></Settings><Actions Context=""><Exec><Command>${escapeXml(runtime)}</Command><Arguments>${escapeXml(args.slice(1).map(quote).join(" "))}</Arguments></Exec></Actions></Task>`,
      },
    ];
  }
  throw new Error("不支持此系统的自动调度。");
}
export async function installSchedule(dir = dataDir()) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files = scheduleFiles(process.platform, dir);
  for (const f of files)
    await atomicWrite(
      f.path,
      f.content.replace('encoding="UTF-16"', 'encoding="UTF-8"'),
    );
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid!()}`;
    await run("launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
    await run("launchctl", ["bootstrap", domain, files[0]!.path]);
  } else if (process.platform === "linux") {
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "--now", `${label}.timer`]);
  } else
    await run("schtasks", [
      "/Create",
      "/TN",
      label,
      "/XML",
      files[0]!.path,
      "/F",
    ]);
  await atomicWrite(
    join(dir, "schedule.json"),
    JSON.stringify(
      {
        installed: true,
        platform: process.platform,
        files: files.map((f) => f.path),
      },
      null,
      2,
    ),
  );
}
export async function uninstallSchedule(dir = dataDir()) {
  const saved = await jsonFile<{ installed?: boolean }>(
    join(dir, "schedule.json"),
    {},
  );
  if (!saved.installed) return;
  if (process.platform === "darwin")
    await run("launchctl", ["bootout", `gui/${process.getuid!()}/${label}`]);
  else if (process.platform === "linux")
    await run("systemctl", ["--user", "disable", "--now", `${label}.timer`]);
  else await run("schtasks", ["/Delete", "/TN", label, "/F"]);
  for (const f of scheduleFiles(process.platform, dir))
    await rm(f.path, { force: true });
  if (process.platform === "linux")
    await run("systemctl", ["--user", "daemon-reload"]);
  await atomicWrite(
    join(dir, "schedule.json"),
    JSON.stringify({ installed: false }),
  );
}
