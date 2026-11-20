# MCP diagnosis — November 14, 2026

## Observed failure

The live installation had three different views of MCP configuration:

- Library staging and the native vault contained the `magpie` router.
- Global OpenCode configuration still contained seven earlier direct servers
  and this installation's runtime bridge.
- The workspace gateway proxy contained only `magpie`.

OpenCode reported most old direct servers as connected. Design's capability
catalog used this inventory to show connected cards, but session calls use
grants from the V3 gateway proxy. These direct servers had no callable proxy
grant, so their cards and actual calls disagreed. The active session's
`design_capability_list` errors confirmed this distinction.

The router had another failure: repeated `tools/list` requests took about
31 seconds. The installed gateway defaults its connector request timeout to
30 seconds, while Magpie's hub listing budget is 40 seconds. A connection
could become green and then fail a later list request with `Request timed out`.

Separately, logs recorded a stopped Eagle listener and `spawn node ENOENT`
in the former direct bridge. These individual service errors do not explain
why the other directly connected servers lacked session grants.

## Changes

Native projection now supplies a 60-second timeout when Library has not
specified one. Explicit Library timeouts remain authoritative.

Migration rechecks global runtime residue even when an ownership receipt
already says `nativeReady`. Receipts retain the last staged runtime definitions
to clean exact matches after direct/router switches. Failed cleanup retains
that evidence for the next attempt.

Older installations without these receipts require verified legacy ownership:
the previous Library `applied` names and matching original runtime definitions.
`syncMcpStore` accepts these as `legacyManaged`; it never guesses ownership
from names or URLs. Locally edited definitions block removal.

Integration review also reproduced two cleanup failures: Design's native
runtime projection adds `enabled` and `timeout` fields, and a same-name
Library update previously overwrote the last runtime definition. Receipts now
retain exact candidates for the original Library entry and native projection,
plus the prior version until cleanup succeeds. No runtime fields are ignored
when matching; edits that match none of these receipts still block removal.
The full acceptance asserts actual runtime removal instead of deleting the
test entry itself after withdrawal.

## Validation

- Integration suite including media changes: Node passed 79 tests, with one
  Bun-specific YAML test skipped; Bun passed all 80.
- Installed Design native vault load/toggle/withdrawal passed.
- Installed Design projection and V3 proxy discovered and called a fixture
  after a deliberately delayed 31-second `tools/list`, then disabled and
  withdrew it successfully.
- An isolated instance of the installed Design gateway implementation
  discovered the actual local Magpie router and called
  `davinci-resolve__get_resolve_status`. The service returned
  `{"running":true,"version":"21.1"}`.
- A private clone of the live configuration migrated all seven exact legacy
  matches, retained the native router and applied the new timeout. A repeat
  sync passed and all five live input files remained byte-identical.
- Added regressions cover exact native runtime projection on withdrawal,
  native disabled projections, same-name updates, and retrying failed cleanup
  without losing old evidence.
- Full packaged Magpie/Design sandbox acceptance passed, including a real
  model → MCP tool → model fixture turn, automatic runtime withdrawal and
  splitting/shrinking a 101-model catalogue without loss.

## Desktop acceptance

The local 0.4.4 update was applied with Design closed after backing up the
installed plugin, Library settings, native vault, runtime configuration and
media store. All seven legacy definitions matched the earlier Library
application evidence exactly and were removed from the global runtime.
The native vault retained the enabled `magpie` router with a 60-second timeout.
Repeated migration made no changes.

After a normal restart, Design's local plugin page showed `magpie` connected.
The existing desktop conversation discovered tools through `magpie.find_tools`
and called Resolve through `magpie.call_tool`, returning
`{"running":true,"version":"21.1"}`. This confirms a desktop session call,
in addition to the isolated proxy validation above.

All 73 existing media models retained their enabled states. GUI spot checks
showed native ratio, 1K/2K/4K and quality controls for a Xiaoyunque image model,
and reference mode, ratio, resolution and duration controls for its Seedance
2.5 video model. No paid media generation was submitted; these checks do not
establish acceptance of every model or parameter combination.
