// src/rules.ts
var MINUTE_MS = 60000;
var HOUR_MS = 3600000;
var RESET_GRACE_MS = 30000;
var LAST_DUE_LOOKBACK_MS = 48 * HOUR_MS;
var NAME_MAX = 40;
var formatters = new Map;
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatters.set(timeZone, f);
  }
  return f;
}
function wallOf(t, timeZone) {
  const p = {};
  for (const part of formatter(timeZone).formatToParts(t)) {
    if (part.type !== "literal")
      p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute };
}
function offsetMs(t, timeZone) {
  const sec = Math.floor(t.getTime() / 1000) * 1000;
  const w = wallOf(new Date(sec), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, sec / 1000 % 60) - sec;
}
function sameWall(w, y, mo, d, hh, mm) {
  return w.year === y && w.month === mo && w.day === d && w.hour === hh && w.minute === mm;
}
function resolveWallTime(y, mo, d, hh, mm, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  let t = guess - offsetMs(new Date(guess), timeZone);
  t = guess - offsetMs(new Date(t), timeZone);
  for (let i = 0;i < 4; i++) {
    const w = wallOf(new Date(t), timeZone);
    if (sameWall(w, y, mo, d, hh, mm)) {
      return earliestInstanceOf(guess, t, y, mo, d, hh, mm, timeZone);
    }
    if (w.hour === hh && w.minute === mm) {
      t += Date.UTC(y, mo - 1, d) - Date.UTC(w.year, w.month - 1, w.day);
      continue;
    }
    const probe = guess - offsetMs(new Date(t), timeZone);
    let lo = Math.min(t, probe);
    const loOffset = offsetMs(new Date(lo), timeZone);
    let hi = Math.max(t, probe);
    if (offsetMs(new Date(hi), timeZone) === loOffset)
      return new Date(t);
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetMs(new Date(mid), timeZone) === loOffset)
        lo = mid;
      else
        hi = mid;
    }
    return new Date(hi);
  }
  return new Date(t);
}
function earliestInstanceOf(guess, t, y, mo, d, hh, mm, timeZone) {
  const at = new Date(t);
  const oAt = offsetMs(at, timeZone);
  const back = t - 3 * HOUR_MS - MINUTE_MS;
  if (offsetMs(new Date(back), timeZone) === oAt)
    return at;
  let lo = back;
  let hi = t;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMs(new Date(mid), timeZone) === oAt)
      hi = mid;
    else
      lo = mid;
  }
  const oBefore = offsetMs(new Date(lo), timeZone);
  if (oBefore <= oAt)
    return at;
  const earlier = guess - oBefore;
  return sameWall(wallOf(new Date(earlier), timeZone), y, mo, d, hh, mm) ? new Date(earlier) : at;
}
function occurrencesOnDay(y, mo, d, hh, mm, timeZone) {
  const first = resolveWallTime(y, mo, d, hh, mm, timeZone);
  const out = [first];
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const oAt = offsetMs(first, timeZone);
  const probeEnd = first.getTime() + 3 * HOUR_MS + MINUTE_MS;
  if (offsetMs(new Date(probeEnd), timeZone) === oAt)
    return out;
  let lo = first.getTime();
  let hi = probeEnd;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMs(new Date(mid), timeZone) === oAt)
      lo = mid;
    else
      hi = mid;
  }
  const oAfter = offsetMs(new Date(hi), timeZone);
  if (oAfter >= oAt)
    return out;
  const second = guess - oAfter;
  if (second > first.getTime() && sameWall(wallOf(new Date(second), timeZone), y, mo, d, hh, mm)) {
    out.push(new Date(second));
  }
  return out;
}
function nextCalDay(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d + 1));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}
function nextDaily(t, after) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t.time);
  if (!m)
    throw new Error("时间需为 24 小时制的 HH:MM");
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const start = wallOf(after, t.timeZone);
  let y = start.year;
  let mo = start.month;
  let d = start.day;
  for (let i = 0;i < 400; i++) {
    for (const occ of occurrencesOnDay(y, mo, d, hh, mm, t.timeZone)) {
      if (occ.getTime() > after.getTime())
        return occ;
    }
    [y, mo, d] = nextCalDay(y, mo, d);
  }
  throw new Error("无法计算下一次执行时间");
}
function nextEvery(t, after) {
  const anchor = new Date(t.anchor).getTime();
  if (Number.isNaN(anchor))
    throw new Error("起点时间无法识别");
  if (!Number.isFinite(t.hours) || t.hours <= 0)
    throw new Error("间隔小时数必须为正数");
  if (after.getTime() < anchor)
    return new Date(anchor);
  const step = t.hours * HOUR_MS;
  const k = Math.floor((after.getTime() - anchor) / step) + 1;
  return new Date(anchor + k * step);
}
function upcoming(trigger, now, n) {
  if (trigger.kind === "window")
    return [];
  const out = [];
  let cursor = new Date(now.getTime());
  for (let i = 0;i < n; i++) {
    cursor = trigger.kind === "daily" ? nextDaily(trigger, cursor) : nextEvery(trigger, cursor);
    out.push(cursor);
  }
  return out;
}

// web/i18n.ts
var I18N = {
  en: {
    "模型列表来自 Magpie 上次获取的结果。账号和模型对不上时，到 Magpie「供应商」里打开这个供应商，点「获取模型」，再回来刷新本页。": "The model list comes from Magpie's last fetch. If accounts and models don't match, open this provider under Magpie's Providers page, click Fetch models, then refresh this page.",
    "还没有这个供应商的模型列表。请到 Magpie「供应商」里打开它，点「获取模型」。": "No model list for this provider yet. Open it under Magpie's Providers page and click Fetch models.",
    "窗口重置后": "After window reset",
    "每天定时": "Daily",
    "固定间隔": "Every N hours",
    "已停用": "Disabled",
    "发送中": "Sending",
    "上次失败": "Last failed",
    "上次结果未知": "Last result unknown",
    "明天": "Tomorrow",
    "今天": "Today",
    "昨天": "Yesterday",
    "自动选账号": "auto account",
    "自动选模型": "auto model",
    "窗口": "Window",
    "重置后": "after reset",
    "每天": "Daily",
    "每": "Every",
    "小时": "hours",
    "思考档位无法识别：": "Cannot read the reasoning effort: ",
    "思考：": "Reasoning: ",
    "成功": "Success",
    "失败": "Failed",
    "未知": "Unknown",
    "手动": "manual",
    "补发": "catch-up",
    "按计划": "scheduled",
    "已发送": "Sent",
    "思考": "reasoning",
    "秒": "s",
    "（不在当前账号列表）": " (not in the current account list)",
    "请选择账号": "Pick an account",
    "该供应商没有账号": "This provider has no accounts",
    "自动": "Auto",
    "已用": "Used",
    "重置": "reset",
    "空闲": "Idle",
    "该账号没有窗口信息": "No window info for this account",
    "先选定账号": "Pick an account first",
    "名字带 flash / lite / mini 的小模型优先，每次发送前重新选；思考能关就关，不能关用最低档。": "Smaller models with flash / lite / mini in the name are preferred and re-picked before each send; reasoning is turned off when possible, else the lowest effort is used.",
    "思考档位按这个模型的配置自动决定：能关就关，不能关用最低档。": "The reasoning effort follows this model's own configuration: off when possible, else the lowest effort.",
    "思考：目录里暂时没有这个模型": "Reasoning: this model is not in the catalog yet",
    "这个账号没有可用模型": "This account has no usable models",
    "该供应商没有可用模型": "This provider has no usable models",
    "自动选中": "Auto picks",
    "给任务起个名字": "Name the task",
    "名称不能超过": "The name can be at most",
    "字": "characters",
    "必须选择供应商": "Pick a provider",
    "必须选择账号": "Pick an account",
    "必须填写额度窗口名": "Enter the quota window name",
    "时间需为 24 小时制的 HH:MM": "Time must be HH:MM in 24-hour format",
    "任务没有暂停，下一次照常发送。": "The task is not paused; the next send proceeds as usual.",
    "名称": "Name",
    "选择供应商": "Pick a provider",
    "供应商": "Provider",
    "账号": "Account",
    "模型": "Model",
    "这个供应商没有按账号区分的模型列表，列出的是全部模型": "This provider has no per-account model list; every model is listed.",
    "跟随窗口重置时必须指定账号，每个账号的窗口各自计时。": "Following a window reset requires an account; each account's windows run on their own clocks.",
    "发送到": "Send to",
    "时区": "Time zone",
    "时间": "Time",
    "从": "From",
    "接下来": "Next",
    "，之后跟随每次重置": ", then after every reset",
    "等下一次额度刷新，之后跟随每次重置": "Waiting for the next quota refresh, then after every reset",
    "这个账号没有可跟随的窗口，已改为每天定时，保存后生效。": "This account has no window to follow; switched to Daily. Takes effect after saving.",
    "触发": "Trigger",
    "确认删除": "Confirm delete",
    "删除": "Delete",
    "放弃": "Discard",
    "有未保存的修改": "Unsaved changes",
    "取消": "Cancel",
    "保存": "Save",
    "执行记录": "Run history",
    "最近 50 次": "Last 50",
    "立即发送一次": "Send once now",
    "先保存任务": "Save the task first",
    "按已保存的设置发送，不含未保存的修改": "Sends with the saved settings; unsaved changes are not included",
    "马上按当前设置发一条，不影响计划": "Sends one message with the current settings right away, without affecting the schedule",
    "还没有执行过。": "No runs yet.",
    "显示更多": "Show more",
    "未命名任务": "Untitled task",
    "启用": "Enabled",
    "当前无法编辑任务。": "Tasks cannot be edited right now.",
    "还没有任务": "No tasks yet",
    "点「新建任务」，选好账号和触发方式即可。": "Click New task, pick an account and a trigger, and you are set.",
    "没有启用的任务": "No enabled tasks",
    "个任务启用": "task(s) enabled",
    "下一次": "Next",
    "页面与服务断开了：": "The page lost contact with the service: ",
    "（服务可能已退出，重新打开页面试试）": " (the service may have exited; try reopening the page)",
    "重试": "Retry",
    "与服务断开了，正在自动重连…": "Disconnected from the service; reconnecting automatically…",
    "服务处于故障状态，任务没有在运行：": "The service is in a failed state; tasks are not running: ",
    "另一个实例正在运行（进程 ": "Another instance is running (process ",
    "），本页只读。": "); this page is read-only.",
    "另一个实例可能正在运行（无法确认持有者进程），本页只读。": "Another instance may be running (its process could not be confirmed); this page is read-only.",
    "数据可能没保存：": "Data may not have been saved: ",
    "模型目录读取失败：": "Failed to read the model catalog: ",
    "（稍后自动重试）": " (retrying automatically)",
    "这个任务刚在别处被更新。下面保留的是你未保存的修改，直接保存会覆盖新版本。": "This task was just updated elsewhere. Your unsaved changes are kept below; saving now would overwrite the new version.",
    "页面缺少访问口令，请从 Magpie 的插件页重新打开。": "The page is missing its access token; please reopen it from Magpie's plugin page.",
    "窗口预热": "Window Warmup",
    "新建任务": "New task",
    "说明": "Help",
    "消息按供应商自己的额度规则计费，可能用到赠送额度或 API 余额；发送成功不代表窗口一定已开始计时。": "Each message is billed under the provider's own quota rules and may draw on bonus quota or API balance; a successful send does not guarantee the window has started counting.",
    "Magpie 关闭期间不会执行，重新打开后每个任务最多补发一次。": "Nothing runs while Magpie is closed; after it reopens, each task catches up at most once.",
    "失败不会暂停任务，下一次照常执行。": "A failure does not pause the task; the next run proceeds as usual."
  },
  "zh-TW": {
    "模型列表来自 Magpie 上次获取的结果。账号和模型对不上时，到 Magpie「供应商」里打开这个供应商，点「获取模型」，再回来刷新本页。": "模型清單來自 Magpie 上次取得的結果。帳號和模型對不上時，到 Magpie「供應商」裡開啟這個供應商，點「取得模型」，再回來重新整理本頁。",
    "还没有这个供应商的模型列表。请到 Magpie「供应商」里打开它，点「获取模型」。": "還沒有這個供應商的模型清單。請到 Magpie「供應商」裡開啟它，點「取得模型」。",
    "窗口重置后": "窗口重置後",
    "每天定时": "每天定時",
    "固定间隔": "固定間隔",
    "已停用": "已停用",
    "发送中": "傳送中",
    "上次失败": "上次失敗",
    "上次结果未知": "上次結果未知",
    "明天": "明天",
    "今天": "今天",
    "昨天": "昨天",
    "自动选账号": "自動選帳號",
    "自动选模型": "自動選模型",
    "窗口": "窗口",
    "重置后": "重置後",
    "每天": "每天",
    "每": "每",
    "小时": "小時",
    "思考档位无法识别：": "思考檔位無法識別：",
    "思考：": "思考：",
    "成功": "成功",
    "失败": "失敗",
    "未知": "未知",
    "手动": "手動",
    "补发": "補發",
    "按计划": "按計畫",
    "已发送": "已傳送",
    "思考": "思考",
    "秒": "秒",
    "（不在当前账号列表）": "（不在目前帳號清單）",
    "请选择账号": "請選擇帳號",
    "该供应商没有账号": "這個供應商沒有帳號",
    "自动": "自動",
    "已用": "已用",
    "重置": "重置",
    "空闲": "空閒",
    "该账号没有窗口信息": "這個帳號沒有窗口資訊",
    "先选定账号": "先選定帳號",
    "名字带 flash / lite / mini 的小模型优先，每次发送前重新选；思考能关就关，不能关用最低档。": "名字帶 flash / lite / mini 的小模型優先，每次傳送前重新選；思考能關就關，不能關用最低檔。",
    "思考档位按这个模型的配置自动决定：能关就关，不能关用最低档。": "思考檔位按這個模型的設定自動決定：能關就關，不能關用最低檔。",
    "思考：目录里暂时没有这个模型": "思考：目錄裡暫時沒有這個模型",
    "这个账号没有可用模型": "這個帳號沒有可用模型",
    "该供应商没有可用模型": "這個供應商沒有可用模型",
    "自动选中": "自動選中",
    "给任务起个名字": "給任務取個名字",
    "名称不能超过": "名稱不能超過",
    "字": "字",
    "必须选择供应商": "必須選擇供應商",
    "必须选择账号": "必須選擇帳號",
    "必须填写额度窗口名": "必須填寫額度窗口名",
    "时间需为 24 小时制的 HH:MM": "時間需為 24 小時制的 HH:MM",
    "任务没有暂停，下一次照常发送。": "任務沒有暫停，下一次照常傳送。",
    "名称": "名稱",
    "选择供应商": "選擇供應商",
    "供应商": "供應商",
    "账号": "帳號",
    "模型": "模型",
    "这个供应商没有按账号区分的模型列表，列出的是全部模型": "這個供應商沒有按帳號區分的模型清單，列出的是全部模型",
    "跟随窗口重置时必须指定账号，每个账号的窗口各自计时。": "跟隨窗口重置時必須指定帳號，每個帳號的窗口各自計時。",
    "发送到": "傳送到",
    "时区": "時區",
    "时间": "時間",
    "从": "從",
    "接下来": "接下來",
    "，之后跟随每次重置": "，之後跟隨每次重置",
    "等下一次额度刷新，之后跟随每次重置": "等下一次額度刷新，之後跟隨每次重置",
    "这个账号没有可跟随的窗口，已改为每天定时，保存后生效。": "這個帳號沒有可跟隨的窗口，已改為每天定時，儲存後生效。",
    "触发": "觸發",
    "确认删除": "確認刪除",
    "删除": "刪除",
    "放弃": "放棄",
    "有未保存的修改": "有未儲存的修改",
    "取消": "取消",
    "保存": "儲存",
    "执行记录": "執行記錄",
    "最近 50 次": "最近 50 次",
    "立即发送一次": "立即傳送一次",
    "先保存任务": "先儲存任務",
    "按已保存的设置发送，不含未保存的修改": "按已儲存的設定傳送，不含未儲存的修改",
    "马上按当前设置发一条，不影响计划": "馬上按目前設定發一條，不影響計畫",
    "还没有执行过。": "還沒有執行過。",
    "显示更多": "顯示更多",
    "未命名任务": "未命名任務",
    "启用": "啟用",
    "当前无法编辑任务。": "目前無法編輯任務。",
    "还没有任务": "還沒有任務",
    "点「新建任务」，选好账号和触发方式即可。": "點「新增任務」，選好帳號和觸發方式即可。",
    "没有启用的任务": "沒有啟用的任務",
    "个任务启用": "個任務啟用",
    "下一次": "下一次",
    "页面与服务断开了：": "頁面與服務的連線中斷：",
    "（服务可能已退出，重新打开页面试试）": "（服務可能已結束，重新開啟頁面試試）",
    "重试": "重試",
    "与服务断开了，正在自动重连…": "與服務的連線中斷，正在自動重新連線…",
    "服务处于故障状态，任务没有在运行：": "服務處於故障狀態，任務沒有在執行：",
    "另一个实例正在运行（进程 ": "另一個執行個體正在執行（處理程序 ",
    "），本页只读。": "），本頁唯讀。",
    "另一个实例可能正在运行（无法确认持有者进程），本页只读。": "另一個執行個體可能在執行（無法確認持有者處理程序），本頁唯讀。",
    "数据可能没保存：": "資料可能沒儲存：",
    "模型目录读取失败：": "模型目錄讀取失敗：",
    "（稍后自动重试）": "（稍後自動重試）",
    "这个任务刚在别处被更新。下面保留的是你未保存的修改，直接保存会覆盖新版本。": "這個任務剛在別處被更新。下面保留的是你未儲存的修改，直接儲存會覆蓋新版本。",
    "页面缺少访问口令，请从 Magpie 的插件页重新打开。": "頁面缺少存取權杖，請從 Magpie 的外掛頁重新開啟。",
    "窗口预热": "窗口預熱",
    "新建任务": "新增任務",
    "说明": "說明",
    "消息按供应商自己的额度规则计费，可能用到赠送额度或 API 余额；发送成功不代表窗口一定已开始计时。": "訊息按供應商自己的額度規則計費，可能用到贈送額度或 API 餘額；傳送成功不代表窗口一定已開始計時。",
    "Magpie 关闭期间不会执行，重新打开后每个任务最多补发一次。": "Magpie 關閉期間不會執行，重新開啟後每個任務最多補發一次。",
    "失败不会暂停任务，下一次照常执行。": "失敗不會暫停任務，下一次照常執行。"
  },
  ja: {
    "模型列表来自 Magpie 上次获取的结果。账号和模型对不上时，到 Magpie「供应商」里打开这个供应商，点「获取模型」，再回来刷新本页。": "モデル一覧は Magpie が最後に取得した結果のものです。アカウントとモデルが合わないときは、Magpie の「プロバイダー」でこのプロバイダーを開き、「モデルを取得」をクリックしてから、このページを再読み込みしてください。",
    "还没有这个供应商的模型列表。请到 Magpie「供应商」里打开它，点「获取模型」。": "このプロバイダーのモデル一覧はまだありません。Magpie の「プロバイダー」で開き、「モデルを取得」をクリックしてください。",
    "窗口重置后": "ウィンドウリセット後",
    "每天定时": "毎日定時",
    "固定间隔": "固定間隔",
    "已停用": "停止中",
    "发送中": "送信中",
    "上次失败": "前回失敗",
    "上次结果未知": "前回結果不明",
    "明天": "明日",
    "今天": "今日",
    "昨天": "昨日",
    "自动选账号": "アカウント自動選択",
    "自动选模型": "モデル自動選択",
    "窗口": "ウィンドウ",
    "重置后": "リセット後",
    "每天": "毎日",
    "每": "毎",
    "小时": "時間",
    "思考档位无法识别：": "思考レベルを判別できません：",
    "思考：": "思考：",
    "成功": "成功",
    "失败": "失敗",
    "未知": "不明",
    "手动": "手動",
    "补发": "キャッチアップ",
    "按计划": "予定どおり",
    "已发送": "送信済み",
    "思考": "思考",
    "秒": "秒",
    "（不在当前账号列表）": "（現在のアカウント一覧にありません）",
    "请选择账号": "アカウントを選択してください",
    "该供应商没有账号": "このプロバイダーにはアカウントがありません",
    "自动": "自動",
    "已用": "使用済み",
    "重置": "リセット",
    "空闲": "アイドル",
    "该账号没有窗口信息": "このアカウントにはウィンドウ情報がありません",
    "先选定账号": "先にアカウントを選択してください",
    "名字带 flash / lite / mini 的小模型优先，每次发送前重新选；思考能关就关，不能关用最低档。": "名前に flash / lite / mini が付く小さめのモデルを優先し、送信のたびに選び直します。思考はオフにできるときはオフ、できないときは最低レベルを使います。",
    "思考档位按这个模型的配置自动决定：能关就关，不能关用最低档。": "思考レベルはこのモデルの設定に従って自動的に決まります。オフにできるときはオフ、できないときは最低レベルです。",
    "思考：目录里暂时没有这个模型": "思考：このモデルはまだ一覧にありません",
    "这个账号没有可用模型": "このアカウントには使えるモデルがありません",
    "该供应商没有可用模型": "このプロバイダーには使えるモデルがありません",
    "自动选中": "自動選択",
    "给任务起个名字": "タスクに名前を付けてください",
    "名称不能超过": "名前は",
    "字": "文字まで",
    "必须选择供应商": "プロバイダーを選択してください",
    "必须选择账号": "アカウントを選択してください",
    "必须填写额度窗口名": "クォータウィンドウ名を入力してください",
    "时间需为 24 小时制的 HH:MM": "時刻は 24 時間制の HH:MM で入力してください",
    "任务没有暂停，下一次照常发送。": "タスクは停止せず、次回も通常どおり送信します。",
    "名称": "名前",
    "选择供应商": "プロバイダーを選択",
    "供应商": "プロバイダー",
    "账号": "アカウント",
    "模型": "モデル",
    "这个供应商没有按账号区分的模型列表，列出的是全部模型": "このプロバイダーにはアカウント別のモデル一覧がなく、すべてのモデルが表示されます。",
    "跟随窗口重置时必须指定账号，每个账号的窗口各自计时。": "ウィンドウのリセットに追従するにはアカウントの指定が必要です。各アカウントのウィンドウはそれぞれ別に計時されます。",
    "发送到": "送信先",
    "时区": "タイムゾーン",
    "时间": "時刻",
    "从": "起点",
    "接下来": "次回",
    "，之后跟随每次重置": "、その後はリセットのたびに送信",
    "等下一次额度刷新，之后跟随每次重置": "次のクォータ更新を待って、その後はリセットのたびに送信",
    "这个账号没有可跟随的窗口，已改为每天定时，保存后生效。": "このアカウントには追従できるウィンドウがないため、毎日定時に変更しました。保存後に有効になります。",
    "触发": "トリガー",
    "确认删除": "削除する",
    "删除": "削除",
    "放弃": "破棄",
    "有未保存的修改": "未保存の変更があります",
    "取消": "キャンセル",
    "保存": "保存",
    "执行记录": "実行履歴",
    "最近 50 次": "直近 50 件",
    "立即发送一次": "今すぐ 1 回送信",
    "先保存任务": "先にタスクを保存してください",
    "按已保存的设置发送，不含未保存的修改": "保存済みの設定で送信します。未保存の変更は含まれません",
    "马上按当前设置发一条，不影响计划": "現在の設定で 1 通すぐ送信します。予定には影響しません",
    "还没有执行过。": "まだ実行されていません。",
    "显示更多": "もっと表示",
    "未命名任务": "無題のタスク",
    "启用": "有効",
    "当前无法编辑任务。": "現在タスクを編集できません。",
    "还没有任务": "まだタスクがありません",
    "点「新建任务」，选好账号和触发方式即可。": "「新規タスク」から、アカウントとトリガーを選ぶだけで始められます。",
    "没有启用的任务": "有効なタスクはありません",
    "个任务启用": "件のタスクが有効",
    "下一次": "次回",
    "页面与服务断开了：": "ページとサービスの接続が切れました：",
    "（服务可能已退出，重新打开页面试试）": "（サービスが終了した可能性があります。ページを開き直してみてください）",
    "重试": "再試行",
    "与服务断开了，正在自动重连…": "サービスと切断されました。自動的に再接続しています…",
    "服务处于故障状态，任务没有在运行：": "サービスは故障状態にあり、タスクは実行されていません：",
    "另一个实例正在运行（进程 ": "別のインスタンスが実行中（プロセス ",
    "），本页只读。": "）。このページは閲覧のみです。",
    "另一个实例可能正在运行（无法确认持有者进程），本页只读。": "別のインスタンスが実行中の可能性があります（保持しているプロセスを確認できません）。このページは閲覧のみです。",
    "数据可能没保存：": "データが保存されていない可能性があります：",
    "模型目录读取失败：": "モデルカタログの読み取りに失敗しました：",
    "（稍后自动重试）": "（後で自動的に再試行します）",
    "这个任务刚在别处被更新。下面保留的是你未保存的修改，直接保存会覆盖新版本。": "このタスクは別の場所で更新されました。下には未保存の変更が残っています。このまま保存すると新しいバージョンが上書きされます。",
    "页面缺少访问口令，请从 Magpie 的插件页重新打开。": "ページにアクセストークンがありません。Magpie のプラグインページから開き直してください。",
    "窗口预热": "ウィンドウ予熱",
    "新建任务": "新規タスク",
    "说明": "ヘルプ",
    "消息按供应商自己的额度规则计费，可能用到赠送额度或 API 余额；发送成功不代表窗口一定已开始计时。": "メッセージはプロバイダー独自のクォータ規則で課金され、ボーナス額度や API 残高を使うことがあります。送信が成功してもウィンドウの計時が始まったとは限りません。",
    "Magpie 关闭期间不会执行，重新打开后每个任务最多补发一次。": "Magpie が閉じている間は実行されません。再オープン後、各タスクは最大 1 回キャッチアップ送信されます。",
    "失败不会暂停任务，下一次照常执行。": "失敗してもタスクは停止せず、次回も通常どおり実行します。"
  }
};
function normalizeLang(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.startsWith("zh-hant") || s === "zh-tw" || s === "zh-hk")
    return "zh-TW";
  if (s.startsWith("zh"))
    return "zh";
  if (s.startsWith("ja"))
    return "ja";
  if (s.startsWith("en"))
    return "en";
  return "zh";
}
var lang = "zh";
function setLang(raw) {
  lang = normalizeLang(raw);
}
function currentLang() {
  return lang;
}
function t(s) {
  return I18N[lang]?.[s] ?? s;
}

// src/types.ts
function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

// web/app.ts
var DAY_MS = 86400000;
var POLL_MS = 3000;
var CATALOG_POLL_MS = 60000;
var RUNS_PREVIEW = 5;
var RUNS_MAX = 50;
var DELETE_CONFIRM_MS = 3000;
var MODEL_SOURCE_HINT = "模型列表来自 Magpie 上次获取的结果。账号和模型对不上时，到 Magpie「供应商」里打开这个供应商，点「获取模型」，再回来刷新本页。";
var NO_MODELS_HINT = "还没有这个供应商的模型列表。请到 Magpie「供应商」里打开它，点「获取模型」。";
var TRIGGERS = [
  ["window", "窗口重置后"],
  ["daily", "每天定时"],
  ["every", "固定间隔"]
];
function statusOf(task, runs) {
  if (!task.enabled)
    return { tone: "", text: t("已停用") };
  let latest = null;
  for (const r of runs) {
    if (r.taskId !== task.id)
      continue;
    if (!latest || r.startedAt >= latest.startedAt)
      latest = r;
  }
  if (latest?.outcome === "running")
    return { tone: "ok", text: t("发送中") };
  if (latest?.outcome === "failed")
    return { tone: "bad", text: t("上次失败") };
  if (latest?.outcome === "unknown")
    return { tone: "unk", text: t("上次结果未知") };
  return { tone: "", text: "" };
}
function nextLabel(iso, now) {
  if (!iso)
    return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "—";
  const fmt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const time = fmt.format(d);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (day === 0)
    return time;
  if (day === 1)
    return `${t("明天")} ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
function runTimeLabel(iso, now) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "—";
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (day === 0)
    return `${t("今天")} ${hm}`;
  if (day === -1)
    return `${t("昨天")} ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function rowSub(task, providers) {
  const acct = providers.find((p) => p.id === task.provider)?.accounts.find((a) => a.id === task.account);
  const who = task.account ? acct?.label || task.account : t("自动选账号");
  return `${trigText(task.trigger)} · ${who} · ${task.model ? shortModel(task.model) : t("自动选模型")}`;
}
function trigText(trigger) {
  switch (trigger.kind) {
    case "window":
      return `${t("窗口")} ${trigger.window} ${t("重置后")}`;
    case "daily":
      return `${t("每天")} ${trigger.time}`;
    case "every":
      return `${t("每")} ${trigger.hours} ${t("小时")}`;
  }
}
function shortModel(id) {
  return id.split("/").pop() ?? id;
}
function modelDisplay(modelId, providerId) {
  return providerId && modelId.startsWith(`${providerId}/`) ? modelId.slice(providerId.length + 1) : modelId;
}
function effortLabel(pick) {
  if ("error" in pick)
    return `${t("思考档位无法识别：")}${pick.error}`;
  return `${t("思考：")}${pick.label}`;
}
function runOutcome(outcome) {
  switch (outcome) {
    case "ok":
      return { text: t("成功"), tone: "" };
    case "failed":
      return { text: t("失败"), tone: "bad" };
    case "unknown":
      return { text: t("未知"), tone: "unk" };
    case "running":
      return { text: t("发送中"), tone: "" };
    default:
      return { text: t("未知"), tone: "unk" };
  }
}
var SOURCE_TEXT = {
  manual: "手动",
  catchup: "补发",
  schedule: "按计划"
};
function runReason(r) {
  if (r.outcome !== "ok")
    return r.reason;
  const parts = [t("已发送")];
  if (r.model)
    parts.push(shortModel(r.model));
  if (r.effort)
    parts.push(`${t("思考")} ${r.effort}`);
  if (r.ms !== null)
    parts.push(`${(r.ms / 1000).toFixed(1)} ${t("秒")}`);
  parts.push(t(SOURCE_TEXT[r.source] ?? r.source));
  return parts.join(" · ");
}
function accountOptions(providerId, current, providers) {
  const list = [];
  const provider = providers.find((p) => p.id === providerId);
  if (!current || !provider?.accounts.some((a) => a.id === current)) {
    list.push({ value: current, text: current ? `${current}${t("（不在当前账号列表）")}` : t("请选择账号") });
  }
  for (const a of provider?.accounts ?? []) {
    if (a.kind === "key" && a.label && a.label !== a.id)
      list.push({ value: a.id, text: a.label, aux: a.id });
    else
      list.push({ value: a.id, text: a.label || a.id });
  }
  if (!list.length)
    list.push({ value: "", text: t("该供应商没有账号") });
  return list;
}
function accountModelView(provider, accountId) {
  const acct = accountId ? provider?.accounts.find((a) => a.id === accountId) : undefined;
  if (!acct) {
    return {
      models: provider?.autoAccountModels ?? null,
      autoModel: provider?.autoModel ?? null,
      perAccount: null
    };
  }
  return { models: acct.models, autoModel: acct.autoModel, perAccount: acct.perAccount };
}
function modelOptions(providerId, accountId, current, providers) {
  const provider = providers.find((p) => p.id === providerId);
  const view = accountModelView(provider, accountId);
  const list = [];
  const auto = { value: "", text: t("自动") };
  if (view.autoModel)
    auto.aux = modelDisplay(view.autoModel, providerId);
  list.push(auto);
  const known = view.models ?? [];
  if (current && !known.includes(current))
    list.push({ value: current, text: current });
  for (const id of view.models ?? [])
    list.push({ value: id, text: modelDisplay(id, providerId) });
  return list;
}
function windowAux(w) {
  const parts = [];
  if (w.used !== null)
    parts.push(`${t("已用")} ${Math.round(w.used)}%`);
  parts.push(w.resetsAt ? `${hm(new Date(w.resetsAt))} ${t("重置")}` : t("空闲"));
  return parts.join(" · ");
}
function accountHasWindows(providerId, accountId, providers) {
  if (!accountId)
    return false;
  const acct = providers.find((p) => p.id === providerId)?.accounts.find((a) => a.id === accountId);
  return (acct?.windows.length ?? 0) > 0;
}
function windowOptions(providerId, accountId, current, providers) {
  const provider = providers.find((p) => p.id === providerId);
  const acct = provider?.accounts.find((a) => a.id === accountId);
  const list = [];
  if (current && !acct?.windows.some((w) => w.name === current)) {
    list.push({ value: current, text: current });
  }
  for (const w of acct?.windows ?? [])
    list.push({ value: w.name, text: w.name, aux: windowAux(w) });
  if (!list.length)
    list.push({ value: "", text: accountId ? t("该账号没有窗口信息") : t("先选定账号") });
  return list;
}
function forceWindowAccount(providerId, providers) {
  const accounts = providers.find((p) => p.id === providerId)?.accounts ?? [];
  return (accounts.find((a) => a.windows.length > 0) ?? accounts[0])?.id ?? "";
}
function modelHint(model, provider, accountId) {
  const autoSub = "名字带 flash / lite / mini 的小模型优先，每次发送前重新选；思考能关就关，不能关用最低档。";
  const fixedSub = "思考档位按这个模型的配置自动决定：能关就关，不能关用最低档。";
  if (model) {
    const m = provider?.models.find((x) => x.id === model);
    return { main: m ? effortLabel(m.effort) : t("思考：目录里暂时没有这个模型"), sub: t(fixedSub) };
  }
  const autoId = accountModelView(provider, accountId).autoModel;
  if (!autoId) {
    return { main: accountId ? t("这个账号没有可用模型") : t("该供应商没有可用模型"), sub: t(autoSub) };
  }
  const m = provider?.models.find((x) => x.id === autoId);
  const think = m ? effortLabel(m.effort) : t("思考：目录里暂时没有这个模型");
  return { main: `${t("自动选中")} ${shortModel(autoId)} · ${think}`, sub: t(autoSub) };
}
function sumView(tasks, next) {
  let enabled = 0;
  let best = null;
  for (const t of tasks) {
    if (!t.enabled)
      continue;
    enabled++;
    const at = next[t.id];
    if (at && (!best || at < best.at))
      best = { at, name: t.name };
  }
  return { enabled, next: best };
}
function validateDraft(d) {
  const name = d.name.trim();
  if (!name)
    return { error: t("给任务起个名字"), field: "name" };
  if ([...name].length > NAME_MAX)
    return { error: `${t("名称不能超过")} ${NAME_MAX} ${t("字")}`, field: "name" };
  if (!d.provider.trim())
    return { error: t("必须选择供应商"), field: "provider" };
  if (!d.account.trim())
    return { error: t("必须选择账号"), field: "account" };
  if (d.trigger.kind === "window") {
    if (!d.trigger.window)
      return { error: t("必须填写额度窗口名"), field: "window" };
  }
  if (d.trigger.kind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.trigger.time)) {
    return { error: t("时间需为 24 小时制的 HH:MM"), field: "time" };
  }
  return null;
}
function syncDraftOnPoll(saved, openUpdatedAt, dirty) {
  if (!saved)
    return "gone";
  if (!dirty)
    return "adopt";
  return saved.updatedAt === openUpdatedAt ? "keep" : "stale";
}
function deleteArmed(confirmDeleteAt, now) {
  return confirmDeleteAt > 0 && now - confirmDeleteAt <= DELETE_CONFIRM_MS;
}
function shouldCloseOnScroll(target, pop) {
  if (!pop)
    return false;
  if (target === pop)
    return false;
  return !pop.contains(target);
}
function nextPointsAfter(trigger, after, count) {
  try {
    return upcoming(trigger, after, count);
  } catch {
    return [];
  }
}
var p2 = (n) => String(n).padStart(2, "0");
var hm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
function b64decode(s) {
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function localTZ() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
function timezones() {
  const supported = Intl.supportedValuesOf;
  const list = supported ? supported("timeZone") : [];
  const fallback = ["UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York"];
  const all = list.length ? list : fallback;
  return all.includes(localTZ()) ? all : [localTZ(), ...all];
}
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function localInputToISO(v) {
  if (!v)
    return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function cloneTask(t) {
  return JSON.parse(JSON.stringify(t));
}
function contentOf(d) {
  return {
    name: d.name,
    enabled: d.enabled,
    provider: d.provider,
    account: d.account,
    model: d.model,
    trigger: d.trigger
  };
}
var NEW_ID = "__new__";
var boot = null;
var state = null;
var catalog = null;
var catalogError = "";
var netError = "";
var fetchFails = 0;
var reconnecting = false;
var actionError = "";
var openId = null;
var draft = null;
var openUpdatedAt = null;
var dirty = false;
var isNew = false;
var staleNote = null;
var formError = null;
var confirmDeleteAt = 0;
var runsExpanded = false;
var catalogTimer;
async function apiJSON(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-window-warmup-token": boot?.token ?? "",
      ...init.headers
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error;
    throw new Error(typeof msg === "string" && msg ? msg : `HTTP ${res.status}`);
  }
  return body;
}
function isReadonly() {
  return !!(state?.fatal || state && typeof state.lockedBy === "number");
}
function currentSavedTask() {
  if (!openId || isNew)
    return null;
  return state?.tasks.find((t) => t.id === openId) ?? null;
}
function latestRunOf(taskId) {
  let latest = null;
  for (const r of state?.runs ?? []) {
    if (r.taskId !== taskId)
      continue;
    if (!latest || r.startedAt >= latest.startedAt)
      latest = r;
  }
  return latest;
}
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls)
    node.className = cls;
  if (text !== undefined)
    node.textContent = text;
  return node;
}
function replaceChildrenIfChanged(container, sig, build) {
  if (container.dataset.sig === sig)
    return;
  container.dataset.sig = sig;
  const top = container.scrollTop;
  container.replaceChildren(...build());
  container.scrollTop = top;
}
var CHEV = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 6.5 2.5 2.5 2.5-2.5"/></svg>';
var popEl = null;
function closePop() {
  if (!popEl)
    return;
  popEl.btn.classList.remove("open");
  popEl.btn.setAttribute("aria-expanded", "false");
  popEl.remove();
  popEl = null;
}
function sel(label, opts, val, onchange, disabled = false) {
  const b = el("button", "field");
  b.type = "button";
  if (disabled)
    b.disabled = true;
  else {
    b.setAttribute("aria-haspopup", "listbox");
    b.setAttribute("aria-expanded", "false");
  }
  const cur = opts.find((o) => o.value === val) ?? opts[0];
  const kv = el("span", "kv");
  if (label)
    kv.append(el("span", "k", label));
  const v = el("span", "v", cur?.text ?? "");
  b.title = (cur?.text ?? "") + (cur?.aux ? ` · ${cur.aux}` : "");
  const c = el("span", "chev");
  c.innerHTML = CHEV;
  kv.append(v);
  if (cur?.aux)
    kv.append(el("span", "aux", cur.aux));
  b.append(kv, c);
  b.addEventListener("click", () => {
    if (popEl && popEl.btn === b) {
      closePop();
      return;
    }
    closePop();
    const m = el("div", "pop");
    m.setAttribute("role", "listbox");
    let focusIdx = 0;
    opts.forEach((o, i) => {
      const it = el("button", "it");
      it.type = "button";
      it.setAttribute("role", "option");
      const on = o.value === val;
      if (on) {
        it.setAttribute("aria-selected", "true");
        focusIdx = i;
      }
      const tx = el("span", "tx", o.text);
      tx.title = o.text;
      it.append(el("span", "tick", on ? "✓" : ""), tx);
      if (o.aux)
        it.append(el("span", "aux", o.aux));
      it.addEventListener("click", () => {
        closePop();
        if (o.value !== val)
          onchange(o.value);
      });
      m.append(it);
    });
    m.btn = b;
    document.body.append(m);
    popEl = m;
    b.classList.add("open");
    b.setAttribute("aria-expanded", "true");
    const r = b.getBoundingClientRect();
    m.style.minWidth = `${Math.max(180, r.width)}px`;
    const w = m.offsetWidth;
    const hgt = m.offsetHeight;
    m.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    m.style.top = `${r.bottom + 4 + hgt > window.innerHeight - 8 ? Math.max(8, r.top - 4 - hgt) : r.bottom + 4}px`;
    const items = [...m.querySelectorAll(".it")];
    items[focusIdx]?.focus();
    m.addEventListener("keydown", (ev) => {
      const idx = items.indexOf(document.activeElement);
      let next = -1;
      if (ev.key === "ArrowDown")
        next = Math.min(items.length - 1, idx + 1);
      else if (ev.key === "ArrowUp")
        next = Math.max(0, idx - 1);
      else if (ev.key === "Home")
        next = 0;
      else if (ev.key === "End")
        next = items.length - 1;
      if (next >= 0) {
        ev.preventDefault();
        items[next].focus();
      }
    });
  });
  return b;
}
function field(label, control) {
  const f = el("label", "field");
  const kv = el("span", "kv");
  if (label)
    kv.append(el("span", "k", label));
  kv.append(control);
  f.append(kv);
  return f;
}
function row(ed, label, ...kids) {
  const v = el("div", "v");
  v.append(...kids);
  ed.append(el("label", undefined, label), v);
}
var tzOptionsCache = null;
function tzOffsetLabel(tz, at) {
  try {
    const min = offsetMs(at, tz) / 60000;
    const abs = Math.abs(min);
    return `UTC${min < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? `:${p2(abs % 60)}` : ""}`;
  } catch {
    return "";
  }
}
function timezoneOptions() {
  if (!tzOptionsCache) {
    const now = new Date;
    tzOptionsCache = timezones().map((z) => ({
      value: z,
      text: z,
      aux: tzOffsetLabel(z, now)
    }));
  }
  return tzOptionsCache;
}
var f = null;
function markDirty() {
  dirty = true;
}
function onNameInput(apply) {
  const caret = f?.name.selectionStart ?? null;
  apply();
  formError = null;
  if (!dirty) {
    dirty = true;
    render();
    const again = f?.name;
    if (again) {
      again.focus();
      const pos = Math.min(caret ?? again.value.length, again.value.length);
      again.setSelectionRange(pos, pos);
    }
  }
}
function openTask(task) {
  openId = task.id;
  draft = cloneTask(task);
  openUpdatedAt = task.updatedAt;
  dirty = false;
  isNew = false;
  runsExpanded = false;
  staleNote = null;
  formError = null;
  confirmDeleteAt = 0;
}
function openNew() {
  const providers = catalog?.providers ?? [];
  const provider = providers[0]?.id ?? "";
  const account = forceWindowAccount(provider, providers);
  const win = windowOptions(provider, account, "", providers).find((o) => o.value)?.value ?? "";
  draft = {
    id: "",
    name: "",
    enabled: true,
    provider,
    account,
    model: "",
    message: "hi",
    trigger: { kind: "window", window: win },
    createdAt: "",
    updatedAt: ""
  };
  openId = NEW_ID;
  openUpdatedAt = null;
  dirty = true;
  isNew = true;
  runsExpanded = false;
  staleNote = null;
  formError = null;
  confirmDeleteAt = 0;
  render();
  f?.name.focus();
}
function closeEditor() {
  openId = null;
  draft = null;
  openUpdatedAt = null;
  dirty = false;
  isNew = false;
  runsExpanded = false;
  staleNote = null;
  formError = null;
  confirmDeleteAt = 0;
  f = null;
}
function cancelEdit() {
  if (isNew || !openId) {
    closeEditor();
    render();
    return;
  }
  const saved = currentSavedTask();
  if (!saved) {
    closeEditor();
    render();
    return;
  }
  draft = cloneTask(saved);
  openUpdatedAt = saved.updatedAt;
  dirty = false;
  formError = null;
  staleNote = null;
  render();
}
async function save() {
  const d = draft;
  if (!d || !openId)
    return;
  const check = validateDraft(d);
  if (check) {
    formError = check.error;
    render();
    if (check.field === "name")
      f?.name.focus();
    return;
  }
  const content = contentOf(d);
  const input = {
    ...content,
    name: content.name.trim(),
    provider: content.provider.trim(),
    account: content.account.trim(),
    model: content.model.trim()
  };
  try {
    if (isNew)
      await apiJSON("api/tasks", { method: "POST", body: JSON.stringify(input) });
    else
      await apiJSON(`api/tasks/${encodeURIComponent(openId)}`, { method: "PUT", body: JSON.stringify(input) });
  } catch (e) {
    formError = errText(e);
    render();
    return;
  }
  if (!draft || !openId || d !== draft) {
    return;
  }
  dirty = false;
  formError = null;
  if (isNew)
    closeEditor();
  await refreshState();
}
async function removeCurrent() {
  const saved = currentSavedTask();
  if (!saved) {
    closeEditor();
    render();
    return;
  }
  if (!deleteArmed(confirmDeleteAt, Date.now())) {
    confirmDeleteAt = Date.now();
    render();
    window.setTimeout(() => {
      if (confirmDeleteAt !== 0 && !deleteArmed(confirmDeleteAt, Date.now())) {
        confirmDeleteAt = 0;
        render();
      }
    }, DELETE_CONFIRM_MS + 100);
    return;
  }
  confirmDeleteAt = 0;
  try {
    await apiJSON(`api/tasks/${encodeURIComponent(saved.id)}`, { method: "DELETE" });
    closeEditor();
    await refreshState();
  } catch (e) {
    actionError = errText(e);
    render();
  }
}
async function runNow() {
  const task = currentSavedTask();
  if (!task)
    return;
  try {
    await apiJSON(`api/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
    await refreshState();
  } catch (e) {
    formError = errText(e);
    render();
  }
}
async function toggleEnabled(saved) {
  if (!saved) {
    if (!draft)
      return;
    draft.enabled = !draft.enabled;
    dirty = true;
    render();
    return;
  }
  const input = { ...contentOf(saved), enabled: !saved.enabled };
  try {
    const updated = await apiJSON(`api/tasks/${encodeURIComponent(saved.id)}`, { method: "PUT", body: JSON.stringify(input) });
    if (openId === saved.id)
      openUpdatedAt = updated.updatedAt;
    await refreshState();
  } catch (e) {
    actionError = errText(e);
    render();
  }
}
function firstWindow(providerId, accountId, providers) {
  return windowOptions(providerId, accountId, "", providers).find((o) => o.value)?.value ?? "";
}
function adoptAccount(provider, accountId) {
  if (!draft)
    return;
  draft.account = accountId;
  if (draft.model && !accountModelView(provider, accountId).models?.includes(draft.model))
    draft.model = "";
}
function editorNotes(d, saved) {
  const notes = [];
  if (saved && d.enabled) {
    const last = latestRunOf(saved.id);
    if (last && last.outcome === "failed") {
      const n = el("div", "note full");
      n.append(`${t("上次失败")}（${runTimeLabel(last.startedAt, new Date)}）：`);
      n.append(el("span", undefined, `${last.reason}。${t("任务没有暂停，下一次照常发送。")}`));
      notes.push(n);
    }
  }
  if (staleNote)
    notes.push(el("div", "stale full", t(staleNote)));
  if (formError)
    notes.push(el("div", "note full", formError));
  return notes;
}
function sendToParts(d, providers, provider) {
  const fs = el("div", "fields c3");
  const provOpts = providers.map((p) => ({ value: p.id, text: p.id }));
  if (d.provider && !provOpts.some((o) => o.value === d.provider))
    provOpts.unshift({ value: d.provider, text: d.provider });
  if (!provOpts.length)
    provOpts.push({ value: "", text: t("选择供应商") });
  fs.append(sel(t("供应商"), provOpts, d.provider, (v) => {
    markDirty();
    if (!draft)
      return;
    draft.provider = v;
    draft.account = forceWindowAccount(v, providers);
    if (draft.trigger.kind === "window") {
      draft.trigger = { kind: "window", window: firstWindow(v, draft.account, providers) };
    }
    draft.model = "";
    formError = null;
    render();
  }));
  fs.append(sel(t("账号"), accountOptions(d.provider, d.account, providers), d.account, (v) => {
    markDirty();
    adoptAccount(provider, v);
    if (draft && draft.trigger.kind === "window") {
      draft.trigger = { kind: "window", window: firstWindow(draft.provider, v, providers) };
    }
    formError = null;
    render();
  }));
  const view = accountModelView(provider, d.account);
  fs.append(sel(t("模型"), modelOptions(d.provider, d.account, d.model, providers), d.model, (v) => {
    markDirty();
    if (draft)
      draft.model = v;
    formError = null;
    render();
  }, view.models === null));
  const parts = [fs];
  if (view.models === null) {
    parts.push(el("div", "hint warn", t(NO_MODELS_HINT)));
  } else {
    const mh = modelHint(d.model, provider, d.account);
    parts.push(el("div", "hint", mh.main), el("div", "hint mute", mh.sub));
    if (view.perAccount === false) {
      parts.push(el("div", "hint mute", t("这个供应商没有按账号区分的模型列表，列出的是全部模型")));
    }
    parts.push(el("div", "hint mute", t(MODEL_SOURCE_HINT)));
  }
  if (d.trigger.kind === "window") {
    parts.push(el("div", "hint mute", t("跟随窗口重置时必须指定账号，每个账号的窗口各自计时。")));
  }
  return parts;
}
function triggerSeg(d, providers, provider) {
  const hasWindows = accountHasWindows(d.provider, d.account, providers);
  const seg = el("div", "seg");
  for (const [k, txt] of TRIGGERS) {
    if (k === "window" && !hasWindows)
      continue;
    const b = el("button", d.trigger.kind === k ? "on" : "", t(txt));
    b.type = "button";
    b.addEventListener("click", () => {
      if (!draft || draft.trigger.kind === k)
        return;
      markDirty();
      if (k === "window") {
        adoptAccount(provider, draft.account || forceWindowAccount(draft.provider, providers));
        draft.trigger = { kind: "window", window: firstWindow(draft.provider, draft.account, providers) };
      } else if (k === "daily") {
        draft.trigger = { kind: "daily", time: "06:00", timeZone: localTZ() };
      } else {
        draft.trigger = { kind: "every", hours: 24, anchor: new Date().toISOString() };
      }
      formError = null;
      render();
    });
    seg.append(b);
  }
  return seg;
}
function triggerFields(d, providers) {
  const line = el("div", "fields " + (d.trigger.kind === "window" ? "c1" : "c2"));
  line.style.marginTop = "8px";
  if (d.trigger.kind === "window") {
    const winName = d.trigger.window;
    line.append(sel(t("窗口"), windowOptions(d.provider, d.account, winName, providers), winName, (v) => {
      markDirty();
      if (draft && draft.trigger.kind === "window")
        draft.trigger = { kind: "window", window: v };
      formError = null;
      render();
    }));
  } else if (d.trigger.kind === "daily") {
    const ti = el("input");
    ti.type = "time";
    ti.dataset.fk = "daily-time";
    ti.value = d.trigger.time;
    ti.addEventListener("change", () => {
      markDirty();
      if (draft && draft.trigger.kind === "daily")
        draft.trigger = { ...draft.trigger, time: ti.value };
      formError = null;
      render();
    });
    const tz = sel(t("时区"), timezoneOptions(), d.trigger.timeZone, (v) => {
      markDirty();
      if (draft && draft.trigger.kind === "daily")
        draft.trigger = { ...draft.trigger, timeZone: v };
      render();
    });
    line.append(field(t("时间"), ti), tz);
  } else {
    const hoursOpts = [1, 2, 3, 4, 5, 6, 8, 12, 24, 48, 72, 168].map((n) => ({ value: String(n), text: `${n} ${t("小时")}` }));
    const hv = String(d.trigger.hours);
    if (!hoursOpts.some((o) => o.value === hv))
      hoursOpts.unshift({ value: hv, text: `${hv} ${t("小时")}` });
    line.append(sel(t("每"), hoursOpts, hv, (v) => {
      markDirty();
      if (draft && draft.trigger.kind === "every")
        draft.trigger = { ...draft.trigger, hours: Number(v) };
      formError = null;
      render();
    }));
    const an = el("input");
    an.type = "datetime-local";
    an.dataset.fk = "every-anchor";
    an.value = isoToLocalInput(d.trigger.anchor);
    an.addEventListener("change", () => {
      markDirty();
      if (draft && draft.trigger.kind === "every") {
        draft.trigger = { ...draft.trigger, anchor: localInputToISO(an.value) ?? draft.trigger.anchor };
      }
      formError = null;
      render();
    });
    line.append(field(t("从"), an));
  }
  return line;
}
function nextPreview(d, provider, saved) {
  const nextEl = el("div", "next");
  const now = new Date;
  const nextIso = saved && !dirty && state ? state.next[saved.id] ?? null : null;
  if (d.trigger.kind === "window") {
    const winName = d.trigger.window;
    let first = nextIso ? nextLabel(nextIso, now) : "";
    if (!first) {
      const win = provider?.accounts.find((a) => a.id === d.account)?.windows.find((w) => w.name === winName);
      if (win?.resetsAt) {
        first = nextLabel(new Date(new Date(win.resetsAt).getTime() + RESET_GRACE_MS).toISOString(), now);
      }
    }
    nextEl.append(`${t("接下来")} `, el("b", undefined, first ? `${first}${t("，之后跟随每次重置")}` : t("等下一次额度刷新，之后跟随每次重置")));
    return nextEl;
  }
  const dates = [];
  const trig = saved?.trigger ?? null;
  if (trig && trig.kind !== "window" && nextIso) {
    const first = new Date(nextIso);
    dates.push(first, ...nextPointsAfter(trig, first, 2));
  } else {
    dates.push(...nextPointsAfter(d.trigger, now, 3));
  }
  nextEl.append(`${t("接下来")} `, el("b", undefined, dates.length ? dates.map((x) => nextLabel(x.toISOString(), now)).join(" · ") : "—"));
  return nextEl;
}
function editorActions(saved) {
  const act = el("div", "actions full");
  const del = el("button", "btn danger", saved ? deleteArmed(confirmDeleteAt, Date.now()) ? t("确认删除") : t("删除") : t("放弃"));
  del.type = "button";
  del.disabled = isReadonly();
  del.addEventListener("click", () => void removeCurrent());
  act.append(del, el("span", "sp"));
  if (dirty) {
    act.append(el("span", "dirty-tip", t("有未保存的修改")));
    const cancel = el("button", "btn", t("取消"));
    cancel.type = "button";
    cancel.addEventListener("click", cancelEdit);
    const saveBtn = el("button", "btn primary", t("保存"));
    saveBtn.type = "button";
    saveBtn.disabled = isReadonly();
    saveBtn.addEventListener("click", () => void save());
    act.append(cancel, saveBtn);
  }
  return act;
}
function runsSection(saved) {
  const now = new Date;
  const box = el("div", "full");
  const rh = el("div", "runs-h");
  rh.append(el("b", undefined, t("执行记录")), el("span", undefined, t("最近 50 次")), el("span", "sp"));
  const runBtn = el("button", "link", t("立即发送一次"));
  runBtn.type = "button";
  runBtn.disabled = isNew || isReadonly();
  runBtn.title = isNew ? t("先保存任务") : dirty ? t("按已保存的设置发送，不含未保存的修改") : t("马上按当前设置发一条，不影响计划");
  runBtn.addEventListener("click", () => void runNow());
  rh.append(runBtn);
  box.append(rh);
  const runsBox = el("div", "runs");
  const all = saved ? (state?.runs ?? []).filter((r) => r.taskId === saved.id).slice().sort((a, b) => a.startedAt < b.startedAt ? 1 : -1) : [];
  const shown = all.slice(0, runsExpanded ? RUNS_MAX : RUNS_PREVIEW);
  if (!shown.length) {
    const e = el("div", "empty", t("还没有执行过。"));
    e.style.padding = "14px";
    runsBox.append(e);
  }
  for (const r of shown) {
    const out = runOutcome(r.outcome);
    const lineEl = el("div", "run");
    lineEl.append(el("span", "t", runTimeLabel(r.startedAt, now)), el("span", `r ${out.tone}`.trim(), out.text), el("span", "why", runReason(r)));
    runsBox.append(lineEl);
  }
  if (!runsExpanded && all.length > RUNS_PREVIEW) {
    const more = el("button", "more", t("显示更多"));
    more.type = "button";
    more.addEventListener("click", () => {
      runsExpanded = true;
      render();
    });
    runsBox.append(more);
  }
  box.append(runsBox);
  return box;
}
function buildEditor() {
  const d = draft;
  if (!d)
    return el("div");
  const providers = catalog?.providers ?? [];
  const provider = providers.find((p) => p.id === d.provider);
  const ed = el("div", "editor");
  let droppedWindow = false;
  if (d.trigger.kind === "window" && !accountHasWindows(d.provider, d.account, providers)) {
    d.trigger = { kind: "daily", time: "06:00", timeZone: localTZ() };
    droppedWindow = true;
  }
  const saved = currentSavedTask();
  ed.append(...editorNotes(d, saved));
  const name = el("input", "text");
  name.dataset.fk = "name";
  name.value = d.name;
  name.maxLength = NAME_MAX;
  name.placeholder = t("给任务起个名字");
  name.addEventListener("input", () => onNameInput(() => {
    if (draft)
      draft.name = name.value;
  }));
  row(ed, t("名称"), name);
  if (d.trigger.kind === "window" && !d.account)
    d.account = forceWindowAccount(d.provider, providers);
  row(ed, t("发送到"), ...sendToParts(d, providers, provider));
  const nextEl = nextPreview(d, provider, saved);
  if (droppedWindow) {
    nextEl.prepend(el("div", "hint mute", t("这个账号没有可跟随的窗口，已改为每天定时，保存后生效。")));
  }
  row(ed, t("触发"), triggerSeg(d, providers, provider), triggerFields(d, providers), nextEl);
  ed.append(editorActions(saved), runsSection(saved));
  f = { name };
  return ed;
}
function draftDisplaySig() {
  if (!draft)
    return null;
  const d = draft;
  return JSON.stringify([d.enabled, d.provider, d.account, d.model, d.trigger]);
}
function catalogSig() {
  return JSON.stringify((catalog?.providers ?? []).map((p) => [
    p.id,
    p.autoModel,
    p.autoAccountModels,
    p.accounts.map((a) => [
      a.id,
      a.label,
      a.kind,
      a.perAccount,
      a.autoModel,
      a.models,
      a.windows.map((w) => [w.name, w.used, w.resetsAt])
    ]),
    p.models.map((m) => m.id)
  ]));
}
function runsViewSig() {
  const saved = currentSavedTask();
  const runs = saved ? (state?.runs ?? []).filter((r) => r.taskId === saved.id) : [];
  return JSON.stringify(runs.map((r) => [r.id, r.outcome, r.reason, r.effort, r.model, r.ms, r.source, r.startedAt]));
}
function rowEl(view, saved, isOpen) {
  const status = statusOf(view, state?.runs ?? []);
  const r = el("div", "row" + (isOpen ? " open" : "") + (view.enabled ? "" : " dim"));
  r.tabIndex = 0;
  r.setAttribute("role", "button");
  r.setAttribute("aria-expanded", isOpen ? "true" : "false");
  const who = el("div", "who");
  who.append(el("div", "name", view.name || t("未命名任务")), el("div", "sub", rowSub(view, catalog?.providers ?? [])));
  const when = el("div", "when");
  if (view.enabled) {
    const at = saved ? state?.next[saved.id] ?? null : null;
    when.append(el("div", "t", nextLabel(at, new Date)));
  }
  if (status.text)
    when.append(el("div", `s ${status.tone}`.trim(), status.text));
  const sw = el("button", "sw" + (view.enabled ? " on" : ""));
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-label", t("启用"));
  sw.setAttribute("aria-checked", view.enabled ? "true" : "false");
  sw.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleEnabled(saved);
  });
  r.append(who, when, sw, el("span", "chev", "›"));
  r.addEventListener("click", () => {
    if (isOpen) {
      closeEditor();
      render();
    } else if (saved) {
      openTask(saved);
      render();
    }
  });
  r.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      r.click();
    }
  });
  return r;
}
function renderList() {
  const list = document.getElementById("list");
  if (!list)
    return;
  const focus = captureFocus(list);
  const tasks = state?.tasks ?? [];
  const confirming = deleteArmed(confirmDeleteAt, Date.now());
  const sig = JSON.stringify([
    tasks.map((t) => [t.id, t.updatedAt, t.enabled, state?.next[t.id] ?? null, statusOf(t, state?.runs ?? [])]),
    openId,
    isNew,
    draftDisplaySig(),
    dirty,
    formError,
    staleNote,
    isReadonly(),
    runsExpanded,
    confirming,
    currentLang(),
    catalogSig(),
    runsViewSig(),
    state === null
  ]);
  replaceChildrenIfChanged(list, sig, () => {
    if (!state)
      return [];
    const nodes = [];
    if (isReadonly()) {
      const e = el("div", "empty", t("当前无法编辑任务。"));
      nodes.push(e);
      return nodes;
    }
    if (!tasks.length && !isNew) {
      const e = el("div", "empty");
      e.append(el("b", undefined, t("还没有任务")), t("点「新建任务」，选好账号和触发方式即可。"));
      nodes.push(e);
      return nodes;
    }
    if (isNew && draft)
      nodes.push(rowEl(draft, null, true));
    for (const t of tasks) {
      const open = openId === t.id;
      nodes.push(rowEl(open && draft ? draft : t, t, open));
    }
    if (openId && draft)
      nodes.push(buildEditor());
    return nodes;
  });
  restoreFocus(list, focus);
}
function captureFocus(root) {
  const a = document.activeElement;
  if (!(a instanceof HTMLInputElement) || !a.dataset.fk || !root.contains(a))
    return null;
  let start = null;
  let end = null;
  try {
    start = a.selectionStart;
    end = a.selectionEnd;
  } catch {}
  return { key: a.dataset.fk, start, end };
}
function restoreFocus(root, focus) {
  if (!focus)
    return;
  const again = root.querySelector(`[data-fk="${focus.key}"]`);
  if (!again)
    return;
  again.focus();
  if (focus.start !== null && focus.end !== null) {
    try {
      again.setSelectionRange(focus.start, focus.end);
    } catch {}
  }
}
function renderSum() {
  const sum = document.getElementById("sum");
  if (!sum)
    return;
  sum.replaceChildren();
  if (!state)
    return;
  const view = sumView(state.tasks, state.next);
  if (!view.enabled) {
    sum.textContent = t("没有启用的任务");
    return;
  }
  sum.append(`${view.enabled} ${t("个任务启用")}`);
  if (view.next) {
    sum.append(` · ${t("下一次")} `, el("b", undefined, nextLabel(view.next.at, new Date)), ` ${view.next.name}`);
  }
}
function renderBars() {
  const bars = document.getElementById("bars");
  if (!bars)
    return;
  const nodes = [];
  if (reconnecting || netError) {
    const note = el("div", "notice bad");
    note.append(reconnecting ? t("与服务断开了，正在自动重连…") : document.createTextNode(`${t("页面与服务断开了：")}${netError}${t("（服务可能已退出，重新打开页面试试）")}`));
    const retry = el("button", "link", t("重试"));
    retry.type = "button";
    retry.addEventListener("click", reconnectNow);
    note.append(retry);
    nodes.push(note);
  }
  if (state?.fatal)
    nodes.push(el("div", "notice bad", `${t("服务处于故障状态，任务没有在运行：")}${state.fatal}`));
  if (state && typeof state.lockedBy === "number") {
    nodes.push(el("div", "notice warn", state.lockedBy > 0 ? `${t("另一个实例正在运行（进程 ")}${state.lockedBy}${t("），本页只读。")}` : t("另一个实例可能正在运行（无法确认持有者进程），本页只读。")));
  }
  if (state?.saveError)
    nodes.push(el("div", "notice warn", `${t("数据可能没保存：")}${state.saveError}`));
  if (catalogError)
    nodes.push(el("div", "notice warn", `${t("模型目录读取失败：")}${catalogError}${t("（稍后自动重试）")}`));
  if (actionError)
    nodes.push(el("div", "notice bad", actionError));
  bars.replaceChildren(...nodes);
}
function render() {
  renderBars();
  renderSum();
  renderList();
  const newBtn = document.getElementById("new");
  if (newBtn)
    newBtn.disabled = isReadonly();
}
function reconnectNow() {
  reconnecting = true;
  render();
  setTimeout(() => {
    const to = document.referrer && document.referrer !== location.href ? document.referrer : location.href;
    location.href = to;
  }, 300);
}
async function refreshState() {
  try {
    state = await apiJSON("api/state");
    netError = "";
    fetchFails = 0;
    actionError = "";
  } catch (e) {
    netError = errText(e);
    fetchFails++;
    if (!reconnecting && fetchFails >= 2 && document.referrer && document.referrer !== location.href) {
      reconnectNow();
      return;
    }
    render();
    return;
  }
  syncOpen();
  render();
}
function syncOpen() {
  if (!openId || isNew || !draft)
    return;
  const saved = state?.tasks.find((t) => t.id === openId) ?? null;
  const act = syncDraftOnPoll(saved, openUpdatedAt, dirty);
  if (act === "gone") {
    closeEditor();
    return;
  }
  if (act === "adopt" && saved) {
    draft = cloneTask(saved);
    openUpdatedAt = saved.updatedAt;
    staleNote = null;
    return;
  }
  if (act === "stale") {
    staleNote = "这个任务刚在别处被更新。下面保留的是你未保存的修改，直接保存会覆盖新版本。";
  }
}
async function refreshCatalog() {
  try {
    catalog = await apiJSON("api/catalog");
    catalogError = "";
  } catch (e) {
    catalogError = errText(e);
  }
  render();
}
function applyLook(dark, vars) {
  if (dark === true)
    document.body.classList.add("dark");
  else if (dark === false)
    document.body.classList.remove("dark");
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      if (k.startsWith("--") && typeof v === "string" && v) {
        document.documentElement.style.setProperty(k, v);
      }
    }
  }
}
function decodeTokens(raw) {
  if (!raw)
    return null;
  try {
    return JSON.parse(b64decode(raw));
  } catch {
    return null;
  }
}
function applyTheme() {
  if (!boot)
    return;
  applyLook(boot.theme === "dark" ? true : boot.theme === "light" ? false : undefined, decodeTokens(boot.tokens));
}
function applyStaticTexts() {
  document.title = t("窗口预热");
  document.documentElement.lang = currentLang();
  const newBtn = document.getElementById("new");
  if (newBtn)
    newBtn.textContent = t("新建任务");
  const info = document.getElementById("info");
  if (info) {
    info.setAttribute("aria-label", t("说明"));
    const tip = info.querySelector(".tip");
    if (tip) {
      const lines = [
        t("消息按供应商自己的额度规则计费，可能用到赠送额度或 API 余额；发送成功不代表窗口一定已开始计时。"),
        t("Magpie 关闭期间不会执行，重新打开后每个任务最多补发一次。"),
        t("失败不会暂停任务，下一次照常执行。")
      ];
      tip.replaceChildren(...lines.flatMap((l) => [document.createTextNode(l), document.createElement("br")]).slice(0, -1));
    }
  }
}
function init() {
  const raw = document.getElementById("boot")?.textContent ?? "";
  try {
    boot = JSON.parse(raw);
  } catch {
    boot = null;
  }
  setLang(boot?.lang);
  applyTheme();
  applyStaticTexts();
  if (!boot?.token) {
    document.getElementById("bars")?.replaceChildren(el("div", "notice bad", t("页面缺少访问口令，请从 Magpie 的插件页重新打开。")));
    return;
  }
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || typeof m !== "object" || m.magpie !== 1 || m.event !== "theme")
      return;
    const d = m.data ?? {};
    applyLook(typeof d.dark === "boolean" ? d.dark : undefined, d.tokens && typeof d.tokens === "object" ? d.tokens : null);
    if (typeof d.lang === "string" && d.lang)
      setLang(d.lang);
    applyStaticTexts();
    render();
  });
  document.getElementById("new")?.addEventListener("click", () => {
    if (!isReadonly() && !isNew)
      openNew();
  });
  document.addEventListener("mousedown", (e) => {
    if (popEl && e.target instanceof Node && !popEl.contains(e.target) && !popEl.btn.contains(e.target))
      closePop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
      closePop();
  });
  document.addEventListener("scroll", (e) => {
    if (shouldCloseOnScroll(e.target, popEl))
      closePop();
  }, true);
  refreshCatalog().then(() => refreshState());
  setInterval(() => {
    if (document.hidden)
      return;
    refreshState();
  }, POLL_MS);
  catalogTimer = setInterval(() => {
    if (document.hidden)
      return;
    refreshCatalog();
  }, CATALOG_POLL_MS);
}
if (typeof document !== "undefined") {
  if (document.getElementById("boot"))
    init();
  else
    document.addEventListener("DOMContentLoaded", init);
}
export {
  DELETE_CONFIRM_MS,
  I18N,
  accountHasWindows,
  accountModelView,
  accountOptions,
  contentOf,
  deleteArmed,
  effortLabel,
  forceWindowAccount,
  modelDisplay,
  modelHint,
  modelOptions,
  nextLabel,
  nextPointsAfter,
  normalizeLang,
  rowSub,
  runOutcome,
  runReason,
  runTimeLabel,
  setLang,
  shortModel,
  shouldCloseOnScroll,
  statusOf,
  sumView,
  syncDraftOnPoll,
  t,
  trigText,
  validateDraft,
  windowOptions
};
