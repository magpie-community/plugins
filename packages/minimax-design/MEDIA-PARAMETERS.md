# Automatic media parameters

Verified November 13, 2026, with Magpie 0.1.4040 and Design 4.0.10.

The bridge discovers models and refreshes their specifications automatically.
Selecting a model loads its options; users do not edit configuration files.
`自动` omits an override so the route retains its own defaults. Optional
durations are also omitted when unset. No inference is performed during sync.

## Source order

1. Explicit `supported_parameters` on the authenticated gateway model entry,
   when present. The current Magpie catalogue does **not** emit this field.
   This reader accepts the enum/range shape used by OpenRouter: `type: enum`
   with `values`, or `type: range` with `min`/`max`. It is a bridge-supported
   extension, not a claim that Magpie has standardized a capability API.
2. For direct OpenRouter image routes without gateway parameters, fetch its
   public `/api/v1/images/models/<model>/endpoints` schema. Intersect endpoint
   options/reference limits; never send the gateway authorization header.
3. Exact routes with verified provider and gateway contracts use bundled
   profiles. A remote-magpie mirror of a known direct route can reuse the
   profile; routing groups and arbitrary aliases cannot.
4. Unidentified routes retain optional manual size/duration and provider
   defaults. Known routes whose gateway cannot carry a parameter expose no
   ineffective control. The catalogue's explicit lack of image input wins.

Metadata is validated before store writes. Invalid schemas or failed endpoint
discovery keep the previously installed store and report the error. Parameters
are only exposed when their transport mapping is established; unknown fields
are not blindly passed through.

## Verified profiles and transport

| Route | Controls and reference budget | Gateway mapping |
| --- | --- | --- |
| minimax-code/MiniMax-Image | Common ratios within 1:3–3:1; 1K/2K/4K; up to 16 images | ratio → size, resolution → quality low/medium/high |
| minimax-code/MiniMax-H3 | Six ratios; 768P/2K; 4–15 seconds; first/last frames or up to 9 subject images | resolution → size, ratio → ratio, duration → seconds |
| minimax-code/MiniMax-H3-Max | Six ratios; 480P/768P; 5–15 seconds; up to 2 ordered frames | Same mapping; no subject collections |
| minimax-code/MiniMax-Hailuo-2.3 | 768P/6s, 768P/10s, 1080P/6s; one first frame | One combined preset supplies size and seconds |
| grok/grok-imagine-video | Seven ratios; 480p/720p; 1–15 seconds; up to 7 subject images | ratio/resolution → pixel size; subjects limited to 10 seconds |
| grok/grok-imagine-video-1.5 | Seven ratios; 480p/720p/1080p; 1–15 seconds; up to 14 subject images | Subjects limited to 720p; no tail-frame control |
| grok image / quality; xai/grok-imagine-image | Thirteen ratios | size → aspect_ratio; catalogue decides reference support |
| qwen-cn or bailian-token-plan/qwen-image-3.0-pro | Verified pixel presets; automatic size | WIDTHxHEIGHT; never send a ratio as size |
| rightimage GPT Image 2, 2.5, 2.6 routes | Verified pixel presets | size; no unverified reference-count or quality expansion |
| rightimage Gemini routes | Provider defaults | Current route cannot faithfully carry size/resolution |
| OpenRouter images | Live ratios; 2K combinations only for faithfully mapped ratios; live reference budget | size; unsupported 1.5K combinations omitted |

For image models with declared image input but no verified count, the bridge
retains its existing one-image bridge budget; this is not a vendor maximum.
Unsupported video/audio references remain outside this bridge.

## Automatic reference modes and preflight

No images means text generation; one video image defaults to first frame.
Multiple images choose subject references where supported, or first/last
frames for H3 Max. A reference-purpose selector permits an explicit override.
Frames and subjects are never silently mixed or truncated.

Design's custom `spec.json` supports enum dropdowns, defaults, ranges and
reference budgets, but discards cross-field `paramRules`. Hailuo therefore
uses a single legal-combination dropdown. Other reference-dependent rules
run in `buildSubmit` before any HTTP request, with an actionable message.
First/last-frame H3 requires automatic ratio. For Grok, choosing resolution
with a reference requires an explicit ratio because the gateway encodes both
in `size`; leaving both automatic preserves upstream image-driven framing.
The adapter has no decoded image dimensions and does not claim to infer them.

## Evidence

- Repository `packages/minimax/matrix-tools.json`: tool schemas checked
  November 3 and November 11, 2026; `packages/minimax/native.mjs`:
  `areaOf`, `startVideo`, `resolutionOf`, `durationOf`.
- Magpie source commit `284152c2773935a2e379c0f11aa88f0d3925dc57`:
  `internal/gateway/gateway.go` (`drawerObjects`, `videomakerObjects`);
  `draw.go` (`drawOpenRouterImages`, `openRouterSize`, `grokAspects`);
  `draw_dashscope.go` (`dashScopeSize`); `video.go` (`grokVideoBody`,
  `videoResolution`, `remoteVideoBody`).
- https://openrouter.ai/api/v1/images/models/bytedance-seed/seedream-5-5/endpoints
- https://docs.x.ai/developers/model-capabilities/video/generation
- https://docs.x.ai/developers/model-capabilities/video/reference-to-video
- https://docs.qwencloud.com/api-reference/image-generation/qwen-text-to-image
- https://docs.rightapi.ai/docs/rc_draw/openai.html

Tests cover generated adapters, metadata precedence, public-schema intersection,
automatic defaults, reference counts, modes and illegal combinations. The
installed Design runtime parses generated dropdowns/defaults and rejects an
invalid combination before the fixture HTTP handler runs. Fixture success is
not live vendor generation, desktop selection, or canvas acceptance.
