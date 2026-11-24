import { PERIODS, pricingRule, sampleMultiplier } from './pricing.mjs';
import { creditDayStart, indexDailyCredits, readAccountSpend } from './credit-history.mjs';

const DAY_MS = 86_400_000;
const MILLION = 1_000_000;
const MIN_SAMPLES = 5;
export const SPEND_WINDOWS = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS };
export const EXPIRY_WINDOWS = { '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '45d': 45 * DAY_MS };
const CREDIT_PROVIDERS = new Set([
  'autoclaw', 'autoclaw-cn', 'catpaw', 'codearts', 'minimax-code', 'minimax-code-global',
  'qoder', 'qoder-cn', 'raccoon', 'trae-cn', 'workbuddy', 'workbuddy-ai',
]);
const safeProviderId = value => typeof value === 'string' && /^[a-z0-9][\w./:-]{0,159}$/.test(value);

// Explicit provider aliases. Suffixes such as 1017, Max and Highspeed are SKUs.
const ALIASES = {
  'workbuddy-ai': { 'deepseek-v4.1-flash-sg': 'deepseek-v4.1-flash' },
  raccoon: {
    'sn-kimi-k3-1-pro': 'kimi-k3.1-pro',
    'sn-glm-5-3-flash': 'glm-5.3-flash',
    'sn-deepseek-v4-1-flash-1017': 'deepseek-v4.1-flash-1017',
  },
  autoclaw: { 'zai_glm-5.3-flash': 'glm-5.3-flash' },
  'autoclaw-cn': { 'zai_glm-5.3-flash': 'glm-5.3-flash' },
  qoder: { kmodel_latest: 'kimi-k3.1-pro', mmodel: 'minimax-m3.1-flash', gfmodel: 'glm-5.3-flash' },
  'qoder-cn': { kmodel_latest: 'kimi-k3.1-pro', mmodel: 'minimax-m3.1-flash', gfmodel: 'glm-5.3-flash' },
};

export function modelId(provider, value) {
  if (typeof value !== 'string') return '';
  const id = value.trim().toLowerCase();
  const local = id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
  if (!/^[a-z0-9][\w./:-]{0,159}$/.test(local) || /^(auto(?:[-_].*)?|zai_auto|ultimate|efficient|performance|fast)$/.test(local) ||
      /(?:^|[-_])(?:sub|search|file)[-_]agent(?:[-_]|$)|_subagent$/.test(local)) return '';
  return Object.hasOwn(ALIASES, provider) && Object.hasOwn(ALIASES[provider], local)
    ? ALIASES[provider][local] : local;
}

const natural = value => Number.isFinite(value) && value >= 0;
const creditUnit = /^(?:credits?|points?|积分)$/i;

function displayCredits(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:credits?|points?|积分)$/i);
  const amount = match && Number(match[1].replaceAll(',', ''));
  return natural(amount) ? amount : null;
}

function windowBalance(window) {
  if (creditUnit.test(window.unit ?? '')) {
    if (natural(window.balance)) return window.balance;
    if (natural(window.limit) && natural(window.amount ?? 0)) {
      return Math.max(0, window.limit - (window.amount ?? 0));
    }
  }
  return /^(?:可用积分|积分余额|available credits)$/i.test(window.name ?? '')
    ? displayCredits(window.display) : null;
}

export function cardBalance(card, now) {
  const live = (card.windows ?? []).filter(w => !w.unlimited && !(Date.parse(w.resetsAt) <= now));
  const identified = live.map(w => [w, windowBalance(w)]).filter(([, value]) => value !== null);
  if (card.error) return null;
  const total = identified.find(([w]) => /^(?:total credits|总积分(?:\s*·.*)?|积分余额|可用积分)$/i.test(w.name ?? ''));
  if (total) return total[1];
  const balance = displayCredits(card.balance);
  if (balance !== null) return balance;
  // Some providers expose an unnamed aggregate plus its component packs. When
  // one window's limit equals the sum of the others it is the total, so the
  // packs are not counted again (magpie-quota-glance's sum-relation dedup).
  const withLimit = identified.filter(([window]) => natural(window.limit) && window.limit > 0);
  if (withLimit.length > 1) {
    const sumLimits = withLimit.reduce((sum, [window]) => sum + window.limit, 0);
    const aggregate = withLimit.find(([window]) => Math.abs(window.limit * 2 - sumLimits) < 1e-6);
    if (aggregate) return aggregate[1];
  }
  // Raccoon's Credits already includes its Daily pool. WorkBuddy and Qoder
  // expose independent component windows when their aggregate is absent.
  if (card.provider === 'raccoon') {
    return identified.find(([w]) => w.name === 'Credits')?.[1] ?? null;
  }
  if (identified.length === 1 && !/^(?:daily pool)$/i.test(identified[0][0].name ?? '')) return identified[0][1];
  if (/^(?:workbuddy(?:-ai)?|qoder(?:-cn)?)$/.test(card.provider) && identified.length &&
      identified.every(([w]) => /^(?:credits|extra credits|add-on credits|act-[\w-]+)$/i.test(w.name ?? ''))) {
    return identified.reduce((sum, [, amount]) => sum + amount, 0);
  }
  return null;
}

// The gateway only exposes the soonest-lapsing batch (runsOutAt), and its
// runsOut counter is not a reliable amount. Surface the vendor's own stated
// expiring figure when present, as a note; never silently deduct it.
const totalWindowName = /^(?:total credits|总积分(?:\s*·.*)?|积分余额|可用积分)$/i;
function cardExpiring(card, now) {
  const windows = card.windows ?? [];
  const total = windows.find(window => totalWindowName.test(window.name ?? '')) ?? windows[0];
  const at = Date.parse(total?.runsOutAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const match = typeof total?.display === 'string' && total.display.match(/([\d,]+(?:\.\d+)?)\s*即将过期/);
  const amount = match ? Number(match[1].replaceAll(',', '')) : null;
  return { amount: natural(amount) && amount > 0 ? amount : null, at };
}

function resetHistoryRecords(provider, history, now) {
  const scanFrom = now - 45 * DAY_MS;
  const result = [];
  const reasons = {};
  const bump = (code, count = 1) => {
    if (count > 0) reasons[code] = (reasons[code] ?? 0) + count;
  };
  const diagnostics = {
    accounts: provider.accounts.length,
    historyAccounts: 0,
    matchedWindows: 0,
    completedResets: 0,
    reasons,
  };
  for (const account of provider.accounts) {
    const limits = account.historyWindows ?? new Map();
    const entries = (Array.isArray(history) ? history : []).filter(entry => entry?.provider === provider.id &&
      account.refs.some(ref => String(entry.user ?? '').toLowerCase() === ref.toLowerCase()));
    if (!entries.length) {
      bump('no-account-history');
      continue;
    }
    diagnostics.historyAccounts++;
    let accountNoResettable = true;
    let completed = 0;
    for (const entry of entries) {
      const lines = (Array.isArray(entry.lines) ? entry.lines : []).flatMap(line => {
        const current = [...limits.values()].find(window =>
          String(window.name ?? '').toLowerCase() === String(line?.name ?? '').toLowerCase());
        const credit = current && (creditUnit.test(current.unit ?? '') ||
          /credits?|points?|积分/i.test(`${current.name ?? ''} ${current.display ?? ''}`));
        return credit && natural(current.limit) && current.limit > 0 && Array.isArray(line.points)
          ? [{ ...line, limit: current.limit, currentName: current.name }] : [];
      });
      // Component windows hold the resettable credits; an aggregate repeats
      // them. WorkBuddy/WorkBuddy AI have one resettable base "Credits" pack.
      let selected = lines.filter(line => !totalWindowName.test(line.name ?? '') &&
        !/^daily pool$/i.test(line.name ?? '') && !/\(est\.\)/i.test(line.name ?? ''));
      if (/^workbuddy(?:-ai)?$/i.test(provider.id)) {
        selected = selected.filter(line => /^credits$/i.test(line.name ?? ''));
      } else if (provider.id === 'raccoon') {
        selected = selected.filter(line => /^credits$/i.test(line.name ?? ''));
      }
      if (!selected.length) selected = lines.filter(line => !/\(est\.\)/i.test(line.name ?? ''));
      if (!selected.length) {
        continue;
      }
      for (const line of selected) {
        accountNoResettable = false;
        diagnostics.matchedWindows++;
        if (!line.points.length) bump('no-history-point');
        const periods = new Map();
        const openResets = new Set();
        let missingTime = false;
        let invalidOrder = false;
        for (const point of line.points) {
          const at = Date.parse(point.at);
          const reset = Date.parse(point.resetsAt);
          if (!Number.isFinite(at) || !Number.isFinite(reset)) {
            missingTime = true;
            continue;
          }
          if (reset > now) {
            openResets.add(reset);
            continue;
          }
          if (reset < scanFrom) continue;
          if (at > reset) {
            invalidOrder = true;
            continue;
          }
          const prior = periods.get(reset);
          if (!prior || at > prior.at) periods.set(reset, { at, left: Number(point.left) });
        }
        if (missingTime) bump('missing-history-time');
        if (invalidOrder) bump('invalid-history-order');
        bump('current-cycle', openResets.size);
        completed += periods.size;
        diagnostics.completedResets += periods.size;
        for (const [reset, point] of periods) {
          if (!natural(point.left)) {
            bump('missing-remaining');
            continue;
          }
          if (point.left > 200) {
            bump('invalid-remaining');
            continue;
          }
          const amount = point.left / 100 * line.limit;
          if (!(amount > 0)) {
            bump('no-unused-credit');
            continue;
          }
          result.push({
            account: account.label,
            window: line.currentName,
            amount,
            at: reset,
            source: 'history-reset-estimate',
            firstObservedAt: point.at,
            lastObservedAt: point.at,
          });
        }
      }
    }
    if (accountNoResettable) bump('no-resettable-window');
    else if (!completed) {
      bump('no-completed-reset');
    }
  }
  return { records: result, diagnostics };
}

function expirationSummary(provider, ledger, history, windowDays, now) {
  const from = now - windowDays;
  const through = now + windowDays;
  const derivedHistory = resetHistoryRecords(provider, history, now);
  const records = derivedHistory.records;
  const historyInWindow = records.filter(record => {
    const at = record.at;
    return at >= now - windowDays && at <= now;
  }).length;
  const olderHistory = records.filter(record => record.at < now - windowDays).length;
  const diagnostics = {
    ...derivedHistory.diagnostics,
    historyInWindow,
    olderHistory,
  };
  for (const record of Array.isArray(ledger?.records) ? ledger.records : []) {
    if (record?.provider !== provider.id || !Number.isFinite(record.at)) continue;
    const account = provider.accounts.find(item => item.refs.some(ref =>
      record.refs?.some(value => String(value).toLowerCase() === ref.toLowerCase())));
    // A provider can retain a historical account after it is removed. Keep
    // the record in the ledger, but do not assign it to a live account.
    records.push({ account: account?.label ?? '历史账号', window: record.window,
      amount: natural(record.amount) && record.amount > 0 ? record.amount : null,
      at: record.at, source: record.source, firstObservedAt: record.firstObservedAt,
      lastObservedAt: record.lastObservedAt });
  }
  // A vendor-stated runsOutAt and a reset-history estimate can describe the
  // same moment. Prefer the direct observation and avoid double counting.
  const exact = records.filter(record => record.source !== 'history-reset-estimate')
    .sort((left, right) => left.at - right.at);
  const derived = records.filter(record => record.source === 'history-reset-estimate' &&
    !exact.some(other => other.account === record.account && other.window === record.window &&
      Math.abs(other.at - record.at) <= 10 * 60_000));
  const merged = [...exact, ...derived];
  const notices = (Array.isArray(ledger?.notices) ? ledger.notices : []).flatMap(notice => {
    if (notice?.provider !== provider.id || !natural(notice.amount) || notice.amount <= 0) return [];
    const account = provider.accounts.find(item => item.refs.some(ref =>
      notice.refs?.some(value => String(value).toLowerCase() === ref.toLowerCase())));
    return [{ account: account?.label ?? '历史账号', amount: notice.amount, text: notice.text,
      window: notice.window, observedAt: notice.observedAt }];
  });
  const expiredRecords = merged.filter(record => record.at <= now && record.at >= from);
  const verifiedExpired = expiredRecords.filter(record => record.amount !== null &&
    Number.isFinite(record.firstObservedAt) && record.firstObservedAt <= record.at + 5 * 60_000 &&
    Number.isFinite(record.lastObservedAt) && record.lastObservedAt <= record.at + 5 * 60_000);
  const upcomingRecords = merged.filter(record => record.at > now && record.at <= through);
  const future = merged.filter(record => record.at > now).sort((left, right) => left.at - right.at);
  const coveredAccounts = new Set([
    ...merged.map(record => record.account),
    ...notices.map(notice => notice.account),
  ]).size;
  return {
    expired: {
      total: verifiedExpired.reduce((sum, record) => sum + record.amount, 0),
      records: verifiedExpired.sort((left, right) => right.at - left.at),
      unconfirmed: expiredRecords.length - verifiedExpired.length,
      estimated: verifiedExpired.filter(record => record.source === 'history-reset-estimate').length,
    },
    upcoming: {
      total: upcomingRecords.reduce((sum, record) => sum + (record.amount ?? 0), 0),
      records: upcomingRecords.sort((left, right) => left.at - right.at),
      unknownAmount: upcomingRecords.filter(record => record.amount === null).length,
    },
    next: future[0] ?? null,
    later: future.filter(record => record.at > through),
    notices,
    coveredAccounts,
    accounts: provider.accounts.length,
    status: merged.length || notices.length ? 'ok' : 'none',
    diagnostics,
    since: Number.isFinite(ledger?.since) ? ledger.since : null,
    observedAt: Math.max(...records.map(record => record.lastObservedAt),
      ...notices.map(notice => notice.observedAt), 0) || null,
  };
}

function modelMap(provider, entries, catalogEntries) {
  const catalogModels = new Map((Array.isArray(catalogEntries) ? catalogEntries : [])
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => [String(entry.id ?? '').trim().toLowerCase(), entry]));
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    // Account catalogs list plain ids; the provider-level catalog carries
    // the official multipliers and discounts for those same ids.
    const raw = typeof entry === 'string' ? entry : entry?.id;
    const details = typeof entry === 'string' ? catalogModels.get(raw.trim().toLowerCase()) ?? {} : entry;
    const id = modelId(provider, raw);
    if (id) map.set(id, { name: details.name || id, free: details.free === true,
      rate: natural(details.rate) && details.rate > 0 ? details.rate : null,
      rateWas: natural(details.rateWas) && details.rateWas > 0 ? details.rateWas : null,
      offer: natural(details.rate) && details.rate < details.rateWas ? { rate: details.rate, was: details.rateWas } : null });
  }
  return map;
}

function addUsage(index, model, tokens, credits, multiplier, coefficient = null) {
  const item = index.get(model) ?? { tokens: 0, billedTokens: 0, credits: 0, samples: 0,
    normalizedCredits: 0, normalizedTokens: 0, normalizedSamples: 0,
    allTokens: 0, calibratedTokens: 0, coefficientTokens: 0, cacheTokens: 0 };
  item.tokens += tokens;
  item.allTokens += tokens;
  if (coefficient > 0) {
    item.calibratedTokens += tokens;
    item.coefficientTokens += tokens * coefficient;
  }
  if (tokens > 0 && natural(credits) && credits > 0) {
    item.credits += credits;
    item.billedTokens += tokens;
    item.samples++;
    if (multiplier) {
      item.normalizedCredits += credits / multiplier;
      item.normalizedTokens += tokens;
      item.normalizedSamples++;
    }
  }
  index.set(model, item);
}

function addCache(index, model, cached) {
  const item = index.get(model);
  if (item) item.cacheTokens += cached;
}

function rateOf(item, period, rule) {
  if (period === 'recent' && item?.samples >= MIN_SAMPLES) {
    return { value: item.credits * MILLION / item.billedTokens, source: 'observed', samples: item.samples };
  }
  if (period !== 'recent' && rule && item?.normalizedSamples >= MIN_SAMPLES) {
    return { value: item.normalizedCredits * MILLION / item.normalizedTokens * rule[period],
      source: 'rule-observed', samples: item.normalizedSamples };
  }
  if (period !== 'recent' && !rule && item?.samples >= MIN_SAMPLES) {
    return { value: item.credits * MILLION / item.billedTokens, source: 'observed-average', samples: item.samples };
  }
  return null;
}

function catalogRate(provider, id, account) {
  const own = account?.models.get(id)?.rate;
  if (own > 0) return own * provider.priceRate;
  for (const account of provider.accounts) {
    const value = account.models.get(id)?.rate;
    if (natural(value) && value > 0) return value * provider.priceRate;
  }
  return null;
}

function anchorRate(source, rule) {
  return rule?.anchor ?? (rule && Math.abs(source - rule.offpeak) < 1e-9 ? rule.offpeak : rule?.peak ?? source);
}

// Catalog rates are relative coefficients; the scale comes from this supplier's own ledger.
function officialRate(provider, id, period, rule) {
  const source = catalogRate(provider, id, provider.rateAccount);
  if (!source || !provider.learnedScale) return null;
  const measured = provider.usage.get(id);
  const coefficient = !rule ? source : period === 'recent'
    ? (measured?.coefficientTokens > 0 ? measured.coefficientTokens / measured.calibratedTokens : source)
    : source * rule[period] / anchorRate(source, rule);
  return { value: provider.learnedScale * coefficient,
    source: rule ? 'rule-learned-catalog' : 'learned-catalog' };
}

function clockMinutes(value) {
  const match = typeof value === 'string' && value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 24 && minute >= 0 && minute < 60 && (hour < 24 || minute === 0)
    ? hour * 60 + minute : null;
}

function customWindows(provider) {
  const windows = [];
  for (const item of Array.isArray(provider.rateWindows) ? provider.rateWindows : []) {
    const start = clockMinutes(item?.start);
    const end = clockMinutes(item?.end);
    const rate = Number(item?.rate);
    if (start === null || start === 1440 || end === null || start === end || !natural(rate) || !(rate > 0) || rate > 1000) continue;
    const days = Array.isArray(item.days)
      ? [...new Set(item.days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))] : [];
    windows.push({ start, end, rate, days });
  }
  return windows.slice(0, 8);
}

function windowMultiplier(windows, time) {
  if (!windows.length) return null;
  const at = new Date(time);
  const minute = at.getHours() * 60 + at.getMinutes();
  for (const window of windows) {
    const crossesMidnight = window.start > window.end;
    const inside = crossesMidnight
      ? minute >= window.start || minute < window.end
      : minute >= window.start && minute < window.end;
    if (!inside) continue;
    const day = (at.getDay() + (crossesMidnight && minute < window.end ? 6 : 0)) % 7;
    if (!window.days.length || window.days.includes(day)) return window.rate;
  }
  return 1;
}

function timeRule(provider, id) {
  const windows = customWindows(provider);
  if (!windows.length) return pricingRule(provider.id, id);
  const rates = [1, ...windows.map(window => window.rate)];
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const describe = window => {
    const start = String(Math.floor(window.start / 60)).padStart(2, '0') + `:${String(window.start % 60).padStart(2, '0')}`;
    const end = window.end === 1440 ? '24:00'
      : String(Math.floor(window.end / 60)).padStart(2, '0') + `:${String(window.end % 60).padStart(2, '0')}`;
    const when = window.days.length ? window.days.map(day => days[day]).join('、') : '每天';
    return `${when} ${start}–${end} ×${window.rate}`;
  };
  return {
    peak: Math.max(...rates), offpeak: Math.min(...rates), anchor: 1,
    hours: windows.map(describe).join('；'), url: null, custom: true,
  };
}

function sampleRateMultiplier(provider, id, time) {
  const windows = customWindows(provider);
  if (windows.length) return windowMultiplier(windows, time);
  return sampleMultiplier(pricingRule(provider.id, id), time);
}

function learnedScale(usage, drop) {
  const weighted = [...usage.values()].reduce((sum, item) => sum + item.coefficientTokens, 0);
  return drop > 0 && weighted > 0 ? drop * MILLION / weighted : null;
}

function autoRate(provider, id, preferences, period) {
  const rule = timeRule(provider, id);
  const manual = preferences.rates?.[provider.id]?.[id] ?? {};
  const direct = manual[period];
  const other = period === 'peak' ? 'offpeak' : 'peak';
  if (natural(direct) && direct > 0) return { value: direct, source: 'manual', manual };
  if (period === 'recent' && natural(manual.recent) && manual.recent > 0) {
    return { value: manual.recent, source: 'manual', manual };
  }
  if (period !== 'recent' && rule && natural(manual[other]) && manual[other] > 0) {
    return { value: manual[other] * rule[period] / rule[other], source: 'rule-manual', manual };
  }
  if (period !== 'recent' && !rule && natural(manual.recent) && manual.recent > 0) {
    return { value: manual.recent, source: 'manual', manual };
  }
  const observed = rateOf(provider.usage.get(id), period, rule);
  if (observed) return { ...observed, manual };
  const official = officialRate(provider, id, period, rule);
  return official ? { ...official, manual } : null;
}

function accountModelRate(provider, account, id, preferences, period, rate) {
  if (rate?.source === 'manual') return rate;
  const scoped = { ...provider, usage: account.usage, rateAccount: account };
  if (account.learnedScale) scoped.learnedScale = account.learnedScale;
  const effective = autoRate(scoped, id, preferences, period) ?? rate;
  return effective && !account.learnedScale && ['learned-catalog', 'rule-learned-catalog'].includes(effective.source)
    ? { ...effective, value: effective.value * account.keyRate } : effective;
}

function modelEstimate(provider, id, preferences, period) {
  const rule = timeRule(provider, id);
  const rate = autoRate(provider, id, preferences, period);
  const manual = preferences.rates?.[provider.id]?.[id] ?? {};
  let tokens = null;
  let covered = 0;
  let eligible = 0;
  let uncertain = 0;
  let free = 0;
  let offer = null;
  for (const account of provider.accounts) {
    const supported = account.models.get(id);
    if (!supported) {
      if (!account.catalogKnown) uncertain++;
      continue;
    }
    if (supported.free) { free++; continue; }
    offer ??= supported.offer;
    eligible++;
    const effective = accountModelRate(provider, account, id, preferences, period, rate);
    if (account.balance === null || (!effective && account.balance > 0)) continue;
    tokens = (tokens ?? 0) + (account.balance === 0 ? 0 : account.balance * MILLION / effective.value);
    covered++;
  }
  if (tokens === 0 && covered < eligible) tokens = null;
  const status = tokens !== null ? (covered === eligible && !uncertain ? 'ok' : 'partial')
    : eligible ? 'missing-rate-or-balance' : free ? 'free' : uncertain ? 'unknown-model' : 'unsupported';
  return { tokens, rate, covered, eligible, status, manual, offer, rule: rule ? {
    hours: rule.hours, ratio: rule.offpeak / rule.peak, url: rule.url, custom: rule.custom === true,
  } : null };
}

function aggregateEstimate(provider, ids, modelSummary, period, preferences) {
  const slot = period === 'recent' ? 'recentEstimate' : period;
  const estimates = ids.map(id => modelSummary[id]?.[slot]);
  if (ids.length === 1) return { ...estimates[0], models: ids };
  let tokens = null;
  let balance = 0;
  let covered = 0;
  let eligible = 0;
  let partial = estimates.some(estimate => estimate?.status !== 'ok');
  for (const account of provider.accounts) {
    const supported = ids.filter(id => account.models.has(id) && !account.models.get(id).free);
    if (!supported.length) continue;
    eligible++;
    if (account.balance === null) continue;
    const rated = supported.map(id => ({ id,
      rate: accountModelRate(provider, account, id, preferences, period, modelSummary[id][slot].rate)?.value,
    })).filter(item => item.rate > 0);
    if (rated.length < supported.length && account.balance > 0) partial = true;
    if (!rated.length && account.balance > 0) continue;
    covered++;
    balance += account.balance;
    tokens ??= 0;
    if (account.balance === 0) continue;
    for (const item of rated) item.weight = account.usage.get(item.id)?.tokens ?? 0;
    if (!rated.some(item => item.weight > 0)) {
      for (const item of rated) item.weight = modelSummary[item.id].recent;
    }
    if (!rated.some(item => item.weight > 0)) for (const item of rated) item.weight = 1;
    const weight = rated.reduce((sum, item) => sum + item.weight, 0);
    const weightedRate = rated.reduce((sum, item) => sum + item.rate * item.weight, 0) / weight;
    tokens += account.balance * MILLION / weightedRate;
  }
  if (tokens === 0 && covered < eligible) tokens = null;
  const status = tokens !== null ? partial ? 'partial' : 'ok'
    : eligible ? 'missing-rate-or-balance' : estimates.some(estimate => estimate?.status === 'unknown-model') ? 'unknown-model'
      : estimates.some(estimate => estimate?.status === 'free') ? 'free' : 'unsupported';
  return { tokens, status, covered, eligible, models: ids,
    rate: tokens > 0 ? { value: balance * MILLION / tokens, source: 'aggregate' } : null };
}

function classifyCredit(card, amount) {
  return CREDIT_PROVIDERS.has(card.provider) || amount !== null ||
    creditUnit.test(card.unit ?? '') || card.windows?.some(w => creditUnit.test(w.unit ?? ''));
}

function counterSpend(provider, dailyIndex, creditReadings, now) {
  const result = new Map();
  for (const account of provider.accounts) {
    if (!account.refs.length) continue;
    const spend = readAccountSpend(provider.id, account.refs, dailyIndex, creditReadings, now);
    result.set(account.label, spend);
  }
  return result;
}

const spendTotal = values => values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);

function spendSource(entry, accountLabel) {
  if (accountLabel) return entry.accounts?.[accountLabel] ?? null;
  return entry;
}

function requestSpendOf(source, peak, offpeak, rule) {
  const actual = Math.max(0, Number(source?.actual) || 0);
  const estimate = buckets => Object.entries(buckets ?? {}).reduce((sum, [key, tokens]) => {
    const multiplier = Number(key);
    const rate = rule && multiplier === rule.offpeak ? offpeak?.value
      : rule && multiplier > 0 ? (peak?.value ?? 0) * multiplier / rule.peak : peak?.value;
    return sum + tokens * (rate ?? 0) / MILLION;
  }, 0);
  const beforeTodayActual = Math.max(0, actual - (source.todayActual ?? 0));
  return { actual, estimated: estimate(source.unpricedByRate), beforeTodayActual,
    beforeToday: beforeTodayActual + estimate(source.priorUnpricedByRate), tokens: source.tokens,
    outsideCounter: source.outsideCounter ?? 0, afterSnapshot: source.afterSnapshot ?? 0 };
}

// Allocate one account's authoritative counter to the models that account
// actually called. Request-level actual credits are preserved; only the
// unpriced remainder is scaled to the counter. A counter larger than the
// request estimate stays visible as unallocated spend instead of being
// invented across models.
function allocateSpendGroup(entries, accountLabel, budgetInfo, provider, preferences) {
  const account = provider?.accounts.find(item => item.label === accountLabel);
  const rows = entries.map(entry => {
    const source = spendSource(entry, accountLabel);
    if (!source) return null;
    const peak = account ? accountModelRate(provider, account, entry.id, preferences, 'peak', entry.rate) : entry.rate;
    const offpeak = account ? accountModelRate(provider, account, entry.id, preferences, 'offpeak', entry.offpeakRate) : entry.offpeakRate;
    const request = requestSpendOf(source, peak, offpeak, timeRule(provider, entry.id));
    return request.tokens || request.actual || request.estimated
      ? { id: entry.id, ...request } : null;
  }).filter(Boolean);
  const actual = spendTotal(rows.map(row => row.actual));
  const estimated = spendTotal(rows.map(row => row.estimated));
  const request = actual + estimated;
  const { value: budget, daily, snapshot } = budgetInfo ?? {};
  const beforeToday = spendTotal(rows.map(row => row.beforeToday));
  const outsideCounter = spendTotal(rows.map(row => row.outsideCounter));
  const afterSnapshot = spendTotal(rows.map(row => row.afterSnapshot));
  const measured = daily !== undefined
    ? Math.max(daily + outsideCounter + spendTotal(rows.map(row => row.beforeTodayActual)), (snapshot ?? 0) + afterSnapshot)
    : budgetInfo?.authoritative ? budget + outsideCounter : (budget ?? 0) + afterSnapshot;
  const target = daily !== undefined ? Math.max(actual, daily + outsideCounter + beforeToday, measured)
    : budgetInfo?.authoritative ? Math.max(measured, actual) : Math.max(request, measured);
  const scale = target < request && estimated > 0 ? Math.max(0, (target - actual) / estimated) : 1;
  const allocated = rows.map(row => ({ ...row, estimated: row.estimated * scale }));
  return { rows: allocated, total: target, actual, measured: Math.max(actual, measured) };
}

function residualSpendEntries(entries, accounts) {
  return entries.map(entry => {
    const residual = { ...entry, accounts: undefined,
      unpricedByRate: { ...entry.unpricedByRate }, priorUnpricedByRate: { ...entry.priorUnpricedByRate } };
    for (const account of accounts) {
      const source = entry.accounts?.[account.label];
      if (!source) continue;
      residual.actual -= source.actual;
      residual.tokens -= source.tokens;
      residual.todayActual -= source.todayActual;
      for (const field of ['unpricedByRate', 'priorUnpricedByRate']) {
        for (const [rate, value] of Object.entries(source[field] ?? {})) {
          residual[field][rate] = Math.max(0, (residual[field][rate] ?? 0) - value);
        }
      }
    }
    return { ...residual, actual: Math.max(0, residual.actual), tokens: Math.max(0, residual.tokens) };
  }).filter(entry => entry.actual || entry.tokens);
}

function accountSpendBudget(accountSpend, window, today) {
  if (!accountSpend) return null;
  if (window === '24h') {
    const daily = accountSpend.days.get(today) ?? 0;
    if (daily > 0) return { value: Math.max(daily, accountSpend.last24h ?? 0),
      daily, snapshot: accountSpend.last24h };
    if (accountSpend.last24h !== null) return { value: accountSpend.last24h, authoritative: false };
    return null;
  }
  const value = accountSpend.totals[window];
  return value == null ? null : { value, authoritative: true };
}

function recordSpend(item, tokens, credits, multiplier, today, outsideCounter, afterSnapshot) {
  item.tokens += tokens;
  item.requests++;
  if (credits !== null) {
    item.actual += credits;
    item.priced++;
    if (today) item.todayActual += credits;
    if (outsideCounter) item.outsideCounter = (item.outsideCounter ?? 0) + credits;
    if (afterSnapshot) item.afterSnapshot = (item.afterSnapshot ?? 0) + credits;
    return;
  }
  const key = multiplier ?? 0;
  const totals = item.unpricedByRate ??= {};
  totals[key] = (totals[key] ?? 0) + tokens;
  if (!today) {
    const prior = item.priorUnpricedByRate ??= {};
    prior[key] = (prior[key] ?? 0) + tokens;
  }
}

export function buildReport({ cards, catalog, usage, dailyCredits = {}, creditReadings = {},
  expirationLedger = {}, quotaHistory = [], quotaHistoryStatus = 'ok', checkedModels = {},
  providerConfigs = [], preferences = {}, now = Date.now() }) {
  const period = PERIODS.includes(preferences.period) ? preferences.period : 'recent';
  const expiryWindow = Object.hasOwn(EXPIRY_WINDOWS, preferences.expiryWindow) ? preferences.expiryWindow : '45d';
  const providers = new Map();
  const providerCatalog = new Map(catalog.map(p => [p.id, p]));
  const providerSettings = new Map((Array.isArray(providerConfigs) ? providerConfigs : [])
    .filter(provider => safeProviderId(provider?.id))
    .map(provider => [provider.id, provider]));
  const dailyIndex = indexDailyCredits(dailyCredits);
  const names = new Map();
  const cardKeys = new Set();
  for (const card of cards) {
    if (!card.provider) continue;
    const key = JSON.stringify([card.provider, card.user ?? '', card.user ? '' : card.name ?? '']);
    if (cardKeys.has(key)) continue;
    cardKeys.add(key);
    const balance = cardBalance(card, now);
    if (!classifyCredit(card, balance)) continue;
    const source = providerCatalog.get(card.provider);
    let provider = providers.get(card.provider);
    if (!provider) {
      const settings = providerSettings.get(card.provider);
      const priceRate = Number(settings?.priceRate);
      provider = { id: card.provider, name: card.name || source?.name || card.provider, accounts: [], usage: new Map(),
        priceRate: natural(priceRate) && priceRate > 0 && priceRate <= 1000 ? priceRate : 1,
        rateWindows: Array.isArray(settings?.rateWindows) ? settings.rateWindows : [],
        checked: Array.isArray(checkedModels?.[card.provider])
          ? new Set(checkedModels[card.provider].map(value => modelId(card.provider, value)).filter(Boolean)) : null,
        spend: Object.fromEntries(Object.keys(SPEND_WINDOWS).map(window => [window, { total: 0, models: {} }])) };
      providers.set(card.provider, provider);
    }
    const account = source?.accounts?.find(a => a.accountId && [card.user, card.alias]
      .some(value => value && a.accountId.toLowerCase() === String(value).toLowerCase()));
    // Account-specific catalogs take precedence, including an explicitly empty list.
    const entries = account?.models ?? (account || !source?.accounts?.length ? source?.models : null);
    const models = modelMap(card.provider, entries, source?.models);
    const configuredKeyRate = Number(providerSettings.get(card.provider)?.keyPriceRates?.[account?.key]);
    const keyRate = natural(configuredKeyRate) && configuredKeyRate > 0 && configuredKeyRate <= 1000
      ? configuredKeyRate / provider.priceRate : 1;
    const label = `账号 ${provider.accounts.length + 1}`;
    provider.accounts.push({ refs: [card.user, card.alias].filter(Boolean), label, balance,
      readAt: card.readAt ?? card.asOf ?? null, catalogKnown: Array.isArray(entries), models, usage: new Map(),
      keyId: account?.key ?? null, keyRate, expiring: cardExpiring(card, now),
      historyWindows: new Map((card.windows ?? []).filter(window => typeof window?.name === 'string')
        .map(window => [window.name, window])) });
  }

  for (const provider of providers.values()) provider.counterSpend = counterSpend(provider, dailyIndex, creditReadings, now);
  const seen = new Set();
  const dayStart = creditDayStart(now);
  const spendStarts = { '24h': now - DAY_MS, '7d': dayStart - 6 * DAY_MS, '30d': dayStart - 29 * DAY_MS };
  for (const row of usage) {
    const at = Date.parse(row.t);
    if (!providers.has(row.provider) || !(row.status >= 200 && row.status < 300) ||
        (row.source && row.source !== 'gateway') || !(at >= now - 30 * DAY_MS && at <= now)) continue;
    const id = modelId(row.provider, row.served || row.model);
    if (!id || (row.rid && seen.has(row.rid))) continue;
    if (row.rid) seen.add(row.rid);
    const provider = providers.get(row.provider);
    const accountId = typeof row.providerAccount === 'string' ? row.providerAccount.toLowerCase() : null;
    const account = accountId ? provider.accounts.find(a => a.refs.some(ref => ref.toLowerCase() === accountId))
      : provider.accounts.length === 1 ? provider.accounts[0] : null;
    const credits = natural(row.credits) ? row.credits : null;
    const free = credits === 0 || (account?.models.get(id)?.free ?? provider.accounts.some(a => a.models.get(id)?.free));
    const tokens = [row.in, row.out, row.cache_read, row.cache_write].reduce((sum, n) => sum + (natural(n) ? n : 0), 0);
    const cached = [row.cache_read, row.cache_write].reduce((sum, n) => sum + (natural(n) ? n : 0), 0);
    const multiplier = sampleRateMultiplier(provider, id, at);
    if (!names.has(id)) names.set(id, id);
    const counter = account && provider.counterSpend.get(account.label);
    const afterCounter = counter?.lastCounterAt != null && at > counter.lastCounterAt;
    const beforeCounter = counter?.since && at < Date.parse(`${counter.since}T00:00:00+08:00`);
    const afterSnapshot = counter?.snapshotThrough != null && at > counter.snapshotThrough;
    for (const [window, start] of Object.entries(spendStarts)) {
      if (at < start) continue;
      const bucket = provider.spend[window];
      const model = bucket.models[id] ??= {
        actual: 0, tokens: 0, requests: 0, priced: 0, todayActual: 0,
        accounts: {},
      };
      recordSpend(model, tokens, credits ?? (free ? 0 : null), multiplier, at >= dayStart);
      if (account) {
        const accountModel = model.accounts[account.label] ??= {
          actual: 0, tokens: 0, requests: 0, priced: 0, todayActual: 0,
        };
        recordSpend(accountModel, tokens, credits ?? (free ? 0 : null), multiplier, at >= dayStart,
          window === '24h' ? at >= dayStart && afterCounter : afterCounter || beforeCounter, afterSnapshot);
      }
    }
    if (at < spendStarts['7d']) continue;
    // Magpie records input, output and the cache buckets independently. The
    // reasoning counter can be an output detail, so it is not added again.
    const firstDay = counter?.since ? Date.parse(`${counter.since}T00:00:00+08:00`) : spendStarts['7d'];
    let coefficient = null;
    if (counter?.totals['7d'] > 0 && at >= firstDay && at <= (counter.through ?? now) && !free) {
      const source = catalogRate(provider, id, account);
      const rule = timeRule(provider, id);
      if (source && (!rule || multiplier)) coefficient = rule ? source * multiplier / anchorRate(source, rule) : source;
      else account.calibrationIncomplete = true;
    }
    addUsage(provider.usage, id, tokens, row.credits, multiplier, coefficient);
    addCache(provider.usage, id, cached);
    if (account) {
      addUsage(account.usage, id, tokens, row.credits, multiplier, coefficient);
      addCache(account.usage, id, cached);
      if (!account.catalogKnown) account.models.set(id, { name: id, free: false });
    }
  }

  for (const provider of providers.values()) {
    let drop = 0;
    let covered = !provider.accounts.some(account => account.calibrationIncomplete);
    for (const account of provider.accounts) {
      const spend = provider.counterSpend.get(account.label);
      const total = spend?.totals['7d'];
      account.learnedScale = account.calibrationIncomplete ? null : learnedScale(account.usage, total);
      if (total == null || (total > 0 && !account.learnedScale)) covered = false;
      drop += total ?? 0;
    }
    provider.learnedScale = covered ? learnedScale(provider.usage, drop) : null;
  }
  const summaries = [];
  const sold = new Map();
  for (const provider of providers.values()) {
    const ids = new Set();
    for (const account of provider.accounts) {
      for (const [id, details] of account.models) {
        ids.add(id);
        if (!names.has(id) || names.get(id) === id) names.set(id, details.name);
      }
    }
    const accounts = provider.accounts.map(({ label, readAt, balance, expiring }) => ({ label, readAt, balance, expiring }));
    const known = accounts.filter(account => account.balance !== null);
    const balance = known.length ? known.reduce((sum, a) => sum + a.balance, 0) : null;
    const models = Object.fromEntries([...ids].map(id => {
    const peak = modelEstimate(provider, id, preferences, 'peak');
    const offpeak = modelEstimate(provider, id, preferences, 'offpeak');
    const recentEstimate = modelEstimate(provider, id, preferences, 'recent');
    const estimate = period === 'offpeak' ? offpeak : period === 'recent' ? recentEstimate : peak;
    sold.set(id, (sold.get(id) ?? 0) + (provider.usage.get(id)?.tokens ?? 0));
    const usageItem = provider.usage.get(id);
    const listed = !provider.checked || provider.checked.has(id);
    const hide = slot => listed ? slot : { ...slot, eligible: 0, tokens: null };
    return [id, { ...hide(estimate), peak: hide(peak), offpeak: hide(offpeak), recentEstimate: hide(recentEstimate),
      recent: usageItem?.tokens ?? 0,
      cacheShare: usageItem?.allTokens > 0 ? usageItem.cacheTokens / usageItem.allTokens : null,
      // The Magpie provider page's checked list bounds the forecast surface;
      // account catalogs may still list every SKU the account can call.
      checked: listed }];
    }));
    provider.modelSummary = models;
    const spend = Object.fromEntries(Object.entries(provider.spend).map(([window, bucket]) => {
      const entries = Object.entries(bucket.models).map(([id, item]) => {
        const peakRate = models[id]?.peak?.rate;
        const recentRate = models[id]?.rate;
        const estimatedRate = peakRate ?? recentRate;
        return { ...item, id, name: names.get(id) ?? id,
          priced: item.priced, unpriced: item.requests - item.priced, todayActual: item.todayActual,
          rate: estimatedRate, offpeakRate: models[id]?.offpeak?.rate };
      });
      const today = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
      const accountGroups = provider.accounts.map(account => {
        const accountSpend = provider.counterSpend.get(account.label);
        const budgetInfo = accountSpendBudget(accountSpend, window, today);
        return { account, budgetInfo, hasCounter: budgetInfo !== null, accountSpend };
      });
      const knownGroups = accountGroups.filter(group => group.hasCounter);
      const groups = [];
      for (const group of accountGroups) {
        const hasRows = entries.some(entry => entry.accounts[group.account.label]);
        if (group.hasCounter || hasRows) {
          groups.push(allocateSpendGroup(entries, group.account.label, group.budgetInfo, provider, preferences));
        }
      }
      const residual = residualSpendEntries(entries, provider.accounts);
      const namedTotal = spendTotal(groups.map(group => group.total));
      const namedMeasured = spendTotal(groups.map(group => group.measured));
      if (residual.length) groups.push(allocateSpendGroup(residual, null, null, provider, preferences));
      const loggedActual = spendTotal(groups.map(group => group.actual));
      // The unattributed calls may already be included in official counters.
      // Preserve known request charges as a floor, without adding both sources.
      const overlapping = residual.length > 0 && knownGroups.length > 0;
      const total = overlapping ? Math.max(namedTotal, loggedActual) : spendTotal(groups.map(group => group.total));
      const actual = overlapping ? Math.max(namedMeasured, loggedActual) : spendTotal(groups.map(group => group.measured));
      const assignedEstimate = spendTotal(groups.flatMap(group => group.rows.map(row => row.estimated)));
      const scale = assignedEstimate > 0 ? Math.max(0, Math.min(1, (total - loggedActual) / assignedEstimate)) : 1;
      const allocated = new Map();
      for (const group of groups) {
        for (const row of group.rows) {
          const item = allocated.get(row.id) ?? { credits: 0, actual: 0, estimated: 0 };
          item.credits += row.actual + row.estimated * scale;
          item.actual += row.actual;
          item.estimated += row.estimated * scale;
          allocated.set(row.id, item);
        }
      }
      const spendModels = entries.map(({ unpricedByRate, priorUnpricedByRate, offpeakRate, ...item }) => {
        const value = allocated.get(item.id);
        return { ...item, credits: value?.credits ?? 0, actual: value?.actual ?? 0,
          estimated: value?.estimated ?? 0 };
      }).sort((left, right) => right.credits - left.credits || left.id.localeCompare(right.id));
      const unallocated = Math.max(0, total - spendTotal(spendModels.map(item => item.credits)));
      const counterPartial = knownGroups.length < provider.accounts.length || overlapping ||
        (window !== '24h' && knownGroups.some(group => group.accountSpend.since &&
          Date.parse(`${group.accountSpend.since}T00:00:00+08:00`) > spendStarts[window]));
      const readTimes = knownGroups.map(group => group.accountSpend?.through).filter(Number.isFinite);
      const through = readTimes.length ? Math.min(...readTimes) : null;
      const basis = knownGroups.length
        ? window === '24h' ? (counterPartial ? 'snapshot-partial' : 'snapshot')
          : (counterPartial ? 'counter-partial' : 'counter')
        : entries.some(item => item.priced > 0) ? 'request' : total > 0 ? 'request-estimate' : 'none';
      return [window, { total, actual: Math.min(total, actual),
        estimated: Math.max(0, total - Math.min(total, actual)), unallocated,
        basis, partial: counterPartial, through, unattributed: overlapping, models: spendModels }];
    }));
    const expiryWindows = Object.fromEntries(Object.entries(EXPIRY_WINDOWS).map(([key, span]) => [
      key, expirationSummary(provider, expirationLedger, quotaHistory, span, now),
    ]));
    summaries.push({ id: provider.id, name: provider.name, enabled: preferences.enabled?.[provider.id] !== false,
      balance, unknown: accounts.length - known.length,
      modelCoverageUnknown: provider.accounts.some(a => !a.catalogKnown), accounts, models, spend,
      expiry: expiryWindows[expiryWindow], expiryWindows });
  }
  const models = [...sold].filter(([id]) => summaries.some(item => item.models[id]?.checked))
    .map(([id, recent]) => ({ id, name: names.get(id), recent }))
    .sort((a, b) => b.recent - a.recent || a.id.localeCompare(b.id));
  const selectedModel = models.some(m => m.id === preferences.model) ? preferences.model
    : models.some(m => m.id === 'kimi-k3.1-pro') ? 'kimi-k3.1-pro' : models[0]?.id ?? null;
  const base = summaries.find(x => x.id === preferences.base) ?? summaries.find(x => x.id === 'workbuddy') ?? summaries[0];
  const baseModel = base && Object.hasOwn(base.models, preferences.baseModel) &&
    base.models[preferences.baseModel].checked ? preferences.baseModel : null;
  const mappings = base && baseModel ? preferences.mappings?.[base.id]?.[baseModel] ?? {} : {};
  for (const item of summaries) {
    item.shared = [];
    item.bridge = null;
    item.selectedBridge = null;
    item.equivalent = null;
    item.equivalents = null;
    if (item.id === base.id) {
      item.bridge = baseModel;
      item.equivalent = baseModel ? item.balance : null;
      item.equivalents = baseModel ? { peak: item.balance, offpeak: item.balance } : null;
      continue;
    }
    if (!baseModel || !base.models[baseModel]?.eligible) continue;
    item.shared = models.filter(({ id }) => item.models[id]?.eligible && item.models[id]?.checked && id === baseModel).map(({ id }) => id);
    const selected = Object.hasOwn(mappings, item.id) ? mappings[item.id] : preferences.bridges?.[base.id]?.[item.id];
    const selectedIds = Array.isArray(selected) ? selected : selected ? [selected] : [];
    item.selectedBridges = [...new Set(selectedIds.map(value => modelId(item.id, value))
      .filter(value => value && Object.hasOwn(item.models, value) && item.models[value].checked))];
    item.selectedBridge = item.selectedBridges[0] ?? null;
    item.bridge = item.selectedBridge;
    const timing = period === 'recent' ? 'recent' : period;
    const baseEstimate = timing === 'recent'
      ? base.models[baseModel]?.recentEstimate : base.models[baseModel]?.[timing];
    const rate = baseEstimate?.rate;
    const sourceProvider = providers.get(item.id);
    const aggregate = item.selectedBridges.length
      ? aggregateEstimate(sourceProvider, item.selectedBridges, item.models, timing, preferences) : null;
    if (aggregate && aggregate.tokens !== null && rate) {
      item.aggregate = aggregate;
      item.equivalent = aggregate.tokens * rate.value / MILLION;
    } else {
      item.aggregate = aggregate;
    }
    // Peak and offpeak equivalents use the base provider's own rate for the
    // same period, so both totals stay in one consistent credit unit.
    const equivalents = {};
    const equivalentStatuses = {};
    for (const slot of ['peak', 'offpeak']) {
      const slotAggregate = item.selectedBridges.length
        ? aggregateEstimate(sourceProvider, item.selectedBridges, item.models, slot, preferences) : null;
      const slotRate = base.models[baseModel]?.[slot]?.rate;
      equivalents[slot] = slotAggregate?.tokens != null && slotRate
        ? slotAggregate.tokens * slotRate.value / MILLION : null;
      equivalentStatuses[slot] = slotAggregate?.status ?? null;
    }
    item.equivalents = equivalents;
    item.equivalentStatuses = equivalentStatuses;
  }
  // Token view: names differ across providers, so each provider aggregates the
  // aliases the user selects for the target model. Same-name matches default
  // in; an explicit (even empty) saved selection is authoritative.
  for (const item of summaries) {
    const sourceProvider = providers.get(item.id);
    const saved = preferences.tokenMappings?.[selectedModel]?.[item.id];
    const sameName = item.models[selectedModel]?.eligible && item.models[selectedModel]?.checked ? [selectedModel] : [];
    const chosen = Array.isArray(saved) ? saved : sameName;
    item.tokenBridges = [...new Set(chosen.map(value => modelId(item.id, value))
      .filter(value => value && item.models[value]?.eligible && item.models[value]?.checked))];
    const peak = item.tokenBridges.length
      ? aggregateEstimate(sourceProvider, item.tokenBridges, item.models, 'peak', preferences) : null;
    const offpeak = item.tokenBridges.length
      ? aggregateEstimate(sourceProvider, item.tokenBridges, item.models, 'offpeak', preferences) : null;
    const recentEstimate = item.tokenBridges.length
      ? aggregateEstimate(sourceProvider, item.tokenBridges, item.models, 'recent', preferences) : null;
    const recent = item.tokenBridges.reduce((sum, id) => sum + (item.models[id]?.recent ?? 0), 0);
    const cacheWeighted = item.tokenBridges.reduce((sum, id) =>
      sum + (item.models[id]?.cacheShare ?? 0) * (item.models[id]?.recent ?? 0), 0);
    item.tokenPlan = { peak, offpeak, recentEstimate, recent, cacheShare: recent > 0 ? cacheWeighted / recent : null };
  }
  return { now, period, base: base?.id ?? null, baseModel, providers: summaries, models,
    spendWindow: Object.hasOwn(SPEND_WINDOWS, preferences.spendWindow) ? preferences.spendWindow : '24h',
    expiryWindow, quotaHistoryStatus, selectedModel };
}
