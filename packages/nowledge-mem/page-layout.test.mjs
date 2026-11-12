// This small layout regression runs only with Linux Chrome. It uses a data
// URL, a temporary profile and no network or user browser state.
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

const chrome = process.platform === "linux" &&
  (Bun.which("google-chrome") || Bun.which("google-chrome-stable") || Bun.which("chromium") || Bun.which("chromium-browser"))
const LAUNCH_BOUND = 25000

test.skipIf(!chrome)("narrow settings footer keeps translated actions inside the dialog", async () => {
  const read = (name) => Bun.file(new URL(`./page/${name}`, import.meta.url)).text()
  const [html, css, dictionary] = await Promise.all([read("settings.html"), read("style.css"), read("i18n.js")])
  const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0]
  expect(footer).toBeTruthy()
  const { messages } = runInNewContext(`${dictionary}\nnowledgeMemI18n`)
  const translations = Object.fromEntries(["en", "zh", "zh-TW", "ja", "de"].map((lang) => [lang, {
    saveHelp: messages[lang].saveHelp, cancel: messages[lang].cancel, save: messages[lang].save,
  }]))
  const script = `
    const translations = ${JSON.stringify(translations)};
    const footer = ${JSON.stringify(footer)};
    const results = [];
    for (const language of Object.keys(translations)) for (const width of [320, 380, 900]) for (const theme of ['light', 'dark']) {
      const host = document.createElement('div'); host.style.width = width + 'px';
      host.style.colorScheme = theme;
      if (theme === 'dark') { host.style.setProperty('--magpie-card', '#222'); host.style.setProperty('--magpie-fg', '#eee'); }
      host.innerHTML = '<dialog open><form><div class="dialog-body"><small id="key-help">Help</small><div class="field-wrap"><label>Key environment</label></div></div>' + footer + '</form></dialog>';
      host.querySelectorAll('[data-t]').forEach((el) => { el.textContent = translations[language][el.dataset.t]; });
      document.body.append(host);
      const box = host.querySelector('dialog').getBoundingClientRect();
      const form = host.querySelector('form').getBoundingClientRect();
      const foot = host.querySelector('footer').getBoundingClientRect();
      const actions = host.querySelector('.actions').getBoundingClientRect();
      const save = host.querySelector('#save').getBoundingClientRect();
      const gap = host.querySelector('.field-wrap').getBoundingClientRect().top - host.querySelector('#key-help').getBoundingClientRect().bottom;
      const inside = (r, p) => r.left >= p.left - 1 && r.right <= p.right + 1;
      results.push({language, width, theme, fits: inside(form, box) && inside(foot, box) && inside(actions, foot) && inside(save, foot), gap});
    }
    document.getElementById('results').textContent = JSON.stringify(results);
  `
  const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>${css}\ndialog { position: relative; inset: auto; margin: 0; }</style><pre id="results"></pre><script>${script}</script>`
  const temp = await mkdtemp(join(tmpdir(), "nowledge-layout-"))
  try {
    const proc = Bun.spawn({
      cmd: ["setsid", chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-extensions", "--disable-sync", "--disable-features=OnDeviceSpeechRecognition,SODA,OptimizationHints,MediaRouter,Translate", "--disable-component-update", "--disable-breakpad", "--disable-field-trial-config", "--no-service-autorun", "--disable-default-apps", "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${temp}/profile`, "--window-size=1200,1600", "--dump-dom", `data:text/html;charset=utf-8,${encodeURIComponent(page)}`],
      env: { HOME: temp, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: `${temp}/config`, XDG_CACHE_HOME: `${temp}/cache` },
      stdout: "pipe", stderr: "pipe",
    })
    // The results are read as soon as Chrome prints them, and Chrome is then
    // stopped: the test needs the dumped DOM, not Chrome's own exit (#972).
    // A launch that prints nothing by the bound is stopped too, and the test
    // fails with what Chrome wrote to stderr instead of a bare timeout.
    const err = new Response(proc.stderr).text()
    const found = /<pre id="results">([^<]+)<\/pre>/
    let out = ""
    let timedOut = false
    // setsid gives Chrome a process group of its own, so stopping it stops
    // its zygote, GPU and renderer children too.
    const stop = () => { try { process.kill(-proc.pid, "SIGKILL") } catch {} }
    const bound = setTimeout(() => { timedOut = true; stop() }, LAUNCH_BOUND)
    try {
      const decoder = new TextDecoder()
      for await (const chunk of proc.stdout) {
        out += decoder.decode(chunk, { stream: true })
        if (found.test(out)) break
      }
    } finally {
      clearTimeout(bound)
      stop()
    }
    await proc.exited
    const result = out.match(found)?.[1]
    if (!result) throw new Error(`Chrome gave no results${timedOut ? ` within ${LAUNCH_BOUND}ms` : ` (exit ${proc.exitCode})`}; stderr:\n${(await err).slice(-4000)}`)
    const rows = JSON.parse(result)
    expect(rows).toHaveLength(30)
    for (const row of rows) {
      expect({ language: row.language, width: row.width, fits: row.fits }).toEqual({ language: row.language, width: row.width, fits: true })
      expect(row.gap).toBeGreaterThanOrEqual(11)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 30000)
