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
The previously installed agent platform adaptation was preserved; the portable
repository entry continues to require Magpie's `magpie.platform` contract.
Other pre-existing uncommitted MCP and speech changes remain in the workspace.
