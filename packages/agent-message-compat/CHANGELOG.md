# Changelog

## 0.1.1

- Persist verified plaintext hashes without the six-hour expiry or 2048-entry eviction in 0.1.0, so old verified messages remain readable when replayed.
- Store `verifiedAt` timestamps, read legacy ledger entries and merge verified disk entries during writes.
- Reload the ledger cache when `provenanceRevision` changes.
- Extend offline checks to cover legacy ledger entries and explicit reload after import: 12 checks total.
- Prepare the public release with a Chinese README, architecture diagram, MIT license and offline CI. Runtime modules match the existing 0.1.1 implementation.

## 0.1.0

- Record plaintext evidence from local Responses tool calls with an explicit empty `encrypted_function_args` marker.
- Restore only matching plaintext strings mislabeled as `encrypted_content`.
- Convert readable `agent_message` items into ordinary user messages for configured routes.
- Reject unverifiable sealed content with HTTP 409.
