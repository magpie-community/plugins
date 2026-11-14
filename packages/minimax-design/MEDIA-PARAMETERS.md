# Automatic media parameters

Verified November 14, 2026, with Magpie 0.1.4040 and Design 4.0.10.

The bridge discovers models and refreshes their specifications automatically.
Selecting a model loads its options; users do not edit configuration files.
`自动` uses a source's validated, unconditional default when one is declared;
otherwise it omits the override. Optional durations without a declared default
remain unset. No inference is performed during sync.

## Source order

1. Explicit `supported_parameters` on the authenticated gateway model entry,
   when present. The current Magpie catalogue does **not** emit this field.
   This reader accepts the enum/range shape used by OpenRouter: `type: enum`
   with `values`, or `type: range` with `min`/`max`. It is a bridge-supported
   extension, not a claim that Magpie has standardized a capability API.
2. Source plugin declarations from Magpie's shared `config.provider` object:
   per-model `supported_parameters`, or `capabilities.maxReferences` and
   explicit input modalities. These fill catalogue gaps without introducing
   models absent from the authenticated gateway list. An explicit gateway
   reference limit of zero remains authoritative.
3. For direct OpenRouter image routes without gateway parameters, fetch its
   public `/api/v1/images/models/<model>/endpoints` schema. Intersect endpoint
   options/reference limits; never send the gateway authorization header.
4. Exact routes with verified provider and gateway contracts use bundled
   profiles. A remote-magpie mirror of a known direct route can reuse the
   profile; routing groups and arbitrary aliases cannot.
5. Plugin option `mediaParameters` supplies missing fields using the same
   enum/range schema. Explicit source and gateway fields take precedence.
6. Unidentified routes retain provider defaults and expose only declared,
   transferable options. Known routes whose gateway cannot carry a parameter expose no
   ineffective control. Missing image modality alone does not override an
   explicit reference-count schema.

## Portable configuration

Source reference limits are distinct from this bridge's verified 16-image
budget. A valid source declaration such as 0–30 remains unchanged in model
metadata and is retained as `sourceReferences` in the generated adapter.
Design's spec and request validation use the smaller bridge/mode limit.
A minimum above the usable limit is rejected explicitly. The budget is a
bridge constraint, not a claim about the vendor's maximum or Design's
ultimate capacity. OpenRouter endpoint intersections also retain their
source limits before this projection.

The current host may omit extended model metadata from `/v1/models`.
Startup `config.provider` fills that gap only for declarations it contains;
it does not guarantee live discovery of new models' complete controls.
`media_request` and combined `size` encodings remain opt-in plugin
extensions. Design interprets the existing native `parameter_config` shape
described below inside this plugin; no Magpie core change or new shared
contract is required. Parameters without a verified request
mapping are not advertised; explicit unrecognized controls are rejected.

Plugin options are persisted by Magpie in `plugins.json` and passed to the
companion's factory. The package declares empty defaults; no routing
replacement or model-specific reference expansion is enabled implicitly.
For a provider whose existing route cannot carry references, install or
configure a source plugin that supports the required protocol first.
An optional `imageRoutes` map then reuses the existing Design identity and
enabled switch while submitting to the explicitly selected replacement.

```json
{
  "imageRoutes": { "old-provider/image": "source-plugin/new-image" },
  "mediaParameters": {
    "source-plugin/new-image": {
      "input_references": { "type": "range", "min": 0, "max": 6 }
    }
  }
}
```

The IDs and limit above are examples, not defaults. Both routes must be in
the authenticated catalogue. Do not raise limits to bypass an unsupported
provider transport. New models with explicit metadata are discovered on the
next refresh without a code change; models lacking such information need a
source declaration or a verified manual supplement.

Speech discovery also accepts a source model's `native_endpoints` declaration
containing `/v1/audio/speech` or `/audio/speech`. The model must already exist
in the authenticated gateway catalogue. Its `supported_parameters` supplies
voice, format and speed controls using the same precedence rules. Audio output
modality alone does not identify speech: ASR, music and chat audio are excluded.
No model-name pattern or user-specific endpoint is needed for this declaration.

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
| minimax-code/MiniMax-Hailuo-2.3 | 768P/1080P; 6s/10s; one first frame | Separate resolution/duration; 1080P with 10s rejected before HTTP |
| grok/grok-imagine-video | Seven ratios; 480p/720p; 1–15 seconds; up to 7 subject images | ratio/resolution → pixel size; subjects limited to 10 seconds |
| grok/grok-imagine-video-1.5 | Seven ratios; 480p/720p/1080p; 1–15 seconds; up to 14 subject images | Subjects limited to 720p; no tail-frame control |
| grok image / quality; xai/grok-imagine-image | Thirteen ratios | size → aspect_ratio; catalogue decides reference support |
| qwen-cn or bailian-token-plan/qwen-image-3.0-pro | Verified pixel presets; automatic size | WIDTHxHEIGHT; never send a ratio as size |
| rightimage GPT Image 2, 2.5, 2.6 routes | Verified pixel presets | size; no unverified reference-count or quality expansion |
| rightimage Gemini routes | Provider defaults on the original route; declared ratios/resolutions on a configured image-source route | Source plugin declaring `aspect-resolution` encodes both through size |
| OpenRouter images | Live ratios and reference budget; declared 2K/4K for image-only routes | size; chat image routes expose ratios without resolution controls |

For image models with declared image input but no verified count, the bridge
retains its existing one-image bridge budget; this is not a vendor maximum.
Unsupported video/audio references remain outside this bridge.
Video reference counts are capped by the verified frame/subject mapping.
Count metadata alone does not establish a new multi-image mode; unknown video
routes accept at most one first frame. A minimum above the mapped maximum
fails synchronization rather than installing an unusable specification.

Generic video sources may explicitly declare `media_request.reference_modes`
using `first-frame`, `first-last-frame`, and/or `reference`. These correspond to
the existing gateway `input_reference`, `last_frame`, and `reference_images`
fields; they do not enable video editing or reference audio/video. Reference
budgets still come from `input_references` and are capped at 16 by the bridge,
or two for frames alone. An empty mode list disables references.
`media_request.frame_ratio: "auto"` rejects a manual ratio with frame input.
This contract is independent of provider IDs and model names.

## Automatic reference modes and preflight

No images means text generation; one video image defaults to first frame.
Multiple images choose subject references where supported, or first/last
frames for H3 Max. A reference-purpose selector permits an explicit override.
Frames and subjects are never silently mixed or truncated.

Design's custom `spec.json` supports enum dropdowns, defaults, ranges and
reference budgets, but discards cross-field `paramRules`. Hailuo's illegal
resolution/duration pair and other reference-dependent rules
run in `buildSubmit` before any HTTP request, with an actionable message.
First/last-frame H3 requires automatic ratio. For Grok, choosing resolution
with a reference requires an explicit ratio because the gateway encodes both
in `size`; leaving both automatic preserves upstream image-driven framing.
The adapter has no decoded image dimensions and does not claim to infer them.

## Native canvas controls

All media specifications use Design's canonical `aspect_ratio`, `resolution`,
`duration` and `image_mode` keys. String options always have a nonempty enum;
unknown size strings are not exposed as empty text controls. Pixel-only size
lists become ratio and approximate long-edge tiers rounded to the nearest
`0.5K` (`1K` = 1024 pixels), with an exact lookup back to every original size.
Long edges below 512 pixels use their unrounded K value. When presets share a
tier for the same ratio, labels include the original dimensions so each stays
selectable. Pixel-only routes require an explicit ratio when selecting a tier;
leaving both automatic omits size and preserves the upstream default.
Unsupported combinations fail before HTTP.

Sources that can encode independent image ratio and resolution in the standard
image API declare `media_request: { "size": "aspect-resolution" }`. The bridge
sends `size: "16:9@2K"` (or `auto@2K` / `16:9@auto`); the source plugin must
decode it before calling its vendor. This is an explicit plugin contract,
not an upstream provider size format. Pixel routes can declare `"pixels"`.

Declared image `quality`, `background` and `output_format` enums are passed through generic
image routes. An optional nonempty `title` preserves source terminology such
as inference effort without conflating it with resolution. A generic video route can declare `generate_audio` with
`type: "boolean"` and an optional boolean `default`; a declared default gives
Design a switch, while an unspecified default preserves its optional control.
False remains false in the submitted JSON. Specialized transports do not
inherit these fields when their gateway mapping cannot carry them (MiniMax
Image already uses `quality` for resolution). Screenshots establish native
presentation, not another provider's supported values.

## Design-owned defaults and constraints

Validated `supported_parameters` defaults configure native controls and are
also applied by the generated adapter when an option is left automatic or
unset. Explicit selections win. Duration defaults follow the declared step;
pixel-size defaults resolve back to their exact ratio/tier pair. Image
adaptive defaults use `auto@tier`, never `adaptive@tier`. Video adaptive
defaults use the existing `size` field. For smart first/last-frame input,
an automatic ratio omits the source default so framing follows the image;
an explicitly selected incompatible ratio is rejected.

When a source already supplies `capabilities.parameter_config`, the Design
plugin converts its `ratio`, `resolution`, `duration` and `effort` dimensions
to native keys. The source schema's numeric ratio IDs are translated to
their declared protocol meanings; provider IDs and model names do not select
this adapter. `active_when_any` is checked against selected values and known
source defaults, and enabled `available_combinations` are checked before
HTTP. An unknown condition value is left to the source, rather than guessed.
These checks do not make Design's dropdowns dynamically dependent: the
installed native spec parser does not preserve that feature.

An explicit `total_limit` further caps the usable image reference budget
without rewriting `sourceReferences`. Only reference images are exposed by
this bridge. Source-only video/audio inputs, editing modes, and fields the
gateway cannot faithfully carry remain outside the native controls.

This is a consumer adaptation of existing source declarations, not a new
Magpie standard. Sources without this schema keep their own submit-time
validation; undeclared defaults and combinations are not invented.

## Evidence

November 14 Design-owned adaptation: all 19 live XiaoYunQue model declarations
passed 43 read-only `spec → buildSubmit → source normalizeRequest` cases using
native defaults, reference images and ordered frames. A further 659-case
single-control matrix passed 647 source checks and rejected 12 incompatible
frame/ratio choices inside Design; none of its accepted requests failed
source validation. The installed Design
parser/executor preserved declared defaults and output format and rejected
invalid source combinations before HTTP. An isolated packaged Magpie gateway
forwarded quality, output format and four exact references through the image
source plugin; all vendor responses were local fixtures. This does not
constitute paid generation or acceptance of the running desktop instance.

November 14 contract alignment: Node passed 65 tests with one Bun-only skip;
Bun passed all 66. Image Models passed 34 tests with
`DESIGN_CONTRACT_ROOT` pointing to this package, including its consumer
contract fixtures. The installed Design runtime parser/executor accepted
the projected 30-image source budget and submitted all 16 permitted
references to a fixture. A read-only XiaoYunQue catalogue check generated
specs for all 19 models and validated requests with declared ratios against
the source normalizer; no uploads or paid requests were made. Some video
models reject an omitted ratio at the source: this is not evidence that
every model's automatic settings were valid at that checkpoint. The Design-owned
adaptation above subsequently verifies automatic settings for the current
19-model catalogue. Dynamic metadata propagation through the host and
conditional dropdown updates remain separate gaps.

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

On November 14, 2026, the installed Xiaoyunque source was queried read-only:
11 image models and eight video models were converted with unrelated provider
IDs, then their generated requests were checked by the source's normalizer.
This covered independent resolution/effort and the declared reference budget.
The native Design executor fixture also preserved 12 subject images, ordered
first/last frames, and a 30-second duration. No paid generation was submitted.
Models with no declared reference count retain the existing conservative
budget; source-specific conditions and combinations still run in Xiaoyunque
before upload. They are not yet dynamic dropdown dependencies in Design.

Tests cover generated adapters, metadata precedence, public-schema intersection,
automatic defaults, reference counts, modes and illegal combinations. The
installed Design runtime parses generated dropdowns/defaults and rejects an
invalid combination before the fixture HTTP handler runs. Fixture success is
not live vendor generation, desktop selection, or canvas acceptance.
