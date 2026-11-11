import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { GumloopPlugin, _internal } from "./index.mjs"
import { LOCK_STALE_MS, LOCK_WAIT_MS, Store } from "./gumloop.mjs"

const auth = { type: "api", key: "mock-regression-key", metadata: { userId: "regression-user" } }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const dirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "gumloop-regression-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const fake = async (url) => url.includes("openrouter.ai")
  ? json({ data: [] })
  : url.includes("/models")
    ? json({ model_groups: [] })
    : json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
async function chat(plugin) {
  const loaded = await plugin.auth.loader(async () => auth)
  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-6-sol", messages: [] }),
  })
  const body = await res.text()
  return { res, body }
}

async function holdLock(directory, runtime = process.execPath, phase = "held") {
  // Pause real lock code at precise crash windows, without changing the
  // filesystem operations. The uninstrumented concurrency tests stay below.
  let source = readFileSync(new URL("./gumloop.mjs", import.meta.url), "utf8")
  const pause = 'process.stdout.write("ready\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);'
  if (phase === "partial") {
    source = source.replace("// Fully written before publication.", `writeFileSync(temporary, '{"pid":'); ${pause}`)
  } else if (phase === "choosing") {
    source = source.replace("publish(0)", `publish(0); ${pause}`)
  }
  const module = phase === "held" ? new URL("./gumloop.mjs", import.meta.url).href
    : `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  const script = `
    const { Store } = await import(${JSON.stringify(module)});
    new Store(${JSON.stringify(join(directory, "gumloop-ledger.json"))}).withLock(() => { ${pause} });
  `
  const child = spawn(runtime, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] })
  const lines = createInterface({ input: child.stdout })
  const done = once(child, "exit")
  let errors = ""
  child.stderr.on("data", (chunk) => { errors += chunk })
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await done
    lines.close()
  }
  try {
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => line),
      done.then(() => { throw new Error(`Lock child exited before ready: ${errors}`) }),
    ])
    expect(ready).toBe("ready")
    return { child, stop }
  } catch (e) {
    await stop()
    throw e
  }
}

describe("exclusive ledger updates", () => {
  test("a live old owner bounds waiting; after forced death the next chat recovers", async () => {
    const directory = tempDir()
    const file = join(directory, "gumloop-ledger.json")
    const store = new Store(file)
    store.anchor(auth.metadata.userId, 5000, "initial")
    const before = readFileSync(file)
    const owner = await holdLock(directory)
    const lock = join(directory, readdirSync(directory).find((name) => name.includes(".lock.") && name.endsWith(".json")))
    let callbacks = 0
    const start = performance.now()
    try {
      expect(store.change(auth.metadata.userId, () => callbacks++)).toBeUndefined()
      expect(store.anchor(auth.metadata.userId, 1, "blocked")).toBeUndefined()
      store.setPrices({ "gpt-6-sol": { p: [99, 99] } })
      const p = _internal.createPlugin({ directory, magpie: true, fetchImpl: fake })
      expect((await chat(p)).res.status).toBe(200)
      expect(callbacks).toBe(0)
      expect(readFileSync(file)).toEqual(before)
      expect(existsSync(lock)).toBe(true)
      expect(performance.now() - start).toBeGreaterThanOrEqual(900)
      expect(performance.now() - start).toBeLessThan(4000)
    } finally {
      await owner.stop()
    }
    expect(() => process.kill(owner.child.pid, 0)).toThrow()
    const recovered = _internal.createPlugin({ directory, magpie: true, fetchImpl: fake })
    expect((await chat(recovered)).res.status).toBe(200)
    expect(store.remaining(auth.metadata.userId)).toBe(4999)
    expect(store.account(auth.metadata.userId).month).toMatchObject({ calls: 1, credits: 1 })
    expect(readdirSync(directory)).toEqual(["gumloop-ledger.json"])
  }, 15000)

  test("a leftover lock record with a live foreign PID blocks at most LOCK_WAIT_MS while fresh and is removed once older than LOCK_STALE_MS", async () => {
    const directory = tempDir()
    const file = join(directory, "gumloop-ledger.json")
    const store = new Store(file)
    store.anchor(auth.metadata.userId, 5000, "initial")
    const uuid = "00000000-0000-4000-8000-000000000001"
    const lockPath = join(directory, `gumloop-ledger.json.lock.${process.ppid}.${uuid}.json`)
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, name: `${process.ppid}.${uuid}`, ticket: 3 }))

    const p = _internal.createPlugin({ directory, magpie: true, fetchImpl: fake })
    const t0 = performance.now()
    expect((await chat(p)).res.status).toBe(200)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 50)
    expect(performance.now() - t0).toBeLessThan(800)
    expect(store.remaining(auth.metadata.userId)).toBe(5000)
    expect(existsSync(lockPath)).toBe(true)

    const old = new Date(Date.now() - LOCK_STALE_MS - 2000)
    utimesSync(lockPath, old, old)
    const t1 = performance.now()
    expect((await chat(p)).res.status).toBe(200)
    expect(performance.now() - t1).toBeLessThan(200)
    expect(existsSync(lockPath)).toBe(false)
    expect(store.remaining(auth.metadata.userId)).toBe(4999)
    expect(readdirSync(directory)).toEqual(["gumloop-ledger.json"])
  })

  test("ignores stray lock filenames and cleans up stale or dead-PID ledger .tmp files", async () => {
    const directory = tempDir()
    const file = join(directory, "gumloop-ledger.json")
    const store = new Store(file)
    store.anchor(auth.metadata.userId, 5000, "initial")
    const strayLock = join(directory, "gumloop-ledger.json.lock.bak")
    const deadTmp = join(directory, "gumloop-ledger.json.99999999.1.tmp")
    const staleLiveTmp = join(directory, `gumloop-ledger.json.${process.ppid}.2.tmp`)
    writeFileSync(strayLock, "unexpected")
    writeFileSync(deadTmp, "{}")
    writeFileSync(staleLiveTmp, "{}")
    const old = new Date(Date.now() - LOCK_STALE_MS - 2000)
    utimesSync(strayLock, old, old)
    utimesSync(staleLiveTmp, old, old)

    const p = _internal.createPlugin({ directory, magpie: true, fetchImpl: fake })
    expect((await chat(p)).res.status).toBe(200)
    expect(store.remaining(auth.metadata.userId)).toBe(4999)
    expect(existsSync(strayLock)).toBe(true)
    expect(existsSync(deadTmp)).toBe(false)
    expect(existsSync(staleLiveTmp)).toBe(false)
  })

  test("an advanced injected Store clock does not treat a fresh live lock record as stale", () => {
    const directory = tempDir()
    const file = join(directory, "gumloop-ledger.json")
    new Store(file).anchor("u", 100, "initial")
    const uuid = "00000000-0000-4000-8000-000000000002"
    const lockPath = join(directory, `gumloop-ledger.json.lock.${process.ppid}.${uuid}.json`)
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, name: `${process.ppid}.${uuid}`, ticket: 1 }))
    const futureStore = new Store(file, () => Date.now() + LOCK_STALE_MS + 60_000)
    let ran = false
    expect(futureStore.change("u", () => { ran = true })).toBeUndefined()
    expect(ran).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
  })

  test("waits for a peer in ticket 0 (choosing) state before entering critical section", () => {
    const directory = tempDir()
    const file = join(directory, "gumloop-ledger.json")
    new Store(file).anchor("u", 100, "initial")
    let enteredA = false
    let enteredB = false
    let choosingRan = false
    const storeB = new Store(file)
    const storeA = new Store(file, Date.now, () => {
      choosingRan = true
      // At this instant storeA has published ticket 0 on disk and chosen ticket 1,
      // but has not yet published ticket 1. storeB sees storeA with ticket 0,
      // picks ticket 1, and must wait on storeA's ticket 0 rather than entering.
      expect(storeB.change("u", (a) => {
        enteredB = true
        a.spent += 10
      })).toBeUndefined()
    })
    expect(storeA.change("u", (a) => {
      enteredA = true
      a.spent += 1
      return a.spent
    })).toBe(1)
    expect(choosingRan).toBe(true)
    expect(enteredA).toBe(true)
    expect(enteredB).toBe(false)
    expect(storeB.remaining("u")).toBe(99)
  })

  for (const runtime of ["node", process.execPath]) {
    for (const phase of ["held", "partial", "choosing"]) {
      test(`${runtime === "node" ? "Node" : "Bun"} crash at ${phase} recovers without manual cleanup`, async () => {
        const directory = tempDir()
        const file = join(directory, "gumloop-ledger.json")
        new Store(file).anchor(auth.metadata.userId, 5000, "initial", 1)
        const before = readFileSync(file)
        const owner = await holdLock(directory, runtime, phase)
        await owner.stop()
        let missing = false
        try { process.kill(owner.child.pid, 0) } catch (e) { missing = e.code === "ESRCH" }
        expect(missing).toBe(true)
        expect(readFileSync(file)).toEqual(before)
        const start = performance.now()
        expect((await chat(_internal.createPlugin({ directory, magpie: true, fetchImpl: fake }))).res.status).toBe(200)
        const store = new Store(file)
        expect(store.remaining(auth.metadata.userId)).toBe(4999)
        expect(store.account(auth.metadata.userId).month).toMatchObject({ calls: 1, credits: 1 })
        expect(readdirSync(directory)).toEqual(["gumloop-ledger.json"])
        expect(performance.now() - start).toBeLessThan(2000)
      }, 15000)
    }
  }

  test("a throwing callback runs once, preserves disk and releases its lock", () => {
    const directory = tempDir()
    const file = join(directory, "gumloop-ledger.json")
    const store = new Store(file)
    store.anchor("u", 100, "initial")
    const before = readFileSync(file)
    let calls = 0
    expect(() => store.change("u", (a) => {
      calls++
      a.spent += 9
      throw new Error("callback failed")
    })).toThrow("callback failed")
    expect(calls).toBe(1)
    expect(readFileSync(file)).toEqual(before)
    expect(existsSync(`${file}.lock`)).toBe(false)
    store.change("u", (a) => a.spent++)
    expect(store.remaining("u")).toBe(99)
    expect(readdirSync(directory)).toEqual(["gumloop-ledger.json"])
  })

  test("an acquisition filesystem error skips the callback and preserves existing bytes", () => {
    const file = join(tempDir(), "not-a-directory")
    writeFileSync(file, "keep")
    const store = new Store(join(file, "ledger.json"))
    let calls = 0
    expect(store.change("u", () => calls++)).toBeUndefined()
    expect(calls).toBe(0)
    expect(readFileSync(file, "utf8")).toBe("keep")
  })

  for (const [name, runtime] of [["Node", "node"], ["Bun", process.execPath]]) {
    test(`${name}: two independent overlapping processes preserve all 200 chat charges`, async () => {
      const directory = tempDir()
      const file = join(directory, "gumloop-ledger.json")
      new Store(file).anchor(auth.metadata.userId, 5000, "initial", 1)
      // Both contenders encounter the same abandoned owner. Recovery must
      // never unlink a new contender's record when another recoverer wins.
      const abandoned = await holdLock(directory, runtime)
      await abandoned.stop()
      // No store instrumentation: each child uses the real response tap and
      // filesystem store. The stdin barrier starts both fresh hosts together.
      const source = `
        import { once } from "node:events";
        const { _internal } = await import(${JSON.stringify(new URL("./index.mjs", import.meta.url).href)});
        const p = _internal.createPlugin({
          directory: ${JSON.stringify(directory)}, magpie: true,
          fetchImpl: async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
        });
        const loaded = await p.auth.loader(async () => (${JSON.stringify(auth)}));
        console.log(JSON.stringify({ ready: true }));
        await once(process.stdin, "data");
        const start = Date.now();
        let successful = 0;
        for (let i = 0; i < 100; i++) {
          const res = await loaded.fetch(loaded.baseURL + "/chat/completions", {
            method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] })
          });
          await res.text();
          if (res.status === 200) successful++;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        console.log(JSON.stringify({ start, end: Date.now(), successful }));
        process.stdin.destroy();
      `
      const children = [0, 1].map(() => {
        const child = spawn(runtime, ["--input-type=module", "--eval", source], { stdio: ["pipe", "pipe", "pipe"] })
        const lines = createInterface({ input: child.stdout })
        const ready = once(lines, "line")
        const done = once(child, "exit")
        let stderr = ""
        child.stderr.on("data", (chunk) => { stderr += chunk })
        return { child, lines, ready, done, stderr: () => stderr }
      })
      try {
        const results = await Promise.all(children.map(async (c) => {
          expect(JSON.parse((await c.ready)[0])).toEqual({ ready: true })
          const result = once(c.lines, "line")
          return { c, result }
        }))
        for (const { c } of results) c.child.stdin.end("go\n")
        const totals = await Promise.all(results.map(async ({ c, result }) => {
          const value = JSON.parse((await result)[0])
          expect((await c.done)[0]).toBe(0)
          expect(c.stderr()).toBe("")
          return value
        }))
        expect(totals.map((v) => v.successful)).toEqual([100, 100])
        expect(Math.max(...totals.map((v) => v.start))).toBeLessThan(Math.min(...totals.map((v) => v.end)))
        const account = JSON.parse(readFileSync(file, "utf8")).accounts[auth.metadata.userId]
        expect(account.month).toMatchObject({ calls: 200, credits: 200 })
        expect(account.spent).toBe(200)
        expect(account.charges).toHaveLength(200)
        expect(new Store(file).remaining(auth.metadata.userId)).toBe(4800)
        expect(readdirSync(directory)).toEqual(["gumloop-ledger.json"])
      } finally {
        for (const { child, lines } of children) {
          if (child.exitCode === null) {
            child.kill()
            await once(child, "exit")
          }
          lines.close()
        }
      }
    }, 15000)
  }
})

describe("short-lived hosts finish accounting before terminal response bytes", () => {
  for (const sse of [false, true]) {
    test(`${sse ? "SSE" : "JSON"} terminal response is not visible before the last usage is charged`, async () => {
      const first = { prompt_tokens: 10, completion_tokens: 1 }
      const last = { prompt_tokens: 10, completion_tokens: 5 }
      const text = sse
        ? `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: ${JSON.stringify({ usage: first })}\n\ndata: ${JSON.stringify({ usage: last })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({ choices: [], usage: last })
      let charged
      let calls = 0
      const source = new ReadableStream({
        start(controller) {
          // Split inside terminal frames and UTF-8-independent ASCII bytes.
          for (let i = 0; i < text.length; i += 7) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 7)))
          controller.close()
        },
      })
      const reader = _internal.tapUsage(source, sse, undefined, (usage) => {
        calls++
        charged = usage
      }).getReader()
      let received = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        received += new TextDecoder().decode(value)
        if (sse ? received.includes('"finish_reason":"stop"}]}\n') : received.endsWith("}")) {
          expect(charged).toEqual(last)
          expect(calls).toBe(1)
        }
      }
      expect(received).toBe(text)
      expect(charged).toEqual(last)
      expect(calls).toBe(1)
    })
  }
})

describe("SSE byte boundaries and backpressure", () => {
  const encode = (text) => new TextEncoder().encode(text)
  const frame = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
  async function readSoon(reader) {
    let timer
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SSE first read stalled")), 1000) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  test("DONE accounts before a combined content/terminal chunk is visible without waiting for EOF", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5 }
    const text = frame + 'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
      `data: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`
    let upstream
    const calls = []
    const source = new ReadableStream({
      start(controller) { upstream = controller; controller.enqueue(encode(text)) },
    })
    const reader = _internal.tapUsage(source, true, undefined, (...args) => calls.push(args)).getReader()
    try {
      expect((await readSoon(reader)).value).toEqual(encode(text))
      expect(calls).toEqual([[usage, false]])
      upstream.close()
      expect((await readSoon(reader)).done).toBe(true)
      expect(calls).toEqual([[usage, false]])
    } finally {
      await reader.cancel()
    }
  })

  test("101 cross-event chunks deliver complete frames while the source remains open", async () => {
    let upstream
    let pulls = 0
    let produced = 0
    const calls = []
    const source = new ReadableStream({
      start(controller) { upstream = controller },
      pull(controller) {
        pulls++
        if (produced < 101) controller.enqueue(encode((produced++ === 0 ? frame : frame.slice(1)) + "d"))
      },
    })
    const reader = _internal.tapUsage(source, true, undefined, (...args) => calls.push(args)).getReader()
    const received = []
    try {
      const first = await readSoon(reader)
      expect(new TextDecoder().decode(first.value)).toBe(frame)
      received.push(first.value)
      await settle()
      expect(pulls).toBeLessThanOrEqual(4)
      const idlePulls = pulls
      await settle()
      expect(pulls).toBe(idlePulls)
      for (let i = 1; i < 101; i++) received.push((await readSoon(reader)).value)
      expect(calls).toEqual([])
      upstream.close()
      while (true) {
        const result = await readSoon(reader)
        if (result.done) break
        received.push(result.value)
      }
      expect(Buffer.concat(received)).toEqual(Buffer.from(frame.repeat(101) + "d"))
      expect(calls).toEqual([[undefined, false]])
    } finally {
      await reader.cancel()
    }
  })

  test("a 10 MiB content source delivers immediately and cancellation does not drain it", async () => {
    const large = frame.replace("hello", "x".repeat(65535))
    let pulls = 0
    let cancelled = 0
    let reason
    const calls = []
    const source = new ReadableStream({
      pull(controller) {
        if (pulls < 160) controller.enqueue(encode((pulls++ === 0 ? large : large.slice(1)) + "d"))
      },
      cancel(value) { cancelled++; reason = value },
    })
    const reader = _internal.tapUsage(source, true, undefined, (...args) => calls.push(args)).getReader()
    try {
      expect(large.length * 160).toBeGreaterThan(10 * 1024 * 1024)
      expect((await readSoon(reader)).value).toEqual(encode(large))
      await settle()
      expect(pulls).toBeLessThanOrEqual(4)
      await reader.cancel("consumer stopped")
      await settle()
      expect(cancelled).toBe(1)
      expect(reason).toBe("consumer stopped")
      const stoppedAt = pulls
      await settle()
      expect(pulls).toBe(stoppedAt)
      expect(calls).toEqual([[undefined, true]])
    } finally {
      await reader.cancel()
    }
  })

  test("split UTF-8, LF, CRLF and an unterminated EOF frame preserve exact bytes", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5 }
    const terminal = 'data: {"choices":[{"finish_reason":"stop"}]}\r\n\r\n'
    const bytes = encode(
      frame.replace("hello", "你好🙂é").replaceAll("\n", "\r\n") +
      frame + terminal + `data: ${JSON.stringify({ usage })}\n\ndata: [DONE]`,
    )
    let offset = 0
    let calls = 0
    let charged
    const source = new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset))
        else controller.close()
      },
    })
    const reader = _internal.tapUsage(source, true, undefined, (value) => { calls++; charged = value }).getReader()
    const received = []
    try {
      while (true) {
        const result = await readSoon(reader)
        if (result.done) break
        received.push(result.value)
        if (Buffer.concat(received).includes(Buffer.from(terminal))) {
          expect(charged).toEqual(usage)
          expect(calls).toBe(1)
        }
      }
      expect(Buffer.concat(received)).toEqual(Buffer.from(bytes))
      expect(charged).toEqual(usage)
      expect(calls).toBe(1)
    } finally {
      await reader.cancel()
    }
  })

  for (const terminal of [false, true]) {
    test(`${terminal ? "terminal tail" : "unterminated line"} overflow is bounded and preserves bytes`, async () => {
      const prefix = terminal
        ? 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\n'
        : "data: "
      const part = terminal ? ":" + "x".repeat(8190) + "\n" : "x".repeat(8192)
      let pulls = 0
      const calls = []
      const source = new ReadableStream({
        pull(controller) {
          if (pulls < 100) controller.enqueue(encode((pulls++ === 0 ? prefix : "") + part))
          else controller.close()
        },
      })
      const reader = _internal.tapUsage(source, true, undefined, (...args) => calls.push(args)).getReader()
      const received = []
      try {
        const first = await readSoon(reader)
        expect(first.value.byteLength).toBe(256 * 1024)
        received.push(first.value)
        expect(calls).toEqual([[undefined, true]])
        await settle()
        expect(pulls).toBeLessThanOrEqual(36)
        const idlePulls = pulls
        await settle()
        expect(pulls).toBe(idlePulls)
        while (true) {
          const result = await readSoon(reader)
          if (result.done) break
          received.push(result.value)
        }
        expect(Buffer.concat(received)).toEqual(Buffer.from(prefix + part.repeat(100)))
        expect(calls).toEqual([[undefined, true]])
      } finally {
        await reader.cancel()
      }
    })
  }
})

describe("OpenCode project ledger isolation", () => {
  for (const [name, bytes] of [
    ["valid", '{ "accounts": { "regression-user": { "spent": 99 } }, "project": true }\n'],
    ["corrupt", '{"accounts": broken'],
  ]) {
    test(`existing ${name} project ledger is untouched by calibration, chat and prices`, async () => {
      const directory = tempDir()
      const file = join(directory, "gumloop-ledger.json")
      writeFileSync(file, bytes)
      const p = await GumloopPlugin({ directory }, { balance: 7000 })
      await p.auth.loader(async () => auth)
      expect(readFileSync(file, "utf8")).toBe(bytes)
      const local = _internal.createPlugin({ directory, options: { balance: 7000 }, fetchImpl: fake })
      expect((await chat(local)).res.status).toBe(200)
      expect((await local.auth.usage(async () => auth)).balance).toBe("6999 credits")
      expect(readFileSync(file, "utf8")).toBe(bytes)
      expect(readdirSync(directory)).toEqual(["gumloop-ledger.json"])
    })
  }
  test("Magpie persists calibration and chat charges and reloads them", async () => {
    const directory = tempDir()
    const p = await GumloopPlugin({ directory, magpie: {} }, { balance: 7000 })
    await p.auth.loader(async () => auth)
    const local = _internal.createPlugin({ directory, magpie: true, fetchImpl: fake })
    expect((await chat(local)).res.status).toBe(200)
    const store = new Store(join(directory, "gumloop-ledger.json"))
    expect(store.remaining(auth.metadata.userId)).toBe(6999)
    expect(store.account(auth.metadata.userId).month.calls).toBe(1)
  })
})

describe("structured credit refusals", () => {
  const cases = [
    [403, { error: { code: "provider_error", message: "upstream credit_limit_exceeded" } }, false],
    [403, { error: { message: "credit_limit_exceeded" } }, false],
    [403, { message: "credit_limit_exceeded" }, false],
    [403, "provider failed: credit_limit_exceeded", false],
    [403, { error: null }, false],
    [403, null, false],
    [400, { error: { code: "provider_error", message: "credit_limit_exceeded" } }, false],
    [429, { error: { code: "tier_limit" } }, false],
    [403, { error: { code: "credit_limit_exceeded" } }, true],
    [403, { error: { type: "credit_limit_exceeded" } }, true],
    [403, { error: "credit_limit_exceeded" }, true],
    [403, { code: "credit_limit_exceeded" }, true],
    [402, { error: "Payment required" }, false],
    [402, { error: { code: 402, message: "Insufficient credits" } }, false],
  ]
  for (const [status, body, exhausted] of cases) {
    test(`${status} ${JSON.stringify(body)} ${exhausted ? "exhausts" : "preserves"} balance`, async () => {
      const text = typeof body === "string" ? body : JSON.stringify(body)
      const p = _internal.createPlugin({
        options: { balance: 5000 },
        fetchImpl: async (url) => url.includes("/models") ? fake(url) : new Response(text, { status }),
      })
      const result = await chat(p)
      expect(result.res.status).toBe(exhausted ? 429 : status)
      expect(result.res.headers.get("x-magpie-sign-in")).toBe(exhausted || status === 403 ? "kept" : null)
      if (!exhausted) expect(result.body).toBe(text)
      expect((await p.auth.usage(async () => auth)).balance).toBe(exhausted ? "0 credits" : "5000 credits")
    })
  }
})

describe("chat 403 checks account credentials with models", () => {
  for (const status of [200, 401, 403, 500, "network"]) {
    test(`upstream Invalid API key with models ${status}`, async () => {
      let probes = 0
      let cancelled = 0
      const body = JSON.stringify({ error: { code: "provider_error", message: "Fireworks: Invalid API key" } })
      const p = _internal.createPlugin({
        fetchImpl: async (url, init) => {
          if (!url.includes("/models")) return new Response(body, { status: 403, headers: { "x-original": "preserved" } })
          probes++
          const headers = new Headers(init.headers)
          expect(headers.get("authorization")).toBe(`Bearer ${auth.key}`)
          expect(headers.get("x-auth-key")).toBe(auth.metadata.userId)
          if (status === "network") throw new Error("offline")
          return new Response(new ReadableStream({ cancel() { cancelled++ } }), { status })
        },
      })
      const result = await chat(p)
      expect(probes).toBe(1)
      expect(cancelled).toBe(status === "network" ? 0 : 1)
      expect(result.res.status).toBe(403)
      expect(result.body).toBe(body)
      expect(result.res.headers.get("x-original")).toBe("preserved")
      expect(result.res.headers.get("x-magpie-sign-in")).toBe(status === 200 ? "kept" : status === 401 || status === 403 ? "expired" : null)
    })
  }
})
