import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Clipboard,
  ClockCounterClockwise,
  DownloadSimple,
  Lightning,
  List,
  MagnifyingGlass,
  Moon,
  Monitor,
  Play,
  Stop,
  Sun,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import type { Bootstrap, Job, Model, RunConfig, Target, TargetResult } from '../src/types';
import { embedded, subscribeTheme } from './magpie';
import { AppMenu } from './AppMenu';
import { localeFor, type Locale } from './locale';
import './vendor/magpie-ui.css';
import './style.css';

declare global {
  interface Window {
    __FINGERPRINT__?: { token?: string; initialProvider?: string; theme?: string; lang?: string };
  }
}
const apiUrl = (path: string) => new URL(path.replace(/^\//, ''), document.baseURI).toString();
const token = () => window.__FINGERPRINT__?.token;
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (token()) headers.set('Authorization', `Bearer ${token()}`);
  if (init?.body) headers.set('content-type', 'application/json');
  const r = await fetch(apiUrl(path), { ...init, headers });
  if (r.status === 401) location.reload();
  if (!r.ok) {
    const data = await r.json().catch(() => null);
    throw new Error(data?.error || `${r.status} ${r.statusText}`);
  }
  return r.json();
}
type Text = {
  locale: Locale;
  detect: string;
  history: string;
  settings: string;
  ready: string;
  offline: string;
  start: string;
  cancel: string;
  search: string;
  selected: string;
  noModels: string;
  provider: string;
  model: string;
  account: string;
  protocol: string;
  effort: string;
  tier: string;
  strict: string;
  targetParallel: string;
  sampleParallel: string;
  deadline: string;
  estimated: string;
  live: string;
  results: string;
  candidates: string;
  details: string;
  export: string;
  demo: string;
  clear: string;
  completed: string;
  running: string;
  failed: string;
  queued: string;
  cancelled: string;
};
const zh: Text = {
  locale: 'zh-Hans',
  detect: '指纹检测',
  history: '检测历史',
  settings: '运行设置',
  ready: '服务已连接',
  offline: '服务离线',
  start: '开始检测',
  cancel: '取消任务',
  search: '搜索模型',
  selected: '已选择',
  noModels: '暂无可用模型',
  provider: '提供商',
  model: '模型',
  account: '账号',
  protocol: '协议',
  effort: '推理强度',
  tier: '服务等级',
  strict: '完整样本',
  targetParallel: '模型并行',
  sampleParallel: '样本并行',
  deadline: '超时（秒）',
  estimated: '预计请求',
  live: '实时进度',
  results: '检测结果',
  candidates: '候选排名',
  details: '样本详情',
  export: '导出 JSON',
  demo: '示例数据',
  clear: '清空选择',
  completed: '已完成',
  running: '运行中',
  failed: '失败',
  queued: '排队中',
  cancelled: '已取消',
};
const zhHant: Text = {
  locale: 'zh-Hant',
  detect: '指紋檢測',
  history: '檢測歷史',
  settings: '執行設定',
  ready: '服務已連線',
  offline: '服務離線',
  start: '開始檢測',
  cancel: '取消任務',
  search: '搜尋模型',
  selected: '已選擇',
  noModels: '暫無可用模型',
  provider: '提供者',
  model: '模型',
  account: '帳號',
  protocol: '協定',
  effort: '推理強度',
  tier: '服務等級',
  strict: '完整樣本',
  targetParallel: '模型並行',
  sampleParallel: '樣本並行',
  deadline: '逾時（秒）',
  estimated: '預計請求',
  live: '即時進度',
  results: '檢測結果',
  candidates: '候選排名',
  details: '樣本詳情',
  export: '匯出 JSON',
  demo: '示例資料',
  clear: '清除選擇',
  completed: '已完成',
  running: '執行中',
  failed: '失敗',
  queued: '排隊中',
  cancelled: '已取消',
};
const en: Text = {
  locale: 'en',
  detect: 'Fingerprint',
  history: 'History',
  settings: 'Run settings',
  ready: 'Service connected',
  offline: 'Service offline',
  start: 'Start detection',
  cancel: 'Cancel job',
  search: 'Search models',
  selected: 'selected',
  noModels: 'No models available',
  provider: 'Provider',
  model: 'Model',
  account: 'Account',
  protocol: 'Protocol',
  effort: 'Reasoning effort',
  tier: 'Service tier',
  strict: 'Complete samples',
  targetParallel: 'Model parallelism',
  sampleParallel: 'Sample parallelism',
  deadline: 'Deadline (sec)',
  estimated: 'Estimated requests',
  live: 'Live progress',
  results: 'Results',
  candidates: 'Candidate ranking',
  details: 'Sample details',
  export: 'Export JSON',
  demo: 'Demo data',
  clear: 'Clear selection',
  completed: 'Completed',
  running: 'Running',
  failed: 'Failed',
  queued: 'Queued',
  cancelled: 'Cancelled',
};

const terminal = (state: string) => !['queued', 'running'].includes(state);
const integerInRange = (value: unknown, min: number, max: number) =>
  Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const stateLabel = (t: Text, state: string) =>
  ({
    completed: t.completed,
    running: t.running,
    failed: t.failed,
    queued: t.queued,
    cancelled: t.cancelled,
    interrupted: t.locale === 'en' ? 'Interrupted' : t.locale === 'zh-Hant' ? '已中斷' : '已中断',
    scored: t.locale === 'en' ? 'Scored' : t.locale === 'zh-Hant' ? '已評分' : '已评分',
    partial: t.locale === 'en' ? 'Partial' : t.locale === 'zh-Hant' ? '部分樣本' : '部分样本',
    unscorable: t.locale === 'en' ? 'Unscorable' : t.locale === 'zh-Hant' ? '不可評分' : '不可评分',
    not_model:
      t.locale === 'en'
        ? 'Unexpected sequence'
        : t.locale === 'zh-Hant'
          ? '序列不符合檢測假設'
          : '序列不符合检测假设',
    complete: t.locale === 'en' ? 'Complete' : t.locale === 'zh-Hant' ? '完成' : '完成',
    truncated: t.locale === 'en' ? 'Truncated' : t.locale === 'zh-Hant' ? '已截斷' : '已截断',
    waiting: t.locale === 'en' ? 'Waiting' : t.locale === 'zh-Hant' ? '等待回應' : '等待响应',
    streaming: t.locale === 'en' ? 'Streaming' : t.locale === 'zh-Hant' ? '接收中' : '接收中',
  })[state] || state;
const localize = (t: Text, hans: string, hant: string, english: string) =>
  t.locale === 'en' ? english : t.locale === 'zh-Hant' ? hant : hans;
function App() {
  const [lang, setLang] = useState<Locale>(() => {
    try {
      const saved = !embedded ? localStorage.getItem('fp-lang') : null;
      return localeFor(saved || window.__FINGERPRINT__?.lang);
    } catch {
      return localeFor(window.__FINGERPRINT__?.lang);
    }
  });
  const t = lang === 'en' ? en : lang === 'zh-Hant' ? zhHant : zh;
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    try {
      return (
        (!embedded && (localStorage.getItem('fp-theme') as any)) ||
        window.__FINGERPRINT__?.theme ||
        'system'
      );
    } catch {
      return (window.__FINGERPRINT__?.theme as 'light' | 'dark') || 'system';
    }
  });
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [section, setSection] = useState<'detect' | 'history'>('detect');
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [account, setAccount] = useState('');
  const [config, setConfig] = useState({
    api: 'auto',
    effort: '',
    serviceTier: 'default',
    strict: false,
    targetParallel: 2,
    sampleParallel: 3,
    deadlineSeconds: 300,
  } as any);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [downloadingBank, setDownloadingBank] = useState(false);
  const configValid =
    integerInRange(config.targetParallel, 1, 3) &&
    integerInRange(config.sampleParallel, 1, 3) &&
    integerInRange(config.deadlineSeconds, 10, 900);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const paint = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    paint();
    media.addEventListener('change', paint);
    try {
      if (!embedded) localStorage.setItem('fp-theme', theme);
    } catch {}
    return () => media.removeEventListener('change', paint);
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      if (!embedded) localStorage.setItem('fp-lang', lang);
    } catch {}
  }, [lang]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const m = e.data;
      if (m?.magpie === 1 && m.event === 'action' && m.data?.provider?.id) {
        setProvider(m.data.provider.id);
        setSection('detect');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  useEffect(
    () =>
      subscribeTheme((next) => {
        setTheme(next.dark ? 'dark' : 'light');
        const locale = localeFor(next.lang);
        document.documentElement.lang = locale;
        setLang(locale);
      }),
    [],
  );
  const load = async () => {
    setError('');
    try {
      const b = await api<Bootstrap>('api/bootstrap');
      setBoot(b);
      setHistory(b.jobs || []);
      setJob((current) => current || b.jobs.find((j) => !terminal(j.state)) || null);
      if (window.__FINGERPRINT__?.initialProvider)
        setProvider(window.__FINGERPRINT__.initialProvider);
      setError(b.gateway.error || '');
    } catch (e) {
      setError(String(e));
    }
  };
  const downloadBank = async () => {
    if (downloadingBank) return;
    setDownloadingBank(true);
    setError('');
    try {
      const result = await api<Pick<Bootstrap, 'bank' | 'bankStatus'> & { error?: string }>(
        'api/bank/download',
        { method: 'POST' },
      );
      setBoot((current) =>
        current
          ? {
              ...current,
              bank: result.bank,
              bankStatus: result.bankStatus,
              bankError: result.error,
            }
          : current,
      );
      if (result.error) setError(result.error);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloadingBank(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!job || terminal(job.state)) return;
    const controller = new AbortController();
    const id = job.id;
    const watch = async () => {
      let done = false;
      while (!controller.signal.aborted && !done) {
        try {
          const response = await fetch(apiUrl(`api/jobs/${id}/events`), {
            headers: { Authorization: `Bearer ${token()}` },
            signal: controller.signal,
          });
          if (response.status === 401) location.reload();
          if (!response.ok || !response.body)
            throw new Error(`Progress connection: HTTP ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (!controller.signal.aborted) {
              const part = await reader.read();
              if (part.done) break;
              buffer += decoder.decode(part.value, { stream: true });
              let split: number;
              while ((split = buffer.indexOf('\n\n')) >= 0) {
                const event = buffer.slice(0, split);
                buffer = buffer.slice(split + 2);
                const data = event.split('\n').find((line) => line.startsWith('data: '));
                if (!data) continue;
                const next = JSON.parse(data.slice(6)) as Job;
                setJob((current) => (current?.id === id ? next : current));
                setHistory((list) => [next, ...list.filter((j) => j.id !== id)]);
                done = terminal(next.state);
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        } catch (e) {
          if (!controller.signal.aborted) setError(String(e));
        }
        if (!done && !controller.signal.aborted)
          await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    };
    void watch();
    return () => controller.abort();
  }, [job?.id]);
  const models = boot?.models || [];
  const providers = useMemo(
    () => ['all', ...Array.from(new Set(models.map((m) => m.provider)))],
    [models],
  );
  const filtered = models.filter(
    (m) =>
      (provider === 'all' || m.provider === provider) &&
      `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedModels = models.filter((m) => selected.includes(m.id));
  const effortChoices =
    selectedModels[0]?.efforts.filter((effort) =>
      selectedModels.every((model) => model.efforts.includes(effort)),
    ) || [];
  const effort = effortChoices.includes(config.effort) ? config.effort : '';
  const estimate = selected.length * 3;
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length < 24 ? [...s, id] : s,
    );
  const setField = (k: string, v: any) => setConfig((c: any) => ({ ...c, [k]: v }));
  const start = async () => {
    if (!selected.length || starting) return;
    if (account && new Set(selectedModels.map((m) => m.provider)).size > 1) {
      setError(
        localize(
          t,
          '固定账号时请只选择同一提供商的模型。',
          '固定帳號時請只選擇同一提供者的模型。',
          'Select models from one provider when pinning an account.',
        ),
      );
      return;
    }
    setStarting(true);
    setError('');
    const cfg: RunConfig = {
      targets: selected.map((model) => ({ model, ...(account ? { account } : {}) })),
      api: config.api,
      effort,
      serviceTier: config.serviceTier,
      strict: config.strict,
      targetParallel: Number(config.targetParallel),
      sampleParallel: Number(config.sampleParallel),
      deadlineSeconds: Number(config.deadlineSeconds),
    };
    try {
      const j = await api<Job>('api/jobs', { method: 'POST', body: JSON.stringify(cfg) });
      setJob(j);
      setHistory((h) => [j, ...h.filter((x) => x.id !== j.id)]);
      setExpanded(j.results[0]?.id || null);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  };
  const cancel = async () => {
    if (!job) return;
    try {
      const x = await api<Job>(`api/jobs/${job.id}/cancel`, { method: 'POST' });
      setJob(x);
    } catch (e) {
      setError(String(e));
    }
  };
  const download = async () => {
    if (!job) return;
    try {
      const r = await fetch(apiUrl(`api/jobs/${job.id}/export`), {
        headers: token() ? { Authorization: `Bearer ${token()}` } : {},
      });
      if (!r.ok) throw new Error('Export failed');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `fingerprint-${job.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      setError(String(e));
    }
  };
  const deleteJob = async (id: string) => {
    try {
      await api(`api/jobs/${id}`, { method: 'DELETE' });
      setHistory((h) => h.filter((x) => x.id !== id));
      if (job?.id === id) setJob(null);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className={`app-shell ${embedded ? 'embedded' : 'standalone'}`}>
      {!embedded && <h1 className="standalone-title">Fingerprint</h1>}
      <div className="page-tools">
        <nav
          className="segs"
          aria-label={localize(t, '指纹检测视图', '指紋檢測檢視', 'Fingerprint views')}
          role="tablist"
          onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              const next =
                e.key === 'Home'
                  ? 'detect'
                  : e.key === 'End'
                    ? 'history'
                    : section === 'detect'
                      ? 'history'
                      : 'detect';
              setSection(next);
              document.getElementById(`tab-${next}`)?.focus();
            }
          }}
        >
          <button
            className={`opt ${section === 'detect' ? 'on' : ''}`}
            id="tab-detect"
            role="tab"
            aria-selected={section === 'detect'}
            aria-controls="fingerprint-panel"
            tabIndex={section === 'detect' ? 0 : -1}
            onClick={() => setSection('detect')}
          >
            {t.detect}
          </button>
          <button
            className={`opt ${section === 'history' ? 'on' : ''}`}
            id="tab-history"
            role="tab"
            aria-selected={section === 'history'}
            aria-controls="fingerprint-panel"
            tabIndex={section === 'history' ? 0 : -1}
            onClick={() => setSection('history')}
          >
            {t.history}
            {history.length > 0 && <span className="tab-count">{history.length}</span>}
          </button>
        </nav>
        <div className="page-status">
          {boot?.demo ? (
            <span className="badge">{t.demo}</span>
          ) : (
            <span className="service-dot" role="status">
              <i className={boot?.gateway.reachable ? '' : 'bad'} />
              {!boot
                ? error
                  ? t.offline
                  : localize(t, '正在连接…', '正在連線…', 'Connecting…')
                : boot.gateway.reachable
                  ? t.ready
                  : t.offline}
            </span>
          )}
          <button
            className="icon icon-button"
            onClick={load}
            aria-label={localize(
              t,
              '刷新模型与检测历史',
              '重新整理模型與檢測歷史',
              'Refresh models and history',
            )}
            title={localize(t, '刷新', '重新整理', 'Refresh')}
          >
            <ArrowClockwise size={15} />
          </button>
          {!embedded && (
            <>
              <button
                className="text"
                onClick={() =>
                  setLang(lang === 'en' ? 'zh-Hans' : lang === 'zh-Hans' ? 'zh-Hant' : 'en')
                }
              >
                {lang === 'en' ? '简体中文' : lang === 'zh-Hans' ? '繁體中文' : 'English'}
              </button>
              <button
                className="icon icon-button"
                aria-label={localize(t, `主题：${theme}`, `主題：${theme}`, `Theme: ${theme}`)}
                onClick={() =>
                  setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')
                }
              >
                {theme === 'system' ? (
                  <Monitor size={15} />
                ) : theme === 'dark' ? (
                  <Moon size={15} />
                ) : (
                  <Sun size={15} />
                )}
              </button>
            </>
          )}
        </div>
      </div>
      <main
        className="main"
        id="fingerprint-panel"
        role="tabpanel"
        aria-labelledby={`tab-${section}`}
      >
        {error && (
          <div className="notice error" role="alert">
            <WarningCircle size={18} />
            <span>{error}</span>
            <button onClick={load} aria-label={localize(t, '重新连接', '重新連線', 'Reconnect')}>
              <ArrowClockwise size={16} />
            </button>
          </div>
        )}
        {section === 'history' ? (
          <History
            history={history}
            t={t}
            onSelect={(j) => {
              setJob(j);
              setExpanded(j.results[0]?.id || null);
              setSection('detect');
            }}
            onDelete={deleteJob}
          />
        ) : (
          <>
            <div className="intro">
              <p>
                {localize(
                  t,
                  '选择模型，用同一组挑战比较响应指纹。',
                  '選擇模型，用同一組挑戰比較回應指紋。',
                  'Select models to compare their fingerprints with shared challenges.',
                )}
              </p>
              <div className="bank-tools">
                {boot?.bank ? (
                  <span title={boot.bank.builtAt}>
                    {localize(t, '参考库', '參考庫', 'Reference bank')} ·{' '}
                    {boot.bank.modelCount ?? '—'} {localize(t, '个模型', '個模型', 'models')}
                  </span>
                ) : (
                  <span>
                    {boot?.bankStatus?.state === 'cached'
                      ? localize(
                          t,
                          '参考数据已缓存，将在运行时读取',
                          '參考資料已快取，執行時讀取',
                          'Reference data cached; it will be read when a run starts',
                        )
                      : localize(
                          t,
                          '参考数据未下载',
                          '參考資料尚未下載',
                          'Reference data not downloaded',
                        )}
                  </span>
                )}
                <button
                  className="ghost-button bank-download"
                  type="button"
                  onClick={downloadBank}
                  disabled={!boot || downloadingBank || starting}
                >
                  <DownloadSimple size={14} />
                  {downloadingBank
                    ? localize(t, '下载中…', '下載中…', 'Downloading…')
                    : localize(t, '下载参考数据', '下載參考資料', 'Download reference data')}
                </button>
                {boot?.bankError && (
                  <span className="bank-error" role="alert">
                    {boot.bankError}
                  </span>
                )}
              </div>
            </div>
            <p className="source-note">
              {localize(
                t,
                '默认参考源：lm.ikale.io，备用 cdn.jsdmirror.com。仅主动下载或无缓存时启动检测才会连接；来源站点会看到 IP，不接收凭证、提示词或模型回答。',
                '預設參考來源：lm.ikale.io，備用 cdn.jsdmirror.com。僅主動下載或無快取時開始檢測才會連線；來源網站會看到 IP，不接收憑證、提示詞或模型回答。',
                'Default reference sources: lm.ikale.io, with cdn.jsdmirror.com as fallback. Contacted only on download or an uncached run; these hosts see your IP, but receive no credentials, prompts or replies.',
              )}
            </p>
            {boot?.demo && (
              <div className="notice demo">
                <Lightning size={15} />
                <span>
                  {localize(
                    t,
                    '示例数据，可直接试用检测流程。',
                    '示例資料，可直接試用檢測流程。',
                    'Demo data. Try the detection workflow.',
                  )}
                </span>
              </div>
            )}
            <div className="workspace-grid">
              <section className="list panel models-panel">
                <div className="panel-title">
                  <div>
                    <h2>
                      {localize(t, '选择模型', '選擇模型', 'Models')}{' '}
                      <span className="section-count">{models.length}</span>
                    </h2>
                  </div>
                  <span className="selection-count">
                    {selected.length} {t.selected}
                  </span>
                  <button
                    className="text ghost-button"
                    onClick={() => setSelected([])}
                    disabled={!selected.length}
                  >
                    {t.clear}
                  </button>
                </div>
                <div className="filter-row">
                  <div className="search">
                    <MagnifyingGlass size={17} />
                    <input
                      placeholder={t.search}
                      aria-label={t.search}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <AppMenu
                    label={t.provider}
                    value={provider}
                    options={providers.map((p) => ({
                      value: p,
                      label: p === 'all' ? t.provider : p,
                    }))}
                    onChange={setProvider}
                  />
                </div>
                <div className="model-list">
                  {filtered.length ? (
                    filtered.map((m) => (
                      <label
                        className={`row model model-row ${selected.includes(m.id) ? 'selected' : ''}`}
                        key={m.id}
                      >
                        <input
                          type="checkbox"
                          aria-label={`${m.name} · ${m.id}`}
                          checked={selected.includes(m.id)}
                          onChange={() => toggle(m.id)}
                        />
                        <span className="who model-name">
                          <strong className="name">{m.name}</strong>
                          <small className="sub">{m.id}</small>
                        </span>
                        <span className="model-endpoint">
                          {m.nativeEndpoints?.[0]?.replace('/v1/', '') || 'chat'}
                        </span>
                      </label>
                    ))
                  ) : (
                    <div className="empty-state">
                      <List size={26} />
                      <p>
                        {boot
                          ? t.noModels
                          : localize(
                              t,
                              '正在加载模型与参考库…',
                              '正在載入模型與參考庫…',
                              'Loading models and reference data…',
                            )}
                      </p>
                    </div>
                  )}
                </div>
              </section>
              <section className="list panel config-panel">
                <div className="panel-title">
                  <div>
                    <h2>{t.settings}</h2>
                  </div>
                </div>
                <label>
                  {t.account}
                  <input
                    value={account}
                    list="account-options"
                    onChange={(e) => setAccount(e.target.value)}
                    placeholder={localize(
                      t,
                      '可选：账号 ID 或名称',
                      '可選：帳號 ID 或名稱',
                      'Optional account ID or name',
                    )}
                  />
                  <datalist id="account-options">
                    {(boot?.accounts || [])
                      .filter(
                        (a) =>
                          !selectedModels.length ||
                          selectedModels.some((m) => m.provider === a.provider),
                      )
                      .map((a) => (
                        <option key={`${a.provider}/${a.id}`} value={a.id}>
                          {a.name} · {a.provider}
                        </option>
                      ))}
                  </datalist>
                </label>
                <div className="two-col">
                  <label>
                    {t.protocol}
                    <AppMenu
                      label={t.protocol}
                      value={config.api}
                      options={[
                        { value: 'auto', label: 'Auto' },
                        { value: 'chat_completions', label: 'chat_completions' },
                        { value: 'responses', label: 'responses' },
                        { value: 'messages', label: 'messages' },
                      ]}
                      onChange={(value) => setField('api', value)}
                    />
                  </label>
                  <label>
                    {t.effort}
                    <AppMenu
                      label={t.effort}
                      value={effort}
                      options={[
                        { value: '', label: 'Default' },
                        ...effortChoices.map((value) => ({ value, label: value })),
                      ]}
                      onChange={(value) => setField('effort', value)}
                    />
                  </label>
                </div>
                <div className="switch-row">
                  <div>
                    <strong>{localize(t, '完整样本', '完整樣本', 'Complete samples')}</strong>
                    <small>
                      {localize(
                        t,
                        '仅接受完整的 3 条采样',
                        '僅接受完整的 3 條取樣',
                        'Require all three samples',
                      )}
                    </small>
                  </div>
                  <button
                    className={`lib-switch switch ${config.strict ? 'on' : ''}`}
                    role="switch"
                    aria-label={t.strict}
                    aria-checked={config.strict}
                    onClick={() => setField('strict', !config.strict)}
                  >
                    <i />
                  </button>
                </div>
                <button
                  className="advanced-toggle"
                  aria-expanded={showAdvanced}
                  aria-controls="run-advanced"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  {showAdvanced ? '−' : '+'}{' '}
                  {localize(t, '高级并行与超时', '進階並行與逾時', 'Concurrency & deadline')}
                </button>
                {showAdvanced && (
                  <div className="advanced" id="run-advanced">
                    <label>
                      {t.tier}
                      <AppMenu
                        label={t.tier}
                        value={config.serviceTier}
                        options={[
                          { value: 'default', label: 'Default' },
                          { value: 'flex', label: 'Flex' },
                          { value: 'fast', label: 'Fast' },
                          { value: 'ultrafast', label: 'Ultra-fast' },
                        ]}
                        onChange={(value) => setField('serviceTier', value)}
                      />
                    </label>
                    <div className="three-col">
                      <label>
                        {t.targetParallel}
                        <input
                          type="number"
                          min="1"
                          max="3"
                          aria-invalid={!integerInRange(config.targetParallel, 1, 3)}
                          value={config.targetParallel}
                          onChange={(e) => setField('targetParallel', e.target.value)}
                        />
                      </label>
                      <label>
                        {t.sampleParallel}
                        <input
                          type="number"
                          min="1"
                          max="3"
                          aria-invalid={!integerInRange(config.sampleParallel, 1, 3)}
                          value={config.sampleParallel}
                          onChange={(e) => setField('sampleParallel', e.target.value)}
                        />
                      </label>
                      <label>
                        {t.deadline}
                        <input
                          type="number"
                          min="10"
                          max="900"
                          aria-invalid={!integerInRange(config.deadlineSeconds, 10, 900)}
                          value={config.deadlineSeconds}
                          onChange={(e) => setField('deadlineSeconds', e.target.value)}
                        />
                      </label>
                    </div>
                    {!configValid && (
                      <p className="muted-line" role="alert">
                        {localize(
                          t,
                          '并行数须为 1–3 的整数，超时须为 10–900 的整数秒。',
                          '並行數須為 1–3 的整數，逾時須為 10–900 的整數秒。',
                          'Parallelism must be an integer from 1–3; deadline must be 10–900 whole seconds.',
                        )}
                      </p>
                    )}
                  </div>
                )}
                <div className="run-footer">
                  <div>
                    <span>{t.estimated}</span>
                    <strong>{estimate}</strong>
                    <small>3 × {selected.length || 0}</small>
                  </div>
                  <button
                    className="text primary primary-button"
                    disabled={
                      !selected.length ||
                      !configValid ||
                      starting ||
                      history.some((j) => !terminal(j.state))
                    }
                    onClick={start}
                  >
                    <Play size={17} weight="fill" />
                    {t.start}
                  </button>
                </div>
              </section>
            </div>
            {job && (
              <JobView
                job={job}
                t={t}
                expanded={expanded}
                setExpanded={setExpanded}
                onCancel={cancel}
                onDownload={download}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function JobView({
  job,
  t,
  expanded,
  setExpanded,
  onCancel,
  onDownload,
}: {
  job: Job;
  t: Text;
  expanded: string | null;
  setExpanded: (x: string | null) => void;
  onCancel: () => void;
  onDownload: () => void;
}) {
  const [showExport, setShowExport] = useState(false);
  const [copied, setCopied] = useState(false);
  const exportArea = useRef<HTMLTextAreaElement>(null);
  const total = job.results.length || job.config.targets.length;
  const done = job.results.filter((r) => r.state === 'completed').length;
  const finishedSamples = job.results
    .flatMap((r) => r.samples)
    .filter((s) => !['queued', 'waiting', 'streaming'].includes(s.state)).length;
  const json = JSON.stringify({ schema: 'magpie-fingerprint/v1', ...job }, null, 2);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(json);
      setCopied(true);
    } catch {
      exportArea.current?.focus();
      exportArea.current?.select();
      setCopied(document.execCommand('copy'));
    }
  };
  return (
    <section className="results">
      <div className="results-head">
        <div>
          <h2>{terminal(job.state) ? t.results : t.live}</h2>
        </div>
        <div className="result-actions">
          <span className={`status ${job.state}`}>
            {job.state === 'running' && <CircleNotch className="spin" size={14} />}{' '}
            {stateLabel(t, job.state)}
          </span>
          {['queued', 'running'].includes(job.state) ? (
            <button className="danger-button" onClick={onCancel}>
              <Stop size={16} />
              {t.cancel}
            </button>
          ) : (
            <button className="ghost-button" onClick={() => setShowExport(true)}>
              <DownloadSimple size={16} />
              {t.export}
            </button>
          )}
        </div>
      </div>
      <div className="progress-track">
        <i
          style={{
            width: `${total ? Math.round((finishedSamples / (total * 3)) * 100) : 0}%`,
          }}
        />
      </div>
      <div className="result-meta">
        <span>
          {finishedSamples}/{total * 3}{' '}
          {localize(t, '条采样已结束', '條取樣已結束', 'samples finished')} · {done}/{total}{' '}
          {localize(t, '个模型完成', '個模型完成', 'models completed')}
        </span>
        <span>
          {job.demo && <b className="demo-chip">{t.demo}</b>}
          {new Date(job.createdAt).toLocaleString()}
        </span>
      </div>
      <div className="run-context">
        <span title={job.bank.builtAt}>
          {localize(t, '参考库', '參考庫', 'Reference')}: {job.bank.builtAt.slice(0, 19)}
        </span>
        <span>SDK {job.bank.sdk}</span>
        <span>
          {job.config.effort || 'default'} · {job.config.serviceTier}
        </span>
      </div>
      {job.error && (
        <div className="notice error" role="alert">
          {job.error}
        </div>
      )}
      <details className="challenge-details">
        <summary>
          {localize(
            t,
            '本批次共享的 3 个挑战',
            '本批次共用的 3 個挑戰',
            'Three challenges shared across this batch',
          )}
        </summary>
        {job.challenges.map((c, i) => (
          <div key={c.id}>
            <b>
              {i + 1} · {c.expected_count} {localize(t, '个数字', '個數字', 'numbers')}
            </b>
            <p>{c.prompt}</p>
          </div>
        ))}
      </details>
      {job.results.map((r: TargetResult) => (
        <ResultRow
          key={r.id}
          r={r}
          demo={job.demo}
          t={t}
          expanded={expanded === r.id}
          toggle={() => setExpanded(expanded === r.id ? null : r.id)}
        />
      ))}
      {showExport && (
        <div
          className="export-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={t.export}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowExport(false);
          }}
        >
          <div className="export-head">
            <strong>{t.export}</strong>
            <button
              className="icon icon-button"
              aria-label={localize(t, '关闭导出', '關閉匯出', 'Close export')}
              onClick={() => setShowExport(false)}
            >
              ×
            </button>
          </div>
          <textarea ref={exportArea} aria-label="JSON" autoFocus readOnly value={json} />
          <div>
            <button className="text primary primary-button" onClick={copy}>
              <Clipboard size={16} />{' '}
              {copied
                ? localize(t, '已复制', '已複製', 'Copied')
                : localize(t, '复制 JSON', '複製 JSON', 'Copy JSON')}
            </button>
            {window.self === window.top && (
              <button className="ghost-button" onClick={onDownload}>
                <DownloadSimple size={16} />
                {localize(t, '下载文件', '下載檔案', 'Download file')}
              </button>
            )}
            <small>
              {localize(
                t,
                '也可选中文本后手动复制保存。',
                '也可選取文字後手動複製儲存。',
                'You can also select and copy the text manually.',
              )}
            </small>
          </div>
        </div>
      )}
    </section>
  );
}
function ResultRow({
  r,
  demo,
  t,
  expanded,
  toggle,
}: {
  r: TargetResult;
  demo?: boolean;
  t: Text;
  expanded: boolean;
  toggle: () => void;
}) {
  const analysis = r.analysis;
  const candidates = analysis?.results || [];
  const decision = analysis?.decision;
  return (
    <div className={`result-card ${r.state}`}>
      <button
        className="result-summary"
        aria-expanded={expanded}
        aria-controls={`result-${r.id}`}
        onClick={toggle}
      >
        <span className="result-icon">
          {r.state === 'completed' ? (
            <CheckCircle size={20} />
          ) : r.state === 'failed' ? (
            <WarningCircle size={20} />
          ) : (
            <CircleNotch size={20} className={r.state === 'running' ? 'spin' : ''} />
          )}
        </span>
        <span className="result-model">
          <strong>{r.target.model}</strong>
          <small>
            {r.target.account ? `${r.target.accountName || r.target.account} · ` : ''}
            {r.api} · {stateLabel(t, r.state)}
          </small>
        </span>
        <span className="result-label">
          {analysis?.prediction_name || (decision ? stateLabel(t, decision) : '—')}
          <small>{demo ? t.demo : decision ? stateLabel(t, decision) : ''}</small>
        </span>
        <span className="evidence-caveat">
          {localize(t, '证据，不是证明', '證據，不是證明', 'Evidence, not proof')}
        </span>
        <CaretDown size={17} className={expanded ? 'rotate' : ''} />
      </button>
      {expanded && (
        <div className="result-body" id={`result-${r.id}`}>
          <div className="candidate-head">
            <h3>{t.candidates}</h3>
            <span>
              {analysis?.probability_status === 'reference_calibrated'
                ? localize(t, '参考库内概率', '參考庫內機率', 'Within-bank probability')
                : localize(
                    t,
                    '排名分数（非概率）',
                    '排名分數（非機率）',
                    'Ranking score (not probability)',
                  )}
            </span>
          </div>
          {candidates.length ? (
            candidates.slice(0, 5).map((c, i) => (
              <div className="candidate" key={i}>
                <span>{i + 1}</span>
                <div>
                  <div className="candidate-label">
                    <strong>{c.display_name || c.model || 'Unknown'}</strong>
                    <em>
                      {c.probability == null
                        ? c.score.toFixed(3)
                        : `${(c.probability * 100).toFixed(1)}%`}
                    </em>
                  </div>
                  <div className="bar">
                    <i
                      style={{
                        width: `${c.probability == null ? Math.max(6, 100 - i * 18) : Math.max(1, Math.min(100, c.probability * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="muted-line">
              {r.error ||
                (decision === 'partial'
                  ? 'Partial result'
                  : decision === 'unscorable'
                    ? 'Unscorable'
                    : decision === 'not_model'
                      ? 'Not a model reply'
                      : localize(
                          t,
                          '暂未产生可评分候选。',
                          '暫未產生可評分候選。',
                          'No scored candidates yet.',
                        ))}
            </div>
          )}
          {analysis && (
            <p className="evidence-note">
              {localize(
                t,
                `有效样本 ${analysis.used_outputs}/3 · 家族 ${analysis.family_prediction_name || '—'}。概率仅在参考库候选之间分配，库外模型也可能得到相近候选。`,
                `有效樣本 ${analysis.used_outputs}/3 · 家族 ${analysis.family_prediction_name || '—'}。機率僅在參考庫候選之間分配，庫外模型也可能得到相近候選。`,
                `${analysis.used_outputs}/3 usable samples · Family ${analysis.family_prediction_name || '—'}. Probabilities cover reference-bank candidates only; an unseen model can still rank close.`,
              )}
            </p>
          )}
          {r.error && <p className="notice error">{r.error}</p>}
          <div className="sample-grid">
            {r.samples.map((sample, i) => (
              <div className="sample-tile" key={i}>
                <header>
                  <b>
                    {localize(t, '采样', '取樣', 'Sample')} {i + 1}
                  </b>
                  <span className={`status ${sample.state}`}>{stateLabel(t, sample.state)}</span>
                </header>
                <strong>
                  {sample.count}
                  <small> / {sample.expected_count}</small>
                </strong>
                <code>
                  {r.provenance[i]?.model ||
                    localize(t, '路由待确认', '路由待確認', 'Route unverified')}
                </code>
                {r.provenance[i]?.mismatch && (
                  <em>{localize(t, '实际路由已变化', '實際路由已變更', 'Route changed')}</em>
                )}
                {sample.error && <small>{sample.error}</small>}
              </div>
            ))}
          </div>
          <details>
            <summary>{t.details}</summary>
            <pre>{JSON.stringify({ samples: r.samples, provenance: r.provenance }, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
function History({
  history,
  t,
  onSelect,
  onDelete,
}: {
  history: Job[];
  t: Text;
  onSelect: (j: Job) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="history-page">
      <div className="history-tools">
        <p>
          {localize(
            t,
            `本地保存了 ${history.length} 次检测`,
            `本機儲存了 ${history.length} 次檢測`,
            `${history.length} runs saved locally`,
          )}
        </p>
      </div>
      <div className="list history-list">
        {history.length ? (
          history.map((j) => (
            <div className="history-row" key={j.id}>
              <button onClick={() => onSelect(j)}>
                <span className={`history-state ${j.state}`} />
                <span>
                  <strong>
                    {j.config.targets[0]?.model || j.id.slice(0, 12)}
                    {j.config.targets.length > 1 ? ` +${j.config.targets.length - 1}` : ''}
                  </strong>
                  <small>
                    {new Date(j.createdAt).toLocaleString()} · {j.config.targets.length}{' '}
                    {localize(t, '个模型', '個模型', 'models')} · {j.id.slice(0, 8)}
                  </small>
                </span>
              </button>
              <span className={`status ${j.state}`}>
                {j.demo ? t.demo : stateLabel(t, j.state)}
              </span>
              <button
                className="icon icon-button danger-icon"
                title={localize(t, '删除', '刪除', 'Delete')}
                aria-label={`${localize(t, '删除检测记录', '刪除檢測紀錄', 'Delete run')} ${j.id.slice(0, 8)}`}
                onClick={() => onDelete(j.id)}
              >
                <Trash size={17} />
              </button>
            </div>
          ))
        ) : (
          <div className="empty-history">
            <ClockCounterClockwise size={32} />
            <p>{localize(t, '还没有检测记录', '還沒有檢測紀錄', 'No detection history yet')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
