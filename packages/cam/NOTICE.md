# Third-party notice

`vendor/cam/` contains the protocol and attachment-selection core copied from
**Context Attachment Manager v0.13.1**, Copyright (c) 2026 chipfighter, under
the MIT License. Its upstream project is:

https://github.com/chipfighter/context-attachment-manager

The vendored files retain their original comments. The only intentional
behavioral extension is in `adapters/protocols/any.ts`: the optional
`PlatformRewritePolicy` adds a session-level automatic-selection switch and a
set of pinned content digests. With the default policy, behavior is the same as
the upstream generic request adapter.

See `vendor/cam/LICENSE` for the unmodified upstream license text.
