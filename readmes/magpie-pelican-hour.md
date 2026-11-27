# Pelican Monitor

[English](https://github.com/fengcyborg/magpie-pelican-hour/blob/main/README.md) · [简体中文](https://github.com/fengcyborg/magpie-pelican-hour/blob/main/README.zh-CN.md) · [繁體中文](https://github.com/fengcyborg/magpie-pelican-hour/blob/main/README.zh-TW.md) · [日本語](https://github.com/fengcyborg/magpie-pelican-hour/blob/main/README.ja.md) · [Deutsch](https://github.com/fengcyborg/magpie-pelican-hour/blob/main/README.de.md)

Pelican Monitor checks each enabled subscription under Magpie’s official Codex provider. Every check asks the same model to animate a pelican riding a bicycle. Open **Pelican Monitor** in Magpie’s sidebar or use the [local dashboard](http://localhost:18765/). Select an account to see its next check, latest animation and run history.

## Install

In Magpie’s Plugins page, add the package `magpie-pelican-hour`. If you use the Magpie CLI, run

```sh
magpie plugin add npm:magpie-pelican-hour
```

Enable the plugin and keep Magpie running on an awake computer. Checks make real requests against each account’s subscription quota. To pause one account, use the switch on its card. Enabling it schedules an immediate check. Turning it off cancels any pending start-up check and keeps its history.

## Language and help

With **System language** selected, each check reads the language of the computer running Magpie. You can also choose Simplified Chinese, Traditional Chinese, English, Japanese or German on the local dashboard. Unsupported languages fall back to Simplified Chinese. The plugin sends the prompt in the selected language and asks the model to use it for the reply, title, visible text and accessibility descriptions. Open a run to read its exact prompt and original response. Language changes apply to future checks. Magpie uses its own interface language for the sidebar and plugin details.

## Scheduling and quiet hours

Each account normally runs once an hour at a random minute from 01 to 59. The next minute stays within ten minutes of the previous start minute during continuous operation, so the interval is roughly 50–70 minutes. Plans survive restarts. Missed hours during sleep are skipped. Magpie refreshes the account list hourly and checks availability before each run. New enabled accounts join automatically. Removed or disabled accounts keep their history.

Expand **Quiet hours and rest days**, turn on **Daily quiet hours**, choose start and end times and select **Save settings**. The window applies to all accounts in the host computer’s time zone and can cross midnight. During quiet hours the plugin pauses checks and interrupts active requests. If you enable an account during this window, its initial check waits until the window ends. Pausing it again cancels that check.

## Regional calendars and rest-day sampling

Enable rest-day sampling and choose one to eight checks per account per day. Workdays, including make-up workdays, keep their usual hourly frequency. **Evenly spaced** divides eligible time into equal intervals and picks one time in each for each account. **Custom times** lets you choose the exact times. After saving, select an account to see its plan for today or the next rest day.

In **Rest-day calendar**, keep **Match language** or select a region explicitly. For example, en-GB and en-US select different calendars. Browse by month and click today or a future date to mark it as a workday or rest day. Click it again to restore the regional rule. **Save settings** applies the overrides to every account.

The daily count uses local calendar dates and counts scheduled checks when they start. Editing the plan takes checks already started into account. A check queued by a busy service can wait up to an hour, ending earlier at the next slot, quiet hours or midnight. Missed slots are skipped after sleep or shutdown. An initial check on resume is recorded separately.

Calendars are available offline. Mainland China uses the published holiday and make-up dates for 2026 and 2027. For 245 other countries and regions, the plugin includes 2026–2028 public holiday data from python-holidays 0.109. You can override local differences. The calendar indicates when only weekend rules are available. Custom times skipped by the spring clock change are omitted that day. A time repeated in autumn runs once. [Holiday data](https://github.com/vacanza/holidays) · [China 2026](https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html) · [China 2027](https://chinajob.mohrss.gov.cn/h5/c/2026-11-09/635850.shtml)

## Checks, previews and storage

Select an account and choose **Run one check** for a single request, even while its schedule is paused. It uses the account’s quota, respects quiet hours and concurrency limits, and keeps its scheduled appointments. Repeated requests merge while a manual check is pending. Expired appointments are skipped after restart or sleep.

History has 12 entries per page for the selected account and filter. Open a run for its original prompt. Model request success and artwork save rates count known outcomes at each stage. Interrupted runs and unknown historical outcomes are excluded from the respective denominators. Intentional interruptions count checks stopped by quiet hours or an explicit plugin stop. The dashboard lists damaged records by relative path and preserves their files for recovery.

Magpie’s local gateway sends the fixed task in the check’s language to `gpt-6.2-astra` with `xhigh` reasoning. Up to three accounts can run at once. Open a run to see the original reply, HTML, extracted SVG and preview. **Back to run details** returns from the raw response. The extractor also handles a complete HTML document inside a JSON string.

Thumbnails play when visible. When a recording is unavailable, the gallery plays the saved HTML preview in a sandbox, including for older artwork. If the plugin finds Chrome or Chromium and FFmpeg, it records silent 60 fps previews for scripted artwork and saves 30 fps animated PNGs for browsers that restrict autoplay. Set `CHROME_PATH` and `FFMPEG_PATH` to the executables for custom installations.

The plugin serves the dashboard on port 18765. Devices that can reach this port on the LAN can read account aliases, run records and outputs. Settings can be changed on the host. Magpie manages login credentials. On macOS, archives are stored in `~/Library/Application Support/magpie-pelican/`, or in `$XDG_DATA_HOME/magpie-pelican/` if configured. Copy the entire directory to back up or migrate the archive. Renaming an account keeps its records under its stable ID.

To install from source, keep the full directory in a permanent location and select it in Magpie, or run this from that directory on macOS

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add "$PWD"
```
