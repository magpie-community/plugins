// The page's DOM: a small h() and an in-place patch, so the receipt tree reads like
// dsh-token-receipt's React one while focus and the paper-feed animation survive
// each render.
(function (root) {
  const M = root.TRModel
  const SVG_NS = 'http://www.w3.org/2000/svg'

  // ---- h() and patch ----
  function h(t, p, ...c) {
    const children = []
    const add = (x) => {
      if (x === null || x === undefined || x === false || x === true) return
      if (Array.isArray(x)) x.forEach(add)
      else children.push(typeof x === 'object' ? x : String(x))
    }
    add(c)
    return { t, p: p || {}, c: children }
  }

  function setProps(el, prev, next) {
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      const value = next[key]
      if (key === 'ref') continue
      if (key.startsWith('on')) {
        const type = key.slice(2).toLowerCase()
        el._on = el._on || {}
        if (!el._on[type]) el.addEventListener(type, (e) => el._on[type] && el._on[type](e))
        el._on[type] = value
        continue
      }
      if (prev[key] === value && key !== 'value') continue
      const attr = key === 'className' ? 'class' : key
      if (key === 'value') {
        if (el.value !== String(value ?? '')) el.value = String(value ?? '')
      } else if (value === false || value === null || value === undefined) {
        el.removeAttribute(attr)
        if (key === 'disabled') el.disabled = false
      } else if (value === true) {
        el.setAttribute(attr, '')
        if (key === 'disabled') el.disabled = true
      } else {
        el.setAttribute(attr, String(value))
      }
    }
    el._p = next
    if (typeof next.ref === 'function') next.ref(el)
  }

  function create(v, svg) {
    if (typeof v === 'string') return document.createTextNode(v)
    const inSvg = svg || v.t === 'svg'
    const el = inSvg ? document.createElementNS(SVG_NS, v.t) : document.createElement(v.t)
    // children first: a <select>'s value needs its options in place
    for (const child of v.c) el.appendChild(create(child, inSvg))
    setProps(el, {}, v.p)
    return el
  }

  function patch(dom, v, svg) {
    if (typeof v === 'string') {
      if (dom.nodeType === 3) {
        if (dom.data !== v) dom.data = v
        return dom
      }
      const text = document.createTextNode(v)
      dom.replaceWith(text)
      return text
    }
    const inSvg = svg || v.t === 'svg'
    if (dom.nodeType !== 1 || dom.localName !== v.t) {
      const fresh = create(v, inSvg)
      dom.replaceWith(fresh)
      return fresh
    }
    patchChildren(dom, v.c, inSvg)
    setProps(dom, dom._p || {}, v.p)
    return dom
  }

  function patchChildren(parent, children, svg) {
    children.forEach((child, i) => {
      const dom = parent.childNodes[i]
      if (dom) patch(dom, child, svg)
      else parent.appendChild(create(child, svg))
    })
    while (parent.childNodes.length > children.length) parent.lastChild.remove()
  }

  function render(container, v) {
    patchChildren(container, [v], false)
  }

  // ---- glyphs ----
  const stroke = (size, width, ...paths) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, paths)
  const path = (d) => h('path', { d })

  // magpie's mark (page/logo.js) in the 40px box the receipt head gave the whale
  const LOGO = root.TRLogo
  const MagpieGlyph = (size = 40) => h('svg', { width: size, height: size, viewBox: `0 0 ${LOGO.viewBox} ${LOGO.viewBox}`, fill: 'currentColor', 'aria-hidden': 'true' },
    h('path', { d: LOGO.d, 'fill-rule': LOGO.fillRule }))
  const PrinterGlyph = (size = 18) => stroke(size, 1.6, path('M6.5 8V4.5h11V8'), h('rect', { x: 3, y: 8, width: 18, height: 9, rx: 2.2 }), path('M7.5 17v2.5h9V17'), path('M7.5 12.5h9'))
  const Chevron = (dir) => stroke(14, 2, path(dir === 'right' ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'))
  const HomeIcon = () => stroke(12, 2, path('M4 11.5L12 4l8 7.5'), path('M6.5 10.5V20h11v-9.5'))
  const CalendarIcon = () => stroke(12, 1.8, h('rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }), path('M8 3v4M16 3v4M3 10h18'))
  const DownloadIcon = () => stroke(14, 2, path('M12 3v12'), path('M7 10l5 5 5-5'), path('M4 21h16'))
  const CopyIcon = () => stroke(14, 2, h('rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }), path('M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8'))
  const ReplayIcon = () => stroke(14, 2, path('M4 11a8 8 0 1 1 2.3 5.7'), path('M4 5v6h6'))
  const Spinner = () => h('svg', { class: 'tr-spin', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', 'stroke-opacity': 0.18, 'stroke-width': 2.4 }),
    h('path', { d: 'M20.5 12a8.5 8.5 0 0 0-8.5-8.5', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }))
  const CheckCircle = () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    h('circle', { cx: 12, cy: 12, r: 9, fill: '#30a46c' }),
    h('path', { d: 'M8 12.2l2.6 2.6L16.3 9', stroke: '#fff', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
  const AlertIcon = () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M12 3.5L21 20H3z', stroke: '#f0a49a', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }),
    h('path', { d: 'M12 9v5', stroke: '#f0a49a', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
    h('circle', { cx: 12, cy: 17, r: 1, fill: '#f0a49a' }))

  // ---- the receipt ----
  // The agents' logos in the meta block, in black and white (style.css; the PNG
  // exporter prints them the same way). An agent with no logo gets its initial.
  // the re-inked logo once page/ink.js has drawn it (it calls inkReady then);
  // until then, or where the engine won't let it, the logo greyed by style.css
  function agentImg(agent, inkReady) {
    const inked = root.TRInk ? root.TRInk.inked(agent.src, agent.mono, inkReady) : null
    return h('img', {
      src: inked || agent.src, alt: agent.name, width: 12, height: 12, draggable: 'false',
      'data-inked': inked ? '1' : null, 'data-mono': agent.mono ? '1' : null,
    })
  }

  function AgentIcons(agents, moreAgents, inkReady) {
    return [
      agents.map((agent) => h('span', { className: `tr-agent${agent.src ? '' : ' tr-agent-initial'}`, title: agent.name },
        agent.src
          ? agentImg(agent, inkReady)
          : Array.from(agent.name)[0].toUpperCase())),
      moreAgents > 0 ? h('span', { className: 'tr-agent-more' }, `+${moreAgents}`) : null,
    ]
  }

  // Hidden for now: the reasoning tokens vendors report (OpenAI's
  // reasoning_tokens, Claude's and Gemini's thinking). They are part of the
  // output, not tokens on top of it, so the row read as a second count beside
  // input and output; and vendors that don't report them leave it short. The
  // receipt's totals never added them, so hiding the row changes no figure.
  // Set this to true to print the row in the meta block again.
  const SHOW_REASONING = false

  // Hidden for now: the notes under the meta block (how many requests had no
  // price, and the CNY / JPY rate the money was converted at). The total's own
  // label still says "Priced subtotal" when some calls had no price. Set this
  // to true to print the notes again.
  const SHOW_PRICE_NOTES = false

  const row = (label, value) => h('div', { className: 'tr-summary-row' }, h('dt', null, label), h('dd', null, value))

  function Receipt(r, { copy, lang, currency, inkReady }) {
    const money = (usd) => M.fmtMoney(usd, currency, r.pricing.rates)
    const t = r.totals
    const notes = []
    if (SHOW_PRICE_NOTES && r.pricing.partial) notes.push(copy.partialPrice.replace('{n}', M.fmtExact(r.pricing.unpriced, lang)))
    if (SHOW_PRICE_NOTES && currency === 'cny') notes.push(copy.exchangeRate.replace('{rate}', Number(r.pricing.rates.cny.toFixed(4))))
    if (SHOW_PRICE_NOTES && currency === 'jpy') notes.push(copy.exchangeRateJpy.replace('{rate}', M.JPY_RATE).replace('{date}', M.JPY_RATE_DATE))
    const issued = r.generatedAt
    const modelRow = (model) => h('div', { className: 'tr-item-block' },
      h('div', { className: 'tr-item' },
        h('span', { className: 'tr-item-name', title: model.model }, model.model),
        h('span', { className: 'tr-item-value', title: model.costUsd === null ? copy.unpriced : null },
          model.costUsd === null ? '—' : `${model.complete ? '' : '≈'}${money(model.costUsd)}`)),
      h('p', { className: 'tr-item-detail' }, `${M.fmtExact(model.total, lang)} tokens · ${M.fmtExact(model.requests, lang)} ${copy.requests.toLowerCase()}`))
    // magpie prices each call whole, so the breakdown lists tokens, not a cost per kind
    const tokens = (label, value) => row(label, M.fmtExact(value, lang))
    return h('article', { className: 'tr-paper', lang, 'data-currency': currency, 'aria-label': copy.receiptLabel },
      h('div', { className: 'tr-paper-head' },
        h('span', { className: 'tr-paper-logo' }, MagpieGlyph(40)),
        h('p', { className: 'tr-paper-kicker' }, 'TOKEN RECEIPT'),
        h('p', { className: 'tr-paper-date' }, r.label)),
      h('div', { className: 'tr-rule' }),
      h('p', { className: 'tr-section-label' }, copy.model),
      r.models.length > 0
        ? h('div', { className: 'tr-items' }, r.models.map(modelRow))
        : h('div', { className: 'tr-empty' }, copy.noUsage),
      h('div', { className: 'tr-rule tight' }),
      h('dl', { className: 'tr-summary' },
        tokens(copy.input, t.inputTokens),
        tokens(copy.output, t.outputTokens),
        t.cacheReadTokens > 0 ? tokens(copy.cacheRead, t.cacheReadTokens) : null,
        t.cacheWriteTokens > 0 ? tokens(copy.cacheWrite, t.cacheWriteTokens) : null,
        h('div', { className: 'tr-total' },
          h('dt', null, r.pricing.partial ? copy.partialTotal : copy.estimatedTotal),
          h('dd', null, money(r.pricing.totalUsd)))),
      h('div', { className: 'tr-rule tight' }),
      h('dl', { className: 'tr-meta' },
        h('dt', null, copy.totalTokens), h('dd', null, M.fmtExact(t.totalTokens, lang)),
        h('dt', null, `${copy.requests} / ${copy.errors}`), h('dd', null, `${M.fmtExact(t.requests, lang)} / ${M.fmtExact(t.errors, lang)}`),
        h('dt', null, copy.agents), h('dd', { className: 'tr-agents', 'aria-label': r.agents.map((a) => a.name).join(', ') },
          r.agents.length ? AgentIcons(r.agents, t.agents - r.agents.length, inkReady) : '—'),
        SHOW_REASONING && t.reasoningTokens > 0 ? [h('dt', null, copy.reasoning), h('dd', null, M.fmtExact(t.reasoningTokens, lang))] : null,
        h('dt', null, copy.billNo), h('dd', null, r.billNo),
        h('dt', null, copy.period), h('dd', null, M.periodName(r.period, copy)),
        h('dt', null, copy.generated), h('dd', null, M.fmtDateTime(issued)),
        h('dt', null, copy.currency), h('dd', null, currency.toUpperCase())),
      notes.length > 0 ? h('div', { className: 'tr-price-notes' }, notes.map((note) => h('p', null, note))) : null,
      h('div', { className: 'tr-barcodewrap' },
        h('div', { className: 'tr-barcode', 'aria-hidden': 'true' }),
        h('p', { className: 'tr-barcode-label' }, r.billNo),
        // two spans, so the site keeps its lower case (and the PNG draws each at its own place)
        h('p', { className: 'tr-thanks' }, h('span', null, copy.thankYou), h('span', { className: 'tr-site' }, M.SITE))))
  }

  function StatusLine(stage, copy) {
    const complete = stage === 'complete'
    const failed = stage === 'error'
    const working = stage === 'processing' || stage === 'printing'
    const text = stage === 'processing' ? copy.preparing : stage === 'printing' ? copy.printingStatus : complete ? copy.completeStatus : failed ? copy.errorStatus : copy.readyStatus
    return h('div', { className: `tr-status${complete ? ' is-complete' : ''}${failed ? ' is-error' : ''}` },
      h('span', { className: 'tr-status-icon' }, complete ? CheckCircle() : failed ? AlertIcon() : working ? Spinner() : CheckCircle()),
      h('div', { role: 'status', 'aria-live': 'polite', className: 'tr-status-text' }, text))
  }

  // An action button's label for its state: idle, working, done or failed.
  function actionLabel(state, labels) {
    return labels[state] || labels.idle
  }

  // ---- the page ----
  function Page(s, a) {
    const { copy, lang } = s
    const now = new Date()
    const currency = M.resolveCurrency(s.currencyPref, lang)
    const range = M.periodRange(s.period, s.anchor)
    const current = M.isCurrentPeriod(s.period, s.anchor, now)
    const rel = M.relativeLabel(s.period, range.start, s.anchor, copy, now)
    const busy = s.stage === 'processing' || s.stage === 'printing'
    const exporting = s.saveState === 'working' || s.copyState === 'working'
    const actionLocked = busy || exporting
    const reduced = a.reducedMotion()
    const receipt = s.receipt
    const allTime = s.period === 'all'
    // all time's first day comes with the read
    const dateText = allTime ? (receipt ? receipt.label : copy.allTime) : M.periodLabel(s.period, range.start, range.end, lang)
    const screenSub = s.period === 'day' ? `${rel ? `${rel} · ` : ''}${M.shortDate(range.start, lang)}` : dateText
    const isMonth = s.period === 'month'
    const today = M.startOfDay(now)
    const saveLabel = actionLabel(s.saveState, { idle: copy.savePng, working: copy.savingPng, done: copy.savedPng, error: copy.saveFailed })
    const copyLabel = actionLabel(s.copyState, { idle: copy.copyImage, working: copy.copyingImage, done: copy.copiedImage, error: copy.copyFailed })
    const primaryLabel = busy ? copy.printingButton : s.stage === 'complete' ? copy.again : copy.print
    const exportError = s.saveState === 'error' ? { title: copy.saveFailed, message: s.saveMessage, retry: a.onSave }
      : s.copyState === 'error' ? { title: copy.copyFailed, message: s.copyMessage, retry: a.onCopy } : null
    const announce = s.saveState === 'done' ? s.saveMessage || copy.savedPng : s.copyState === 'done' ? copy.copiedImage : exportError ? `${exportError.title}: ${exportError.message}` : ''

    return h('div', { className: `tr-page${s.dark ? ' is-dark' : ''}`, lang },
      h('div', { className: 'tr-shell' },
        h('header', { className: 'tr-head' },
          h('div', null,
            h('p', { className: 'tr-eyebrow' }, 'magpie · Usage'),
            h('h1', { className: 'tr-title' }, copy.title),
            h('p', { className: 'tr-sub' }, copy.subtitle)),
          h('div', { className: 'tr-actions' },
            h('span', { className: 'tr-sr-only', role: 'status', 'aria-live': 'polite' }, announce),
            s.saveState === 'done' && s.saveMessage ? h('span', { className: 'tr-status-msg', title: s.saveMessage }, s.saveMessage) : null,
            h('button', { className: 'tr-btn', type: 'button', disabled: !receipt || actionLocked || !a.canExport(), onClick: a.onCopy },
              s.copyState === 'done' ? CheckCircle() : CopyIcon(), copyLabel),
            h('button', { className: 'tr-btn', type: 'button', disabled: !receipt || actionLocked || !a.canExport(), onClick: a.onSave },
              s.saveState === 'done' ? CheckCircle() : DownloadIcon(), saveLabel),
            h('button', { className: 'tr-btn tr-btn-primary', type: 'button', disabled: actionLocked, onClick: a.onReplay },
              s.stage === 'complete' ? ReplayIcon() : PrinterGlyph(15), primaryLabel))),
        h('div', { className: 'tr-controls' },
          h('div', { className: 'tr-filter-group' },
            h('div', { className: 'tr-periods', role: 'group', 'aria-label': copy.period },
              M.PERIODS.map((value) => h('button', {
                className: `tr-periodbtn${s.period === value ? ' is-active' : ''}`, type: 'button',
                'aria-pressed': String(s.period === value), disabled: exporting, onClick: () => a.onPeriod(value),
              }, copy[value]))),
            h('label', { className: 'tr-currency' }, copy.currency,
              h('select', { value: s.currencyPref, disabled: exporting, 'aria-label': copy.currency, onChange: (e) => a.onCurrency(e.target.value) },
                h('option', { value: 'auto' }, `${copy.autoCurrency} (${M.defaultCurrencyForLocale(lang).toUpperCase()})`),
                h('option', { value: 'usd' }, 'USD'), h('option', { value: 'cny' }, 'CNY'), h('option', { value: 'jpy' }, 'JPY')))),
          h('div', { className: 'tr-daternav' },
            h('div', { className: 'tr-datenav' },
              h('button', { className: 'tr-navbtn', type: 'button', 'aria-label': copy.prevPeriod, title: copy.prevPeriod, disabled: exporting || allTime, onClick: () => a.onShift(-1) }, Chevron('left')),
              h('label', { className: 'tr-datebox', title: copy.pickDate },
                h('span', { className: 'tr-datemain' }, dateText),
                rel ? h('span', { className: 'tr-daterel' }, rel) : null,
                h('span', { className: 'tr-dateicon', 'aria-hidden': 'true' }, CalendarIcon()),
                h('input', {
                  className: 'tr-datepicker', disabled: exporting || allTime, type: isMonth ? 'month' : 'date',
                  value: isMonth ? M.monthKey(s.anchor) : M.dateKey(s.anchor),
                  max: isMonth ? M.monthKey(today) : M.dateKey(today),
                  'aria-label': copy.pickDate, onClick: a.onDateClick, onChange: (e) => a.onPickDate(e.target.value),
                })),
              h('button', { className: 'tr-navbtn', type: 'button', 'aria-label': copy.nextPeriod, title: copy.nextPeriod, disabled: exporting || current, onClick: () => a.onShift(1) }, Chevron('right'))),
            current ? null : h('button', { className: 'tr-btn tr-todaybtn', type: 'button', disabled: exporting, onClick: a.onToday }, copy.backToday))),
        exportError
          ? h('div', { className: 'tr-save-error', role: 'alert' },
              h('strong', null, exportError.title),
              h('span', null, exportError.message),
              h('button', { className: 'tr-btn', type: 'button', disabled: !receipt || actionLocked, onClick: exportError.retry }, copy.retry))
          : null,
        h('section', { className: 'tr-stage', 'aria-label': copy.title },
          h('div', { className: 'tr-printer' },
            h('div', { className: 'tr-machine' },
              h('div', { className: 'tr-machine-head' },
                h('div', { className: 'tr-brand' }, PrinterGlyph(22), h('span', null, 'TOKEN RECEIPT')),
                h('button', { className: 'tr-machine-btn', type: 'button', disabled: exporting, onClick: a.onToday }, h('span', null, HomeIcon(), copy.today))),
              h('div', { className: 'tr-screen' },
                h('div', { className: 'tr-screen-row' },
                  h('div', null, h('p', { className: 'tr-screen-title' }, copy.usage), h('p', { className: 'tr-screen-sub' }, screenSub)),
                  h('div', { className: 'tr-screen-right' },
                    h('p', { className: 'tr-screen-label' }, receipt && receipt.pricing.partial ? copy.partialTotal : copy.estimatedTotal),
                    h('p', { className: 'tr-screen-total' }, receipt ? M.fmtMoney(receipt.pricing.totalUsd, currency, receipt.pricing.rates) : '—'))),
                StatusLine(s.stage, copy)),
              h('div', { className: 'tr-slot', 'aria-hidden': 'true' })),
            s.error
              ? h('div', { className: 'tr-error', role: 'alert' },
                  h('strong', null, copy.fetchError),
                  h('span', null, s.error),
                  h('div', null, h('button', { className: 'tr-btn', type: 'button', disabled: actionLocked, onClick: a.onRetry }, copy.retry)))
              : h('div', { className: 'tr-output' },
                  h('div', {
                    className: `tr-paper-wrap${reduced ? ' is-reduced' : ''}`,
                    'data-stage': s.stage, 'aria-hidden': String(s.stage !== 'complete'),
                  }, receipt ? Receipt(receipt, { copy, lang, currency, inkReady: a.inkReady }) : null))),
          h('div', { className: 'tr-foot' }, h('i', null), copy.dataNote))))
  }

  root.TRView = { h, render, Page }
})(globalThis)
