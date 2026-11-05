// @bun
// src/plugin.ts
import { join as join4 } from "path";

// src/accounts.ts
var FINGERPRINT_RE = /^[0-9a-f]{10}$/;
var MASKED_SEP = " \xB7 ";
var isFingerprint = (v) => FINGERPRINT_RE.test(v);
var AUTO_SPEC_WORDS = ["flash", "lite", "mini", "nano", "small", "turbo"];
var AUTO_SPEC_RES = AUTO_SPEC_WORDS.map((w) => new RegExp(`\\b${w}\\b`, "i"));
function specTier(id) {
  const seg = id.slice(id.lastIndexOf("/") + 1);
  let best = AUTO_SPEC_WORDS.length;
  for (let i = 0;i < AUTO_SPEC_RES.length; i++) {
    if (i < best && AUTO_SPEC_RES[i].test(seg))
      best = i;
  }
  return best;
}
function cmpNewerDesc(a, b) {
  const ta = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const tb = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0;i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined)
      return 1;
    if (y === undefined)
      return -1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(y) - Number(x);
      if (d !== 0)
        return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return y < x ? 1 : -1;
    }
  }
  return 0;
}
function pickAutoModel(models) {
  if (models.length === 0)
    return null;
  const decorated = models.map((m, i) => ({ m, tier: specTier(m.id), i }));
  decorated.sort((a, b) => a.tier - b.tier || cmpNewerDesc(a.m.id, b.m.id) || a.i - b.i);
  return decorated[0].m;
}
var byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function keepWindows(windows) {
  return windows.filter((w) => w.unlimited !== true);
}
function windowsForAccount(provider, account, quotas, keyDir) {
  const login = quotas.find((q) => q.provider === provider && !q.viaKey && q.account === account);
  if (login)
    return keepWindows(login.windows);
  const name = isFingerprint(account) ? keyDir?.get(provider)?.keys.find((k) => k.fingerprint === account)?.name ?? null : account;
  if (name === null)
    return null;
  if (name === "")
    return [];
  const low = name.toLowerCase();
  const card = quotas.find((q) => q.provider === provider && q.viaKey && (q.account.toLowerCase() === low || q.account.startsWith(`${name}${MASKED_SEP}`)));
  return card ? keepWindows(card.windows) : [];
}
function candidatesOf(provider, models, cache, chosen) {
  const prefix = `${provider}/`;
  const out = (cache ?? []).map((c) => ({ full: `${prefix}${c.id}`, bare: c.id, keys: c.keys }));
  const seen = new Set(out.map((c) => c.full));
  for (const m of models) {
    if (seen.has(m))
      continue;
    seen.add(m);
    out.push({ full: m, bare: m.startsWith(prefix) ? m.slice(prefix.length) : m, keys: null });
  }
  for (const bare of chosen) {
    const full = `${provider}/${bare}`;
    if (seen.has(full))
      continue;
    seen.add(full);
    out.push({ full, bare, keys: null });
  }
  return out;
}
function modelsForAccount(provider, account, input) {
  const hasCache = input.cache !== null;
  if (!hasCache && input.models.length === 0 && input.chosen.length === 0) {
    return { list: null, perAccount: false };
  }
  let cands = candidatesOf(provider, input.models, input.cache, input.chosen);
  if (hasCache && isFingerprint(account)) {
    cands = cands.filter((c) => !c.keys || c.keys.length === 0 || c.keys.includes(account));
  }
  const filterKey = isFingerprint(account) ? account : account.toLowerCase();
  const allowed = input.keyDir?.get(provider)?.accountModels[filterKey];
  if (allowed && allowed.length > 0) {
    const set = new Set(allowed);
    cands = cands.filter((c) => set.has(c.bare));
  }
  const present = new Set([
    ...input.models,
    ...input.chosen.map((bare) => `${provider}/${bare}`)
  ]);
  const list = cands.map((c) => c.full).filter((id) => present.has(id)).sort();
  return { list, perAccount: hasCache };
}
function accountsOf(provider, input) {
  const entry = input.keyDir?.get(provider) ?? null;
  const accounts = [];
  const seenFingerprints = new Set;
  for (const k of entry?.keys ?? []) {
    if (seenFingerprints.has(k.fingerprint))
      continue;
    seenFingerprints.add(k.fingerprint);
    accounts.push({
      id: k.fingerprint,
      label: k.name || k.fingerprint,
      kind: "key",
      windows: windowsForAccount(provider, k.fingerprint, input.quotas, input.keyDir) ?? [],
      ...pickModels(provider, k.fingerprint, input)
    });
  }
  const seenUsers = new Set;
  for (const q of input.quotas) {
    if (q.provider !== provider || q.viaKey)
      continue;
    if (seenUsers.has(q.account))
      continue;
    seenUsers.add(q.account);
    accounts.push({
      id: q.account,
      label: q.account,
      kind: "login",
      windows: windowsForAccount(provider, q.account, input.quotas, input.keyDir) ?? [],
      ...pickModels(provider, q.account, input)
    });
  }
  accounts.sort(byId);
  return { accounts, autoAccountModels: autoAccountModelsOf(provider, input) };
}
function pickModels(provider, account, input) {
  const pick = modelsForAccount(provider, account, input);
  return {
    models: pick.list,
    perAccount: pick.perAccount,
    autoModel: pick.list ? pickAutoModel(pick.list.map((id) => ({ id })))?.id ?? null : null
  };
}
function autoAccountModelsOf(provider, input) {
  if (input.cache === null && input.models.length === 0 && input.chosen.length === 0)
    return null;
  const present = new Set([
    ...input.models,
    ...input.chosen.map((bare) => `${provider}/${bare}`)
  ]);
  return candidatesOf(provider, input.models, input.cache, input.chosen).map((c) => c.full).filter((id) => present.has(id)).sort();
}
function pinFor(provider, account, keyDir, quotas = []) {
  if (!account)
    return null;
  const isLogin = quotas.some((q) => q.provider === provider && !q.viaKey && q.account === account);
  if (isLogin)
    return account;
  if (isFingerprint(account)) {
    const enabled = keyDir?.get(provider)?.keys.length ?? 2;
    return enabled >= 2 ? `${provider}#${account}` : null;
  }
  return account;
}

// src/magpie-files.ts
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { homedir } from "os";
import path, { join, resolve } from "path";
var PLUGIN_DIR_TAILS = [
  ["plugins", "node_modules", "@magpie-community", "page-window-warmup", "dist"],
  ["plugins", "node_modules", "magpie-window-warmup", "dist"]
];
var BROKEN_PROVIDERS_MESSAGE = "Magpie \u7684\u4F9B\u5E94\u5546\u914D\u7F6E\u6587\u4EF6\u8BFB\u4E0D\u51FA\u6765";
var READ_CACHE_MS = 5000;
function magpieDirs(env = process.env, moduleDir = import.meta.dir, p = path) {
  const installConfig = p.resolve(xdgConfigHome(env, p), "magpie");
  const installCache = p.resolve(rooted(env.XDG_CACHE_HOME, p) ?? p.join(homedir(), ".cache"), "magpie");
  const segments = moduleDir.split(p.sep === "\\" ? /[\\/]/ : p.sep).filter((s) => s !== "");
  const tail = PLUGIN_DIR_TAILS.find((t) => {
    if (segments.length < t.length)
      return false;
    const got = segments.slice(-t.length);
    return t.every((seg, i) => got[i] === seg);
  });
  if (!tail)
    return { config: installConfig, cache: installCache };
  const config = p.resolve(moduleDir, ...tail.map(() => ".."));
  return {
    config,
    cache: p.resolve(config) === installConfig ? installCache : p.join(config, "cache")
  };
}
function rooted(v, p) {
  const t = v?.trim();
  return t && p.isAbsolute(t) ? t : null;
}
function xdgConfigHome(env = process.env, p = path) {
  return rooted(env.XDG_CONFIG_HOME, p) ?? p.join(homedir(), ".config");
}
function readDefaultKeyDirectory() {
  return readKeyDirectory(magpieDirs().config).catch(() => null);
}
function readDefaultModelCache(providerId) {
  return readModelCache(magpieDirs().cache, providerId);
}
function keyFingerprint(key) {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 10);
}
function asStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
}
function entryOf(raw) {
  if (typeof raw !== "object" || raw === null)
    return null;
  const pr = raw;
  if (typeof pr.id !== "string" || !pr.id)
    return null;
  const keys = [];
  const seen = new Set;
  const push = (key, name) => {
    if (typeof key !== "string" || !key)
      return;
    const fingerprint = keyFingerprint(key);
    if (seen.has(fingerprint))
      return;
    seen.add(fingerprint);
    keys.push({ fingerprint, name: typeof name === "string" ? name : "" });
  };
  push(pr.key, pr.keyName);
  if (Array.isArray(pr.keys)) {
    for (const k of pr.keys) {
      if (typeof k !== "object" || k === null)
        continue;
      const rec = k;
      if (rec.off === true)
        continue;
      push(rec.key, rec.name);
    }
  }
  const accountModels = {};
  if (typeof pr.accountModels === "object" && pr.accountModels !== null) {
    for (const [k, v] of Object.entries(pr.accountModels)) {
      const list = asStringArray(v);
      if (list)
        accountModels[k] = list;
    }
  }
  return { keys, accountModels, models: asStringArray(pr.models) ?? [] };
}
var readCache = new Map;
function cached(key, load, worth) {
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_MS && worth(hit.value)) {
    return Promise.resolve(hit.value);
  }
  return load().then((value) => {
    if (worth(value))
      readCache.set(key, { at: Date.now(), value });
    return value;
  });
}
function readKeyDirectory(configDir) {
  const file = resolve(join(configDir, "providers.json"));
  return cached(file, async () => {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT")
        return new Map;
      throw new Error(BROKEN_PROVIDERS_MESSAGE);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(BROKEN_PROVIDERS_MESSAGE);
    }
    const map = new Map;
    const providers = parsed?.providers;
    if (Array.isArray(providers)) {
      for (const item of providers) {
        const entry = entryOf(item);
        if (entry) {
          const id = item.id;
          const prev = map.get(id);
          if (prev) {
            for (const k of entry.keys) {
              if (!prev.keys.some((x) => x.fingerprint === k.fingerprint))
                prev.keys.push(k);
            }
            Object.assign(prev.accountModels, entry.accountModels);
            prev.models = entry.models;
          } else {
            map.set(id, entry);
          }
        }
      }
    }
    return map;
  }, (v) => v.size > 0);
}
function readModelCache(cacheDir, providerId) {
  if (!providerId || providerId.includes("/") || providerId.includes("\\") || providerId.includes("..")) {
    return Promise.resolve(null);
  }
  const file = resolve(join(cacheDir, "models", `${providerId}.json`));
  return cached(file, async () => {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const models = parsed?.models;
    if (!Array.isArray(models))
      return null;
    const out = [];
    for (const item of models) {
      if (typeof item !== "object" || item === null)
        return null;
      const rec = item;
      if (typeof rec.ID !== "string" || !rec.ID)
        return null;
      const keys = rec.Keys === undefined || rec.Keys === null ? [] : asStringArray(rec.Keys);
      if (!keys)
        return null;
      out.push({ id: rec.ID, keys });
    }
    return out;
  }, (v) => v !== null);
}

// src/rules.ts
var MINUTE_MS = 60000;
var HOUR_MS = 3600000;
var RESET_GRACE_MS = 30000;
var WARMUP_MESSAGE = "hi";
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
    throw new Error("\u65F6\u95F4\u9700\u4E3A 24 \u5C0F\u65F6\u5236\u7684 HH:MM");
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
  throw new Error("\u65E0\u6CD5\u8BA1\u7B97\u4E0B\u4E00\u6B21\u6267\u884C\u65F6\u95F4");
}
function nextEvery(t, after) {
  const anchor = new Date(t.anchor).getTime();
  if (Number.isNaN(anchor))
    throw new Error("\u8D77\u70B9\u65F6\u95F4\u65E0\u6CD5\u8BC6\u522B");
  if (!Number.isFinite(t.hours) || t.hours <= 0)
    throw new Error("\u95F4\u9694\u5C0F\u65F6\u6570\u5FC5\u987B\u4E3A\u6B63\u6570");
  if (after.getTime() < anchor)
    return new Date(anchor);
  const step = t.hours * HOUR_MS;
  const k = Math.floor((after.getTime() - anchor) / step) + 1;
  return new Date(anchor + k * step);
}
function lastDue(trigger, before) {
  if (trigger.kind === "window")
    return null;
  if (trigger.kind === "every") {
    const anchor = new Date(trigger.anchor).getTime();
    if (Number.isNaN(anchor) || before.getTime() < anchor)
      return null;
    if (!Number.isFinite(trigger.hours) || trigger.hours <= 0)
      return null;
    const step = trigger.hours * HOUR_MS;
    const k = Math.floor((before.getTime() - anchor) / step);
    return new Date(anchor + k * step);
  }
  let best = null;
  let cursor = nextDaily(trigger, new Date(before.getTime() - LAST_DUE_LOOKBACK_MS));
  for (let i = 0;i < 6 && cursor.getTime() <= before.getTime(); i++) {
    best = cursor;
    cursor = nextDaily(trigger, cursor);
  }
  return best;
}
function hourFloorISO(at) {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS).toISOString();
}
function windowDue(win, snapshotAt) {
  if (!win)
    return { error: "\u8D26\u53F7\u7684\u989D\u5EA6\u91CC\u6CA1\u6709\u8FD9\u4E2A\u7A97\u53E3" };
  if (win.resetsAt) {
    const resetsAt = new Date(win.resetsAt);
    if (!Number.isNaN(resetsAt.getTime()) && resetsAt.getTime() > snapshotAt.getTime()) {
      return { at: new Date(resetsAt.getTime() + RESET_GRACE_MS), resetKey: win.resetsAt };
    }
  }
  return { at: new Date(snapshotAt.getTime()), resetKey: `idle:${hourFloorISO(snapshotAt)}` };
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
function isValidTimeZone(tz) {
  if (!tz)
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
function validateTask(input, now) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F JSON \u5BF9\u8C61", field: "body" };
  }
  const raw = input;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name)
    return { error: "\u7ED9\u4EFB\u52A1\u8D77\u4E2A\u540D\u5B57", field: "name" };
  if ([...name].length > NAME_MAX)
    return { error: `\u540D\u79F0\u4E0D\u80FD\u8D85\u8FC7 ${NAME_MAX} \u5B57`, field: "name" };
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  if (!provider)
    return { error: "\u5FC5\u987B\u9009\u62E9\u4F9B\u5E94\u5546", field: "provider" };
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (model.startsWith("group/"))
    return { error: "\u4E0D\u652F\u6301\u8DEF\u7531\u7EC4\u6A21\u578B", field: "model" };
  const message = WARMUP_MESSAGE;
  let enabled = true;
  if (raw.enabled !== undefined && raw.enabled !== null) {
    if (typeof raw.enabled !== "boolean")
      return { error: "\u542F\u7528\u72B6\u6001\u5FC5\u987B\u662F\u5E03\u5C14\u503C", field: "enabled" };
    enabled = raw.enabled;
  }
  let account = "";
  if (raw.account !== undefined && raw.account !== null) {
    if (typeof raw.account !== "string")
      return { error: "\u8D26\u53F7\u6807\u8BC6\u5FC5\u987B\u662F\u6587\u672C", field: "account" };
    account = raw.account.trim();
  }
  if (!account)
    return { error: "\u5FC5\u987B\u9009\u62E9\u8D26\u53F7", field: "account" };
  const trig = raw.trigger;
  if (typeof trig !== "object" || trig === null || Array.isArray(trig)) {
    return { error: "\u7F3A\u5C11\u89E6\u53D1\u65B9\u5F0F", field: "trigger" };
  }
  const tv = trig;
  let trigger;
  switch (tv.kind) {
    case "window": {
      const win = typeof tv.window === "string" ? tv.window.trim() : "";
      if (!win)
        return { error: "\u5FC5\u987B\u586B\u5199\u989D\u5EA6\u7A97\u53E3\u540D", field: "window" };
      trigger = { kind: "window", window: win };
      break;
    }
    case "daily": {
      const time = typeof tv.time === "string" ? tv.time : "";
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        return { error: "\u65F6\u95F4\u9700\u4E3A 24 \u5C0F\u65F6\u5236\u7684 HH:MM", field: "time" };
      }
      const timeZone = typeof tv.timeZone === "string" ? tv.timeZone : "";
      if (!isValidTimeZone(timeZone))
        return { error: "\u65E0\u6CD5\u8BC6\u522B\u7684\u65F6\u533A", field: "timeZone" };
      trigger = { kind: "daily", time, timeZone };
      break;
    }
    case "every": {
      const hours = tv.hours;
      if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 1 || hours > 168) {
        return { error: "\u95F4\u9694\u9700\u4E3A 1\u2013168 \u5C0F\u65F6", field: "hours" };
      }
      let anchor;
      if (tv.anchor === undefined || tv.anchor === null || tv.anchor === "") {
        anchor = new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS).toISOString();
      } else {
        if (typeof tv.anchor !== "string")
          return { error: "\u8D77\u70B9\u65F6\u95F4\u65E0\u6CD5\u8BC6\u522B", field: "anchor" };
        const a = new Date(tv.anchor);
        if (Number.isNaN(a.getTime()))
          return { error: "\u8D77\u70B9\u65F6\u95F4\u65E0\u6CD5\u8BC6\u522B", field: "anchor" };
        anchor = a.toISOString();
      }
      trigger = { kind: "every", hours, anchor };
      break;
    }
    default:
      return { error: "\u89E6\u53D1\u65B9\u5F0F\u5FC5\u987B\u662F window\u3001daily \u6216 every", field: "trigger" };
  }
  return { task: { name, enabled, provider, account, model, message, trigger } };
}

// src/types.ts
function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/gateway.ts
var DEFAULT_GATEWAY = "http://127.0.0.1:3425";
var SEND_MAX_TOKENS = 16;
var SEND_TIMEOUT_MS = 30000;
var READ_TIMEOUT_MS = 1e4;
var FULL_QUOTAS_TIMEOUT_MS = 15000;
var CARD_REFRESH_TIMEOUT_MS = 35000;
var MIN_FULL_GAP_MS = 5 * 60000;
var REASON_MAX = 200;
function timeoutReason(timeoutMs) {
  const duration = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} \u79D2` : `${timeoutMs} \u6BEB\u79D2`;
  return `${duration}\u5185\u6CA1\u6709\u7ED3\u679C\uFF0C\u53EF\u80FD\u5DF2\u53D1\u9001`;
}
function gatewayBase(env = process.env) {
  const addr = env.MAGPIE_ADDR?.trim().replace(/\/+$/, "");
  if (!addr)
    return DEFAULT_GATEWAY;
  if (/^https?:\/\//.test(addr))
    return addr;
  return `http://${addr}`;
}
var KNOWN_EFFORT_RANK = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5
};
function normalizeLevel(s) {
  const t = s.trim();
  const low = t.toLowerCase();
  if (low === "disabled" || low === "off")
    return "none";
  return t;
}
function levelList(model) {
  const raw = model.reasoning_levels;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw))
      return { error: "\u6A21\u578B\u7684\u601D\u8003\u6863\u4F4D\u6570\u636E\u65E0\u6CD5\u8BC6\u522B" };
    const list = raw.filter((s) => typeof s === "string");
    if (raw.length > 0 && list.length === 0)
      return { error: "\u6A21\u578B\u7684\u601D\u8003\u6863\u4F4D\u6570\u636E\u65E0\u6CD5\u8BC6\u522B" };
    return list;
  }
  const supported = model.supported_reasoning_levels;
  if (supported !== undefined && supported !== null) {
    if (!Array.isArray(supported))
      return { error: "\u6A21\u578B\u7684\u601D\u8003\u6863\u4F4D\u6570\u636E\u65E0\u6CD5\u8BC6\u522B" };
    const list = supported.map((x) => typeof x === "object" && x !== null ? x.effort : null).filter((s) => typeof s === "string");
    if (supported.length > 0 && list.length === 0)
      return { error: "\u6A21\u578B\u7684\u601D\u8003\u6863\u4F4D\u6570\u636E\u65E0\u6CD5\u8BC6\u522B" };
    return list;
  }
  return [];
}
function pickEffort(model) {
  const levels = levelList(model);
  if ("error" in levels)
    return levels;
  if (!model.reasoning || levels.length === 0) {
    return { send: null, label: "\u4E0D\u9002\u7528" };
  }
  const normalized = levels.map(normalizeLevel).filter((s) => s !== "");
  if (normalized.length === 0)
    return { send: null, label: "\u4E0D\u9002\u7528" };
  if (normalized.some((s) => s.toLowerCase() === "none")) {
    return { send: "none", label: "\u5173\u95ED\uFF08\u6A21\u578B\u652F\u6301\u5173\u95ED\uFF09" };
  }
  const decorated = normalized.map((s, i) => {
    if (/^\d+$/.test(s))
      return { s, group: 0, rank: Number(s), i };
    const known = KNOWN_EFFORT_RANK[s.toLowerCase()];
    return { s, group: known === undefined ? 2 : 1, rank: known ?? i, i };
  });
  decorated.sort((a, b) => a.group - b.group || a.rank - b.rank || a.i - b.i);
  const lowest = decorated[0].s;
  const allUnknown = decorated.every((d) => d.group === 2);
  return {
    send: lowest,
    label: allUnknown ? `${lowest}\uFF08\u6309\u6A21\u578B\u5217\u8868\u7B2C\u4E00\u6863\uFF09` : `${lowest}\uFF08\u6A21\u578B\u5FC5\u987B\u601D\u8003\uFF0C\u5DF2\u7528\u6700\u4F4E\u6863\uFF09`
  };
}
function errorReason(text) {
  try {
    const parsed = JSON.parse(text);
    const msg = parsed?.error?.message;
    if (typeof msg === "string" && msg.trim())
      return msg.trim().slice(0, REASON_MAX);
  } catch {}
  return text.trim().slice(0, REASON_MAX) || "\u4E0A\u6E38\u672A\u8FD4\u56DE\u9519\u8BEF\u8BF4\u660E";
}
async function requestJSON(base, path, signal, timeoutMs = READ_TIMEOUT_MS, method = "GET") {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(base + path, {
    method,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  const text = await res.text().catch(() => "");
  if (!res.ok)
    throw new Error(`HTTP ${res.status}\uFF1A${errorReason(text)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Magpie \u8FD4\u56DE\u7684\u4E0D\u662F JSON\uFF08${path}\uFF09`);
  }
}
function dataArray(data) {
  if (Array.isArray(data))
    return data;
  if (typeof data === "object" && data !== null && Array.isArray(data.data)) {
    return data.data;
  }
  return [];
}
function coerceWindows(list) {
  const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    const raw = typeof w === "object" && w !== null ? w : {};
    if (raw.unlimited === true)
      continue;
    out.push({
      name: typeof raw.name === "string" ? raw.name : "",
      used: typeof raw.used === "number" ? raw.used : null,
      resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : null
    });
  }
  return out;
}
function parseQuotas(data) {
  const entries = [];
  for (const item of dataArray(data)) {
    if (typeof item !== "object" || item === null)
      continue;
    const q = item;
    const rawProvider = typeof q.provider === "string" ? q.provider : "";
    const viaKey = rawProvider.endsWith("/~keys");
    const provider = viaKey ? rawProvider.slice(0, -"/~keys".length) : rawProvider;
    const user = typeof q.user === "string" ? q.user : "";
    if (!provider || !user)
      continue;
    const readAt = typeof q.readAt === "string" && q.readAt ? q.readAt : null;
    entries.push({
      provider,
      account: user,
      label: typeof q.name === "string" && q.name ? q.name : user,
      windows: coerceWindows(q.windows),
      viaKey,
      ...readAt ? { readAt } : {}
    });
  }
  return entries;
}
function createQuotaReader(opts = {}) {
  const nowFn = opts.now ?? (() => new Date);
  const lastGood = new Map;
  const lastAttempt = new Map;
  const inflight = new Map;
  return async (base) => {
    const kept = parseQuotas(await requestJSON(base, "/v1/magpie/quotas?kept=1"));
    if (kept.length > 0)
      return { at: nowFn(), entries: kept };
    let pending = inflight.get(base);
    if (!pending) {
      const now = nowFn().getTime();
      const attempted = lastAttempt.get(base);
      if (attempted !== undefined && now - attempted < MIN_FULL_GAP_MS) {
        return lastGood.get(base) ?? { at: nowFn(), entries: [] };
      }
      lastAttempt.set(base, now);
      pending = requestJSON(base, "/v1/magpie/quotas", undefined, FULL_QUOTAS_TIMEOUT_MS).then((data) => {
        const fresh = { at: nowFn(), entries: parseQuotas(data) };
        lastGood.set(base, fresh);
        return fresh;
      }).finally(() => {
        inflight.delete(base);
      });
      inflight.set(base, pending);
    }
    return pending;
  };
}
async function refreshQuotaCard(base, provider, user) {
  const q = new URLSearchParams({ provider, user });
  await requestJSON(base, `/v1/magpie/quotas/refresh?${q}`, undefined, CARD_REFRESH_TIMEOUT_MS, "POST");
}
var fetchQuotas = createQuotaReader();
async function fetchModels(base, signal) {
  const data = await requestJSON(base, "/v1/models", signal);
  const out = [];
  for (const item of dataArray(data)) {
    if (typeof item !== "object" || item === null)
      continue;
    const m = item;
    if (typeof m.id !== "string" || !m.id || m.id.startsWith("group/"))
      continue;
    out.push(m);
  }
  return out;
}
function modelProvider(m) {
  const owner = typeof m.owned_by === "string" ? m.owned_by.trim() : "";
  return owner || (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : "");
}
async function fetchCatalog(base) {
  const [models, quotas] = await Promise.all([
    fetchModels(base),
    fetchQuotas(base).catch(() => ({ at: new Date, entries: [] }))
  ]);
  const providers = new Map;
  const rawModels = new Map;
  const ensure = (id) => {
    let p = providers.get(id);
    if (!p) {
      p = { id, accounts: [], models: [], autoAccountModels: null, autoModel: null };
      providers.set(id, p);
    }
    return p;
  };
  for (const m of models) {
    const pid = modelProvider(m);
    if (!pid)
      continue;
    ensure(pid);
    const raws = rawModels.get(pid);
    if (raws)
      raws.push(m);
    else
      rawModels.set(pid, [m]);
  }
  for (const q of quotas.entries)
    ensure(q.provider);
  const keyDir = await readDefaultKeyDirectory();
  const list = [...providers.values()];
  for (const p of list) {
    const raws = rawModels.get(p.id) ?? [];
    p.models = raws.map((m) => ({ id: m.id, effort: pickEffort(m) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const chosen = keyDir?.get(p.id)?.models ?? [];
    const built = accountsOf(p.id, {
      models: raws.map((m) => m.id),
      quotas: quotas.entries,
      keyDir,
      cache: await readDefaultModelCache(p.id),
      chosen
    });
    p.accounts = built.accounts;
    p.autoAccountModels = built.autoAccountModels;
    p.autoModel = built.autoAccountModels ? pickAutoModel(built.autoAccountModels.map((id) => ({ id })))?.id ?? null : null;
  }
  list.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { providers: list };
}
function usableChatBody(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}
async function send(base, task, pin, effort, signal, timeoutMs = SEND_TIMEOUT_MS) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timer]);
  const headers = {
    "content-type": "application/json",
    "x-magpie-session": `window-warmup/${task.id}`
  };
  if (pin) {
    headers["x-magpie-account"] = /[^\x00-\x7F]/.test(pin) ? Buffer.from(pin, "utf8").toString("latin1") : pin;
  }
  const body = {
    model: task.model,
    messages: [{ role: "user", content: WARMUP_MESSAGE }],
    max_tokens: SEND_MAX_TOKENS,
    stream: false
  };
  if (effort)
    body.reasoning_effort = effort;
  let res;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combined
    });
  } catch (e) {
    if (signal.aborted)
      return { outcome: "unknown", reason: "\u53D1\u9001\u88AB\u53D6\u6D88", ms: elapsed() };
    if (timer.aborted)
      return { outcome: "unknown", reason: timeoutReason(timeoutMs), ms: elapsed() };
    const code = e.code;
    if (code === "ECONNRESET" || code === "EPIPE") {
      return { outcome: "unknown", reason: "\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u7ED3\u679C\u672A\u77E5\uFF08\u53EF\u80FD\u5DF2\u53D1\u9001\uFF09", ms: elapsed() };
    }
    return { outcome: "failed", reason: errText(e), ms: elapsed() };
  }
  let text = "";
  let bodyBroken = false;
  try {
    text = await res.text();
  } catch {
    bodyBroken = true;
    if (signal.aborted)
      return { outcome: "unknown", reason: "\u53D1\u9001\u88AB\u53D6\u6D88", ms: elapsed() };
    if (timer.aborted)
      return { outcome: "unknown", reason: timeoutReason(timeoutMs), ms: elapsed() };
  }
  if (res.ok) {
    return !bodyBroken && usableChatBody(text) ? { outcome: "ok", reason: "", ms: elapsed() } : { outcome: "unknown", reason: `HTTP ${res.status}\uFF0C\u54CD\u5E94\u4F53\u8BFB\u53D6\u5931\u8D25\uFF0C\u7ED3\u679C\u672A\u77E5`, ms: elapsed() };
  }
  return { outcome: "failed", reason: `HTTP ${res.status}\uFF1A${errorReason(text)}`, ms: elapsed() };
}

// src/server.ts
import { randomBytes, timingSafeEqual } from "crypto";
import { readFile as readFile3 } from "fs/promises";
import path2, { basename, extname, join as join3, resolve as resolve2 } from "path";
// package.json
var version = "0.1.3";

// src/diagnostics.ts
var DIAGNOSTICS_SCHEMA = "window-warmup-diagnostics/1";
var LIST_MAX = 200;
var RUNS_PER_TASK = 20;
var TEXT_MAX = 400;
var SCRUB_MIN_LEN = 4;
var MASKED_SEP2 = " \xB7 ";

class Aliases {
  byRaw = new Map;
  acctN = 0;
  keyN = 0;
  key(fingerprint, name) {
    let alias = this.byRaw.get(fingerprint);
    if (!alias) {
      alias = `key-${++this.keyN}`;
      this.byRaw.set(fingerprint, alias);
    }
    if (name && !this.byRaw.has(`name:${name.toLowerCase()}`))
      this.byRaw.set(`name:${name.toLowerCase()}`, alias);
    return alias;
  }
  account(raw) {
    if (!raw)
      return "";
    const hit = this.byRaw.get(raw) ?? this.byRaw.get(`login:${raw.toLowerCase()}`);
    if (hit)
      return hit;
    const alias = `acct-${++this.acctN}`;
    this.byRaw.set(`login:${raw.toLowerCase()}`, alias);
    return alias;
  }
  keyCard(user) {
    const name = user.includes(MASKED_SEP2) ? user.slice(0, user.indexOf(MASKED_SEP2)) : user;
    return this.byRaw.get(`name:${name.toLowerCase()}`) ?? this.account(user);
  }
  accountKey(k) {
    return this.byRaw.get(k) ?? this.account(k);
  }
  raws() {
    return [...this.byRaw].map(([k, v]) => [k.replace(/^(login|name):/, ""), v]).filter(([k]) => k.length >= SCRUB_MIN_LEN).sort((a, b) => b[0].length - a[0].length);
  }
}
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function scrubber(aliases) {
  const known = aliases.raws().map(([raw, alias]) => [new RegExp(escapeRe(raw), "gi"), alias]);
  return (s) => {
    let out = s;
    for (const [re, alias] of known)
      out = out.replace(re, alias);
    out = out.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>").replace(/\bBearer\s+\S+/gi, "Bearer <redacted>").replace(/\b(sk|pk|rk|ak|key)-[\w-]{8,}/gi, "<key>").replace(/([?&](?:key|api_?key|token|access_token|auth|sig|signature|cookie)=)[^&\s"']+/gi, "$1<redacted>").replace(/[A-Za-z0-9_-]{32,}/g, "<token>").replace(/(\/home|\/Users)\/[^/\s"']+/g, "$1/<user>").replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, "$1<user>");
    return out.length > TEXT_MAX ? `${out.slice(0, TEXT_MAX)}\u2026\uFF08\u622A\u65AD\uFF0C\u539F\u957F ${out.length}\uFF09` : out;
  };
}
function baseView(base) {
  try {
    const u = new URL(base);
    return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ? `${u.protocol}//${u.host}` : "<\u975E\u672C\u673A\u5730\u5740>";
  } catch {
    return "<\u65E0\u6CD5\u89E3\u6790>";
  }
}
async function buildDiagnostics(input) {
  const now = input.now ?? new Date;
  const truncated = [];
  const cap = (list, path, max = LIST_MAX) => {
    if (list.length <= max)
      return list;
    truncated.push(`${path}\uFF1A\u5171 ${list.length} \u6761\uFF0C\u53EA\u5BFC\u51FA\u524D ${max} \u6761`);
    return list.slice(0, max);
  };
  const settle = (p) => p.then((ok) => ({ ok }), (e) => ({ error: errText(e) }));
  const dirs = magpieDirs();
  const [models, quotas, keyDir, catalog] = await Promise.all([
    settle(fetchModels(input.base)),
    settle(fetchQuotas(input.base)),
    settle(readKeyDirectory(dirs.config)),
    settle(fetchCatalog(input.base))
  ]);
  const dir = "ok" in keyDir ? keyDir.ok : null;
  const quotaEntries = "ok" in quotas ? quotas.ok.entries : [];
  const rawModels = "ok" in models ? models.ok : [];
  const aliases = new Aliases;
  for (const entry of dir?.values() ?? [])
    for (const k of entry.keys)
      aliases.key(k.fingerprint, k.name);
  const cardAlias = (q) => q.viaKey ? aliases.keyCard(q.account) : aliases.account(q.account);
  for (const q of quotaEntries)
    cardAlias(q);
  for (const t of input.tasks)
    aliases.account(t.account);
  for (const q of input.scheduler?.quotaEntries() ?? [])
    cardAlias(q);
  const scrub = scrubber(aliases);
  const pids = new Set([
    ...rawModels.map(modelProvider).filter(Boolean),
    ...quotaEntries.map((q) => q.provider),
    ...dir?.keys() ?? [],
    ...input.tasks.map((t) => t.provider)
  ]);
  const catalogById = new Map(("ok" in catalog ? catalog.ok.providers : []).map((p) => [p.id, p]));
  const providers = await Promise.all([...pids].sort().map(async (pid) => {
    const entry = dir?.get(pid);
    const v1 = rawModels.filter((m) => modelProvider(m) === pid);
    const cache = await readDefaultModelCache(pid).catch(() => null);
    const cat = catalogById.get(pid);
    const path = `providers.${pid}`;
    return {
      id: pid,
      v1Models: cap(v1.map((m) => ({
        id: m.id,
        owned_by: m.owned_by,
        reasoning: m.reasoning,
        reasoning_levels: m.reasoning_levels,
        supported_reasoning_levels: m.supported_reasoning_levels?.map((l) => l.effort)
      })), `${path}.v1Models`),
      providersJson: entry ? {
        chosen: cap(entry.models, `${path}.chosen`),
        keys: entry.keys.map((k) => ({ alias: aliases.key(k.fingerprint, k.name), named: k.name !== "" })),
        accountModels: Object.fromEntries(Object.entries(entry.accountModels).map(([k, v]) => [aliases.accountKey(k), v]))
      } : null,
      modelCache: cache ? cap(cache.map((c) => ({ id: c.id, keys: c.keys.map((fp) => aliases.accountKey(fp)) })), `${path}.modelCache`) : null,
      quotaCards: quotaEntries.filter((q) => q.provider === pid).map((q) => ({ account: cardAlias(q), viaKey: q.viaKey, readAt: q.readAt ?? null, windows: q.windows })),
      catalog: cat ? {
        accounts: cat.accounts.map((a) => ({
          id: a.kind === "key" ? aliases.accountKey(a.id) : aliases.account(a.id),
          kind: a.kind,
          windows: a.windows.map((w) => w.name),
          models: a.models === null ? null : cap(a.models, `${path}.catalog.accounts.models`),
          perAccount: a.perAccount,
          autoModel: a.autoModel
        })),
        autoAccountModels: cat.autoAccountModels === null ? null : cap(cat.autoAccountModels, `${path}.catalog.autoAccountModels`),
        autoModel: cat.autoModel
      } : null
    };
  }));
  const scheduler = input.scheduler;
  const next = scheduler?.snapshot().next ?? {};
  const tasks = await Promise.all(input.tasks.map(async (t) => {
    const preview = scheduler ? await scheduler.previewSend(t) : { error: "\u8C03\u5EA6\u5668\u672A\u8FD0\u884C" };
    const marks = input.marks[t.id];
    return {
      id: t.id,
      enabled: t.enabled,
      provider: t.provider,
      account: aliases.account(t.account),
      accountKind: /^[0-9a-f]{10}$/.test(t.account) ? "key" : t.account ? "login" : "",
      model: t.model || "<\u81EA\u52A8>",
      trigger: t.trigger,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      next: next[t.id] ?? null,
      marks: marks ? { ...marks, resetKeys: marks.resetKeys.slice(-5).map(scrub) } : null,
      sendPreview: "error" in preview ? { error: scrub(preview.error) } : { ...preview, pin: preview.pin === null ? null : scrub(preview.pin) }
    };
  }));
  const runs = input.tasks.flatMap((t) => input.runs.filter((r) => r.taskId === t.id).slice(-RUNS_PER_TASK).map((r) => ({ ...r, reason: scrub(r.reason) })));
  return {
    schema: DIAGNOSTICS_SCHEMA,
    note: "\u8D26\u53F7\u4E0E key \u5DF2\u6362\u6210\u522B\u540D\uFF08acct-N / key-N\uFF09\uFF0C\u4EFB\u52A1\u540D\u4E0E\u989D\u5EA6\u5361\u663E\u793A\u540D\u672A\u5BFC\u51FA\uFF0C\u81EA\u7531\u6587\u672C\u5DF2\u8131\u654F",
    generatedAt: now.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    plugin: { version, bun: Bun.version, platform: `${process.platform}-${process.arch}` },
    gateway: {
      base: baseView(input.base),
      models: "ok" in models ? `ok\uFF08${models.ok.length} \u4E2A\uFF09` : scrub(models.error),
      quotas: "ok" in quotas ? `ok\uFF08${quotas.ok.entries.length} \u5F20\u5361\uFF09` : scrub(quotas.error),
      catalog: "ok" in catalog ? "ok" : scrub(catalog.error)
    },
    files: {
      configDir: scrub(dirs.config),
      cacheDir: scrub(dirs.cache),
      dataDir: scrub(input.dir),
      providersJson: "ok" in keyDir ? keyDir.ok.size > 0 ? `ok\uFF08${keyDir.ok.size} \u4E2A\u4F9B\u5E94\u5546\uFF09` : "\u6CA1\u6709\u6587\u4EF6\u6216\u4E3A\u7A7A" : keyDir.error
    },
    service: {
      fatal: input.fatal === null ? null : scrub(input.fatal),
      lockedBy: input.lockedBy,
      saveError: scrub(scheduler?.snapshot().saveError ?? "") || null,
      scheduler: scheduler?.debugView() ?? null
    },
    tasks,
    runs,
    providers,
    truncated
  };
}

// src/scheduler.ts
import { randomUUID } from "crypto";
var TIMER_CAP_MS = 600000;
var QUOTA_REFRESH_MS = 600000;
var POST_SEND_SETTLE_MS = 60000;
var CARD_FRESH_MS = 60000;
var CARD_REFRESH_GAP_MS = 60000;
var HOUR_MS2 = 3600000;
var DAY_MS = 24 * HOUR_MS2;
var INTERRUPTED_REASON = "Magpie \u5728\u53D1\u9001\u4E2D\u9014\u9000\u51FA\uFF0C\u7ED3\u679C\u672A\u77E5";
var OVERLAP_REASON = "\u4E0A\u4E00\u6B21\u53D1\u9001\u8FD8\u6CA1\u7ED3\u675F\uFF0C\u672C\u6B21\u8DF3\u8FC7";
var DISABLED_REASON = "\u4EFB\u52A1\u5DF2\u505C\u7528\uFF0C\u53D1\u9001\u88AB\u53D6\u6D88";
var DELETED_REASON = "\u4EFB\u52A1\u5DF2\u5220\u9664\uFF0C\u53D1\u9001\u88AB\u53D6\u6D88";
var CONFLICT_MESSAGE = "\u4E0A\u4E00\u6B21\u53D1\u9001\u8FD8\u6CA1\u7ED3\u675F\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5";
var NOT_FOUND_MESSAGE = "\u4EFB\u52A1\u4E0D\u5B58\u5728";
function taskContent(input) {
  return {
    name: input.name,
    enabled: input.enabled,
    provider: input.provider,
    account: input.account,
    model: input.model,
    message: input.message,
    trigger: input.trigger
  };
}
function newRun(task, at, due, source, resetKey) {
  return {
    id: randomUUID(),
    taskId: task.id,
    source,
    due: due?.toISOString() ?? null,
    startedAt: at.toISOString(),
    endedAt: null,
    outcome: "running",
    reason: "",
    effort: null,
    model: null,
    ms: null,
    resetKey
  };
}

class Scheduler {
  store;
  base;
  nowFn;
  setTimerFn;
  sendFn;
  quotasFn;
  refreshCardFn;
  modelsFn;
  keyDirFn;
  modelCacheFn;
  started = false;
  chain = Promise.resolve();
  background = [];
  lastWrite = Promise.resolve();
  cancelTimer = null;
  armedFor = new Map;
  inflight = new Map;
  quota = null;
  keyDirMap = null;
  quotaStale = false;
  quotaTried = false;
  saveError = null;
  lastErrKey = new Map;
  lastCardRefresh = new Map;
  constructor(deps) {
    this.store = deps.store;
    this.base = deps.base;
    this.nowFn = deps.now ?? (() => new Date);
    this.setTimerFn = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    this.sendFn = deps.sendFn ?? send;
    this.quotasFn = deps.quotasFn ?? fetchQuotas;
    this.refreshCardFn = deps.refreshCardFn ?? refreshQuotaCard;
    this.modelsFn = deps.modelsFn ?? fetchModels;
    this.keyDirFn = deps.keyDirFn ?? readDefaultKeyDirectory;
    this.modelCacheFn = deps.modelCacheFn ?? readDefaultModelCache;
  }
  start() {
    this.started = true;
    const now = this.nowFn();
    let dirty = false;
    for (const r of this.store.data.runs) {
      if (r.outcome === "running") {
        r.outcome = "unknown";
        r.reason = INTERRUPTED_REASON;
        r.endedAt = now.toISOString();
        dirty = true;
      }
    }
    if (dirty)
      this.trackSave();
    this.rearm();
  }
  stop() {
    this.started = false;
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.armedFor = new Map;
  }
  upsert(input) {
    return this.queueOp(async () => {
      const now = this.nowFn();
      if (input.id) {
        const idx = this.store.data.tasks.findIndex((t) => t.id === input.id);
        if (idx < 0)
          throw new Error(NOT_FOUND_MESSAGE);
        const prev = this.store.data.tasks[idx];
        const next = {
          id: prev.id,
          ...taskContent(input),
          createdAt: prev.createdAt,
          updatedAt: now.toISOString()
        };
        this.store.data.tasks[idx] = next;
        const flight = this.inflight.get(next.id);
        if (prev.enabled && !next.enabled && flight && !flight.cancel) {
          flight.cancel = "disabled";
          flight.abort.abort();
          await flight.done;
        }
        await this.store.save();
        this.rearm();
        return next;
      }
      const task = {
        id: randomUUID(),
        ...taskContent(input),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.store.data.tasks.push(task);
      this.store.data.marks[task.id] = { lastDue: null, resetKeys: [] };
      await this.store.save();
      this.rearm();
      return task;
    });
  }
  async remove(id) {
    await this.queueOp(async () => {
      const exists = this.store.data.tasks.some((t) => t.id === id);
      const flight = this.inflight.get(id);
      if (!exists && !flight)
        throw new Error(NOT_FOUND_MESSAGE);
      if (flight) {
        flight.cancel = "deleted";
        flight.abort.abort();
        await flight.done;
      }
      this.store.data.tasks = this.store.data.tasks.filter((t) => t.id !== id);
      this.store.data.runs = this.store.data.runs.filter((r) => r.taskId !== id);
      delete this.store.data.marks[id];
      this.lastErrKey.delete(id);
      await this.store.save();
      this.rearm();
    });
  }
  runNow(id) {
    return this.queueOp(async () => {
      const task = this.store.data.tasks.find((t) => t.id === id);
      if (!task)
        throw new Error(NOT_FOUND_MESSAGE);
      if (this.inflight.has(id))
        throw new Error(CONFLICT_MESSAGE);
      return this.fire(task, null, "manual", null);
    });
  }
  snapshot() {
    const now = this.nowFn();
    const next = {};
    const timeline = [];
    for (const task of this.store.data.tasks) {
      if (!task.enabled) {
        next[task.id] = null;
        continue;
      }
      const points = [];
      try {
        this.snapshotTask(task, now, next, points);
      } catch {
        next[task.id] = null;
        continue;
      }
      timeline.push(...points);
    }
    timeline.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    return {
      tasks: [...this.store.data.tasks],
      runs: [...this.store.data.runs],
      next,
      timeline,
      saveError: this.saveError === null ? null : `\u72B6\u6001\u6587\u4EF6\u5199\u4E0D\u8FDB\u53BB\uFF1A${this.saveError}`
    };
  }
  debugView() {
    return {
      quotaAt: this.quota?.at.toISOString() ?? null,
      quotaStale: this.quotaStale,
      quotaTried: this.quotaTried,
      keyDirLoaded: this.keyDirMap !== null,
      inflight: [...this.inflight.keys()],
      armedFor: Object.fromEntries([...this.armedFor].map(([id, at]) => [id, at.toISOString()]))
    };
  }
  quotaEntries() {
    return this.quota?.entries ?? null;
  }
  async previewSend(task) {
    try {
      const resolved = await this.resolveSend(task, await this.modelsFn(this.base));
      if ("error" in resolved)
        return resolved;
      const pick = pickEffort(resolved.model);
      if ("error" in pick)
        return pick;
      return { model: resolved.id, pin: resolved.pin, effort: pick.send };
    } catch (e) {
      return { error: errText(e) };
    }
  }
  snapshotTask(task, now, next, points) {
    if (task.trigger.kind === "window") {
      const due = this.currentWindowDue(task, now);
      let at = null;
      if (due && !this.tried(task, due)) {
        if (due.at.getTime() > now.getTime())
          at = due.at;
        else
          at = this.snapshotFresh(now) ? now : new Date(now.getTime() + QUOTA_REFRESH_MS);
      }
      next[task.id] = at ? at.toISOString() : null;
      if (at && at.getTime() > now.getTime() && at.getTime() <= now.getTime() + DAY_MS) {
        points.push({ taskId: task.id, at: at.toISOString() });
      }
    } else {
      const base = this.pendingFixedDue(task, now) ?? now;
      const at = task.trigger.kind === "daily" ? nextDaily(task.trigger, base) : nextEvery(task.trigger, base);
      next[task.id] = at.toISOString();
      for (const p of upcoming(task.trigger, now, 25)) {
        if (p.getTime() > now.getTime() + DAY_MS)
          break;
        points.push({ taskId: task.id, at: p.toISOString() });
      }
    }
  }
  async flush() {
    for (let i = 0;i < 100; i++) {
      const bg = [...this.background];
      if (bg.length > 0) {
        await Promise.race([Promise.allSettled(bg), new Promise((r) => setTimeout(r, 0))]);
      }
      await this.chain.catch(() => {});
      await this.lastWrite;
      await new Promise((r) => setTimeout(r, 0));
      if (this.background.length === 0) {
        await this.chain.catch(() => {});
        await this.lastWrite;
        return;
      }
    }
  }
  queueOp(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => {}, () => {});
    return run;
  }
  track(p) {
    const wrapped = p.catch(() => {}).finally(() => {
      this.background = this.background.filter((x) => x !== wrapped);
    });
    this.background.push(wrapped);
  }
  trackSave() {
    const p = this.store.save().then(() => {
      this.saveError = null;
      return true;
    }, (e) => {
      this.saveError = errText(e);
      return false;
    });
    this.lastWrite = p.then(() => {});
    return p;
  }
  marksOf(id) {
    let m = this.store.data.marks[id];
    if (!m) {
      m = { lastDue: null, resetKeys: [] };
      this.store.data.marks[id] = m;
    }
    return m;
  }
  async tick() {
    if (!this.started)
      return;
    const now = this.nowFn();
    const tasks = this.store.data.tasks;
    const hasWindow = tasks.some((t) => t.enabled && t.trigger.kind === "window");
    if (hasWindow) {
      await this.refreshQuotas();
      if (await this.readCards(now)) {
        this.quotaStale = true;
        await this.refreshQuotas();
      }
    }
    for (const task of [...tasks]) {
      if (!task.enabled)
        continue;
      try {
        if (task.trigger.kind === "window")
          await this.evaluateWindow(task, now);
        else
          await this.evaluateFixed(task, now);
      } catch (e) {
        const reason = `\u8C03\u5EA6\u51FA\u9519\uFF1A${errText(e)}`;
        const key = `${hourFloorISO(now)}|${reason}`;
        if (this.lastErrKey.get(task.id) !== key) {
          this.lastErrKey.set(task.id, key);
          this.appendFailure(task, now, null, reason, null, "schedule");
        }
      }
    }
    if (hasWindow)
      await this.refreshQuotas();
    this.rearm();
  }
  fixedConsumedUntil(task) {
    const last = this.store.data.marks[task.id]?.lastDue;
    const updated = new Date(task.updatedAt).getTime();
    return last ? Math.max(new Date(last).getTime(), updated) : updated;
  }
  pendingFixedDue(task, now) {
    const recent = lastDue(task.trigger, now);
    return recent && recent.getTime() > this.fixedConsumedUntil(task) ? recent : null;
  }
  async evaluateFixed(task, now) {
    const due = this.pendingFixedDue(task, now);
    if (!due)
      return;
    const armed = this.armedFor.get(task.id) ?? null;
    const source = armed !== null && armed.getTime() === due.getTime() ? "schedule" : "catchup";
    await this.fire(task, due, source, null);
  }
  async evaluateWindow(task, now) {
    const due = this.currentWindowDue(task, now);
    if (!due || !this.windowReady(task, due, now))
      return;
    const marks = this.marksOf(task.id);
    marks.resetKeys.push(due.resetKey);
    const companion = `idle:${hourFloorISO(due.at)}`;
    if (companion !== due.resetKey)
      marks.resetKeys.push(companion);
    this.quotaStale = true;
    await this.fire(task, due.at, "schedule", due.resetKey);
  }
  tried(task, due) {
    return this.marksOf(task.id).resetKeys.includes(due.resetKey);
  }
  windowReady(task, due, now) {
    return due.at.getTime() <= now.getTime() && !this.tried(task, due);
  }
  quotaWindow(task) {
    if (task.trigger.kind !== "window" || !this.quota || !task.account)
      return;
    const name = task.trigger.window;
    const windows = windowsForAccount(task.provider, task.account, this.quota.entries, this.keyDirMap);
    return windows?.find((w) => w.name === name);
  }
  recordResets() {
    let dirty = false;
    for (const task of this.store.data.tasks) {
      if (!task.enabled)
        continue;
      const raw = this.quotaWindow(task)?.resetsAt;
      if (!raw || Number.isNaN(new Date(raw).getTime()))
        continue;
      const mark = this.marksOf(task.id);
      if (mark.lastReset !== raw) {
        mark.lastReset = raw;
        dirty = true;
      }
    }
    if (dirty)
      this.trackSave();
  }
  currentWindowDue(task, now) {
    const win = this.quotaWindow(task);
    if (!win || !this.quota)
      return null;
    const due = windowDue(win, this.quota.at);
    if ("error" in due)
      return null;
    if (due.resetKey.startsWith("idle:") && this.staleIdle(task))
      return null;
    const raw = win.resetsAt;
    if (raw && !Number.isNaN(new Date(raw).getTime())) {
      return { at: due.at, resetKey: raw };
    }
    const mark = this.marksOf(task.id);
    const isFuture = (iso) => !!iso && new Date(iso).getTime() > now.getTime();
    if (isFuture(mark.lastReset) || mark.resetKeys.some(isFuture))
      return null;
    return due;
  }
  loginCard(task) {
    return this.quota?.entries.find((q) => q.provider === task.provider && !q.viaKey && q.account === task.account) ?? null;
  }
  lastSentMs(task) {
    const v = this.store.data.marks[task.id]?.lastSent;
    return v ? new Date(v).getTime() : NaN;
  }
  staleIdle(task) {
    const readAt = new Date(this.loginCard(task)?.readAt ?? "").getTime();
    const sent = this.lastSentMs(task);
    return Number.isFinite(readAt) && Number.isFinite(sent) && readAt < sent + POST_SEND_SETTLE_MS;
  }
  async readCards(now) {
    let asked = false;
    for (const task of this.store.data.tasks) {
      if (!task.enabled || task.trigger.kind !== "window")
        continue;
      const card = this.loginCard(task);
      if (!card)
        continue;
      const readAt = new Date(card.readAt ?? "").getTime();
      const settled = this.lastSentMs(task) + POST_SEND_SETTLE_MS;
      const afterSend = now.getTime() >= settled && readAt < settled;
      const due = this.currentWindowDue(task, now);
      const readFresh = now.getTime() - readAt <= CARD_FRESH_MS;
      const dueNow = due !== null && this.windowReady(task, due, now) && !readFresh;
      if (!afterSend && !dueNow)
        continue;
      const key = `${card.provider}|${card.account}`;
      const last = this.lastCardRefresh.get(key);
      if (last !== undefined && now.getTime() - last < CARD_REFRESH_GAP_MS)
        continue;
      this.lastCardRefresh.set(key, now.getTime());
      asked = true;
      await this.refreshCardFn(this.base, card.provider, card.account).catch(() => {});
    }
    return asked;
  }
  snapshotFresh(now) {
    return this.quota !== null && !this.quotaStale && now.getTime() - this.quota.at.getTime() < QUOTA_REFRESH_MS;
  }
  async refreshQuotas() {
    const now = this.nowFn();
    const quotaFresh = this.snapshotFresh(now);
    if (quotaFresh && this.keyDirMap !== null)
      return;
    this.quotaTried = true;
    const [keyDir, snap] = await Promise.all([
      this.keyDirFn().then((m) => m, () => this.keyDirMap),
      quotaFresh ? Promise.resolve(this.quota) : this.quotasFn(this.base).catch(() => null)
    ]);
    this.keyDirMap = keyDir;
    if (snap) {
      this.quota = snap;
      this.quotaStale = false;
    } else if (!quotaFresh) {
      this.quotaStale = true;
    }
    this.recordResets();
  }
  async fire(task, due, source, resetKey) {
    const now = this.nowFn();
    if (this.inflight.has(task.id)) {
      if (due && task.trigger.kind !== "window")
        this.marksOf(task.id).lastDue = due.toISOString();
      return this.appendFailure(task, now, due, OVERLAP_REASON, resetKey, source);
    }
    if (due && task.trigger.kind !== "window")
      this.marksOf(task.id).lastDue = due.toISOString();
    const run = newRun(task, now, due, source, resetKey);
    this.store.data.runs.push(run);
    const abort = new AbortController;
    const entry = { abort, cancel: null, done: Promise.resolve() };
    this.inflight.set(task.id, entry);
    const savedRunning = this.trackSave();
    entry.done = this.sendAndFinalize(task, run, entry, savedRunning);
    this.track(entry.done);
    await savedRunning;
    return run;
  }
  async resolveSend(task, models) {
    const [keyDir, cache] = await Promise.all([
      this.keyDirFn().catch(() => null),
      this.modelCacheFn(task.provider).catch(() => null)
    ]);
    const pin = pinFor(task.provider, task.account, keyDir, this.quota?.entries ?? []);
    const chosen = keyDir?.get(task.provider)?.models ?? [];
    if (task.model) {
      const model = models.find((m) => m.id === task.model);
      if (model)
        return { id: task.model, model, pin };
      if (chosen.some((bare) => bare === task.model || `${task.provider}/${bare}` === task.model)) {
        return { id: task.model, model: { id: task.model }, pin };
      }
      return { error: `\u6A21\u578B ${task.model} \u5DF2\u4E0D\u5728 Magpie \u7684\u6A21\u578B\u5217\u8868\u91CC` };
    }
    const ids = models.filter((m) => modelProvider(m) === task.provider).map((m) => m.id);
    const list = modelsForAccount(task.provider, task.account, {
      models: ids,
      keyDir,
      cache,
      chosen
    }).list;
    if (list === null) {
      return { error: `\u4F9B\u5E94\u5546 ${task.provider} \u8FD8\u6CA1\u6709\u6A21\u578B\u5217\u8868\uFF0C\u65E0\u6CD5\u81EA\u52A8\u9009\u6A21\u578B` };
    }
    if (list.length === 0)
      return { error: `\u8D26\u53F7 ${task.account || "\u81EA\u52A8"} \u6CA1\u6709\u53EF\u7528\u6A21\u578B` };
    const chosenModel = pickAutoModel(list.map((id) => ({ id })));
    if (!chosenModel)
      return { error: `\u8D26\u53F7 ${task.account || "\u81EA\u52A8"} \u6CA1\u6709\u53EF\u7528\u6A21\u578B` };
    const model = models.find((m) => m.id === chosenModel.id) ?? { id: chosenModel.id };
    return { id: chosenModel.id, model, pin };
  }
  async sendAndFinalize(task, run, entry, savedRunning) {
    try {
      const persisted = await savedRunning;
      let effort = null;
      let result;
      let sent = false;
      if (!persisted) {
        result = {
          outcome: "failed",
          reason: `\u72B6\u6001\u6587\u4EF6\u5199\u4E0D\u8FDB\u53BB\uFF0C\u672C\u6B21\u4E0D\u53D1\u9001\uFF1A${this.saveError ?? "\u672A\u77E5\u539F\u56E0"}`,
          ms: 0
        };
      } else {
        try {
          const models = await this.modelsFn(this.base, entry.abort.signal);
          const resolved = await this.resolveSend(task, models);
          if ("error" in resolved) {
            result = { outcome: "failed", reason: resolved.error, ms: 0 };
          } else {
            const pick = pickEffort(resolved.model);
            if ("error" in pick) {
              result = { outcome: "failed", reason: pick.error, ms: 0 };
            } else {
              effort = pick.send;
              run.model = resolved.id;
              sent = true;
              result = await this.sendFn(this.base, { id: task.id, model: resolved.id }, resolved.pin, effort, entry.abort.signal);
            }
          }
        } catch (e) {
          result = { outcome: "failed", reason: errText(e), ms: 0 };
        }
      }
      run.effort = effort;
      if (entry.cancel === "disabled") {
        run.outcome = "unknown";
        run.reason = DISABLED_REASON;
      } else if (entry.cancel === "deleted") {
        run.outcome = "unknown";
        run.reason = DELETED_REASON;
      } else {
        run.outcome = result.outcome;
        run.reason = result.reason;
      }
      run.ms = result.ms;
      run.endedAt = this.nowFn().toISOString();
      if (!this.store.data.tasks.some((t) => t.id === task.id))
        return;
      const opened = sent && !entry.cancel && result.outcome !== "failed" && task.trigger.kind === "window";
      if (opened)
        this.marksOf(task.id).lastSent = run.endedAt;
      await this.trackSave();
      if (opened)
        this.rearm();
    } finally {
      this.inflight.delete(task.id);
    }
  }
  appendFailure(task, at, due, reason, resetKey, source) {
    const run = {
      ...newRun(task, at, due, source, resetKey),
      endedAt: at.toISOString(),
      outcome: "failed",
      reason,
      ms: 0
    };
    this.store.data.runs.push(run);
    this.trackSave();
    return run;
  }
  rearm() {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.armedFor = new Map;
    if (!this.started)
      return;
    this.recordResets();
    const now = this.nowFn();
    let minDelay = Infinity;
    for (const task of this.store.data.tasks) {
      if (!task.enabled)
        continue;
      if (task.trigger.kind === "window") {
        const settled = this.lastSentMs(task) + POST_SEND_SETTLE_MS;
        if (settled > now.getTime())
          minDelay = Math.min(minDelay, settled - now.getTime());
        const due = this.currentWindowDue(task, now);
        if (due && due.at.getTime() > now.getTime()) {
          minDelay = Math.min(minDelay, due.at.getTime() - now.getTime());
        } else if (due && this.windowReady(task, due, now) && this.snapshotFresh(now)) {
          minDelay = Math.min(minDelay, 0);
        } else {
          minDelay = Math.min(minDelay, this.quotaTried ? QUOTA_REFRESH_MS : 0);
        }
      } else {
        const base = new Date(this.fixedConsumedUntil(task));
        let due;
        try {
          due = task.trigger.kind === "daily" ? nextDaily(task.trigger, base) : nextEvery(task.trigger, base);
        } catch {
          continue;
        }
        if (due.getTime() > now.getTime()) {
          this.armedFor.set(task.id, due);
          minDelay = Math.min(minDelay, due.getTime() - now.getTime());
        } else {
          minDelay = Math.min(minDelay, 0);
        }
      }
    }
    if (Number.isFinite(minDelay)) {
      const delay = Math.min(Math.max(minDelay, 0), TIMER_CAP_MS);
      this.cancelTimer = this.setTimerFn(() => {
        this.queueOp(() => this.tick()).catch(() => {});
      }, delay);
    }
  }
}

// src/store.ts
import { link, mkdir, readdir, readFile as readFile2, rename, unlink, writeFile } from "fs/promises";
import { join as join2 } from "path";
import { randomUUID as randomUUID2 } from "crypto";
var RUNS_PER_TASK2 = 50;
var RESET_KEYS_PER_TASK = 20;
var STATE_FILE = "state.json";
var LOCK_FILE = "service.lock";
var LEGACY_DIR_NAME = "scheduled-messages";

class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreError";
  }
}
function isStr(x) {
  return typeof x === "string";
}
function isStrOrNull(x) {
  return x === null || typeof x === "string";
}
function checkTask(t, at) {
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at} \u5FC5\u987B\u662F\u5BF9\u8C61`;
  }
  const o = t;
  for (const k of ["id", "name", "provider", "account", "model", "message", "createdAt", "updatedAt"]) {
    if (!isStr(o[k]))
      return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.${k} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
  }
  if (typeof o.enabled !== "boolean")
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.enabled \u5FC5\u987B\u662F\u5E03\u5C14\u503C`;
  const trig = o.trigger;
  if (typeof trig !== "object" || trig === null || Array.isArray(trig)) {
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.trigger \u5FC5\u987B\u662F\u5BF9\u8C61`;
  }
  const tv = trig;
  switch (tv.kind) {
    case "window":
      if (!isStr(tv.window))
        return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.trigger.window \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
      break;
    case "daily":
      if (!isStr(tv.time) || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(tv.time)) {
        return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.trigger.time \u9700\u4E3A 24 \u5C0F\u65F6\u5236 HH:MM`;
      }
      if (!isStr(tv.timeZone) || !tv.timeZone) {
        return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.trigger.timeZone \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
      }
      break;
    case "every":
      if (typeof tv.hours !== "number" || !Number.isFinite(tv.hours) || tv.hours <= 0) {
        return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.trigger.hours \u5FC5\u987B\u662F\u6B63\u6570`;
      }
      if (!isStr(tv.anchor) || Number.isNaN(new Date(tv.anchor).getTime())) {
        return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.trigger.anchor \u5FC5\u987B\u662F\u53EF\u8BC6\u522B\u7684\u65F6\u95F4`;
      }
      break;
    default:
      return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.trigger.kind \u5FC5\u987B\u662F window\u3001daily \u6216 every`;
  }
  return null;
}
function checkRun(r, at) {
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at} \u5FC5\u987B\u662F\u5BF9\u8C61`;
  }
  const o = r;
  for (const k of ["id", "taskId", "startedAt"]) {
    if (!isStr(o[k]))
      return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.${k} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
  }
  if (o.source !== "schedule" && o.source !== "catchup" && o.source !== "manual") {
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.source \u65E0\u6CD5\u8BC6\u522B`;
  }
  if (o.outcome !== "ok" && o.outcome !== "failed" && o.outcome !== "unknown" && o.outcome !== "running") {
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.outcome \u65E0\u6CD5\u8BC6\u522B`;
  }
  if (!isStr(o.reason))
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.reason \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`;
  for (const k of ["due", "endedAt", "effort", "resetKey"]) {
    if (!isStrOrNull(o[k]))
      return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.${k} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6216 null`;
  }
  if (o.model !== undefined && !isStrOrNull(o.model)) {
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.model \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6216 null`;
  }
  if (o.ms !== null && typeof o.ms !== "number") {
    return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A${at}.ms \u5FC5\u987B\u662F\u6570\u5B57\u6216 null`;
  }
  return null;
}
function validateState(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return "\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1A\u9876\u5C42\u5FC5\u987B\u662F JSON \u5BF9\u8C61";
  }
  const o = v;
  if (o.version !== 1) {
    return `\u72B6\u6001\u6587\u4EF6\u7248\u672C\u4E0D\u8BA4\u8BC6\uFF1A${JSON.stringify(o.version) ?? "\u7F3A\u5931"}\uFF08\u672C\u7A0B\u5E8F\u53EA\u652F\u6301\u7248\u672C 1\uFF09`;
  }
  if (!Array.isArray(o.tasks))
    return "\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1Atasks \u5FC5\u987B\u662F\u6570\u7EC4";
  for (let i = 0;i < o.tasks.length; i++) {
    const problem = checkTask(o.tasks[i], `tasks[${i}]`);
    if (problem)
      return problem;
  }
  if (!Array.isArray(o.runs))
    return "\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1Aruns \u5FC5\u987B\u662F\u6570\u7EC4";
  for (let i = 0;i < o.runs.length; i++) {
    const problem = checkRun(o.runs[i], `runs[${i}]`);
    if (problem)
      return problem;
  }
  const marks = o.marks;
  if (typeof marks !== "object" || marks === null || Array.isArray(marks)) {
    return "\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1Amarks \u5FC5\u987B\u662F\u5BF9\u8C61";
  }
  for (const [id, value] of Object.entries(marks)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1Amarks.${id} \u5FC5\u987B\u662F\u5BF9\u8C61`;
    }
    const m = value;
    if (!isStrOrNull(m.lastDue))
      return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1Amarks.${id}.lastDue \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6216 null`;
    if (!Array.isArray(m.resetKeys) || m.resetKeys.some((k) => !isStr(k))) {
      return `\u72B6\u6001\u6587\u4EF6\u7ED3\u6784\u4E0D\u5BF9\uFF1Amarks.${id}.resetKeys \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4`;
    }
  }
  return null;
}
function truncateState(data) {
  const counts = new Map;
  const kept = [];
  for (let i = data.runs.length - 1;i >= 0; i--) {
    const r = data.runs[i];
    const n = (counts.get(r.taskId) ?? 0) + 1;
    counts.set(r.taskId, n);
    if (n <= RUNS_PER_TASK2)
      kept.push(r);
  }
  data.runs = kept.reverse();
  for (const m of Object.values(data.marks)) {
    if (m.resetKeys.length > RESET_KEYS_PER_TASK)
      m.resetKeys = m.resetKeys.slice(-RESET_KEYS_PER_TASK);
  }
}

class StoreImpl {
  data;
  path;
  writing = Promise.resolve();
  constructor(data, path) {
    this.data = data;
    this.path = path;
  }
  save() {
    const next = this.writing.then(async () => {
      truncateState(this.data);
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data), { mode: 384 });
      await rename(tmp, this.path);
    });
    this.writing = next.then(() => {}, () => {});
    return next;
  }
}
async function openStore(dir) {
  await mkdir(dir, { recursive: true, mode: 448 });
  const path = join2(dir, STATE_FILE);
  let raw;
  try {
    raw = await readFile2(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      return new StoreImpl({ version: 1, tasks: [], runs: [], marks: {} }, path);
    }
    throw new StoreError(`\u72B6\u6001\u6587\u4EF6\u8BFB\u4E0D\u51FA\u6765\uFF1A${errText(e)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StoreError(`\u72B6\u6001\u6587\u4EF6\u4E0D\u662F\u5408\u6CD5\u7684 JSON\uFF1A${errText(e)}`);
  }
  const problem = validateState(parsed);
  if (problem)
    throw new StoreError(problem);
  const data = parsed;
  for (const r of data.runs) {
    if (r.model === undefined)
      r.model = null;
  }
  truncateState(data);
  return new StoreImpl(data, path);
}
async function migrateLegacyState(dir, env = process.env) {
  const statePath = join2(dir, STATE_FILE);
  try {
    await readFile2(statePath);
    return;
  } catch (e) {
    if (e.code !== "ENOENT")
      return;
  }
  const legacy = join2(xdgConfigHome(env), "magpie", LEGACY_DIR_NAME, STATE_FILE);
  let raw;
  try {
    raw = await readFile2(legacy, "utf8");
  } catch {
    return;
  }
  await mkdir(dir, { recursive: true, mode: 448 });
  await writeFile(statePath, raw, { mode: 384 }).catch(() => {});
}
function parsePid(raw) {
  const t = raw.trim();
  if (/^\d+$/.test(t))
    return Number(t);
  try {
    const j = JSON.parse(t);
    if (typeof j === "object" && j !== null && typeof j.pid === "number") {
      return j.pid;
    }
  } catch {}
  return null;
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function releaseLock(path) {
  let raw;
  try {
    raw = await readFile2(path, "utf8");
  } catch {
    return;
  }
  if (parsePid(raw) === process.pid)
    await unlink(path).catch(() => {});
}
async function acquireLock(dir, opts = {}) {
  await mkdir(dir, { recursive: true, mode: 448 });
  const path = join2(dir, LOCK_FILE);
  const leftovers = await readdir(dir).catch(() => []);
  for (const name of leftovers) {
    if (/^service\.lock\.\d+\.[0-9a-f-]+\.tmp$/.test(name)) {
      await unlink(join2(dir, name)).catch(() => {});
    }
  }
  for (let round = 0;round < 3; round++) {
    const tmp = join2(dir, `${LOCK_FILE}.${process.pid}.${randomUUID2()}.tmp`);
    await writeFile(tmp, String(process.pid), { mode: 384 });
    try {
      await link(tmp, path);
      await unlink(tmp).catch(() => {});
      return { ok: true, release: () => releaseLock(path) };
    } catch (e) {
      await unlink(tmp).catch(() => {});
      if (e.code !== "EEXIST") {
        throw new Error(`\u65E0\u6CD5\u521B\u5EFA\u5355\u5B9E\u4F8B\u9501\uFF1A${errText(e)}`);
      }
    }
    let raw;
    try {
      raw = await readFile2(path, "utf8");
    } catch (e) {
      if (e.code === "ENOENT")
        continue;
      return { ok: false, pid: 0 };
    }
    const pid = parsePid(raw);
    if (pid === null)
      return { ok: false, pid: 0 };
    if (pidAlive(pid)) {
      const confirmed = opts.confirmAlive ? await opts.confirmAlive(pid) : true;
      if (confirmed)
        return { ok: false, pid };
    }
    try {
      await unlink(path);
    } catch {}
  }
  throw new Error("\u5355\u5B9E\u4F8B\u9501\u88AB\u5360\u7528\u4E14\u65E0\u6CD5\u63A5\u7BA1");
}

// src/server.ts
var TOKEN_HEADER = "x-window-warmup-token";
var MARKER_HEADER = "x-window-warmup";
var PROBE_TIMEOUT_MS = 2000;
var BODY_LIMIT = 64 * 1024;
async function alreadyServing(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    return res.headers.get(MARKER_HEADER) === "1";
  } catch {
    return false;
  }
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}
var MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2"
};
async function readBody(req) {
  let text = "";
  if (req.body) {
    const decoder = new TextDecoder;
    const reader = req.body.getReader();
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      text += decoder.decode(value, { stream: true });
      if (text.length > BODY_LIMIT) {
        await reader.cancel().catch(() => {});
        throw new Error("\u8BF7\u6C42\u4F53\u592A\u5927");
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("\u8BF7\u6C42\u4E0D\u662F\u5408\u6CD5\u7684 JSON");
  }
}
function insideDir(root, file, p = path2) {
  const rel = p.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
}
async function startService(opts) {
  const uiDir = opts.uiDir ?? resolve2(import.meta.dir, basename(import.meta.dir) === "src" ? "../dist/ui" : "ui");
  let fatal = null;
  let store;
  try {
    store = await openStore(opts.dir);
  } catch (e) {
    if (e instanceof StoreError)
      fatal = e.message;
    else
      throw e;
  }
  let scheduler = null;
  let lockRelease = null;
  let lockedBy = null;
  if (!fatal && store) {
    const lock = await acquireLock(opts.dir, {
      confirmAlive: opts.confirmLockAlive ?? (() => alreadyServing(opts.port))
    });
    if (lock.ok)
      lockRelease = lock.release;
    else
      lockedBy = lock.pid;
  }
  const token = randomBytes(32).toString("hex");
  let stopped = false;
  let server;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: opts.port,
      async fetch(req) {
        let res;
        try {
          res = await handle(req);
        } catch (e) {
          res = json({ error: errText(e) }, 500, corsHeaders(req.headers.get("origin")));
        }
        res.headers.set(MARKER_HEADER, "1");
        return res;
      }
    });
  } catch (e) {
    await lockRelease?.();
    throw e;
  }
  if (!fatal && store && lockedBy === null) {
    scheduler = new Scheduler({ store, base: opts.base });
    scheduler.start();
  }
  const ownOrigins = () => [
    `http://127.0.0.1:${server.port}`,
    `http://localhost:${server.port}`
  ];
  function tokenOK(got) {
    const a = Buffer.from(got ?? "");
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  function corsHeaders(origin) {
    const allow = origin && ownOrigins().includes(origin) ? origin : "null";
    return {
      "access-control-allow-origin": allow,
      "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      vary: "Origin",
      "cache-control": "no-store"
    };
  }
  function guardedState() {
    if (fatal !== null) {
      return { fatal, tasks: [], runs: [], next: {}, timeline: [], saveError: null };
    }
    if (lockedBy !== null) {
      return { lockedBy, tasks: [], runs: [], next: {}, timeline: [], saveError: null };
    }
    return scheduler.snapshot();
  }
  function opError(e, cors) {
    const msg = errText(e);
    if (msg === NOT_FOUND_MESSAGE)
      return json({ error: msg }, 404, cors);
    if (msg === CONFLICT_MESSAGE)
      return json({ error: msg }, 409, cors);
    return json({ error: msg }, 400, cors);
  }
  async function readBodyChecked(req, cors) {
    try {
      return { value: await readBody(req) };
    } catch (e) {
      return { error: json({ error: errText(e) }, 400, cors) };
    }
  }
  function readonlyBlock(cors) {
    if (fatal !== null) {
      return json({ error: `\u670D\u52A1\u5904\u4E8E\u6545\u969C\u72B6\u6001\uFF0C\u5148\u4FEE\u590D\u6570\u636E\u6587\u4EF6\uFF1A${fatal}` }, 503, cors);
    }
    if (lockedBy !== null) {
      const who = lockedBy > 0 ? `\uFF08\u8FDB\u7A0B ${lockedBy}\uFF09` : "";
      return json({ error: `\u53E6\u4E00\u4E2A\u5B9E\u4F8B\u6B63\u5728\u8FD0\u884C${who}\uFF0C\u672C\u9875\u53EA\u8BFB` }, 503, cors);
    }
    return null;
  }
  async function saveTask(req, cors, id) {
    const input = await readBodyChecked(req, cors);
    if ("error" in input)
      return input.error;
    const checked = validateTask(input.value, new Date);
    if ("error" in checked)
      return json({ error: checked.error, field: checked.field }, 400, cors);
    const task = id === undefined ? checked.task : { ...checked.task, id };
    try {
      return json(await scheduler.upsert(task), 200, cors);
    } catch (e) {
      return opError(e, cors);
    }
  }
  async function api(req, url, origin) {
    const cors = corsHeaders(origin);
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/state")
      return json(guardedState(), 200, cors);
    if (req.method === "GET" && path === "/api/catalog") {
      try {
        return json(await fetchCatalog(opts.base), 200, cors);
      } catch (e) {
        return json({ error: errText(e) }, 502, cors);
      }
    }
    if (req.method === "GET" && path === "/api/diagnostics") {
      const data = await buildDiagnostics({
        base: opts.base,
        dir: opts.dir,
        tasks: store?.data.tasks ?? [],
        runs: store?.data.runs ?? [],
        marks: store?.data.marks ?? {},
        scheduler,
        fatal,
        lockedBy
      });
      return json(data, 200, cors);
    }
    const blocked = readonlyBlock(cors);
    if (blocked)
      return blocked;
    const runMatch = /^\/api\/tasks\/([^/]+)\/run$/.exec(path);
    const idMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (path === "/api/tasks" && req.method === "POST")
      return saveTask(req, cors, undefined);
    if (idMatch && req.method === "PUT")
      return saveTask(req, cors, decodeURIComponent(idMatch[1]));
    if (idMatch && req.method === "DELETE") {
      try {
        await scheduler.remove(decodeURIComponent(idMatch[1]));
      } catch (e) {
        return opError(e, cors);
      }
      return json({ ok: true }, 200, cors);
    }
    if (runMatch && req.method === "POST") {
      try {
        return json(await scheduler.runNow(decodeURIComponent(runMatch[1])), 200, cors);
      } catch (e) {
        return opError(e, cors);
      }
    }
    return json({ error: `\u6CA1\u6709\u8FD9\u4E2A\u63A5\u53E3\uFF1A${path}` }, 404, cors);
  }
  async function serveIndex(req, url) {
    const nonce = randomBytes(16).toString("base64");
    const bootData = {
      token,
      theme: url.searchParams.get("theme") ?? "",
      tokens: url.searchParams.get("tokens") ?? ""
    };
    const lang = url.searchParams.get("lang") ?? "";
    if (/^[a-zA-Z-]{2,10}$/.test(lang))
      bootData.lang = lang;
    const boot = JSON.stringify(bootData).replaceAll("<", "\\u003c");
    let html;
    try {
      html = await readFile3(join3(uiDir, "index.html"), "utf8");
    } catch {
      html = "<!doctype html><title>\u7A97\u53E3\u9884\u70ED</title><p>\u754C\u9762\u8FD8\u6CA1\u6784\u5EFA\uFF1A\u5148\u5728\u5305\u76EE\u5F55\u8FD0\u884C bun run build\u3002</p>";
    }
    html = html.replace("</head>", `<script type="application/json" id="boot" nonce="${nonce}">${boot}</script>
</head>`);
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; ` + "connect-src 'self' http: https:; frame-ancestors *"
    };
    return new Response(req.method === "HEAD" ? null : html, { headers });
  }
  async function serveStatic(req, url, origin) {
    const cors = corsHeaders(origin);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: "\u65B9\u6CD5\u4E0D\u652F\u6301" }, 405, cors);
    }
    if (url.pathname === "/" || url.pathname === "/index.html")
      return serveIndex(req, url);
    const decoded = decodeURIComponent(url.pathname);
    const root = resolve2(uiDir);
    const file = resolve2(root, `.${decoded}`);
    if (!insideDir(root, file) || decoded.includes("..")) {
      return new Response("\u6CA1\u6709\u8FD9\u4E2A\u6587\u4EF6", { status: 404, headers: cors });
    }
    const asset = Bun.file(file);
    if (!await asset.exists())
      return new Response("\u6CA1\u6709\u8FD9\u4E2A\u6587\u4EF6", { status: 404, headers: cors });
    return new Response(asset, {
      headers: {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...cors
      }
    });
  }
  async function handle(req) {
    const url = new URL(req.url);
    const own = `127.0.0.1:${server.port}`;
    const host = (req.headers.get("host") ?? "").toLowerCase();
    if (host !== own && host !== `localhost:${server.port}`) {
      return new Response("\u53EA\u670D\u52A1\u4E8E\u672C\u673A\u9875\u9762", { status: 403 });
    }
    const origin = req.headers.get("origin");
    if (origin && origin !== "null" && !ownOrigins().includes(origin)) {
      return json({ error: "\u53EA\u670D\u52A1\u4E8E magpie \u7A97\u53E3\u91CC\u7684\u9875\u9762" }, 403, corsHeaders(origin));
    }
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (url.pathname.startsWith("/api/")) {
      if (!tokenOK(req.headers.get(TOKEN_HEADER))) {
        return json({ error: "\u53E3\u4EE4\u4E0D\u5BF9\uFF1A\u8BF7\u91CD\u65B0\u6253\u5F00\u7A97\u53E3\u9884\u70ED\u9875" }, 401, corsHeaders(origin));
      }
      return api(req, url, origin);
    }
    return serveStatic(req, url, origin);
  }
  return {
    port: server.port ?? 0,
    async stop() {
      if (stopped)
        return;
      stopped = true;
      scheduler?.stop();
      await scheduler?.flush();
      await lockRelease?.();
      server.stop(true);
    }
  };
}

// src/plugin.ts
var DEFAULT_PORT = 3492;
function defaultDir(env = process.env) {
  const custom = env.WINDOW_WARMUP_DIR?.trim();
  if (custom)
    return custom;
  return join4(xdgConfigHome(env), "magpie", "window-warmup");
}
var instances = new Map;
var plugin_default = {
  id: "magpie-window-warmup",
  server: async (_input, opts = {}) => {
    const port = Number(opts?.port);
    const listen = Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
    if (await alreadyServing(listen))
      return {};
    let instance = instances.get(listen);
    if (!instance) {
      instance = (async () => {
        const dir = defaultDir();
        await migrateLegacyState(dir);
        return startService({
          port: listen,
          dir,
          base: gatewayBase()
        });
      })().catch((e) => {
        instances.delete(listen);
        throw e;
      });
      instances.set(listen, instance);
    }
    await instance;
    return {};
  }
};
export {
  DEFAULT_PORT,
  plugin_default as default
};
