// Bootstraps the page: theme and language from magpie's window, the saved period
// and currency from the plugin's options, usage from `usage:day`, and the
// processing → printing → complete stage machine of dsh-token-receipt's Panel.
(async () => {
  const M = globalThis.TRModel
  const V = globalThis.TRView
  const I = globalThis.TRI18n
  const X = globalThis.TRExport

  const MIN_PROCESSING_MS = 850
  const FEED_MS = 1900
  const REFRESH_MS = 60 * 1000
  const DONE_MS = 3200
  const OPTIONS_GAP_MS = 1100 // magpie takes options.set at most once a second
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const root = document.getElementById('app')
  const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

  const s = {
    lang: 'en',
    copy: I.copyFor('en'),
    dark: false,
    period: 'day',
    anchor: M.startOfDay(new Date()),
    currencyPref: 'auto',
    stage: 'processing',
    raw: null,
    rawView: null, // the period, anchor and time `raw` was read for
    receipt: null,
    error: null,
    saveState: 'idle',
    saveMessage: '',
    copyState: 'idle',
    copyMessage: '',
  }

  let runSeq = 0
  let feedTimer = null
  const doneTimers = {}

  function draw() {
    s.receipt = s.raw && s.rawView
      ? M.toReceipt(s.raw, { period: s.rawView.period, anchor: s.rawView.anchor, now: s.rawView.at, copy: s.copy, lang: s.lang })
      : null
    V.render(root, V.Page(s, actions))
  }

  function applyTheme(theme) {
    if (!theme) return
    s.dark = Boolean(theme.dark)
    s.lang = M.normalizeLocale(theme.lang)
    s.copy = I.copyFor(s.lang)
    document.documentElement.lang = s.lang
    document.title = s.copy.title
    draw()
  }

  const reducedMotion = () => Boolean(motionQuery && motionQuery.matches)
  const exporting = () => s.saveState === 'working' || s.copyState === 'working'
  const busy = () => s.stage === 'processing' || s.stage === 'printing'
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function readError(error) {
    const message = error instanceof Error ? error.message : String(error)
    // a magpie from before usage:day refuses it as a read it doesn't have
    return /usage:day/.test(message) && !/after today/.test(message) ? `${s.copy.needsUpdate} (${message})` : message
  }

  // silent: re-read what's on screen and swap the figures in place (the
  // minute's refresh of a period still running); otherwise print afresh.
  async function runPrint(animate, { silent = false } = {}) {
    if (exporting()) return
    const view = { period: s.period, anchor: s.anchor }
    const params = M.usageParams(view.period, view.anchor, new Date(), tz)
    if (silent) {
      // a refresh never takes over a print: it lands only if none began since
      const seq = runSeq
      try {
        const raw = await magpie.read('usage:day', params)
        if (seq !== runSeq || s.stage !== 'complete' || exporting()) return
        s.raw = raw
        s.rawView = { ...view, at: new Date() }
        draw()
      } catch {
        /* the figures on screen stay */
      }
      return
    }
    const seq = ++runSeq
    clearTimeout(feedTimer)
    const shouldAnimate = Boolean(animate) && !reducedMotion()
    const startedAt = Date.now()
    Object.assign(s, { stage: 'processing', error: null, raw: null, rawView: null, saveState: 'idle', saveMessage: '', copyState: 'idle', copyMessage: '' })
    draw()
    try {
      const raw = await magpie.read('usage:day', params)
      if (seq !== runSeq) return
      const remaining = shouldAnimate ? MIN_PROCESSING_MS - (Date.now() - startedAt) : 0
      if (remaining > 0) await wait(remaining)
      if (seq !== runSeq) return
      s.raw = raw
      s.rawView = { ...view, at: new Date() }
      s.stage = shouldAnimate ? 'printing' : 'complete'
      draw()
      if (shouldAnimate) {
        feedTimer = setTimeout(() => {
          if (seq !== runSeq) return
          s.stage = 'complete'
          draw()
        }, FEED_MS)
      }
    } catch (error) {
      if (seq !== runSeq) return
      s.error = readError(error)
      s.stage = 'error'
      draw()
    }
  }

  // ---- options (period and currency), saved at most once a second ----
  let optionsTimer = null
  let optionsAt = 0
  function persist() {
    clearTimeout(optionsTimer)
    optionsTimer = setTimeout(async () => {
      optionsAt = Date.now()
      try {
        await magpie.options.set({ period: s.period, currency: s.currencyPref })
      } catch {
        /* the choice still holds for this visit */
      }
    }, Math.max(0, OPTIONS_GAP_MS - (Date.now() - optionsAt)))
  }

  // ---- save PNG / copy image ----
  async function exportReceipt(kind) {
    if (!s.receipt || busy() || exporting()) return
    const state = `${kind}State`
    const message = `${kind}Message`
    clearTimeout(doneTimers[kind])
    s.saveState = s.saveState === 'error' ? 'idle' : s.saveState
    s.copyState = s.copyState === 'error' ? 'idle' : s.copyState
    s[state] = 'working'
    s[message] = ''
    draw()
    try {
      const paper = root.querySelector('.tr-paper')
      const blob = await X.exportReceiptPng(paper, { copy: s.copy, logo: globalThis.TRLogo })
      if (kind === 'save') {
        const answer = await magpie.image.save(blob, `token-receipt-${s.receipt.billNo}`)
        s[message] = answer && answer.path ? s.copy.savedTo.replace('{path}', answer.path) : ''
      } else {
        await magpie.image.copy(blob)
      }
      s[state] = 'done'
      doneTimers[kind] = setTimeout(() => {
        if (s[state] !== 'done') return
        s[state] = 'idle'
        s[message] = ''
        draw()
      }, DONE_MS)
    } catch (error) {
      console.error('[token-receipt] export failed', error)
      s[state] = 'error'
      s[message] = error instanceof Error ? error.message : String(error)
    }
    draw()
  }

  const actions = {
    reducedMotion,
    inkReady: () => draw(),
    canExport: () => Boolean(globalThis.magpie && magpie.image),
    onReplay: () => runPrint(true),
    onRetry: () => runPrint(true),
    onSave: () => exportReceipt('save'),
    onCopy: () => exportReceipt('copy'),
    onPeriod(next) {
      if (exporting() || next === s.period || !M.isPeriod(next)) return
      s.anchor = M.anchorForPeriod(next, s.period, s.anchor)
      s.period = next
      persist()
      runPrint(false)
    },
    onCurrency(value) {
      if (exporting()) return
      s.currencyPref = M.CURRENCIES.includes(value) ? value : 'auto'
      persist()
      draw()
    },
    onShift(delta) {
      if (exporting()) return
      const next = M.shiftAnchor(s.period, s.anchor, delta)
      if (next.getTime() === s.anchor.getTime()) return
      s.anchor = next
      runPrint(false)
    },
    onToday() {
      if (exporting()) return
      const today = M.startOfDay(new Date())
      if (s.period === 'day' && s.anchor.getTime() === today.getTime() && s.stage !== 'error') return
      if (s.period !== 'day') persist()
      s.period = 'day'
      s.anchor = today
      runPrint(false)
    },
    onDateClick(event) {
      if (exporting() || event.currentTarget.disabled) return
      try {
        event.currentTarget.showPicker?.()
      } catch {
        /* showPicker may throw if unsupported or already open */
      }
    },
    onPickDate(value) {
      if (exporting() || !value) return
      const parsed = s.period === 'month' ? M.parseMonthKey(value) : M.parseDateKey(value)
      if (!parsed || parsed.getTime() === s.anchor.getTime()) return
      s.anchor = parsed
      runPrint(false)
    },
  }

  // ---- start ----
  draw()
  const [theme] = await Promise.all([magpie.ready, globalThis.TRFonts.load()])
  applyTheme(theme)
  magpie.onTheme(applyTheme)
  try {
    const saved = M.normalizeOptions(await magpie.options.get())
    s.period = saved.period
    s.currencyPref = saved.currency
  } catch {
    /* defaults: today, currency by language */
  }
  if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener('change', draw)
  runPrint(magpie.visible !== false)

  // a period still running gets the minute's new calls while it's seen
  const refreshIfLive = () => {
    if (magpie.visible === false || s.stage !== 'complete' || exporting()) return
    if (M.isCurrentPeriod(s.period, s.anchor)) runPrint(false, { silent: true })
  }
  setInterval(refreshIfLive, REFRESH_MS)
  magpie.onVisibility((visible) => {
    if (visible) refreshIfLive()
  })
})()
