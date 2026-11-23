import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './atomic.mjs';
import {
  resolveQuotas, normalizeUsage, normalizeUsageSummary, sanitizeCachedLabels,
  sanitizeCachedSummary, shanghaiDay, project, providerFamily, accountKey, namedQuotaSubscriptions,
  todayContext, usageForCard, cardName, orderedWith, selectedWith as selectedCards, displayOptions,
} from './normalize.mjs';

// The snapshot of the service is good for a minute. A reading that arrives
// later waits for the refresh that is running, and waits at most a few
// seconds for it.
const SNAPSHOT_TTL_MS = 60_000;
const MAX_WAIT_MS = 2_500;
// The plain quota answer is asked for at most once every half a minute, so a
// service that keeps finding nothing does not hammer the gateway.
const PLAIN_QUOTA_GAP_MS = 30_000;
// After ten minutes without a reader the service slows down; after half an
// hour it stops asking on its own and waits to be asked.
const IDLE_AFTER_MS = 10 * 60_000;
const IDLE_STOP_MS = 30 * 60_000;
const IDLE_CHECK_MS = 5 * 60_000;

// How often the service reads on its own. The user may pick a fixed rhythm
// instead; the smart one keeps the reading fresh while somebody is watching.
export const REFRESH_STRATEGIES = {
  smart: {
    id: 'smart', label: '智能更新', intervalMs: SNAPSHOT_TTL_MS,
    idleMs: IDLE_AFTER_MS, stopMs: IDLE_STOP_MS, idleIntervalMs: IDLE_CHECK_MS, checkMs: IDLE_CHECK_MS,
  },
  '1m': { id: '1m', label: '每分钟', intervalMs: 60_000 },
  '2m': { id: '2m', label: '每两分钟', intervalMs: 120_000 },
  '5m': { id: '5m', label: '每五分钟', intervalMs: 300_000 },
};

export const refreshStrategy = value => (REFRESH_STRATEGIES[value] ? value : 'smart');

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

// The answer of the gateway, when it did not come.
//
// Two kinds of "no" are told apart. "unsupported" means that this gateway
// does not have that answer at all: an older Magpie that knows nothing of
// /v1/magpie/usage. "transient" means that the answer should have been there
// and was not: the gateway was busy, it answered with an error, or the
// network was gone for a moment.
//
// The difference matters. The old way of reading the day asks one answer per
// account; doing that after a hiccup would make the trouble worse, so it is
// only done when the gateway says that the newer answer does not exist.
export class MagpieError extends Error {
  constructor(message, { status = 0, kind = 'transient' } = {}) {
    super(message);
    this.name = 'MagpieError';
    this.status = status;
    this.kind = kind;
  }
}

// The statuses that mean "this answer is not there": the endpoint was never
// built, the method is not allowed on it, or the gateway does not implement
// it.
const UNSUPPORTED_STATUS = new Set([404, 405, 501]);
// How long the answer of an older Magpie is taken for granted. After that
// the newer answer is asked once more, in case the gateway was changed.
const LEGACY_RECHECK_MS = 10 * 60_000;

// On the disk the accounts are written as the name of the account alone: the
// whole address stays in the memory of the service and never reaches the
// phone.
const snapshotForDisk = (snapshot) => {
  const parts = { ...snapshot.parts };
  const today = parts.today;
  if (today?.data?.accounts) {
    parts.today = {
      ...today,
      data: {
        ...today.data,
        accounts: today.data.accounts.map((row) => ({
          ...row,
          account: String(row.account || '').split('@')[0],
        })),
      },
    };
  }
  return { ...snapshot, parts };
};

export class Collector {
  constructor({ upstream, magpieDir, snapshotFile, fetcher = fetch, clock = Date.now, display = {}, strategy = 'smart', ttlMs = SNAPSHOT_TTL_MS, maxWaitMs = MAX_WAIT_MS, requestTimeoutMs = 15_000, enabled = true }) {
    this.upstream = upstream;
    this.magpieDir = magpieDir;
    this.snapshotFile = snapshotFile;
    this.fetcher = fetcher;
    this.clock = clock;
    this.display = display;
    this.strategy = refreshStrategy(strategy);
    this.ttlMs = ttlMs;
    this.maxWaitMs = maxWaitMs;
    this.requestTimeoutMs = requestTimeoutMs;
    // A gateway that was refused is never asked. The service keeps the last
    // reading and waits for the setting to be fixed.
    this.enabled = enabled !== false;
    this.snapshot = { version: 1, parts: {}, failures: {} };
    // The whole address of an account is kept in the memory of the service
    // only. On the disk it is written as the name of the account alone,
    // which is what the console shows anyway.
    this.addresses = new Map();
    // The last good reading of every account, so a reading that fails keeps
    // the numbers of the last good one.
    this.usage = new Map();
    this.pending = null;
    this.lastCollectedAt = 0;
    this.lastPlainQuotaAt = 0;
    // What the vendors said the last time they were asked: 'named' when they
    // named subscriptions, 'empty' when they said they hold none, and nothing
    // at all when they did not answer. It is remembered because the vendors
    // are not asked again for half a minute, and what they said stays true
    // until they are.
    this.lastPlainState = '';
    // Whether the person at the keyboard wants the vendors to be asked: the
    // kept answer of Magpie is a cache, and a subscription that was just
    // added is not in it yet.
    this.vendorRead = false;
    this.lastRequestAt = 0;
    this.expired = false;
    this.timer = null;
    this.stopped = true;
    // What this gateway can answer: 'unknown' at first, then 'new' or
    // 'legacy'. It is remembered so that the missing answer of an older
    // Magpie is not looked for again and again.
    this.todayMode = 'unknown';
    this.todayModeAt = 0;
    // The answers of the gateway about the subscriptions, kept apart: whether
    // it answered at all, whether it named a subscription, whether its answer
    // could be read into a list, and whether that list held nothing at all. A
    // gateway that says "I have no subscriptions" is answering, and that is
    // not a failure of the reading. A list that the gateway did not name is
    // the one that was stored, and it is not a new one.
    this.quotaAnswered = false;
    this.quotaNamed = false;
    this.quotaRead = false;
    this.quotaEmpty = false;
  }

  // A snapshot that was written by an earlier run is read back, but it is
  // marked as old: a fresh reading has to replace it.
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.snapshotFile, 'utf8'));
      if (!saved || saved.version !== 1 || !saved.parts || !saved.failures) return;
      for (const key of ['quotas', 'today', 'week']) {
        const part = saved.parts[key];
        if (!part || !part.data) continue;
        part.data = key === 'today' ? sanitizeCachedSummary(part.data) : sanitizeCachedLabels(part.data, key);
        saved.failures[key] = true;
      }
      this.snapshot = saved;
    } catch { /* Without a snapshot the first reading writes one. */ }
  }

  async request(endpoint, timeout = this.requestTimeoutMs) {
    let response;
    try {
      response = await this.fetcher(new URL(endpoint, this.upstream), {
        signal: AbortSignal.timeout(timeout),
        headers: { Accept: 'application/json' },
        redirect: 'error',
      });
    } catch (error) {
      // The gateway did not answer at all. That is a moment of trouble, not
      // a sign that the answer does not exist.
      throw new MagpieError(`Magpie did not answer: ${error?.message || error}`, { kind: 'transient' });
    }
    if (!response.ok) {
      const kind = UNSUPPORTED_STATUS.has(response.status) ? 'unsupported' : 'transient';
      throw new MagpieError(`Magpie answered ${response.status} for ${endpoint}`, { status: response.status, kind });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new MagpieError(`Magpie answered something that is not JSON: ${error?.message || error}`, { kind: 'transient' });
    }
  }

  // The quota readings Magpie has already written down. They are the same
  // numbers the kept answer carries, and they are here for the case where the
  // gateway is busy.
  async quotaCache() {
    try {
      return JSON.parse(await readFile(path.join(this.magpieDir, 'quotas.json'), 'utf8'));
    } catch { return {}; }
  }

  // The plain answer is the one that asks the vendors. It is asked for when
  // the kept answer holds nothing at all, and never more than once every half
  // a minute.
  plainQuotaAllowed() {
    return this.clock() - this.lastPlainQuotaAt >= PLAIN_QUOTA_GAP_MS;
  }

  async plainQuota() {
    this.lastPlainQuotaAt = this.clock();
    try {
      const answer = await this.request('/v1/magpie/quotas');
      const named = namedQuotaSubscriptions(answer) > 0;
      const empty = Array.isArray(answer?.data) && answer.data.length === 0;
      // What the vendors said is remembered: an answer that says that there is
      // none is remembered as such. An answer that names the subscriptions is
      // remembered only once it has been read into a list of them: what the
      // vendors said is not yet a list, and an answer that cannot be read
      // must never pass for a new one.
      this.lastPlainState = empty ? 'empty' : '';
      return { answer, named, empty };
    } catch {
      this.lastPlainState = '';
      return null;
    }
  }

  // The quota of the subscriptions. The kept answer is the one Magpie has
  // already read, so it costs nothing. The plain answer is the one that asks
  // the vendors, and it is asked for when the kept answer holds nothing at
  // all, or when the person at the keyboard wants the list of this moment.
  async quotas() {
    // The answer of the gateway is remembered before it is read: a gateway
    // that is busy is told apart from a gateway that says that it has
    // nothing at all.
    this.quotaAnswered = false;
    this.quotaNamed = false;
    this.quotaRead = false;
    this.quotaEmpty = false;
    const previous = this.snapshot.parts.quotas?.data || [];
    const cache = await this.quotaCache();
    const resolve = answer => {
      const cachedIdentities = [];
      // The gateway says that it has no subscription at all: an empty answer
      // is a list of its own, and the readings that were stored are not
      // brought back over it, because that would make an old list stand for a
      // new one.
      const cards = resolveQuotas(answer, cache, previous, cachedIdentities);
      return { cards, rows: { data: [...(Array.isArray(answer?.data) ? answer.data : []), ...cachedIdentities] } };
    };
    // The vendors are asked what there is now. The answer that comes is the
    // one that says whether the gateway holds anything at all: it names the
    // subscriptions that exist, or it says that there are none. It is null
    // when the vendors were asked a moment ago and are not asked again, and
    // when they did not answer.
    const fromVendors = async () => {
      if (!this.plainQuotaAllowed()) return null;
      const plain = await this.plainQuota();
      if (!plain) return null;
      const named = plain.named;
      const empty = plain.empty;
      if (empty && this.quotaNamed) {
        // The vendors say that they hold nothing at all, but the kept answer
        // names subscriptions: that is a reading Magpie did, and it is not
        // thrown away because the vendors were quiet. The list stays until
        // Magpie reads the vendors itself and holds nothing either.
        return null;
      }
      if (empty) {
        // The vendors say that they hold nothing at all: the list is empty,
        // and the readings that were stored are not brought back over it.
        this.quotaAnswered = true;
        this.quotaNamed = false;
        this.quotaEmpty = true;
        this.quotaRead = true;
        return { cards: [], rows: { data: [] } };
      }
      try {
        const fresh = resolve(plain.answer);
        // The answer of the vendors is the one that is used from now on, so it
        // is the one that says whether the gateway holds anything at all. The
        // flags are written when the answer is a list: an answer that cannot
        // be read into one does not name a list, and the answer of the
        // gateway keeps the flags that belong to it.
        this.quotaAnswered = true;
        this.quotaNamed = named;
        this.quotaEmpty = false;
        this.quotaRead = true;
        // The vendors named the subscriptions and their answer could be read
        // into a list of them: that list is the one of this moment, and it is
        // remembered as such. An answer that names no subscription at all
        // says nothing about the list, and nothing is remembered.
        this.lastPlainState = named ? 'named' : '';
        return fresh;
      } catch {
        // The plain answer holds nothing usable: the vendors said something
        // that cannot be turned into a list, so they did not name a list after
        // all. The flags of the kept answer stand: the list that is kept is
        // the one that was stored, and it is told as the old one it is — a
        // stored list must never be passed for a new one.
        return null;
      }
    };
    let rows = null;
    let failure = null;
    try {
      rows = await this.request('/v1/magpie/quotas?kept=1');
    } catch (error) {
      failure = error;
    }
    // The gateway answered when it did not throw. An answer that holds no
    // subscription at all is an answer as well, and not a broken reading.
    this.quotaAnswered = !failure;
    // The gateway names a subscription when it says something about a vendor:
    // a row without a vendor is not a subscription this plugin can show, so
    // an answer that holds nothing but such rows does not name one, and the
    // list it falls back to is an old one.
    this.quotaNamed = this.quotaAnswered && namedQuotaSubscriptions(rows) > 0;
    this.quotaEmpty = this.quotaAnswered && Array.isArray(rows?.data) && rows.data.length === 0;
    // The vendors are asked when the kept answer holds nothing at all: Magpie
    // may simply not have read them yet, and they are the ones that say what
    // there is now. The readings that were stored make the empty answer
    // readable into a list, so without this the vendors would never be asked
    // at all, and a subscription that was just added in Magpie would never
    // show up.
    // The person at the keyboard asks for them as well: the kept answer of
    // Magpie is a cache of what it has read, and a subscription that was
    // added a moment ago is not in it yet.
    const wanted = this.vendorRead;
    this.vendorRead = false;
    const vendors = (wanted || this.quotaEmpty) ? await fromVendors() : null;
    if (vendors) return vendors;
    if (this.quotaEmpty) {
      // The vendors were not asked — they were asked a moment ago — or they
      // did not answer. What they said last time is what is known about the
      // list: an answer that says there is none empties the list, an answer
      // that names subscriptions keeps it, and an answer that is not there
      // keeps it as well, marked as old. A list is never emptied on the word
      // of a reading that did not happen.
      if (this.lastPlainState === 'empty') {
        this.quotaEmpty = true;
        this.quotaRead = true;
        return { cards: [], rows: { data: [] } };
      }
      this.quotaEmpty = false;
      this.quotaNamed = this.lastPlainState === 'named';
      this.quotaRead = this.lastPlainState === 'named';
      try {
        return resolve(rows);
      } catch {
        throw failure || new Error('The gateway did not give a new list of subscriptions.');
      }
    }
    try {
      const result = resolve(rows);
      // The answer could be read into a list. The numbers of the cards may
      // be old, but the list of the subscriptions is the one of the gateway.
      this.quotaRead = true;
      return result;
    } catch (error) {
      // The kept answer could not be read into a list. The vendors are asked:
      // they are the ones that say what there is now.
      const other = vendors ? null : await fromVendors();
      if (other) return other;
      // The old snapshot stays as it is: the reader keeps the last numbers it
      // saw, marked as old.
      throw failure || error;
    }
  }

  // The address of every account of every vendor. Two accounts of one vendor
  // that share the name before the "@" are marked as unknown, so they are
  // never asked about and never swap places.
  rememberAddresses(rows) {
    const fresh = new Map();
    const observedFamilies = new Set();
    for (const row of Array.isArray(rows?.data) ? rows.data : []) {
      const family = providerFamily(row?.provider);
      if (family) observedFamilies.add(family);
      const address = typeof row?.user === 'string' ? row.user.trim() : '';
      if (!family || !address.includes('@')) continue;
      const key = accountKey(family, address);
      if (!key) continue;
      const known = fresh.get(key);
      if (known === undefined) fresh.set(key, address);
      else if (known !== address) fresh.set(key, null);
    }
    for (const [key, address] of this.addresses) {
      if (!observedFamilies.has(key.split('@')[0])) {
        fresh.set(key, address);
        continue;
      }
      if (fresh.get(key) !== address) this.usage.delete(key);
    }
    this.addresses = fresh;
  }

  // The name that Magpie gives each vendor. The reading of the usage carries
  // the id of a vendor and not its name, and a vendor that is not written
  // down in the plugin has no name of its own there: the name of the
  // software is used, so that the ranking says the same thing as the card of
  // the subscription.
  vendorNames(cards = []) {
    const names = {};
    for (const card of cards) {
      if (!card?.provider || !card?.vendor) continue;
      names[String(card.provider).toLowerCase()] = card.vendor;
    }
    return names;
  }

  // The reading of today: the totals, the hours, the vendors and the accounts
  // all come with one answer of the gateway.
  //
  // The old way is only used when the gateway says that the newer answer does
  // not exist (404, 405, 501). A gateway that is busy, that answers with an
  // error, or that cannot be reached is a moment of trouble: the old way
  // asks one answer per account, and doing that after a hiccup would only
  // make the trouble worse. The last good reading is kept in that case, and
  // it is marked as old.
  async todayUsage(cards = []) {
    // The newer answer is asked again from time to time, so a gateway that
    // was changed under the feet of the service is noticed.
    const known = this.todayMode === 'legacy' && this.clock() - this.todayModeAt < LEGACY_RECHECK_MS;
    if (known) {
      try {
        return await this.legacyToday(cards);
      } catch (error) {
        // The old way is gone as well. The newer one is asked again the next
        // time, in case the gateway was changed under the feet of the service.
        if (error instanceof MagpieError && error.kind === 'unsupported') this.todayMode = 'unknown';
        throw error;
      }
    }
    let answer;
    try {
      answer = await this.request('/v1/magpie/usage?period=today');
    } catch (error) {
      if (error instanceof MagpieError && error.kind === 'unsupported') {
        this.todayMode = 'legacy';
        this.todayModeAt = this.clock();
        return this.legacyToday(cards);
      }
      throw error;
    }
    this.todayMode = 'new';
    this.todayModeAt = this.clock();
    return normalizeUsageSummary(answer, this.vendorNames(cards));
  }

  // The way of the older Magpie: the totals of the day come from the requests
  // of the day, and the numbers of an account are asked for one by one. It is
  // only used when the newer answer is not there.
  async legacyToday(cards) {
    const raw = await this.request('/v1/magpie/usage/requests?period=today&limit=1');
    const accounts = [];
    for (const card of cards) {
      if (!card.account) continue;
      const address = this.addresses.get(card.id);
      if (!address) continue;
      // Every account stands on its own: one that fails does not take the
      // numbers of the others with it.
      let one = null;
      try {
        one = await this.request(
          `/v1/magpie/usage/requests?period=today&limit=1&account=${encodeURIComponent(address)}`,
          5000,
        );
      } catch { one = null; }
      if (!one) continue;
      accounts.push({
        provider: card.provider,
        account: address,
        calls: one.calls,
        input: one.input,
        output: one.output,
        cache_read: one.cache_read,
        cache_write: one.cache_write,
      });
    }
    const names = this.vendorNames(cards);
    const { metrics, trend, providers } = normalizeUsage(raw, names);
    return { metrics, trend, providers, accounts: normalizeUsageSummary({ ...raw, accounts }, names).accounts };
  }

  // The reading of the week keeps the answer of the requests, because it is
  // the one that carries the models, the agents and the computers.
  async weekUsage() {
    // The reading of the week is asked for at the same time as the quota, so
    // the names of the vendors are the ones of the reading that was before.
    const cards = this.snapshot?.parts?.quotas?.data || [];
    return normalizeUsage(await this.request('/v1/magpie/usage/requests?period=7d&limit=1'), this.vendorNames(cards));
  }

  // The usage of an account belongs to the account it was taken for: the
  // vendor and the whole address have to match. A name before the "@" is
  // never enough.
  attachUsage(cards, summary) {
    // The numbers of an account are the numbers of one day. When the day
    // turns over, the ones of yesterday are of no use to anybody and are
    // let go of, so they can never be read as today's.
    const day = shanghaiDay(this.clock());
    if (this.usageDay !== day) {
      this.usage.clear();
      this.usageDay = day;
    }
    for (const row of Array.isArray(summary?.accounts) ? summary.accounts : []) {
      const family = row.family || providerFamily(row.provider);
      const address = typeof row.account === 'string' ? row.account.trim() : '';
      if (!family || !address.includes('@')) continue;
      const key = accountKey(family, address);
      if (!key) continue;
      if (this.addresses.get(key) !== address) continue;
      const usage = { today: { totalTokens: row.totalTokens, requests: row.requests } };
      this.usage.set(key, usage);
      const card = cards.find(entry => entry.id === key);
      if (card) { card.accountUsage = usage; card.accountUsageDay = day; }
    }
    for (const card of cards) {
      if (!card.accountUsage && card.account) {
        card.accountUsage = this.usage.get(card.id) || null;
        if (card.accountUsage) card.accountUsageDay = day;
      }
    }
  }

  async collect() {
    const now = this.clock();
    const periodDay = shanghaiDay(now);
    // The quota and the week are asked for at the same time. The reading of
    // the day comes after the quota, because on an older Magpie it needs to
    // know which account belongs to which vendor.
    const [quotas, week] = await Promise.allSettled([
      this.quotas(), this.weekUsage(),
    ]);
    if (quotas.status === 'fulfilled') this.rememberAddresses(quotas.value.rows);
    const cards = quotas.status === 'fulfilled' ? quotas.value.cards : [];
    const today = await this.todayUsage(cards).then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    );
    const observedAt = new Date(this.clock()).toISOString();
    // Every part stands on its own: the quota of a failure never touches the
    // reading of today, and a day that fails never touches the week.
    if (quotas.status === 'fulfilled') {
      const { cards: fresh } = quotas.value;
      if (today.status === 'fulfilled') this.attachUsage(fresh, today.value);
      else for (const card of fresh) if (!card.accountUsage && card.account && this.usageDay === periodDay) {
        // The reading of today failed; the numbers of the account are only of
        // use when they are of this day too.
        card.accountUsage = this.usage.get(card.id) || null;
        if (card.accountUsage) card.accountUsageDay = periodDay;
      }
      // A gateway that answered and said that it holds no subscription at
      // all is not a gateway that failed: the list is empty because there is
      // nothing in it. An answer that holds rows and none of them can be
      // read is a failure, and the list that was there stays.
      this.snapshot.failures.quotas = !this.quotaEmpty && !fresh.some(card => !card.stale);
      // The list is what the gateway named. A reading that fell back to the
      // cards that were stored carries the numbers of those cards, but it is
      // not the list of this moment: the empty answer is.
      this.snapshot.parts.quotas = {
        observedAt,
        periodDay,
        data: this.quotaEmpty ? [] : fresh,
      };
    } else {
      // The gateway answered and said that it has no subscription at all: the
      // list is empty, and that is what it holds now. It is written down
      // with the time it was read, so that the page can say that it knows
      // that there is nothing, instead of saying that it does not know.
      if (this.quotaEmpty) {
        this.snapshot.parts.quotas = { observedAt, periodDay, data: [] };
        this.snapshot.failures.quotas = false;
      } else {
        this.snapshot.failures.quotas = true;
      }
    }
    if (today.status === 'fulfilled') {
      this.snapshot.parts.today = { observedAt, periodDay, data: today.value };
      this.snapshot.failures.today = false;
    } else {
      this.snapshot.failures.today = true;
    }
    if (week.status === 'fulfilled') {
      this.snapshot.parts.week = { observedAt, periodDay, data: week.value };
      this.snapshot.failures.week = false;
    } else {
      this.snapshot.failures.week = true;
    }
    this.lastCollectedAt = this.clock();
    await this.save();
    return this.snapshot;
  }

  async save() {
    try {
      await mkdir(path.dirname(this.snapshotFile), { recursive: true });
      await writeAtomic(this.snapshotFile, JSON.stringify(snapshotForDisk(this.snapshot), null, 2), { mode: 0o600 });
    } catch (error) {
      console.log(`Snapshot could not be saved; serving the in-memory snapshot. ${error?.message || error}`);
    }
  }

  // Only one reading runs at a time. Every request that asks for a refresh
  // joins the one that is running.

  refresh() {
    if (this.pending) return this.pending;
    const job = this.collect()
      .catch(() => { /* The parts that failed are already marked. */ })
      .finally(() => { this.pending = null; });
    this.pending = job;
    return job;
  }

  // A reading that the person at the keyboard asks for is a new one. A
  // reading that is already on its way was started before the click, and its
  // answer is the answer of the gateway as it was then: the list of the
  // subscriptions is not what it is now. That reading is waited for, and
  // then the gateway is asked again, so that the answer is the one of this
  // moment. A reading that is on its way is never thrown away, only waited
  // for.
  async refreshNow() {
    if (this.pending) {
      try { await this.pending; } catch { /* The parts that failed are already marked. */ }
    }
    // The person at the keyboard wants the subscriptions as they are now:
    // the vendors are asked, and not only Magpie's own cache.
    this.vendorRead = true;
    return this.refresh();
  }

  fresh() {
    // "Older than the ttl" is old. The boundary itself is not: with a ttl of
    // zero a reading is stale at once, on every clock, in every millisecond.
    return this.lastCollectedAt > 0 && this.clock() - this.lastCollectedAt < this.ttlMs;
  }

  // Somebody is looking at the numbers. The console of the computer counts as
  // well, otherwise a computer without a phone would never read anything
  // again after the first reading.
  noteActivity() {
    this.lastRequestAt = this.clock();
  }

  // The answer of the service. A reading that is old is waited for, but never
  // for long: when the wait runs out the old numbers are given back, marked
  // as old, and the reading continues in the background.
  async ensureFresh() {
    this.lastRequestAt = this.clock();
    if (this.fresh()) {
      this.expired = false;
      return this.overview();
    }
    const job = this.refresh();
    const outcome = await Promise.race([
      job.then(() => 'done', () => 'done'),
      sleep(this.maxWaitMs).then(() => 'late'),
    ]);
    this.expired = outcome === 'late';
    return this.overview();
  }

  overview() {
    return project(this.snapshot, this.clock(), this.display, { expired: this.expired });
  }

  // Every subscription the gateway knows, whatever the display choices are.
  // The console shows the whole list so the user can pick a part of it.
  allSubscriptions() {
    const cards = this.snapshot.parts.quotas?.data || [];
    const { outdated, todayProviders, familySizes, day } = todayContext(this.snapshot, this.clock());
    return cards.map(card => ({
      id: card.id,
      provider: card.provider,
      // The console shows the name the card carries, the one the user gave it
      // or the one the vendor has.
      label: cardName(card, this.display?.names),
      account: card.account || null,
      alias: card.alias || null,
      // Whether the gateway reported a number for this account today. An
      // account it did not report has no number to show on the widget.
      hasToday: Boolean(usageForCard(card, { outdated, todayProviders, familySizes, day })),
    }));
  }

  // The subscriptions the phone is shown, in the order the phone shows them.
  // The console uses it to offer the card of the small widget: a card that is
  // not projected would leave the small widget saying "not found".
  shownSubscriptions() {
    return this.shownWith(this.display);
  }

  // The subscriptions the phone is shown when the display choices are these.
  shownWith(display) {
    const cards = this.snapshot.parts.quotas?.data || [];
    return orderedWith(cards, displayOptions(display || {}));
  }

  // The subscriptions the choice of the user keeps, without the floor under
  // it: a choice that leaves nothing on the phone is a choice, and the
  // service has to be able to say that it refuses it.
  selectedWith(display) {
    const cards = this.snapshot.parts.quotas?.data || [];
    return selectedCards(cards, displayOptions(display || {}));
  }

  // How many subscriptions the gateway knows. It is zero when the gateway has
  // not been read yet: nothing is known, so nothing can be left out.
  knownCount() {
    return (this.snapshot.parts.quotas?.data || []).length;
  }

  // What the last reading of the quotas was: when it was taken, and whether
  // it is a reading of this moment. A reading that failed leaves the old one
  // in place, and the failure is remembered, so the console can say that the
  // list it shows is an old one.
  readingInfo() {
    const part = this.snapshot.parts.quotas;
    return {
      observedAt: part?.observedAt || null,
      // A list that was never read is not a fresh one: it is an unknown one,
      // and the console has to say so rather than show an empty list as if it
      // were the whole truth.
      stale: !part?.observedAt || Boolean(this.snapshot.failures?.quotas),
      known: Boolean(part?.observedAt),
      count: (part?.data || []).length,
      // Whether the gateway answered the last time it was asked for the
      // subscriptions. A gateway that answered and said that it has none
      // is not a gateway that failed.
      answered: this.quotaAnswered,
      // Whether the gateway named a subscription. A list that the gateway did
      // not name is the one that was stored, and it is not a new one.
      named: this.quotaNamed,
      // Whether the answer of the gateway could be read into a list. The
      // numbers of the cards may be old even so: the list of the
      // subscriptions is a new one all the same.
      read: this.quotaRead,
      // Whether the answer of the gateway held no subscription at all.
      empty: this.quotaEmpty,
    };
  }


  setDisplay(display) {
    this.display = display;
  }

  // The rhythm of the reading. The user may pick a fixed one; the smart one
  // keeps the numbers fresh while somebody is watching and slows down when
  // nobody is.
  setStrategy(value) {
    this.strategy = refreshStrategy(value);
    this.schedule();
  }

  start() {
    this.stopped = false;
    this.schedule();
  }

  // The reading that is still on its way is waited for, so that the service
  // does not go away in the middle of a write.
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.pending) {
      try { await this.pending; } catch { /* The parts that failed are already marked. */ }
    }
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.stopped || !this.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
      this.schedule();
    }, this.nextDelay());
    this.timer.unref?.();
  }

  nextDelay() {
    const strategy = REFRESH_STRATEGIES[this.strategy];
    if (!strategy.idleMs) return strategy.intervalMs;
    const idle = this.clock() - this.lastRequestAt;
    if (idle >= strategy.stopMs) return strategy.checkMs;
    if (idle >= strategy.idleMs) return strategy.idleIntervalMs;
    return strategy.intervalMs;
  }

  tick() {
    const strategy = REFRESH_STRATEGIES[this.strategy];
    const idle = this.clock() - this.lastRequestAt;
    if (strategy.idleMs && idle >= strategy.stopMs) return;
    if (this.clock() - this.lastCollectedAt < strategy.intervalMs) return;
    void this.refresh();
  }
}

export const createCollector = options => new Collector(options);
