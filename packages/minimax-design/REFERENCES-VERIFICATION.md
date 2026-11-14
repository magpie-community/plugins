# Reference capability repair

Verified locally on November 14, 2026.

## Findings

The installed Media Adapter middleware matches its source and passes all 35
tests. Direct checks against its installed module preserve four distinct image
references in standard image, Chat and Gemini request bodies without mutation.
This investigation did not reproduce middleware image loss.

The Design bridge relied on catalogue image modalities for its initial budget.
A source could expose editing through its own configuration while the gateway
catalogue omitted the reference-count schema. That omission installed a
zero-reference Design specification. For known video transports, an explicit
positive reference-count schema now also enables their established frame
mapping when the image modality is absent.

A live read-only catalogue check also found legitimate Unicode model IDs
containing internal spaces. Rejecting whitespace blocked synchronization of
the entire catalogue. Media IDs now permit internal spaces, while rejecting
control characters and surrounding whitespace; IDs are sent as JSON values
and filesystem paths continue to use hashed identifiers.

Right Code additionally requires asynchronous task submission and polling.
Its Gemini streaming entry cannot simply be forwarded to the provider's
asynchronous endpoint. Protocol conversion belongs in the image source plugin.
Provider documentation:

- https://docs.rightapi.ai/docs/rc_draw/openai
- https://docs.rightapi.ai/docs/rc_draw/gemini

## Changes and portability

The bridge reads explicit gateway schemas, shared source plugin capability
declarations, and optional per-model supplements. It adds no provider account
or route replacement by default. Configured replacements preserve the original
Design model identity and enabled switch.

The source plugin accepts explicit protocol/capability definitions for new
model IDs. Four references passing a transport fixture is not treated as a
vendor maximum; unknown new catalogue limits remain null.

## Validation

- Design Node and Bun suites: 36 tests passed.
- Image source Node and Bun suites: 15 tests passed.
- Installed Media Adapter: 35 tests passed, source comparison identical.
- Registry validation passed.
- Real installed Magpie, isolated HOME: persisted `plugins.json` options
  selected replacement routes; a source plugin loaded after the Design
  companion supplied a six-reference capability through shared configuration.
  Four distinct image byte sequences reached both protocol endpoints in order,
  with new model names and a random localhost gateway address.
- Installed Design runtime, isolated store: generated specifications and
  adapters loaded; four references reached the standard image API; image,
  video and speech fixtures passed, including invalid combination rejection.

These are fixture and runtime checks, not paid vendor generation or desktop
canvas acceptance.

## Local installation

The installed Design companion and image source plugin were updated after the
fixture checks. Existing credentials were reused without copying secrets into
source or options. Only the Right Code source was enabled through `onlyProvider`.
Route replacements and the four-reference tested budget for otherwise unknown
limits were saved in this machine's Magpie plugin options, not package defaults.
The existing Nano Banana source catalogue declares fourteen references.

A live Bun discovery and store readback completed with 49 media models,
including nine IDs containing spaces. All seven existing Right Code Design
model identities and enabled switches were preserved; their generated adapters
select the configured source routes. No paid generation was submitted.

Backup:
`~/.config/magpie/backups/design-references-1794589992753`.
At that installation, the agent platform adaptation was preserved; the portable
repository entry still required Magpie's `magpie.platform` contract.
The MCP and speech changes were subsequently included in the source commit.

## Remote Mac release verification

Rechecked on November 14, 2026 with the installed applications:

- Node regression suites: Design 36 passed; image source 15 passed.
- The real Magpie gateway fixture passed again with persisted plugin options,
  renamed source models and four distinct reference images through both
  configured protocols.
- Design's packaged media executor passed image editing, four-reference
  forwarding, video submit/poll/content and speech response checks.
- Design's native connector layer passed MCP tool discovery/call, disable and
  withdrawal checks.
- Registry validation and whitespace checks passed.

The release check uses disposable stores and HTTP fixtures. It does not establish
desktop canvas acceptance, native Windows acceptance or a new paid vendor run.
At that verification point, the portable agent required `magpie.platform`; the
installed macOS descriptor adaptation is not a replacement for that prerequisite.

GitHub HTTPS works through this machine's existing HTTP proxy. Direct SSH name
resolution failed, while SSH over port 443 through the same proxy authenticated
the existing GitHub key and successfully pushed both source repositories.
No credential or proxy setting was added to either package.

## Stock host verification — 0.4.2

The Agent now uses a fixed `~/.minimax-design` directory entry, prepared by the
existing companion plugin. The entry links to Design's native data directory
(a junction on Windows). Configuration and Library writes reach the original
files, without copying them or introducing a new host API.

The installed, unmodified Magpie passed `acceptance.mjs` with the repository
package installed through `plugin add`: connection, native configuration
validation, Library skill and MCP distribution, a model-to-MCP round trip,
disconnect restoration, 101-model splitting and catalogue shrink all passed.
The Agent loads with no injected globals. Path fixtures cover macOS and Windows
data roots, atomic replacement through the directory entry, repeated setup and
an occupied entry. Windows junction execution still needs a native Windows run.
Node and Bun each passed all 36 regression tests. The real gateway reference
fixture also passed with the new entry and four references through both source
protocols.

Before upgrading an already connected pre-0.4.2 package, disconnect its Agent
while Design is closed, so Magpie restores the old path's ownership record.
Reconnect after updating to establish ownership under the shared entry.

## Installed desktop generation acceptance — November 14, 2026

The installed 0.4.2 integration completed two real image tasks through Design's
MCP: text-to-image produced a yellow ceramic cup, then reference-image editing
used that output to produce a blue cup. Both JPEG outputs were saved by Design
and visually inspected. The reference-edit task completed with its output
adopted into the composition. This verifies the exercised local route; it does
not establish live generation coverage for every provider, video or speech.

The installed native acceptance also passed connection, Design configuration
validation, Library skill/MCP distribution, native tool execution, disconnect
restoration, 101-model splitting and catalogue shrink.

The desktop's offline banner cleared after restart and a temporary reset of
the existing network tunnel. System proxy and tunnel settings were restored.
No machine-specific proxy configuration or credential is included in the plugin.

Release regression checks repeated successfully: Node and Bun each passed all
36 tests, the registry check passed and `git diff --check` was clean.

## Portable speech discovery and live media follow-up — 0.4.3

A failing regression showed that a gateway-listed model was omitted when only
its source plugin declared the speech endpoint. Discovery now reads that
declaration before classifying the model, then applies source parameters as
usual. Renamed providers/models and a different gateway URL pass; source-only
models absent from the gateway and ASR/chat audio remain excluded.

Node and Bun each pass 37 tests. The native Design media executor passes its
image, video and speech fixtures. The companion lifecycle fixture now uses the
actual runner platform and an isolated APPDATA directory. Added macOS/Windows
CI exercises the real filesystem on each runner; remote results are pending.

The real Design MCP completed a local Ming speech request and adopted its WAV
into the acceptance Composition. A Grok video request failed with HTTP 403
(credits/subscription). A four-second MiniMax H3 request failed with HTTP 502
and an upstream quota/credits explanation. These failures were retained and
not retried. Live video output and listening acceptance remain unverified.
