# respire-memory

Respire memory integration for agents behind Magpie. Every newly observed user turn recalls memory, reads the existing local engine's complete policy and selected records. Every successfully archived writable turn stores and reads back a process diary; new reusable facts are separately updated or attached. Explicit remember emphasizes intent, rather than being the sole storage trigger.

This supports agent self-evolution through reusable experience. It does not train model weights or claim benchmarked quality improvements.

## Install

Install the [Respire CLI](https://github.com/risense-ai/respire-cli) first: this plugin is only the Magpie integration; the CLI provides the memory library and local Runtime. Follow the [npm installation guide](https://www.npmjs.com/package/rsrs-cli), or download your platform from [CLI Releases](https://github.com/risense-ai/respire-cli/releases).

~~~sh
npm install -g rsrs-cli
~~~

Prepare your account/model and start/unlock the local HTTP Runtime using the [Runtime guide](https://github.com/risense-ai/respire-cli/blob/main/docs/runtime.md). Check `rsrs --client-only status --json`, then install this plugin:

~~~sh
magpie plugin add respire-memory
~~~

Requires Magpie 0.1.1273+ and Bun 1.3.6+, with an existing unlocked local Respire HTTP Runtime. Page saves reaching hooks require Magpie 0.1.1531+. The magpie-key classification needs a newer host; older hosts may skip that origin. This plugin does not provision an engine, manage accounts/services or reuse private provider credentials.

Open the respire-memory page and configure the loopback Runtime, optional project filter, and a generation service/model compatible with Chat Completions. Archival defaults to on and needs model configuration. Raw transcript capture and Memory/Used display hints default to off. The page stores an authorization environment-variable name, never a key value. Set any required credential in the host environment yourself.

Enabling model-based archival sends completed turn/tool evidence and relevant memories to the configured service and consumes provider quota. Disabled, unconfigured, paused and read-only workflows are not reported as successful storage. Use readOnly explicitly to prohibit writes; automatic client plan-mode recognition is unavailable.

## Important boundaries

- **Not strict engine-policy parity:** completion notifications arrive after the reply, so the plugin cannot guarantee persistence before the answer is sent.
- A completion notification lost before enqueue, truncated response, unresolved tools, sensitive content or unseen Responses history can prevent archival. No exactly-once guarantee is made.
- A worker rechecks account, engine mode and current control before new model calls or writes. Jobs and their control lease are limited to five minutes from acceptance. Disabling/uninstalling without another request cannot immediately notify a detached worker; accepted/in-flight operations can continue within that bound. No new generation request starts after lease expiry. An accepted write cannot be revoked.
- Known-dead PID locks recover automatically; live contention waits up to five seconds. Unknown legacy lock owners are not deleted. Interrupted jobs whose writes were attempted remain unconfirmed and are not replayed.
- Only queued/running jobs count toward the 512 active-job cap. Cleanup runs on foreground maintenance and worker startup: terminal raw evidence expires after 24 hours; completed receipts and read-only turn/session caches expire after seven days. Compact unknown-write markers are retained, without old raw evidence, to prevent replay. Cleanup runs on the next maintenance activity, not while the host is closed; it does not delete engine-library memories.
- History blocks are restored from durable state after a host restart. Non-recall settings do not change conversation keys. Upgrading from the older whole-options hash may cause a one-time history-cache change; old records are not mapped by guessing.
- Runtime account identity is checked afresh before serving each request and before archival disclosure/writes. It is deliberately not cached across requests, to avoid an account-switch window reusing another library's cached memories.
- Project filters are not authorization. Local encryption keys live beside ciphertext; protect the whole state directory. Historical record content and full engine policy are preserved; generated metadata uses neutral host wording.

## Options and diagnosis

Defaults include runtimeUrl=http://127.0.0.1:15169, project empty, archive=true, capture=false, readOnly=false, showMemoryStatus=false. Set generationBaseUrl, generationModel and authorizationEnv as needed. The ineffective injectRules option has been removed. Complete policy is read every new turn, but identical text is injected once per conversation and again only when it changes; later blocks carry memories and read receipts. Full policy has a separate 128 KiB allowance plus the host adapter; expect extra context cost.

From the complete installed plugin directory, worker.mjs supports setup, status, run, recover and evidence. For example:

~~~sh
node worker.mjs status
node worker.mjs evidence <turn-source-hash>
~~~

Evidence is private and expires after the retention period. status includes safe progress and notification errors. setup does not install/start an engine or call a generation model. Unknown writes must be checked against the actual library before a manual retry decision.

A matching full record is retained when its causal chain exceeds the memory allowance, with an explicit omission notice. Shared daily remember output is removed before model disclosure. Current-turn diary readback uses a source marker, bounded search/fragment calls and exact body/version/Unicode-range checks; only this turn's body and complete locators reach the model. Unsupported, stale, incomplete or oversized readback stays unconfirmed without whole-diary fallback or write replay. Large raw capture is not guaranteed to fit the bounded fragment allowance.

## Checks in this repository

From this repository root:

~~~sh
bun test packages/respire-memory/respire-memory.test.mjs
bun scripts/check.mjs respire-memory
~~~

The Bun test adapter executes the existing isolated checks in a fresh temporary HOME. Checks use fake loopback services, actual detached child processes and temporary state under os.tmpdir(), then remove it. No production HOME, account or provider is used. The root plugin-shape checker alone skips gateway hooks; the Bun test adapter is the behavioral CI entry.

This repository publishes through its own publish.yml and dist branch. npm first publication still requires a community npm owner; trusted-publisher repository metadata points to this monorepo. Upstream GitHub Releases and upstream npm setup are separate distributions.

## Upstream references

- [Source and full configuration](https://github.com/risense-ai/respire-magpie)
- [Feature/host limits](https://github.com/risense-ai/respire-magpie/blob/main/docs/FEATURES.md)
- [Upstream 0.3.0 private-install acceptance report](https://github.com/risense-ai/respire-magpie/blob/v0.3.0/docs/TEST-REPORT-0.3.0.md)

The upstream reports describe that upstream revision and installation; they are not CI evidence for this community package. They are linked rather than repackaged. See this PR's current checks and the local test entry above for this contribution.

MIT; see LICENSE and NOTICE. Feedback: [upstream issues](https://github.com/risense-ai/respire-magpie/issues).
