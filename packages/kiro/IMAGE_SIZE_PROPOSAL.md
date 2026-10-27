# Proposal: prepare inline images within Kiro's encoded size limit

Status: design proposal; no runtime change or new image dependency in this PR.

## Observed failure

On 2026-10-27, a Codex conversation using magpie and
`kiro/claude-opus-5.5` failed after `view_image` returned a PNG contact
sheet. Kiro rejected the subsequent model request:

```text
Kiro: messages.130.content.2.image.source.base64: image exceeds 5 MB maximum:
5561904 bytes > 5242880 bytes (IMAGE_SIZE_EXCEEDED)
```

The image embedded in Codex's persisted tool output decoded to 4,171,428
bytes, with a Base64 string of exactly 5,561,904 bytes. The file is below
5 MiB, but its encoded representation is above Kiro's observed ceiling.
For ordinary padded Base64, encoded length is `4 * ceil(rawBytes / 3)`;
5 MiB encoded corresponds to at most 3,932,160 raw bytes.

Sending text-only follow-ups, including asking the agent to compress the
image, failed again with the same size. The request is rejected before
the model can execute that instruction. This was a tool-produced image,
not an attachment uploaded through the remote UI.

The affected conversation was recovered by temporarily selecting another
available image-capable model, running native Codex context compaction,
and restoring the original model. Inspection of the replacement context
confirmed that the offending image was absent and remaining images were
within the encoded limit. No additional Kiro turn was sent as a test.
This is a recovery workaround, not automatic request protection.

Related upstream reports describe the same encoded-size mismatch:

- <https://github.com/kirodotdev/Kiro/issues/11497>
- <https://github.com/kirodotdev/Kiro/issues/9707>

## Relevant current code

In `index.mjs`, `addImage` copies Anthropic Base64 image data into Kiro's
`source.bytes` unchanged. Tool-result image blocks use this same path.
The conversation translator retains images from the latest image-bearing
user entry. A later text-only turn therefore need not remove the
offending image. There is no image-size preparation in this path.

The exact installed magpie/plugin versions for the original failure were
not captured. The observations above come from that local conversation;
the current-source analysis is not a claim of a new live reproduction
against the latest plugin.

## Suggested request-boundary behavior

Prepare the images that survive conversation translation and its existing
latest-image selection, immediately before serializing the Kiro request.
This covers user images and tool images, including images supplied again
in history, without changing the client's persistent conversation.

1. Leave compliant images byte-for-byte unchanged. Validate the encoded
   byte length rather than trusting a file-size label or MIME extension.
2. For an oversized image, decode it with bounded resource use and prepare
   a separate request copy. Preserve aspect ratio; try an appropriate
   encoding and progressively reduce dimensions/quality until the result
   fits. Prefer readable text and transparency preservation; do not
   silently flatten animation or discard meaningful image content.
3. Check the final encoded result against the provider limit, with some
   headroom. A proposed target is 4 MiB encoded; the reported rejection
   threshold is 5 MiB encoded. Dimensions and other image limits should
   be independently validated when verified, not inferred from this error.
4. Replace only the request's image bytes and matching format. Preserve
   message ordering, tool-call/result identities and surrounding text.
   Do not edit original files, stored Codex history, or global model limits.
5. If conversion is unsupported or cannot fit within resource bounds,
   return an actionable non-retryable validation error before calling
   Kiro. Never silently drop an image or retry the same invalid payload.
   This fallback alone does not recover poisoned history; successful
   request-copy preparation is what enables a later retry to proceed.

Codec choice needs maintainer agreement: the plugin runs in both OpenCode
and magpie's plugin host, so a solution must work in both runtimes rather
than depend on browser Canvas, a macOS-only command, or an assumed native
image package. No such dependency is selected by this proposal.

If caching is useful, use a bounded, short-lived in-memory cache keyed by
image content hash plus policy/codec version. Do not write private images
to disk by default. Limit decoded pixels, input size, concurrent work and
processing duration; avoid logging image bytes or credentials.

## Acceptance criteria for an implementation

Use synthetic images and mocked upstream requests, not real accounts:

- Cover the observed 4,171,428 raw / 5,561,904 encoded mismatch and exact
  below/at/above-limit boundaries, including Base64 padding.
- Compliant images are unchanged; oversized outputs decode successfully,
  match the declared format and fit the encoded limit.
- User-image and tool-result paths are covered. A text-only follow-up
  carrying an earlier oversized image produces a compliant request too.
- Existing latest-image selection is preserved; image preparation does
  not introduce older image groups or change tool pairing/order.
- The input object, source file and persisted history remain unchanged.
- Corrupt/unsupported images, decompression bombs and resource exhaustion
  produce actionable errors and no upstream call or unbounded retry.
- Cache eviction and concurrent identical-image processing are bounded;
  neither payload bytes nor private paths appear in diagnostics.
- Run the package tests and validate the chosen codec in both supported
  plugin hosts before describing this as an implemented fix.
