// magpie's Amp bridge: an Amp plugin that serves amp.ai.generate on
// 127.0.0.1, for @magpie-community/opencode-amp-auth. That package puts this
// file in a folder of its own (<dir>/.amp/plugins/) and starts
// `amp --no-tui` there, so it is loaded by that runner alone and never by
// the user's own Amp sessions.
//
// It listens on a free port of 127.0.0.1, writes the port to <dir>/port and
// answers only requests with the key the package wrote to <dir>/key:
//   GET  /health   → { ok, version, thread }
//   POST /generate → { result } (text, or the object a schema asked for);
//                    on a failure, { error } with status 502
//   POST /stop     → stops the runner (a package of another version starts
//                    its own bridge)
// Each generate is billed to the account through one private thread, made
// on the first request and kept in <dir>/thread (made again when it was
// deleted in Amp). When no request has come
// for <dir>/idle minutes (the package writes it; 30 if not), the runner is
// stopped: the package starts it again on the next request.
import type { PluginAPI } from '@ampcode/plugin'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const description = "magpie's bridge: amp.ai.generate on 127.0.0.1 for magpie's Amp provider"

const VERSION = '0.1.0'
const DIR = process.env.MAGPIE_AMP_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'magpie-amp')

const read = (name: string) => {
	try {
		return readFileSync(join(DIR, name), 'utf8').trim()
	} catch {
		return ''
	}
}

const write = (name: string, value: string) => {
	const tmp = join(DIR, `${name}.${process.pid}.tmp`)
	writeFileSync(tmp, value, { mode: 0o600 })
	renameSync(tmp, join(DIR, name))
}

export default function (amp: PluginAPI) {
	const key = read('key')
	if (!key) {
		amp.logger.log(`magpie bridge: no key in ${DIR}, not serving`)
		return
	}
	let thread = read('thread')
	let making: Promise<string> | null = null
	const billing = (): Promise<string> => {
		if (thread) return Promise.resolve(thread)
		making ??= (async () => {
			// a runner just started may not be registered with Amp yet:
			// "agent.createThread is temporarily unavailable: runner is not
			// registered"
			for (let i = 0; ; i++) {
				try {
					const t = await amp.getBuiltinAgent('low').createThread({ visibility: 'private' })
					thread = t.id
					write('thread', t.id)
					return t.id
				} catch (e) {
					if (i >= 30 || !/not registered|temporarily unavailable/i.test(String(e))) throw e
					await new Promise((r) => setTimeout(r, 1000))
				}
			}
		})().finally(() => (making = null))
		return making
	}
	// A billing thread deleted in Amp (or with `amp threads delete`) fails
	// every generate with "Thread not found": another is made, and the
	// request is asked once more.
	const generate = async (request: any) => {
		const id = await billing()
		try {
			return await amp.ai.generate({ ...request, threadID: id })
		} catch (e) {
			if (!/thread not found/i.test(String((e as Error)?.message ?? e))) throw e
			amp.logger.log(`magpie bridge: thread ${id} is gone, making another`)
			if (thread === id) thread = ''
			return amp.ai.generate({ ...request, threadID: await billing() })
		}
	}

	const idleMinutes = Number(read('idle')) || 30
	let last = Date.now()
	let busy = 0
	// The plugin runs in a process of its own, which the runner starts again
	// when it exits: the runner itself is stopped, and only when it is the
	// one the package started (<dir>/runner.pid) and this process's parent.
	const stopRunner = () => {
		const pid = Number(read('runner.pid'))
		if (!pid || pid !== process.ppid) {
			amp.logger.log(`magpie bridge: not started by magpie's package (runner ${pid || 'unknown'}, parent ${process.ppid}); not stopping it`)
			return false
		}
		process.kill(pid, 'SIGTERM')
		return true
	}
	const timer = setInterval(() => {
		if (busy || Date.now() - last < idleMinutes * 60_000) return
		amp.logger.log(`magpie bridge: idle ${idleMinutes} min, stopping the runner`)
		if (!stopRunner()) clearInterval(timer)
	}, 30_000)
	timer.unref?.()

	const reply = (status: number, body: unknown) => Response.json(body, { status })

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		idleTimeout: 0, // a generate may take minutes
		async fetch(req) {
			if (req.headers.get('authorization') !== `Bearer ${key}`) return reply(401, { error: 'wrong or missing bridge key' })
			const path = new URL(req.url).pathname
			if (req.method === 'GET' && path === '/health') return reply(200, { ok: true, version: VERSION, thread })
			if (req.method === 'POST' && path === '/stop') {
				const ok = stopRunner()
				return reply(ok ? 200 : 409, { ok })
			}
			if (req.method !== 'POST' || path !== '/generate') return reply(404, { error: 'not found' })
			let body: any
			try {
				body = await req.json()
			} catch {
				return reply(400, { error: 'the body is not JSON' })
			}
			busy++
			last = Date.now()
			try {
				const request: any = { model: body.model, prompt: String(body.prompt ?? '') }
				if (typeof body.system === 'string' && body.system) request.system = body.system
				if (Number.isInteger(body.maxTokens) && body.maxTokens > 0) request.maxTokens = body.maxTokens
				if (typeof body.reasoningEffort === 'string' && body.reasoningEffort) request.reasoningEffort = body.reasoningEffort
				if (body.schema && typeof body.schema === 'object') request.schema = body.schema
				return reply(200, { result: await generate(request) })
			} catch (e) {
				return reply(502, { error: String((e as Error)?.message ?? e) })
			} finally {
				busy--
				last = Date.now()
			}
		},
	})
	write('port', String(server.port))
	amp.logger.log(`magpie bridge ${VERSION} on 127.0.0.1:${server.port}`)
}
