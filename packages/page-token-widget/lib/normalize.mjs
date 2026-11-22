// The vendors the widget knows by heart: the id Magpie uses, the family they
// belong to, the name a card carries and the plan it shows.
//
// A vendor that is not written down here is not refused. It is a vendor of its
// own, and the name Magpie gives it is the name its card carries. A vendor
// that is added to Magpie tomorrow therefore shows up without a new release
// of this plugin: the list of vendors is read from the gateway, not from a
// table that is written down here.
const KNOWN_PROVIDERS = new Map([
  ['codex', { id: 'codex', label: 'Codex', plan: 'ChatGPT' }],
  ['minimax-cn', { id: 'minimax', label: 'MiniMax', plan: 'Coding Plan' }],
  ['minimax', { id: 'minimax', label: 'MiniMax', plan: 'Coding Plan' }],
  ['zhipu', { id: 'glm', label: 'GLM', plan: 'Coding Plan' }],
]);
// Canonical display order of the known subscription families.
const PROVIDER_ORDER = ['codex', 'minimax', 'glm'];
// A provider id is a short name in lower case. Anything else is not a
// provider and is not shown. A dot and an underscore are part of a name
// like any other letter, so a vendor whose id carries one is a vendor like
// any other.
const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,19}$/;
// The name of a vendor as the plugin knows it. A name that is not written
// down is not looked for on the prototype either: the table is read with
// "hasOwn", so a vendor called "constructor" is a vendor like any other.
const providerLabel = id => (Object.hasOwn(PROVIDER_LABELS, id) ? PROVIDER_LABELS[id] : '');
// The name Magpie itself gives a vendor ("Zhipu GLM", "MiniMax (China)").
// The component says the same name, so that the software and the widget are
// one thing and not two. It is text of the upstream, so it is cleaned before
// it is shown: the separator of the label ("·") would cut the name in two, a
// name that is too long is not a name, and control characters have no place
// in one.
const vendorName = value => {
  const text = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!text || text.length > 40 || text.includes('·')) return '';
  return text;
};
// The family an upstream provider id belongs to, or null when it is not a
// provider at all. A vendor that is not written down above is a family of its
// own, named by its own id.
export const providerFamily = id => {
  const text = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (!text) return null;
  const known = KNOWN_PROVIDERS.get(text);
  if (known) return known.id;
  return PROVIDER_ID.test(text) ? text : null;
};
// What a card of a vendor shows: the family, the name and the plan. A vendor
// that is not known by heart has no plan of its own; the plan the gateway
// sends is used when it is a plain word.
const providerOf = id => {
  const text = typeof id === 'string' ? id.trim().toLowerCase() : '';
  const known = KNOWN_PROVIDERS.get(text);
  if (known) return known;
  const family = providerFamily(text);
  return family ? { id: family, label: providerLabel(family) || family, plan: '' } : null;
};
export const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
export const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
// Labels are typed metadata, never arbitrary upstream text.
const plans = /^(?:ChatGPT|Coding Plan|Free|Go|Plus|Pro|Team|Business|Enterprise|Starter|Lite|Basic|Standard|Max|Ultra)$/i;
// A vendor may name its plan in its own words ("personal_professional",
// "Pro Plan"). The name is shown as it is, as long as it is a plain line of
// letters, digits, spaces, dots and underscores: it is a label, never a text
// of the upstream.
const planWord = /^[A-Za-z][A-Za-z0-9 ._-]{0,31}$/;
const windows = /^(?:\d{1,3}\s*(?:h|hours?|d|days?|minutes?|weeks?|months?|小时|天|周|月)|weekly|daily|monthly|yearly|tokens?|requests?|search|mcp|total)$/i;
// A window of a provider that is not a span of time has a name of its own:
// the image quota of Codex is one of them. The name is written in the
// language of the person who reads it, and a name that is not known keeps
// the plain "Quota", so that no word of the provider reaches the phone as
// it is. The table is a Map and not an object: a window called "constructor"
// is a name like any other, and it must not find something on the prototype.
const NAMED_WINDOWS = new Map([['image generation', '图片生成']]);
// The name we wrote ourselves comes back on the way out of the cache: a
// stored reading is fed in again with the name it was stored under, and the
// name of ours stays the name of ours.
const OWN_WINDOW_NAMES = new Set(NAMED_WINDOWS.values());
// A window that has no name of its own is called "Quota". Several of them on
// one card are numbered, so that they can be told apart. The number is ours,
// and it comes back out of the cache as the name it was stored under.
const OWN_NUMBERED_WINDOW = /^Quota [1-9]\d*$/;
const windowLabel = name => {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return 'Quota';
  if (windows.test(text) || OWN_WINDOW_NAMES.has(text) || OWN_NUMBERED_WINDOW.test(text)) return text;
  return NAMED_WINDOWS.get(text.toLowerCase()) || 'Quota';
};
// Several windows of one card can carry the same plain name, for instance
// when a vendor has three kinds of credits and calls them all the same.
// They are numbered in the order they come, so that the bars can be read
// one after another.
const numberPlainWindows = list => {
  const plain = list.filter(window => window.label === 'Quota').length;
  if (plain < 2) return list;
  let index = 0;
  return list.map(window => {
    if (window.label !== 'Quota') return window;
    index += 1;
    return { ...window, label: 'Quota ' + index };
  });
};
const modelFamily = /^(?:gpt[-.]?\d|o[1-9](?:-|$)|codex(?:-|$)|claude[-.](?:opus|sonnet|haiku|\d)|minimax-m\d|glm[-.]?\d|gemini[-.]?\d|qwen\d|deepseek[-.]?(?:v\d|r\d|chat|reasoner)|kimi[-.]?(?:k\d|latest)|grok[-.]?\d|mistral[-.]|llama[-.]?\d)/i;
// Keys are stable upstream ids. The display name is registered as an alias as well,
// so re-normalizing a stored label returns the same label instead of "Unknown"
const PROVIDER_LABELS = {
  codex: 'Codex', 'minimax-cn': 'MiniMax', minimax: 'MiniMax', zhipu: 'GLM', glm: 'GLM',
  zcode: 'ZCode', gemini: 'Gemini', 'session-unknown': '本地会话',
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek',
  qwen: 'Qwen', kimi: 'Kimi', moonshot: 'Moonshot', ollama: 'Ollama',
};
const providerNames = new Map();
for (const [id, label] of Object.entries(PROVIDER_LABELS)) {
  providerNames.set(id, label);
  providerNames.set(label.toLowerCase(), label);
}
// The name of a vendor: the one that is written down here, or the one that
// Magpie gives it. A vendor that is not written down keeps the name of the
// software, so that the ranking and the card of a subscription say the same
// thing. A name that is neither keeps the id of the vendor: an id is a name
// like any other, and "Unknown" says less than the name does.
const providerLabelOf = (value, names = {}) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'Unknown';
  const known = providerNames.get(text.toLowerCase());
  if (known) return known;
  const given = names[text.toLowerCase()];
  if (given) return given;
  return PROVIDER_ID.test(text) ? text : 'Unknown';
};
// Agents are identified by a stable upstream id (claude, codex, gemini-cli...);
// the id is registered as its own alias so stored labels survive restarts.
// The list is every agent Magpie knows (its internal/agent registry), so an
// agent Magpie adds later is still shown, by its id, until this map grows.
const AGENT_LABELS = {
  agy: 'Antigravity CLI', aionui: 'AionUi', air: 'JetBrains Air', 'air-ide': 'Air (JetBrains IDEs)',
  alma: 'Alma', ante: 'Ante', antigravity: 'Antigravity', aside: 'Aside', astrbot: 'AstrBot',
  atomcode: 'AtomCode', cherrystudio: 'Cherry Studio', cindy: 'Cindy', claude: 'Claude Code',
  'claude-desktop': 'Claude Desktop', 'claude-science': 'Claude Science', cline: 'Cline',
  codebuddy: 'CodeBuddy', codex: 'Codex', commandcode: 'Command Code', copilot: 'Copilot CLI',
  'copilot-jetbrains': 'Copilot (JetBrains)', crush: 'Crush', curl: 'curl', cursor: 'Cursor CLI',
  'cursor-local': 'Cursor Private Inference', deveco: 'DevEco Code', devin: 'Devin', droid: 'Droid',
  'ds-bot': 'DS Bot', dsh: 'DeepSeek Harness', empryo: 'Empryo', fx: 'fx', gemini: 'Gemini CLI',
  'gemini-cli': 'Gemini CLI', goose: 'Goose', grok: 'Grok Build', 'grok-app': 'Grok App',
  hanako: 'OpenHanako', hermes: 'Hermes Agent', jcode: 'jcode', kimi: 'Kimi Code',
  'kimi-code-desktop': 'Kimi Code Desktop', kirocrew: 'Kiro Crew', liveagent: 'LiveAgent',
  lody: 'Lody', magpie: 'magpie', mimocode: 'MiMo Code', 'minimax-code': 'MiniMax Code',
  morph: 'Mister Morph', mothx: 'MothX', muse: 'Muse Code', newmax: 'NewMax', omo: 'OmO',
  omp: 'omp', openbot: 'OpenBot', openchamber: 'OpenChamber', openclaw: 'OpenClaw',
  opencode: 'OpenCode', openmausbot: 'OpenMausBot', openpencil: 'OpenPencil', pencil: 'Pencil',
  penguin: 'PenguinHarness', pi: 'Pi', 'pi-desktop': 'PI-Desktop', 'prime-agent': 'Prime Agent',
  qoder: 'Qoder', 'qoder-cn': 'Qoder CN', qwen: 'Qwen Code', qwenpaw: 'QwenPaw', raft: 'Raft',
  raycast: 'Raycast', reasonix: 'Reasonix Studio', snow: 'Snow CLI', stepcode: 'StepCode',
  t3code: 'T3 Code', vscode: 'VS Code', 'vscode-insiders': 'VS Code Insiders', vscodium: 'VSCodium',
  workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI',
  zcode: 'ZCode', zed: 'Zed', 'zoo-code': 'Zoo Code',
  // Clients the gateway only knows by the User-Agent they send.
  aider: 'Aider', roo: 'Roo Code', windsurf: 'Windsurf',
  'python-urllib': 'Python', 'go-http-client': 'Go Client',
};
const agentNames = new Map();
for (const [id, label] of Object.entries(AGENT_LABELS)) {
  agentNames.set(id, label);
  agentNames.set(label.toLowerCase(), label);
}
function typedLabel(value, type, index) {
  if (typeof value !== 'string') return type === 'computer' ? 'Device ' + (index + 1) : 'Unknown';
  if (type === 'computer') return /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(value) ? value : 'Device ' + (index + 1);
  if (type === 'provider') return providerLabelOf(value);
  if (type === 'agent') {
    const known = agentNames.get(value.toLowerCase());
    if (known) return known;
    // An agent running in a WSL distro carries the distro after an "@"
    // (codex@wsl:Ubuntu-22.04); the agent itself is the part before it.
    const at = value.indexOf('@');
    if (at > 0) {
      const base = agentNames.get(value.slice(0, at).toLowerCase());
      if (base) return base;
    }
    return /^[a-z0-9][a-z0-9-_.]{0,39}$/i.test(value) ? value : 'Unknown';
  }
  // Accept model identifiers from known families; discard provider prefixes.
  if (value.length > 120 || /^(?:[a-z]:|[\/~.])/i.test(value) || value.includes('\\') || value.split('/').length > 2) return 'Unknown';
  const model = value.split('/').at(-1);
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(model) && modelFamily.test(model) ? model : 'Unknown';
}
// Upstream rows carry both a display name and a stable id. Providers and agents
// resolve by id; models resolve by name because upstream reuses one id per model string.
function labelSource(row, type) {
  if (type === 'provider' || type === 'agent') return row.id || row.name || row.model;
  return row.name || row.model || row.id;
}
export function metrics(raw = {}) {
  const inputTokens = number(raw.input), outputTokens = number(raw.output);
  const cacheReadTokens = number(raw.cache_read), cacheWriteTokens = number(raw.cache_write);
  const inputTotal = inputTokens + cacheReadTokens + cacheWriteTokens;
  const decodeMs = number(raw.decode_ms), decodeOut = number(raw.decode_out);
  const timed = number(raw.timed);
  return {
    requests: number(raw.calls), errors: number(raw.errors),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    reasoningTokens: number(raw.reasoning),
    totalTokens: inputTotal + outputTokens,
    cacheHitPercent: inputTotal ? cacheReadTokens / inputTotal * 100 : null,
    // Cost is Magpie's own estimate at each model's effective prices; the
    // currency unit follows the Magpie price table and is not inferred here.
    cost: number(raw.cost), unpriced: number(raw.unpriced),
    // Streaming decode throughput and mean first-token latency over measured requests.
    outputTokensPerSecond: decodeMs ? Math.round(decodeOut / decodeMs * 1000 * 10) / 10 : null,
    ttftMs: timed ? Math.round(number(raw.ttft_ms) / timed) : null,
  };
}
// A subscription account is told apart by the identity Magpie reports for it.
// Only the part before the "@" is kept: it names the account on screen without
// carrying the address itself.
const ACCOUNT_NAME = /^[A-Za-z0-9._-]{1,32}$/;
const accountName = value => {
  if (typeof value !== 'string') return null;
  const local = value.split('@')[0] || '';
  return ACCOUNT_NAME.test(local) ? local : null;
};
// Magpie lets the user name an account of their own ("magpie accounts alias
// codex <email> <name>"). The name is the user's own text for it, so it may be
// shown, but only as a short plain label: no path, no address, no markup.
const ALIAS_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._*'-]{0,31}$/u;
const aliasName = value => {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return ALIAS_NAME.test(name) ? name : null;
};
// The key of an account of a vendor: the vendor and the name of the account.
// The same key is used by the card id and by the query of its own usage.
export const accountKey = (family, value) => {
  const name = accountName(value);
  return family && name ? family + '@' + name : null;
};
export function normalizeQuotas(raw, cache = {}) {
  if (!raw || !Array.isArray(raw.data)) throw new Error('Invalid quota response');
  // The counter of every family. It is a Map and not an object: a family
  // called "constructor" is a family like any other, and it must not find
  // something on the prototype.
  const counts = new Map();
  // How many cards a family has: one account keeps the plain name, several are
  // named after their own identity so they never swap places.
  const familySize = new Map();
  for (const card of raw.data) {
    const family = providerFamily(card?.provider);
    if (!family) continue;
    // The gateway may know more accounts of a vendor than the rows that are
    // read now: a broken row is still an account, and a vendor with several
    // accounts must not lend its total to one of them.
    const known = Number(card.accounts);
    familySize.set(family, Math.max((familySize.get(family) || 0) + 1, Number.isFinite(known) ? known : 0));
  }
  const taken = new Set();
  // The cached readings are indexed by their vendor once, not once per card.
  const cachedByProvider = new Map();
  for (const item of Object.values(cache || {})) {
    const provider = item?.quota?.provider;
    if (!provider) continue;
    const list = cachedByProvider.get(provider) || [];
    list.push(item);
    cachedByProvider.set(provider, list);
  }
  // The cards of one vendor are ordered by the name of their own account, so
  // an account keeps its place whatever order the gateway lists the accounts
  // in, and "the first account of a vendor" always means the same one. Two
  // accounts of one vendor may share the name; the address breaks the tie, so
  // even then neither of them changes places.
  const ordered = [...raw.data].sort((a, b) => {
    const name = card => (accountName(card?.user ?? card?.account) || '').toLowerCase();
    const address = card => (typeof (card?.user ?? card?.account) === 'string' ? card.user ?? card.account : '').toLowerCase();
    const left = name(a), right = name(b);
    if (left !== right) return left < right ? -1 : 1;
    const first = address(a), second = address(b);
    return first < second ? -1 : first > second ? 1 : 0;
  });
  return ordered.flatMap(card => {
    const provider = providerOf(card?.provider);
    if (!provider || !Array.isArray(card.windows)) return [];
    const index = (counts.get(provider.id) || 0) + 1;
    counts.set(provider.id, index);
    const account = accountName(card?.user ?? card?.account);
    const alias = aliasName(card?.alias);
    // A cached reading belongs to the account it was taken for, so two accounts
    // of one vendor never borrow each other's timestamp.
    // The cache is indexed by the vendor as Magpie writes it down, and the
    // family is tried as well: a vendor that Magpie calls "minimax-cn" and
    // one it calls "minimax" are one family and one reading.
    const cached = [...(cachedByProvider.get(card.provider) || []), ...(cachedByProvider.get(provider.id) || [])].filter(item =>
      !account || accountName(item.quota.user) === account);
    const singleAccount = familySize.get(provider.id) === 1;
    // A card without an identity only inherits a reading of a vendor that has
    // a single account: the reading of another account is not its own.
    const cachedAccounts = new Set(cached.map(item => accountName(item.quota.user) || ''));
    const matches = account || singleAccount && cachedAccounts.size === 1 ? cached : [];
    const latest = matches.reduce((newest, item) =>
      !newest || Date.parse(item.at || 0) > Date.parse(newest.at || 0) ? item : newest, null);
    const updatedAt = iso(card.readAt) || (latest ? iso(latest.at) : null);
    // The account names its own card, but only where it is needed to tell two
    // accounts of one vendor apart: a vendor with a single account keeps its
    // plain name, and no identity leaves the machine for nothing. A name the
    // user gave the account in Magpie is theirs to show either way.
    const several = familySize.get(provider.id) > 1;
    const named = several && account;
    const base = named ? provider.id + '@' + account : provider.id + (index > 1 ? '-' + index : '');
    let id = base, attempt = 2;
    while (taken.has(id)) id = base + '-' + attempt++;
    taken.add(id);
    // Two accounts of one vendor may share the name: the one that had to be
    // numbered keeps its number in the label, so the two can be told apart.
    const suffix = id === base ? '' : id.slice(base.length);
    const shown = alias || (named ? account : null);
    // The name the vendor carries is the name Magpie gives it, so that the
    // card says what the software says about the same subscription.
    const vendor = vendorName(card?.name) || provider.label;
    // The usage of this account alone, when the gateway could report it.
    const own = card?.accountUsage?.today;
    const accountUsage = typeof own?.totalTokens === 'number' && Number.isFinite(own.totalTokens)
      ? { today: { totalTokens: own.totalTokens, requests: number(own.requests) } } : null;
    return [{
      id,
      provider: provider.id,
      label: shown ? vendor + ' · ' + shown + suffix : vendor + (index > 1 ? ' ' + index : ''),
      // The name of the vendor is kept with the card, so that a card that
      // falls back to a reading that was stored still says the name Magpie
      // gives the vendor.
      vendor,
      account: named ? account : null,
      alias,
      accountUsage,
      // The day the number was taken on: a number of another day is not the
      // number of today, and the day travels with it.
      accountUsageDay: card?.accountUsageDay || null,
      // How many accounts of this vendor are known: a card of a vendor with
      // several accounts never shows the total of the vendor.
      accounts: familySize.get(provider.id) || 1,
      plan: typeof card.plan === 'string' && (plans.test(card.plan) || planWord.test(card.plan))
        ? card.plan : provider.plan, updatedAt,
      stale: card.stale === true,
      windows: numberPlainWindows(card.windows.filter(window => window && typeof window === 'object').map(window => {
        const known = typeof window.used === 'number' && Number.isFinite(window.used) && window.used >= 0;
        const usedPercent = known ? Math.min(100, window.used) : null;
        return {
          label: windowLabel(window.name), usedPercent,
          remainingPercent: known ? 100 - usedPercent : null,
          resetsAt: iso(window.resetsAt),
          amount: typeof window.amount === 'number' ? number(window.amount) : null,
          limit: typeof window.limit === 'number' ? number(window.limit) : null,
        };
      })),
    }];
  }).sort((a, b) => {
    // Known families keep their canonical order; anything else sorts last
    // instead of first, and the families that are not known are ordered by
    // their own id, so that the cards of one vendor stay together.
    const ai = PROVIDER_ORDER.indexOf(a.provider), bi = PROVIDER_ORDER.indexOf(b.provider);
    const left = ai < 0 ? PROVIDER_ORDER.length : ai;
    const right = bi < 0 ? PROVIDER_ORDER.length : bi;
    if (left !== right) return left - right;
    if (left < PROVIDER_ORDER.length) return 0;
    return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
  });
}
// Select complete provider groups instead of guessing which anonymous API row
// belongs to a private cache key. All selected rows still cross the same allowlist.
// Accounts of one vendor are kept apart: a reading is only ever taken from the
// account it belongs to, so two Codex accounts never trade places.
export function resolveQuotas(raw, cache = {}, previous = [], cachedIdentities = []) {
  const group = rows => {
    const groups = new Map();
    for (const row of rows) {
      const provider = providerFamily(row?.provider);
      if (!provider) continue;
      const account = accountName(row?.user ?? row?.account) || '';
      const key = provider + '|' + account;
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    return groups;
  };
  const usable = card => !card.error && Array.isArray(card.windows) && card.windows.length > 0 &&
    card.windows.every(window => window && typeof window === 'object') &&
    card.windows.some(window => typeof window.used === 'number' && Number.isFinite(window.used) && window.used >= 0);
  const complete = rows => rows.length > 0 && rows.every(usable);
  // A row that carries no window is not a reading of a quota. The gateway
  // sends one of those next to the plan of an account whose money it knows
  // (Zhipu sends one): there is no quota in it, so it is not a broken
  // reading, and it is not a card of its own. Taken for a reading, it makes
  // the whole account look broken, and the card of that account falls back
  // to the reading that was stored — a number that never moves again.
  const readings = rows => rows.filter(row => Array.isArray(row?.windows) && row.windows.length > 0);
  const api = group(Array.isArray(raw?.data) ? raw.data : []);
  const disk = group(Object.values(cache || {}).map(item => item?.quota && ({
    ...item.quota, readAt: iso(item.quota.readAt) || iso(item.at),
  })));
  const history = group(previous.map(card => ({
    ...card, provider: card.provider === 'glm' ? 'zhipu' : card.provider,
    readAt: card.updatedAt,
    // The name the vendor carries travels with the card, so that a card that
    // falls back to the reading that was stored says the same name.
    name: card.vendor || card.name,
    windows: card.windows.map(window => ({ ...window, name: window.label, used: window.usedPercent })),
  })));
  const selected = [];
  // How many accounts of a vendor the gateway knows, counted over every row it
  // reports: a broken row is still an account.
  const known = new Map();
  for (const [key] of api) {
    const family = key.split('|')[0];
    known.set(family, (known.get(family) || 0) + 1);
  }
  // The answer of the gateway holds something: it knows of at least one
  // subscription, and it is the list of the subscriptions that exist. A
  // vendor it does not mention is gone.
  // A row that is not read at all is not a subscription this plugin can
  // show, so it does not count: when the gateway says nothing that can be
  // read, the reading that was stored is shown instead of nothing.
  const answered = api.size > 0;
  // An answer without a list is not an answer about which subscriptions there
  // are: the reading that was stored is shown instead of nothing at all. An
  // empty array is an answer in itself — the caller carries that meaning.
  // The vendors that are looked at: the ones the widget knows by heart first,
  // in the order they have, and then the ones that are not written down here,
  // in the order of their own id. A vendor that Magpie adds later is a vendor
  // of its own and is looked at as well.
  const families = new Set();
  for (const source of [api, disk, history]) {
    for (const key of source.keys()) families.add(key.split('|')[0]);
  }
  const ordered = [
    ...PROVIDER_ORDER.filter(family => families.has(family)),
    ...[...families].filter(family => !PROVIDER_ORDER.includes(family)).sort(),
  ];
  for (const provider of ordered) {
    const prefix = provider + '|';
    const of = source => [...source.entries()].filter(([key]) => key.startsWith(prefix));
    const live = of(api), familyCached = of(disk).flatMap(([, rows]) => rows),
      familySaved = of(history).flatMap(([, rows]) => rows);
    const accounts = known.get(provider) || 0;
    if (!live.length) {
      // The vendor is not in the answer of the gateway. When the answer holds
      // something, the gateway knows which subscriptions exist, and a vendor
      // it does not mention is gone: it is not brought back from the reading
      // that was stored.
      // When the answer holds nothing at all, the gateway is quiet. Then the
      // reading that was stored is the one that is shown: the source that
      // knows more accounts wins, so a cache that lost an account never hides
      // the one the history still knows.
      if (answered) continue;
      const fallback = familyCached.length >= familySaved.length ? familyCached : familySaved;
      if (fallback === familyCached) cachedIdentities.push(...familyCached);
      const rows = readings(fallback);
      if (rows.length) selected.push(...normalizeQuotas({ data: complete(rows) ? rows : rows.filter(usable) }).map(card => ({ ...card, stale: true })));
      continue;
    }
    // The live answer names the accounts. Each account is recovered on its own:
    // a reading one account is missing never takes the other account's with it.
    const picks = [];
    for (const [key, accountLive] of live) {
      const named = key !== prefix;
      const cached = named ? (disk.get(key) || []) : familyCached;
      const saved = named ? (history.get(key) || []) : familySaved;
      const fresh = readings(accountLive);
      const stored = readings(cached);
      const before = readings(saved);
      picks.push(complete(fresh) ? { rows: fresh, stale: false }
        : complete(stored) ? { rows: stored, stale: true }
        : complete(before) ? { rows: before.map(row => ({ ...row, accountUsage: null, accountUsageDay: null })), stale: true }
        : { rows: fresh.filter(usable), stale: true });
    }
    // The fallback of each account travels with its own rows: the cards are
    // ordered by the name of their account, so a flag cannot be handed to
    // another account by its place in the list.
    const rows = picks.flatMap(pick => pick.rows.map(row => ({
      ...row, ...(pick.stale ? { stale: true } : {}), accounts,
    })));
    selected.push(...normalizeQuotas({ data: rows }));
  }
  if (!selected.length) throw new Error('No usable quota readings');
  return selected;
}
const SUM_FIELDS = ['calls', 'errors', 'input', 'output', 'cache_read', 'cache_write', 'reasoning',
  'cost', 'unpriced', 'timed', 'ttft_ms', 'decode_ms', 'decode_out', 'decode_n'];
// Internal ceiling; the effective number of rows is chosen by the display configuration.
const RANKING_CAP = 50;
// The grouping key of a model row. Rows whose name does not pass the label rules
// are never merged, so they keep their own line.
export function modelKey(value) {
  const label = typedLabel(value, 'model', 0);
  return label === 'Unknown' ? null : label.toLowerCase();
}
// Upstream can report one model several times: with a provider prefix, with a
// different case, or under another account. Merge those rows into one line.
function mergeModels(rows) {
  const groups = new Map();
  for (const [index, row] of rows.entries()) {
    const source = labelSource(row, 'model');
    const label = typedLabel(source, 'model', index);
    const key = modelKey(source) ?? 'unknown:' + index;
    const tokens = metrics(row).totalTokens;
    const group = groups.get(key);
    if (!group) { groups.set(key, { label, tokens, row: { ...row } }); continue; }
    if (tokens > group.tokens) { group.label = label; group.tokens = tokens; }
    for (const field of SUM_FIELDS) group.row[field] = number(group.row[field]) + number(row[field]);
  }
  return [...groups.values()];
}
function ranking(rows, type, names = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const entries = type === 'model'
    ? mergeModels(list).map(group => ({ label: group.label, row: group.row }))
    : list.map((row, i) => ({
      label: type === 'provider' ? providerLabelOf(labelSource(row, type), names) : typedLabel(labelSource(row, type), type, i),
      row,
    }));
  return entries.map((entry, i) => ({
    id: type + '-' + (i + 1), label: entry.label, ...metrics(entry.row),
    // The family of the vendor travels with the row. It is the stable name of
    // the vendor, and the card of the subscription is found by it: a vendor
    // that has no name of its own yet still has this one.
    ...(type === 'provider' ? { family: entry.row.family || providerFamily(labelSource(entry.row, type)) } : {}),
  })).sort((a, b) => b.totalTokens - a.totalTokens).map((entry, i) => ({ ...entry, id: type + '-' + (i + 1) }))
    .slice(0, RANKING_CAP);
}
export function normalizeUsage(raw, names = {}) {
  if (!raw || !['input', 'output', 'cache_read', 'cache_write', 'calls'].every(key =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0)) throw new Error('Invalid usage response');
  return {
    metrics: metrics(raw),
    trend: (Array.isArray(raw.series) ? raw.series : []).map((item, index) => ({
      at: iso(item.time), label: iso(item.time) ? shanghaiDay(Date.parse(item.time)) : 'Day ' + (index + 1), ...metrics(item),
    })),
    models: ranking(raw.by?.model, 'model'),
    providers: ranking(raw.by?.provider, 'provider', names),
    agents: ranking(raw.by?.agent, 'agent'),
    computers: ranking(raw.computers, 'computer'),
  };
}

// The summary of the gateway carries the totals of the day, the hours, the
// vendors and the accounts in one answer. The vendors are gathered from the
// keys of the vendors and from the accounts, so a vendor whose calls come
// from an account it holds is counted once.
export function normalizeUsageSummary(raw, names = {}) {
  if (!raw || !['input', 'output', 'cache_read', 'cache_write', 'calls'].every(key =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0)) throw new Error('Invalid usage response');
  const groups = new Map();
  const gather = (provider, row) => {
    if (typeof provider !== 'string' || !provider) return;
    const family = providerFamily(provider) || provider;
    const group = groups.get(family) || {
      id: provider, family, calls: 0, errors: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0,
    };
    for (const field of ['calls', 'errors', 'input', 'output', 'cache_read', 'cache_write', 'reasoning']) {
      group[field] += number(row?.[field]);
    }
    groups.set(family, group);
  };
  for (const key of Array.isArray(raw.providerKeys) ? raw.providerKeys : []) gather(key?.provider, key);
  for (const account of Array.isArray(raw.accounts) ? raw.accounts : []) gather(account?.provider, account);
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
    .filter(row => row && typeof row.provider === 'string' && typeof row.account === 'string' && row.account.includes('@'))
    .map(row => ({
      provider: row.provider,
      family: providerFamily(row.provider),
      account: row.account.trim(),
      ...metrics(row),
    }));
  return {
    metrics: metrics(raw),
    trend: (Array.isArray(raw.series) ? raw.series : []).map((item, index) => ({
      at: iso(item.time), label: iso(item.time) ? shanghaiDay(Date.parse(item.time)) : 'Day ' + (index + 1), ...metrics(item),
    })),
    providers: ranking([...groups.values()], 'provider', names),
    accounts,
  };
}
// A row that is read from the disk carries the label it was stored under.
// The name of a vendor that is not written down is the one Magpie gave it,
// and that name is ours: it is kept as it is. The name of a vendor that is
// written down is looked up again, so that a name that was changed is the
// new one.
const cleanCachedRows = (rows, type) => (rows || []).map((row, index) => {
  if (type === 'provider' && row.family && !providerNames.has(String(row.family).toLowerCase())) {
    return { ...row, label: typeof row.label === 'string' && row.label.trim() ? row.label : 'Unknown' };
  }
  return { ...row, label: typedLabel(row.label, type, index) };
});
export function sanitizeCachedLabels(data, key) {
  if (key === 'quotas') return normalizeQuotas({ data: data.map(card => ({
    provider: card.provider === 'glm' ? 'zhipu' : card.provider, plan: card.plan, readAt: card.updatedAt, stale: card.stale === true,
    // The name the vendor carries travels with the card, so that the card
    // that is stored says the name Magpie gives the vendor.
    name: card.vendor || card.name,
    account: card.account,
    alias: card.alias,
    accountUsage: card.accountUsage,
    accountUsageDay: card.accountUsageDay || null,
    accounts: card.accounts,
    windows: card.windows.map(window => ({ ...window, name: window.label, used: window.usedPercent })),
  })) });
  const cleanRows = cleanCachedRows;
  return { ...data,
    trend: (data.trend || []).map((row, index) => ({ ...row, label: iso(row.at) ? shanghaiDay(Date.parse(row.at)) : 'Day ' + (index + 1) })),
    models: cleanRows(data.models, 'model'), providers: cleanRows(data.providers, 'provider'),
    agents: cleanRows(data.agents, 'agent'), computers: cleanRows(data.computers, 'computer'),
  };
}

// The summary of today has its own shape: the vendors and the accounts, and
// no models, agents or computers.
export function sanitizeCachedSummary(data) {
  if (!data || typeof data !== 'object') return data;
  const cleanRows = cleanCachedRows;
  return { ...data,
    trend: (data.trend || []).map((row, index) => ({ ...row, label: iso(row.at) ? shanghaiDay(Date.parse(row.at)) : 'Day ' + (index + 1) })),
    providers: cleanRows(data.providers, 'provider'),
    accounts: (data.accounts || []).map(row => ({ ...row })),
  };
}
export const shanghaiDay = value => new Date(value + 8 * 3600_000).toISOString().slice(0, 10);
// Display choices live in the PC-side configuration; the phone and the dashboard
// only render what the service projects.
export const DEFAULT_DISPLAY = {
  // Every subscription the gateway knows is shown. The list of vendors is not
  // written down here, so a subscription that is added to Magpie shows up
  // without being ticked, and one that is removed goes away by itself. The
  // user may still pick a part of it in the console.
  modelLimit: 8, agentLimit: 6, providerLimit: 20, computerLimit: 20, subscriptions: ['*'],
};
// A subscription is a vendor family (codex) or one of its accounts
// (codex@alice). The family's case does not matter; the account's does.
const splitSubscription = id => {
  const at = typeof id === 'string' ? id.indexOf('@') : -1;
  const family = (at < 0 ? String(id) : id.slice(0, at)).toLowerCase();
  const account = at < 0 ? '' : id.slice(at + 1);
  return { family, account };
};
const subscriptionId = id => {
  const { family, account } = splitSubscription(id);
  return family + (account ? '@' + account : '');
};
// The same shape as the id of a vendor: a subscription is named by it.
const SUBSCRIPTION_ID = /^[a-z][a-z0-9._-]{0,19}$/;
const SUBSCRIPTION_ACCOUNT = /^[A-Za-z0-9._-]{1,32}$/;
// How many subscriptions the service lets a user turn off at the same time.
// A longer list is refused when it is written, so that nothing is ever
// dropped without the user being told.
export const MAX_HIDDEN_SUBSCRIPTIONS = 256;
// How many entries are read at all. This one is not a rule of the product but
// a guard against a state file that was written by hand and holds a name a
// thousand times over: it is far above the rule above, so it never cuts a
// list that the user could have made.
const HARD_HIDDEN_LIMIT = 1024;
export function displayOptions(value = {}) {
  const limit = (input, fallback) => {
    if (input === null || input === undefined || input === '') return fallback;
    const parsed = Number(input);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(20, Math.round(parsed)));
  };
  const requested = Array.isArray(value.subscriptions) ? value.subscriptions : [];
  const subscriptions = requested.filter(id => {
    if (typeof id !== 'string') return false;
    if (id === '*') return true;
    const { family, account } = splitSubscription(id);
    return SUBSCRIPTION_ID.test(family) && (!account || SUBSCRIPTION_ACCOUNT.test(account));
  }).map(subscriptionId);
  // The subscriptions the user has turned off. They are written down, so one
  // that is hidden does not come back by itself, not even when the whole list
  // of Magpie is followed. The name of a vendor turns off every account of
  // it; the name of an account turns off that one only.
  const subscriptionHidden = (Array.isArray(value.subscriptionHidden) ? value.subscriptionHidden : [])
    .filter(id => {
      if (typeof id !== 'string' || id === '*') return false;
      const { family, account } = splitSubscription(id);
      return SUBSCRIPTION_ID.test(family) && (!account || SUBSCRIPTION_ACCOUNT.test(account));
    })
    .map(subscriptionId)
    .filter((id, index, list) => list.indexOf(id) === index)
    .slice(0, HARD_HIDDEN_LIMIT);
  // The order of the rows of the page, the ones that are shown and the ones
  // that are turned off among them. It is kept apart from the list of the
  // shown ones, because that list only holds the ones that are shown when
  // the whole list of Magpie is not followed: a row that is turned off would
  // lose its place every time the page is drawn again.
  const subscriptionOrder = (Array.isArray(value.subscriptionOrder) ? value.subscriptionOrder : [])
    .filter(id => {
      if (typeof id !== 'string') return false;
      const { family, account } = splitSubscription(id);
      return SUBSCRIPTION_ID.test(family) && (!account || SUBSCRIPTION_ACCOUNT.test(account));
    })
    .map(subscriptionId)
    .filter((id, index, list) => list.indexOf(id) === index)
    .slice(0, HARD_HIDDEN_LIMIT);
  // The direction of the widget and the card it shows are chosen on the
  // plugin side. The Scriptable parameter may still override them.
  const widgetMode = value.widgetMode === 'used' ? 'used' : 'remaining';
  const widgetCard = (() => {
    if (typeof value.widgetCard !== 'string') return '';
    const wanted = value.widgetCard.trim();
    if (!wanted) return '';
    const { family, account } = splitSubscription(wanted);
    if (!SUBSCRIPTION_ID.test(family)) return '';
    if (account && !SUBSCRIPTION_ACCOUNT.test(account)) return '';
    return subscriptionId(wanted);
  })();
  // The name the user gives a subscription is his own: it is what the widget
  // and the phone show for it. It is kept per card, so a name follows the
  // account it was given to, and it survives a restart of the service.
  const names = (() => {
    const given = value.names && typeof value.names === 'object' && !Array.isArray(value.names) ? value.names : {};
    const out = {};
    for (const [id, name] of Object.entries(given)) {
      if (typeof id !== 'string' || typeof name !== 'string') continue;
      const text = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      // The separator of the label would cut the name in two, so a name that
      // carries one is not a name.
      if (!text || text.length > 32 || text.includes('·')) continue;
      out[id] = text;
    }
    return out;
  })();
  return {
    modelLimit: limit(value.modelLimit, DEFAULT_DISPLAY.modelLimit),
    agentLimit: limit(value.agentLimit, DEFAULT_DISPLAY.agentLimit),
    providerLimit: limit(value.providerLimit, DEFAULT_DISPLAY.providerLimit),
    computerLimit: limit(value.computerLimit, DEFAULT_DISPLAY.computerLimit),
    subscriptions: subscriptions.length ? subscriptions : [...DEFAULT_DISPLAY.subscriptions],
    subscriptionHidden,
    subscriptionOrder,
    widgetMode,
    widgetCard,
    names,
  };
}
// The name of a card is the name the user gave it, or the name the vendor
// carries. The phone and the widget read it from here, so that they say the
// same thing about the same subscription.
export const cardName = (card, names = {}) => {
  const own = typeof names?.[card?.id] === 'string' ? names[card.id].trim() : '';
  return own || card?.label || '';
};
// Command line overrides for the configuration script. An empty value never
// replaces a saved choice; it is ignored so a typo cannot silently reset it.
export function displayOverrides(argv = []) {
  const flags = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const key = String(argv[index] || '').replace(/^--/, '');
    if (key) flags.set(key, argv[index + 1]);
  }
  const overrides = {};
  for (const [flag, key] of [['model-limit', 'modelLimit'], ['agent-limit', 'agentLimit'], ['provider-limit', 'providerLimit'], ['computer-limit', 'computerLimit']]) {
    if (!flags.has(flag)) continue;
    const value = Number(flags.get(flag));
    if (Number.isFinite(value)) overrides[key] = value;
  }
  if (flags.has('subscriptions')) {
    const requested = String(flags.get('subscriptions')).split(',').map(item => item.trim()).filter(Boolean);
    if (requested.length) overrides.subscriptions = requested;
  }
  return overrides;
}
// What the reading of today says about the numbers of the day: whether it is
// of this day at all, which rows the vendors have, and how many accounts each
// vendor has. The rules of the usage live in usageForCard, so the console and
// the phone answer the same question about a card.
export function todayContext(snapshot, now = Date.now()) {
  const todayPart = snapshot?.parts?.today;
  const day = shanghaiDay(now);
  const outdated = !!todayPart && (todayPart.periodDay || shanghaiDay(Date.parse(todayPart.observedAt))) !== day;
  const cards = snapshot?.parts?.quotas?.data || [];
  const familySizes = new Map();
  for (const card of cards) familySizes.set(card.provider, (familySizes.get(card.provider) || 0) + 1);
  return { outdated, familySizes, day, todayProviders: outdated ? [] : (todayPart?.data?.providers || []) };
}

// The usage of a card for today: the account has only its own number, and a
// vendor with several accounts cannot lend its total to one of them. A
// reading of another day is not the usage of today — the number is given back
// as nothing (the reader knows it is missing), so a card must not keep
// yesterday's number and let it be read as today's. The number of an account
// is bound to the day it was taken on, because it comes with the reading of
// the quota and can outlive the day it was taken on.
export function usageForCard(card, { outdated = false, todayProviders = [], familySizes = new Map(), day = '' } = {}) {
  if (!card) return null;
  if (outdated) return null;
  if (card.account) {
    if (!card.accountUsage) return null;
    if (!day || card.accountUsageDay !== day) return null;
    return card.accountUsage;
  }
  if ((card.accounts || familySizes.get(card.provider) || 0) > 1) return null;
  // The name of the vendor as the plugin knows it. A vendor that is not
  // written down here is matched by the name Magpie gives it, so that the
  // total of the day is found as well.
  const label = providerLabel(card.provider) || card.vendor;
  // The family of the vendor is the stable name of it, and it is the first
  // thing that is matched: a vendor that is not written down yet has no name
  // to be found by, but it has this one.
  const rows = todayProviders.filter(row => {
    if (row.family && row.family === card.provider) return true;
    return Boolean(label) && String(row.label).trim().toLowerCase() === label.toLowerCase();
  });
  if (!rows.length) return null;
  // A row of the usage of a vendor is only a number when it is a number: a
  // row that is missing one makes the whole total unknown, not smaller.
  const counted = rows.map(row => typeof row?.totalTokens === 'number' && Number.isFinite(row.totalTokens) &&
    typeof row?.requests === 'number' && Number.isFinite(row.requests) ? row : null);
  if (counted.some(row => !row)) return null;
  return { today: {
    totalTokens: counted.reduce((sum, row) => sum + row.totalTokens, 0),
    requests: counted.reduce((sum, row) => sum + row.requests, 0),
  } };
}

// A subscription the user has turned off stays off: it does not come back by
// itself, not even when the whole list of Magpie is followed. The name of a
// vendor turns off every account of it; the name of an account turns off
// that one only.
export const isTurnedOff = (card, hidden = []) =>
  hidden.some(entry => entry === card?.id || entry === card?.provider);
// A card is ranked by the first entry that names it: its family, or the one
// account of that family the list picked. What is not in the list comes
// after it, in the order of the families the widget knows by heart; a
// family that is not known sorts last instead of first.
const rankOf = (card, pinned, showAll) => {
  const index = pinned.findIndex(entry => entry === card.provider || entry === card.id);
  if (index >= 0) return index;
  if (!showAll) return pinned.length;
  const family = PROVIDER_ORDER.indexOf(card.provider);
  return pinned.length + (family < 0 ? PROVIDER_ORDER.length : family);
};

// The cards the display choices keep, in the order the phone shows them. The
// choices are already read here, so that the caller does not have to read
// them twice. The list can be empty: a choice of the user that matches
// nothing is a choice of the user, and the service keeps it.
export function selectedWith(cards = [], choices = {}) {
  const list = Array.isArray(choices?.subscriptions) ? choices.subscriptions : [];
  const hidden = Array.isArray(choices?.subscriptionHidden) ? choices.subscriptionHidden : [];
  const showAll = list.includes('*');
  const pinned = showAll ? list.filter(entry => entry !== '*') : list;
  // The cards the choice of the user keeps, before the ones that were turned
  // off are taken out of it.
  const wanted = cards
    .filter(card => showAll || list.includes(card.provider) || list.includes(card.id));
  return wanted
    .filter(card => !isTurnedOff(card, hidden))
    .sort((a, b) => rankOf(a, pinned, showAll) - rankOf(b, pinned, showAll));
}
// The cards the display choices keep, in the order the phone shows them. The
// widgets need something to show: a choice that turns off every card does
// not leave the phone empty, the choice itself is left out and the cards are
// shown as they were before it. The service refuses such a choice when it is
// written, so this is the floor under a state file that was written by hand
// or a subscription that was taken away in Magpie.
export function orderedWith(cards = [], choices = {}) {
  const kept = selectedWith(cards, choices);
  if (kept.length) return kept;
  const list = Array.isArray(choices?.subscriptions) ? choices.subscriptions : [];
  const showAll = list.includes('*');
  const pinned = showAll ? list.filter(entry => entry !== '*') : list;
  const wanted = cards
    .filter(card => showAll || list.includes(card.provider) || list.includes(card.id));
  if (!wanted.length) return kept;
  return wanted.sort((a, b) => rankOf(a, pinned, showAll) - rankOf(b, pinned, showAll));
}
// The cards the display choices keep, in the order the phone shows them.
// The list that was written down comes first, in the order it was written
// down in: it is the order the user has given, and it holds even when the
// whole list of Magpie is followed. What is not in it comes after, in the
// order of the families the widget knows by heart; a family that is not
// known sorts last instead of first.
export function orderedSubscriptions(cards = [], display = {}) {
  return orderedWith(cards, displayOptions(display));
}

export function project(snapshot, now = Date.now(), display = {}, settings = {}) {
  const choices = displayOptions(display);
  const sources = {};
  for (const key of ['quotas', 'today', 'week']) {
    const part = snapshot.parts[key];
    sources[key] = {
      state: !part ? 'unavailable' : snapshot.failures[key] || now - Date.parse(part.observedAt) > 180_000 ? 'stale' : 'ok',
      observedAt: part?.observedAt || null,
    };
  }
  // A reading that ran out of time is given back marked as old, so the reader
  // knows the numbers are not of this moment.
  if (settings.expired) for (const key of Object.keys(sources)) if (sources[key].state === 'ok') sources[key].state = 'stale';
  const todayPart = snapshot.parts.today;
  const outdated = !!todayPart && (todayPart.periodDay || shanghaiDay(Date.parse(todayPart.observedAt))) !== shanghaiDay(now);
  if (outdated) { sources.today.state = 'stale'; sources.today.outdated = true; }
  // Each subscription carries the usage of its own account, or of its vendor
  // when it is the only account of that vendor: a widget that shows one
  // subscription then shows that subscription's own numbers.
  const cards = snapshot.parts.quotas?.data || [];
  const { familySizes, todayProviders, day } = todayContext(snapshot, now);
  const usageOf = card => usageForCard(card, { outdated, todayProviders, familySizes, day });
  // The cards the display choices keep, in the order the phone shows them.
  const shown = orderedWith(cards, choices).map(card => ({
    ...card,
    // The name the user gave the card is the name it carries on the phone and
    // on the widget.
    label: cardName(card, choices.names),
    usage: usageOf(card),
    // The usage of a subscription comes from the reading of today: when that
    // reading is old, the numbers on the card are old as well.
    usageStale: sources.today.state !== 'ok',
    stale: card.stale === true || sources.quotas.state !== 'ok' || !!card.updatedAt && now - Date.parse(card.updatedAt) > 900_000,
    windows: card.windows.map(window => ({ ...window,
      expired: !!window.resetsAt && Date.parse(window.resetsAt) <= now,
    })),
  }));
  const week = snapshot.parts.week?.data;
  return {
    schemaVersion: 1, generatedAt: new Date(now).toISOString(), timezone: 'Asia/Shanghai', sources,
    display: choices,
    subscriptions: shown,
    usage: { today: outdated ? null : snapshot.parts.today?.data.metrics || null, week: week?.metrics || null },
    trend: week?.trend || [],
    rankings: {
      models: (week?.models || []).slice(0, choices.modelLimit),
      agents: (week?.agents || []).slice(0, choices.agentLimit),
      providers: (week?.providers || []).slice(0, choices.providerLimit),
      computers: (week?.computers || []).slice(0, choices.computerLimit),
    },
  };
}
