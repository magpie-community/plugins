// UsageWidget · @magpie-community/page-token-widget · MIT
// The Magpie plugin hands this script to the phone and fills PAIRED in.
// No credentials belong in this file.
// Widget parameter: a provider id for the small family (codex, minimax, glm),
// optionally "|used" to show consumed instead of remaining percent (glm|used),
// or "|remaining" to show what is left again.
// One account of a vendor is named codex@<account>; the vendor on its own
// means the first account of that vendor.
// On medium and large families "used" alone flips every card.
// Both families adapt to 1–6 subscriptions; "page=2|used" selects another page.
// Without a parameter the widget follows the choice of the plugin page (the
// "小组件" block there): remaining or used, and which card the small one shows.
const SETTINGS_KEY = "ameaq-rmrcxu-b2";
// The plugin replaces this line with the address of the service and a one-time
// pairing code the first time the script is downloaded.
let PAIRED = null;
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "usage-bridge-cache.json");
const family = ["small", "medium", "large"].includes(config.widgetFamily) ? config.widgetFamily : "medium";
// The name of this phone goes with the pairing, so the person at the computer
// can tell the phones apart when one of them is to be revoked.
function deviceName() {
  try {
    const name = String(Device.name() || "");
    if (name) return name.slice(0, 32);
  } catch {}
  return "iPhone";
}
// Screen points -> medium width, medium height, large height. These are widget
// bounds, not screen bounds. 402x874 uses the 349pt width from the iPhone capture.
function widgetDimensions() {
  const sizes = {
    "320x568": [292, 141, 311], "360x780": [329, 155, 345],
    "375x667": [322, 148, 324], "375x812": [329, 155, 345],
    "390x844": [338, 158, 354], "393x852": [338, 158, 354],
    "402x874": [349, 164, 366], "414x736": [348, 159, 357],
    "414x896": [360, 169, 379], "428x926": [364, 170, 382],
    "430x932": [364, 170, 382], "440x956": [364, 170, 382]
  };
  let bounds = [292, 141, 311];
  try {
    const screen = Device.screenSize();
    const short = Math.round(Math.min(screen.width, screen.height));
    const long = Math.round(Math.max(screen.width, screen.height));
    if (Number.isFinite(short) && short >= 320 && Number.isFinite(long)) {
      const width = Math.min(364, Math.floor(short * 0.84));
      bounds = sizes[short + "x" + long] || [width, Math.floor(width * 0.46), Math.floor(width * 1.05)];
    }
  } catch {}
  return { width: bounds[0], height: family === "large" ? bounds[2] : bounds[1] };
}
const dimensions = widgetDimensions();
const layout = {
  side: 16, vertical: family === "medium" && dimensions.height < 155 ? 12 : 14,
  width: dimensions.width - 32, header: 20, footer: family === "large" ? 30 : 13,
  columnGap: family === "large" ? 16 : 10
};
const dark = Device.isUsingDarkAppearance();
const colors = {
  bg: Color.dynamic(new Color("#ffffff"), new Color("#1f221e")),
  text: Color.dynamic(new Color("#232523"), new Color("#ebeee7")),
  muted: Color.dynamic(new Color("#8a8f85"), new Color("#92998d")),
  track: dark ? new Color("#30362d") : new Color("#eef0eb"),
  // Ink in both appearances. A bright bar in the night mode was read as a
  // warning, and a warning that really means "plenty left" turns the reading
  // of the whole card upside down.
  fill: dark ? new Color("#8b9384") : new Color("#6b7268"),
  warning: new Color(dark ? "#d2a061" : "#b77c36"),
  critical: new Color(dark ? "#e09c88" : "#b35447")
};
const widget = new ListWidget();
widget.backgroundColor = colors.bg;
widget.setPadding(family === "small" ? 14 : layout.vertical, 16, family === "small" ? 14 : layout.vertical, 16);
widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
let settings, data, cached = false, failure = "";
try { settings = JSON.parse(Keychain.get(SETTINGS_KEY)); } catch {}
// A token the service does not know is taken out of the keychain. The phone
// is then unpaired, and it stays that way until it is paired once more — so
// the reason is written down and shown on every refresh, not only on the one
// that heard the 401.
if (settings && settings.pairingNeeded) failure = "令牌无效，请重新配对";
const storedToken = settings && settings.token ? String(settings.token) : "";
const serviceURL = (settings && settings.baseURL) || (PAIRED && PAIRED.baseURL) || "";
// A phone that is going away takes its own row off the list of the devices.
// The token of the row is the only thing that is asked for, and a token that
// has been revoked is enough: the row is dead anyway.
async function forgetToken(token, baseURL) {
  if (!token || !baseURL) return false;
  try {
    const request = new Request(baseURL + "/api/v1/device/forget");
    request.method = "POST";
    request.headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    request.body = "{}";
    request.timeoutInterval = 8;
    const answer = await request.loadJSON();
    return !!(answer && answer.forgotten);
  } catch {
    return false;
  }
}
// The service puts its name on every answer that refuses a token. A phone
// that reads it knows the refusal came from the service and not from
// something that stands in front of it, so a good token is not thrown away
// because a proxy wanted a password of its own.
function refusalIsOurs(response) {
  if (!response || !response.headers) return false;
  const headers = response.headers;
  const name = Object.keys(headers).find(key => String(key).toLowerCase() === "x-token-widget-service");
  return name ? String(headers[name]) === "@magpie-community/page-token-widget" : false;
}
// A script that came from the plugin carries a one-time code. The code is
// exchanged for the token of the service, which is then kept in the keychain.
// A new code is tried before the token that is already in the keychain: a
// token that the service does not know any more would otherwise block the
// way back in, and reading the code again would not help. When the exchange
// does not work, the token that is there is used as it was.
if (PAIRED && PAIRED.code && (!storedToken || (settings.code || "") !== PAIRED.code)) {
  let exchanged = "";
  let codeIsSpent = false;
  try {
    const request = new Request(PAIRED.baseURL + "/api/v1/session");
    request.method = "POST";
    request.headers = { "Content-Type": "application/json" };
    request.body = JSON.stringify({ code: PAIRED.code, name: deviceName() });
    request.timeoutInterval = 12;
    const session = await request.loadJSON();
    if (session && session.token) exchanged = String(session.token);
  } catch (error) {
    // A code that is refused for good (it is stale, or it has been used) is
    // not tried again on every refresh. A network that did not answer is not
    // the code's fault, so the code is tried again the next time.
    const reason = String((error && error.message) || "");
    const said = reason.match(/status\s*(\d{3})/i);
    const status = (error && error.response && Number(error.response.statusCode))
      || (said ? Number(said[1]) : 0);
    codeIsSpent = status === 400 || status === 404 || status === 409 || status === 410;
  }
  if (exchanged) {
    // The new token is put away first. If the phone is closed while the old
    // row is being cleaned up, the token is still there when the phone comes
    // back — a code that has been used cannot be used a second time.
    settings = { baseURL: PAIRED.baseURL, token: exchanged, code: PAIRED.code, pairingNeeded: false };
    try { Keychain.set(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
    // The old token has served its time. Its row is taken off the list, so
    // the phone does not leave a shadow behind.
    if (storedToken) await forgetToken(storedToken, PAIRED.baseURL);
  } else {
    // The code did not work. A code that is spent is written down so it is
    // not tried again on every refresh; a code that only failed because the
    // service did not answer is left alone, so it gets another chance. A new
    // script with a new code comes in when the phone is paired once more.
    settings = {
      baseURL: (settings && settings.baseURL) || PAIRED.baseURL,
      token: storedToken,
      code: codeIsSpent ? PAIRED.code : ((settings && settings.code) || ""),
      pairingNeeded: !!(settings && settings.pairingNeeded)
    };
    try { Keychain.set(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }
}
try { if (fm.fileExists(cachePath)) data = JSON.parse(fm.readString(cachePath)); } catch {}
if (settings && settings.baseURL && settings.token) {
  // The request lives outside the try: the catch has to be able to look at
  // the response it left behind.
  let req = null;
  try {
    req = new Request(settings.baseURL + "/api/v1/overview");
    req.headers = { Authorization: "Bearer " + settings.token };
    req.timeoutInterval = 10;
    const fresh = await req.loadJSON();
    if (fresh.schemaVersion !== 1) throw new Error("数据格式不兼容");
    data = fresh;
    try { fm.writeString(cachePath, JSON.stringify(data)); } catch {}
  } catch (error) {
    cached = true;
    // The reason is told apart: a token the service does not know, a service
    // that answers with an error, a service that does not answer at all. One
    // "离线缓存" for all three told the user nothing.
    const reason = String((error && error.message) || "");
    // Scriptable does not always hang the response on the error, so the
    // status is read from the request (the documented place), from the error
    // (when it is there) and from the message ("The server returned status 401").
    const said = /status\s*(\d{3})/i.exec(reason);
    const status = (req.response && Number(req.response.statusCode))
      || (error && error.response && Number(error.response.statusCode))
      || (said ? Number(said[1]) : 0);
    if (status === 401) {
      if (refusalIsOurs(req.response) || refusalIsOurs(error && error.response)) {
        // The service does not know this token any more. It is taken out of the
        // keychain, the row it belonged to is taken off the list of the
        // devices, and the phone is told to be paired once more.
        const dead = settings.token;
        settings = { baseURL: settings.baseURL, token: "", code: "", pairingNeeded: true };
        try { Keychain.set(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
        await forgetToken(dead, settings.baseURL);
        failure = "令牌无效，请重新配对";
      } else {
        // The refusal did not come from the service. Something in front of it
        // does not know the token, and the token may still be good.
        failure = "服务返回 401";
      }
    } else {
      failure = status ? "服务返回 " + status
        : /timed out|timeout|超时/i.test(reason) ? "服务没有回答"
        : "连不上服务";
    }
  }
}
// The tap opens the usage page even when this phone is not paired any more,
// so that the page can ask for a token again.
if (settings && settings.baseURL) {
  widget.url = settings.baseURL + (settings.token ? "/#token=" + encodeURIComponent(settings.token) : "/");
}
function text(parent, value, size, color, weight) {
  const element = parent.addText(String(value));
  element.font = weight === "medium" ? Font.mediumSystemFont(size) : Font.systemFont(size);
  element.textColor = color || colors.text;
  element.lineLimit = 1;
  element.minimumScaleFactor = family === "small" ? 0.7 : 0.9;
  return element;
}
// The height of a line of a card. A Scriptable line is about 1.2 times its
// font size; a little more is kept, so that a letter with a long tail is not
// cut off.
const LINE_HEIGHT = 1.25;
// A line of a card with a height of its own. The height of a text is decided
// by the letters it holds — a name that is scaled down to fit, a line that
// holds nothing but a space — and a card whose line is shorter than the one
// next to it puts its bar a little higher or lower than the others. A line
// with a fixed height keeps every bar of a row on one level.
function line(parent, size, width) {
  const row = parent.addStack();
  row.size = new Size(width, Math.round(size * LINE_HEIGHT));
  return row;
}
function compact(value) {
  if (value == null) return "—";
  if (value >= 1e9) return (value / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(value));
}
// The width of a name in the system font, as a multiple of its size: the
// Chinese characters are full width, the Latin ones differ by their letter.
function nameWidth(value) {
  return [...String(value)].reduce((sum, char) => sum + (
    char.codePointAt(0) >= 0x2e80 ? 1 : /[MW%]/.test(char) ? 0.85 :
      /[il: .·]/.test(char) ? 0.28 : /\d/.test(char) ? 0.58 : 0.56
  ), 0);
}
// The name of a card is shown in full: it takes the size that fits its cell.
// A name that does not fit even at the smallest size is shortened, and the
// full name stays in the dashboard.
const minimumScale = family === "small" ? 0.7 : 0.9;
function fitName(value, size, width) {
  const label = String(value);
  const em = nameWidth(label);
  return { size: em > 0 ? Math.max(7, Math.min(size, Math.floor(width / em / minimumScale * 10) / 10)) : size, label };
}
function shortenName(label, size, width) {
  if (nameWidth(label) * size * minimumScale <= width) return label;
  let keep = label.length;
  while (keep > 1 && nameWidth(label.slice(0, keep) + "…") * size * minimumScale > width) keep--;
  return label.slice(0, keep) + "…";
}
// The word in front of every number. Without it the bar and the number can
// be read the wrong way round, and the night mode makes that worse.
function direction() { return showUsed ? "已用" : "剩余"; }
// The name of a card is the name of the vendor and, when it has one, the
// account of it.
function splitLabel(label) {
  const parts = String(label).split("·").map(part => part.trim()).filter(Boolean);
  return { vendor: parts[0] || String(label), account: parts.slice(1).join(" · ") };
}
function expired(window) {
  return window.expired || !!window.resetsAt && Date.parse(window.resetsAt) <= Date.now();
}
// The reset of a window is read in one place, so the full text and the short
// one can never disagree about an unknown or an elapsed time.
function parseReset(window) {
  if (expired(window)) return { state: "expired" };
  if (!window.resetsAt) return { state: "unknown" };
  const at = Date.parse(window.resetsAt);
  if (!Number.isFinite(at)) return { state: "unknown" };
  return { state: "known", minutes: Math.ceil((at - Date.now()) / 60000) };
}
// Both directions read the same vendor percentage; only the view changes.
function value(window) {
  if (expired(window)) return null;
  return showUsed ? window.usedPercent : window.remainingPercent;
}
function percent(window) { const current = value(window); return current == null ? "—" : Math.round(current) + "%"; }
function accent(window) {
  const current = value(window);
  if (current == null) return colors.muted;
  const consumed = showUsed ? current : 100 - current;
  return consumed >= 90 ? colors.critical : consumed >= 75 ? colors.warning : colors.text;
}
function reset(window) {
  const parsed = parseReset(window);
  if (parsed.state === "expired") return "已到期· 待更新";
  if (parsed.state === "unknown") return "重置时间未知";
  const mins = parsed.minutes;
  if (mins < 60) return mins + " 分钟后重置";
  if (mins < 1440) return Math.floor(mins / 60) + "时 " + mins % 60 + "分后重置";
  return Math.floor(mins / 1440) + "天 " + Math.floor(mins % 1440 / 60) + "时后重置";
}
function shortReset(window) {
  const parsed = parseReset(window);
  if (parsed.state === "expired") return "待更新";
  if (parsed.state === "unknown") return "时间未知";
  const mins = parsed.minutes;
  if (mins < 60) return mins + "分";
  if (mins < 1440) return Math.floor(mins / 60) + "时" + String(mins % 60).padStart(2, "0") + "分";
  return Math.floor(mins / 1440) + "天" + Math.floor(mins % 1440 / 60) + "时";
}
// The name of a window comes from the provider: "5 hours", "4 hours", "7
// days", or something of its own. The unit is written the same way for every
// provider: h for hours, d for days. The number is kept when there is one.
function windowUnit(label) {
  const text = String(label || "");
  const hours = /^\s*(\d+(?:\.\d+)?)?\s*(?:hours?|hrs?|h)(?![a-z])/i.exec(text);
  if (hours) return (hours[1] ? hours[1] : "") + "h";
  const days = /^\s*(\d+(?:\.\d+)?)?\s*(?:days?|d)(?![a-z])/i.exec(text);
  if (days) return (days[1] ? days[1] : "") + "d";
  if (/week/i.test(text)) return "7d";
  if (/month/i.test(text)) return "30d";
  return text;
}
function windowLabel(window) {
  return windowUnit(window.label);
}
function clock(value) {
  if (!value) return "未更新";
  return new Date(value).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
}
function bar(parent, window, width) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, 4); ctx.opaque = false; ctx.respectScreenScale = true;
  ctx.setFillColor(colors.track); ctx.fillRect(new Rect(0, 0, width, 4));
  const current = value(window);
  if (current != null) {
    const consumed = showUsed ? current : 100 - current;
    ctx.setFillColor(consumed >= 90 ? colors.critical : consumed >= 75 ? colors.warning : colors.fill);
    ctx.fillRect(new Rect(0, 0, width * Math.max(0, Math.min(100, current)) / 100, 4));
  }
  const image = parent.addImage(ctx.getImage()); image.imageSize = new Size(width, 4);
}
function header(status) {
  const row = widget.addStack(); row.centerAlignContent();
  if (family !== "small") row.size = new Size(layout.width, layout.header);
  text(row, "usage.", 12, colors.muted, "medium"); row.addSpacer();
  text(row, status, 9, cached ? colors.warning : colors.muted);
}
// The parameter is read once: a subscription to show, a page and a direction.
// The case of an account is kept: two accounts of one vendor may differ in
// nothing but their case.
const parameter = String(args.widgetParameter || "").split("|").map(part => part.trim()).filter(Boolean);
const pageParts = parameter.filter(part => /^page=/i.test(part));
const rawSelectors = parameter.filter(part => part.toLowerCase() !== "used" && part.toLowerCase() !== "remaining" && !/^page=/i.test(part));
// A token is not a subscription. Somebody who has just copied a read-only
// token pastes it into the parameter sometimes; the answer "没有找到 <a long
// string>" does not say what went wrong. A long, silent, single word is a
// token far more often than it is a subscription, so it is said out loud and
// the parameter is dropped.
const looksLikeToken = rawSelectors.some(part => /^[A-Za-z0-9_-]{32,}$/.test(part));
const selectors = looksLikeToken ? [] : rawSelectors;
// The plugin side says what the widget shows: the direction of the numbers
// and the card of the small family. The parameter may still say otherwise,
// so one widget can differ from the others.
const plugin = data && data.display ? data.display : {};
const wantsUsed = parameter.some(part => part.toLowerCase() === "used");
const wantsRemaining = parameter.some(part => part.toLowerCase() === "remaining");
const showUsed = wantsUsed || (!wantsRemaining && plugin.widgetMode === "used");
const chosen = selectors[0] || plugin.widgetCard || "";
const requested = chosen || "codex";
const emptyWindow = { label: "Quota", remainingPercent: null, usedPercent: null, resetsAt: null };
function subscriptionGrid(parent, cards, sharedWindow) {
  const large = family === "large";
  if (!cards.length) return;
  const columns = large ? Math.min(2, cards.length) : cards.length > 4 ? 3 : cards.length;
  const rows = Math.ceil(cards.length / columns);
  const dense = large ? rows === 3 : rows === 2;
  const cellWidth = (layout.width - layout.columnGap * (columns - 1)) / columns;
  const tight = large ? dimensions.height < 345 : dimensions.height < 155;
  // A cell that has several accounts of one vendor carries a longer name, so a
  // narrow cell takes a smaller title font to keep the account readable.
  // The account of a card needs a line of its own; the weekly limit needs
  // one too. Where there is no room for them, they are left out.
  const style = large
    ? dense
      ? { name: tight ? 11 : 12, value: tight ? 20 : 24, reset: 8, secondary: 8, account: 9, titleGap: 2, barGap: 3, resetGap: 3, rowGap: 8 }
      : { name: 13, value: 34, reset: 10, secondary: 10, account: 9, titleGap: 4, barGap: 6, resetGap: 5, rowGap: 16 }
    : dense
      ? { name: tight ? 10 : 11, value: tight ? 18 : 20, titleGap: 1, barGap: 1, resetGap: 3, rowGap: tight ? 4 : 6, account: 0, secondary: 0, reset: 9 }
      // The medium family gives every card two lines of a title and two lines
      // under the bar. The smallest medium widget has 84 points for a card,
      // and the lines are made smaller there so that they fit: a card that is
      // cut off says less than a card with smaller writing.
      : {
          name: tight ? 11 : 12,
          value: tight ? 21 : (cellWidth < 67 ? 22 : 23),
          reset: tight ? 8 : 9,
          secondary: tight ? 8 : 9,
          account: tight ? 8 : 9,
          titleGap: tight ? 2 : 3,
          barGap: tight ? 4 : 5,
          resetGap: tight ? 2 : 3,
          rowGap: 0
        };
  const grid = parent.addStack(); grid.layoutVertically(); grid.size = new Size(layout.width, 0);
  // The account of a card needs a line of its own. When any card of the page
  // has one, every card gets that line (an empty one where it is not needed),
  // so the bars of the cards sit on one line; when no card has one, the line
  // is not given away at all — the smallest medium widget has 84 points for a
  // card, and every point is needed there.
  const reserveAccountLine = !dense && style.account > 0 && cards.some(card => splitLabel(card.label).account);
  // Every name of the page takes the size that fits the narrowest of them, so
  // the cards keep one title size.
  // The dense large family has no line of its own for the account, so it
  // goes with the name of the vendor.
  const titleText = card => large && dense ? card.label : splitLabel(card.label).vendor;
  const names = cards.map(card => fitName(titleText(card), style.name, cellWidth));
  const nameSize = names.length ? Math.min(...names.map(name => name.size)) : style.name;
  for (let start = 0; start < cards.length; start += columns) {
    if (start) grid.addSpacer(style.rowGap);
    const row = grid.addStack(); row.topAlignContent();
    for (let index = 0; index < columns; index++) {
      if (index) row.addSpacer(layout.columnGap);
      const column = row.addStack(); column.layoutVertically(); column.size = new Size(cellWidth, 0);
      const card = cards[start + index];
      if (!card) continue; // Keep the final card aligned with the previous rows.
      const primary = card.windows[0] || emptyWindow;
      // The name of the vendor is the name of the card; the account of it goes
      // under it when there is a line for it.
      const parts = splitLabel(card.label);
      const inline = large && dense && parts.account;
      const accountSize = Math.max(7, Math.min(style.account || 9, nameSize - 3));
      const vendor = inline ? parts.vendor + " · " + parts.account : parts.vendor;
      // The line of the name has the same height for every card of the row.
      // In the dense large family the name of a card that has an account goes
      // with the account and is written smaller, but the line of it stays as
      // tall as the others, so the bars of the row sit on one line.
      const titleSize = large && dense ? nameSize : (inline ? accountSize : nameSize);
      const titleRow = line(column, titleSize, cellWidth);
      text(titleRow, shortenName(vendor, inline ? accountSize : nameSize, cellWidth), inline ? accountSize : nameSize, colors.text, "medium");
      if (parts.account && style.account && !inline) {
        const accountRow = line(column, accountSize, cellWidth);
        text(accountRow, shortenName(parts.account, accountSize, cellWidth), accountSize, colors.muted);
      } else if (reserveAccountLine) {
        // The medium family gives every card the same two lines of a title:
        // a card without an account keeps the line of the account empty, so
        // the bars of the cards sit on one line and can be read side by side.
        // The line has a height of its own, so it does not matter how the
        // phone measures the space inside it.
        const emptyRow = line(column, accountSize, cellWidth);
        text(emptyRow, " ", accountSize, colors.muted);
      }
      column.addSpacer(style.titleGap);
      const valueRow = line(column, style.value, cellWidth);
      // A narrow cell has no room for the whole word, and the footer of the
      // widget says which way the numbers are read.
      const word = large || cellWidth >= 78 ? direction() : (showUsed ? "用" : "剩");
      text(valueRow, word, large ? 12 : 9, colors.muted);
      valueRow.addSpacer(2);
      text(valueRow, percent(primary), style.value, accent(primary), "medium");
      if (!large && dense && !sharedWindow) {
        valueRow.addSpacer(); text(valueRow, windowLabel(primary), 8, colors.muted);
      }
      column.addSpacer(style.barGap);
      bar(column, primary, cellWidth);
      const secondary = card.windows[1];
      if (large) {
        if (!dense) {
          column.addSpacer(style.resetGap);
          const label = (sharedWindow ? "" : windowLabel(primary) + " · ") + shortReset(primary);
          const size = sharedWindow ? style.reset : Math.min(style.reset, cellWidth < 64 ? 8 : 9);
          text(column, label, size, colors.muted);
        }
        // The second window is the weekly limit. The large family has a line
        // of its own for it.
        if (secondary) {
          column.addSpacer(dense ? 2 : 3);
          text(column, windowLabel(secondary) + (showUsed ? " 已用 " : " 剩余 ") + percent(secondary), style.secondary, accent(secondary));
        }
      } else if (!dense) {
        // The medium family has one line for the reset and one line for the
        // weekly limit. Both of them are short, but together they do not fit
        // on one line: cut short, the time of the reset is the first thing to
        // go, and the weekly share is the second.
        column.addSpacer(style.resetGap);
        const size = Math.min(style.reset, cellWidth < 64 ? 8 : 9);
        const first = (sharedWindow ? "" : windowLabel(primary) + " · ") + shortReset(primary);
        text(column, shortenName(first, size, cellWidth), size, colors.muted);
        if (secondary && style.secondary) {
          column.addSpacer(1);
          const weekly = windowLabel(secondary) + " " + percent(secondary);
          text(column, shortenName(weekly, style.secondary, cellWidth), style.secondary, accent(secondary));
        }
      }
    }
  }
}
// A phone whose token was taken away is not paired any more, and it says so
// on every refresh — a widget that goes on showing the last numbers looks
// healthy while the service has long stopped answering it.
if (!settings || !settings.token || !data || data.schemaVersion !== 1) {
  header(failure || "未连接"); widget.addSpacer(18);
  text(widget, settings && settings.pairingNeeded ? "需要重新配对" : (settings ? "暂时无法连接" : "先连接你的用量"), 16, colors.text, "medium");
  widget.addSpacer(8);
  // Without a cached reading there is nothing else to show, so the reason (a
  // token the service does not know, a service that answers with an error, a
  // service that does not answer) is the most useful thing here.
  const hint = text(widget, failure || (settings ? "检查 PC 与 Tailscale，稍后重试。" : "在 Magpie 的插件页重新配对。"), 11, colors.muted);
  hint.lineLimit = 3; widget.addSpacer();
} else {
  const observations = Object.values(data.sources).map(s => s.observedAt).filter(Boolean).sort();
  const day = value => new Date(value + 8 * 3600000).toISOString().slice(0, 10);
  if (data.sources.today.outdated || data.sources.today.observedAt && day(Date.parse(data.sources.today.observedAt)) !== day(Date.now())) {
    // A reading of another day is not the usage of today: neither the total
    // nor the numbers of the cards may be shown as if they were today's.
    data.usage.today = null;
    for (const card of data.subscriptions || []) if (card) card.usage = null;
  }
  cached = cached || Object.values(data.sources).some(s => s.state !== "ok") || data.subscriptions.some(c => c.stale) || observations.some(s => Date.now() - Date.parse(s) > 180000);
  const status = failure || (cached ? "缓存 " : "") + clock(observations[0]);
  if (family === "small") {
    header(status);
    // A parameter may name one account of a vendor (codex@alice) or the
    // vendor itself, which then means its first account. The id is matched as
    // it is written: two accounts of one vendor may differ in their case only.
    // Without a word from the user the widget follows the first card that has
    // a number for today: an account the gateway did not report today has no
    // number, and a dash is a poor answer to "how much today".
    const cards = data.subscriptions || [];
    const exact = chosen ? cards.find(c => c.id === chosen) : null;
    const same = chosen ? cards.filter(c => String(c.id).toLowerCase() === chosen.toLowerCase()) : [];
    // A vendor is matched before an account: an account of another vendor
    // may carry the name of this one.
    const byProvider = chosen ? cards.find(c => c.provider === chosen.toLowerCase()) : null;
    const byAccount = chosen ? cards.find(c => String(c.account || "").toLowerCase() === chosen.toLowerCase()) : null;
    const found = exact || (same.length === 1 ? same[0] : null) || byProvider || byAccount;
    // The account of a card can be renamed; an old parameter then finds
    // nothing. The first card is shown instead, and the note says so.
    const card = found || cards.find(c => c && c.usage && c.usage.today) || cards[0];
    const missing = Boolean(chosen) && !found && Boolean(card);
    widget.addSpacer(12);
    const primary = card && card.windows[0] || emptyWindow;
    const name = widget.addStack();
    const title = fitName(card ? card.label : "暂无该套餐", 12, layout.width - 60);
    text(name, title.label, title.size, colors.text, "medium");
    name.addSpacer(4);
    if (missing || looksLikeToken) {
      // The note is shortened to the room that is left, so the name of the
      // card and the note never fight for the same line.
      text(name, shortenName(looksLikeToken ? "参数里的是令牌：令牌不填在参数里" : "没有找到 " + requested, 8, Math.max(60, layout.width * 0.42)), 8, colors.warning);
    }
    else text(name, windowLabel(primary), 9, colors.muted);
    widget.addSpacer(3);
    const value = widget.addStack(); value.centerAlignContent();
    text(value, direction(), 13, colors.muted);
    value.addSpacer(4);
    text(value, percent(primary), 34, accent(primary), "medium");
    widget.addSpacer(7); bar(widget, primary, 120); widget.addSpacer(7);
    text(widget, reset(primary), 9, colors.muted);
    if (card && card.windows[1]) {
      widget.addSpacer(3); text(widget, windowLabel(card.windows[1]) + (showUsed ? " 已用 " : " 剩余 ") + percent(card.windows[1]), 9, colors.muted);
    }
    widget.addSpacer();
    // The tokens of the subscription this widget shows, not the total of all.
    // A subscription that is not on screen has no tokens of its own to show.
    const own = card && card.usage && card.usage.today;
    const tokens = own ? own.totalTokens : null;
    text(widget, "今日 " + (tokens == null ? "—" : compact(tokens)) + " token", 10, colors.muted);
  } else {
    // Preserve service order and every independent account; page only on the phone.
    const all = data.subscriptions || [];
    const pages = Math.max(1, Math.ceil(all.length / 6));
    const pageToken = pageParts[0] || "page=1";
    const rawPage = pageToken.slice(5);
    const pageNumber = /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
    const page = Number.isSafeInteger(pageNumber) && pageNumber > 0 ? Math.min(pageNumber, pages) : 1;
    const shown = all.slice((page - 1) * 6, page * 6);
    const windows = shown.map(card => windowLabel(card.windows[0] || emptyWindow));
    const sharedWindow = windows.length && windows.every(label => label === windows[0]) ? windows[0] : "";
    const direction = (showUsed ? "已用" : "剩余") + (sharedWindow ? " · " + sharedWindow : "额度");
    header((pages > 1 ? page + "/" + pages + "页 · " : "") + status);
    const body = widget.addStack(); body.layoutVertically();
    body.size = new Size(layout.width, dimensions.height - 2 * layout.vertical - layout.header - layout.footer);
    body.addSpacer();
    if (!shown.length) text(body, "暂无套餐", 13, colors.muted, "medium");
    else subscriptionGrid(body, shown, sharedWindow);
    body.addSpacer();
    if (family === "medium") {
      const foot = widget.addStack();
      foot.size = new Size(layout.width, layout.footer);
      text(foot, "今日 " + compact(data.usage.today && data.usage.today.totalTokens) + " Token", 9, colors.muted);
      foot.addSpacer();
      text(foot, looksLikeToken ? "参数里的令牌已忽略" : direction, 9, looksLikeToken ? colors.warning : colors.muted);
    } else {
      const foot = widget.addStack(); foot.layoutVertically(); foot.size = new Size(layout.width, layout.footer);
      const totals = foot.addStack();
      text(totals, "今日 " + compact(data.usage.today && data.usage.today.totalTokens), 11, colors.text, "medium");
      totals.addSpacer();
      text(totals, "近七日 " + compact(data.usage.week && data.usage.week.totalTokens), 11, colors.muted);
      foot.addSpacer(4);
      text(foot, looksLikeToken ? "参数里的令牌已忽略 · Token 含缓存" : direction + " · Token 含缓存", 8, looksLikeToken ? colors.warning : colors.muted);
    }
  }
}
Script.setWidget(widget);
if (!config.runsInWidget) {
  if (family === "small") await widget.presentSmall();
  else if (family === "large") await widget.presentLarge();
  else await widget.presentMedium();
}
Script.complete();
