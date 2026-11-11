// Standalone checks for RE2 pattern sanitization. Run with:
//   node test/re2-pattern-unit.mjs
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  translateUnicodeEscapes,
  isRE2Safe,
  sanitizePatternString,
  sanitizePatternFields,
} from "../re2-pattern.mjs"
import { sanitizeInputSchema } from "../index.mjs"

const NUL_CLASS = "^[^\\u0000]*$"
const NUL_CLASS_RE2 = "^[^\\x{0000}]*$"
const PATH_LOOKAHEAD = "^/(?!/)(?:[^\\u0000-\\u0020\\u007f\\\\#%]|%[0-9a-fA-F]{2})*(?![\\s\\S])"

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok  ${name}`)
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? " :: " + detail : ""}`)
}

check("translate \\u0000 in a character class",
  translateUnicodeEscapes(NUL_CLASS) === NUL_CLASS_RE2,
  translateUnicodeEscapes(NUL_CLASS))

check("translate \\u{0000} and \\u007f",
  translateUnicodeEscapes("\\u{0000}\\u007f") === "\\x{0000}\\x{007f}",
  translateUnicodeEscapes("\\u{0000}\\u007f"))

check("translate is idempotent on \\x{0000}",
  translateUnicodeEscapes(NUL_CLASS_RE2) === NUL_CLASS_RE2)

check("does not translate a literal backslash-u sequence",
  translateUnicodeEscapes("\\\\u0000") === "\\\\u0000")

check("translated NUL class is RE2-safe", isRE2Safe(NUL_CLASS_RE2))
check("untranslated \\u0000 is not RE2-safe", !isRE2Safe(NUL_CLASS))
check("lookahead path pattern is not RE2-safe even after translation",
  !isRE2Safe(translateUnicodeEscapes(PATH_LOOKAHEAD)))

check("plain ^[a-z]+$ is RE2-safe", isRE2Safe("^[a-z]+$"))
check("non-capturing group and digits are RE2-safe", isRE2Safe("(?:foo){1,3}"))
check("\\p{L} is RE2-safe", isRE2Safe("\\p{L}+"))
check("named group (?P<name>) is RE2-safe", isRE2Safe("(?P<name>[a-z]+)"))
check("JS named group (?<name>) is RE2-safe", isRE2Safe("(?<name>[a-z]+)"))
check("flags group is RE2-safe", isRE2Safe("(?i)abc"))
check("possessive *+ is not RE2-safe", !isRE2Safe("a*+"))
check("lookahead is not RE2-safe", !isRE2Safe("(?=a)"))
check("lookbehind is not RE2-safe", !isRE2Safe("(?<=a)"))
check("backreference is not RE2-safe", !isRE2Safe("(a)\\1"))
check("unclosed class is not RE2-safe", !isRE2Safe("[a-z"))
check("trailing backslash is not RE2-safe", !isRE2Safe("abc\\"))

// Repeat bounds: RE2 rejects a count over 1000, min > max, and nested or leading repeats.
check("repeat count 1000 is RE2-safe", isRE2Safe("^.{0,1000}$"))
check("repeat count over 1000 is not RE2-safe", !isRE2Safe("^.{0,2000}$"))
check("repeat count 1001 is not RE2-safe", !isRE2Safe("a{1001}"))
check("open repeat with min over 1000 is not RE2-safe", !isRE2Safe("a{1001,}"))
check("min greater than max is not RE2-safe", !isRE2Safe("a{3,2}"))
check("nested repeats are not RE2-safe", !isRE2Safe("a{2}{3}"))
check("leading bare {2} is not RE2-safe", !isRE2Safe("{2}"))
check("a well-formed {2} after an atom is RE2-safe", isRE2Safe("a{2}"))
check("grouped repeat product (a{1000}){2} is not RE2-safe", !isRE2Safe("(a{1000}){2}"))
check("grouped repeat product (a{500}){3} is not RE2-safe", !isRE2Safe("(a{500}){3}"))
check("grouped repeat product (a{32}){32} is not RE2-safe", !isRE2Safe("(a{32}){32}"))
check("grouped repeat product (a{3}){333} is RE2-safe", isRE2Safe("(a{3}){333}"))
check("grouped repeat product (a{3}){334} is not RE2-safe", !isRE2Safe("(a{3}){334}"))
check("(a{1000}){1} does not trip the product limit", isRE2Safe("(a{1000}){1}"))
check("(a{1000})+ is RE2-safe (star/plus are not product-checked)", isRE2Safe("(a{1000})+"))
check("concat siblings are not multiplied: (a{10}b{10}){100}", isRE2Safe("(a{10}b{10}){100}"))
check("concat siblings product (a{10}b{10}){101} is not RE2-safe", !isRE2Safe("(a{10}b{10}){101}"))
check("alternation takes the heavier branch: (a{10}|b{20}){50}", isRE2Safe("(a{10}|b{20}){50}"))
check("alternation product (a{10}|b{20}){51} is not RE2-safe", !isRE2Safe("(a{10}|b{20}){51}"))
check("inverted class range [z-a] is not RE2-safe", !isRE2Safe("[z-a]"))
check("ordinary class range [a-z] is RE2-safe", isRE2Safe("[a-z]"))
check("[a-] trailing hyphen is RE2-safe", isRE2Safe("[a-]"))
check("[a--] inverted range is not RE2-safe", !isRE2Safe("[a--]"))
check("inverted hex range is not RE2-safe", !isRE2Safe("[\\x{5A}-\\x{41}]"))
check("hex class range is RE2-safe", isRE2Safe("[\\x{41}-\\x{5A}]"))

// `[:` inside a class is a POSIX named class in Go's regexp, but literal
// characters in JS. Drop every such pattern, including ones Go can compile.
check("[^é[:alpha:] is not RE2-safe (POSIX class, missing closing ])", !isRE2Safe("[^é[:alpha:]"))
check("[*?\\-[:alpha:] is not RE2-safe (POSIX class, missing closing ])", !isRE2Safe("[*?\\-[:alpha:]"))
check("[[:alpha:]a-\\d is not RE2-safe (POSIX class, invalid escape)", !isRE2Safe("[[:alpha:]a-\\d"))
check("[[:alpha:]] is not RE2-safe (would compile in Go but match differently)", !isRE2Safe("[[:alpha:]]"))
check("[a-z] without a POSIX class stays RE2-safe", isRE2Safe("[a-z]"))
{
  const dropped = sanitizePatternString("[^é[:alpha:]")
  check("sanitizePatternString drops a POSIX class inside a bracket",
    !dropped.ok && dropped.pattern === undefined, JSON.stringify(dropped))
}

// Escapes RE2 does not take, inside or outside a class.
check("[\\b] is not RE2-safe", !isRE2Safe("[\\b]"))
check("[\\Qa] is not RE2-safe", !isRE2Safe("[\\Qa]"))
check("\\é is not RE2-safe", !isRE2Safe("\\é"))
check("\\b outside a class is RE2-safe", isRE2Safe("\\bword"))
check("\\Q...\\E is dropped (RE2 quoting, not ECMA-262)", !isRE2Safe("\\Qabc\\E"))
check("\\a is dropped (BEL in RE2, literal a in JS)", !isRE2Safe("\\a"))
check("\\A is dropped (start-of-text in RE2, literal A in JS)", !isRE2Safe("\\A"))

// \\p names Go does not know, including the ECMA Script= form.
check("\\p{Greek} is RE2-safe", isRE2Safe("\\p{Greek}"))
check("\\p{Script=Greek} is not RE2-safe", !isRE2Safe("\\p{Script=Greek}"))
check("unknown \\p name is not RE2-safe", !isRE2Safe("\\p{NotARealScript}"))
check("\\p{^L} negation is RE2-safe", isRE2Safe("\\p{^L}"))

// Out-of-range code points.
check("\\x{10FFFF} is RE2-safe", isRE2Safe("\\x{10FFFF}"))
check("\\u{110000} is not RE2-safe after translation",
  !isRE2Safe(translateUnicodeEscapes("\\u{110000}")))
check("translated \\x{110000} is not RE2-safe", !isRE2Safe("\\x{110000}"))

// Surrogate pairs must be joined into one code point.
{
  const joined = translateUnicodeEscapes("\\uD83D\\uDE00")
  check("escaped surrogate pair joins into one code point",
    joined === "\\x{1F600}", joined)
  const literal = translateUnicodeEscapes("😀")
  check("literal emoji joins into one code point",
    literal === "\\x{1F600}", literal)
  check("joined emoji escape is RE2-safe", isRE2Safe(joined))
  check("joining is idempotent on \\x{1F600}",
    translateUnicodeEscapes("\\x{1F600}") === "\\x{1F600}")
  check("mixed escaped-high + raw-low surrogates join",
    translateUnicodeEscapes("\\uD83D" + String.fromCharCode(0xDE00)) === "\\x{1F600}")
  check("mixed raw-high + escaped-low surrogates join",
    translateUnicodeEscapes(String.fromCharCode(0xD83D) + "\\uDE00") === "\\x{1F600}")
}

// \\z and \\S compile in RE2 but differ from JS; drop them into a hint.
check("\\z is not treated as RE2-safe (JS vs RE2 semantics)", !isRE2Safe("\\z"))
check("\\S is not treated as RE2-safe (JS vs RE2 semantics)", !isRE2Safe("\\S"))
check("\\s stays RE2-safe", isRE2Safe("\\s+"))
{
  const droppedZ = sanitizePatternString("end\\z")
  check("sanitizePatternString drops \\z into a failed result",
    !droppedZ.ok && droppedZ.pattern === undefined, JSON.stringify(droppedZ))
  const droppedS = sanitizePatternString("\\S+")
  check("sanitizePatternString drops \\S into a failed result",
    !droppedS.ok, JSON.stringify(droppedS))
}

{
  const kept = sanitizePatternString(NUL_CLASS)
  check("sanitizePatternString keeps translated NUL class",
    kept.ok && kept.pattern === NUL_CLASS_RE2, JSON.stringify(kept))
  const dropped = sanitizePatternString(PATH_LOOKAHEAD)
  check("sanitizePatternString drops lookahead path pattern",
    !dropped.ok && dropped.pattern === undefined, JSON.stringify(dropped))
  const named = sanitizePatternString("(?<name>[a-z]+)")
  check("sanitizePatternString keeps (?<name>…)",
    named.ok && named.pattern === "(?<name>[a-z]+)", JSON.stringify(named))
}

{
  const node = { type: "string", description: "a path", pattern: PATH_LOOKAHEAD }
  sanitizePatternFields(node)
  check("sanitizePatternFields drops invalid pattern and hints with the original",
    node.pattern === undefined && typeof node.description === "string"
      && node.description.includes("pattern: ")
      && node.description.includes("(?!/)")
      && !node.description.includes("pattern: pattern:"),
    JSON.stringify(node))
}

{
  const node = { type: "string", pattern: NUL_CLASS }
  sanitizePatternFields(node)
  check("sanitizePatternFields rewrites a translatable pattern in place",
    node.pattern === NUL_CLASS_RE2 && node.description === undefined,
    JSON.stringify(node))
  sanitizePatternFields(node)
  check("sanitizePatternFields is idempotent after a rewrite",
    node.pattern === NUL_CLASS_RE2 && node.description === undefined,
    JSON.stringify(node))
}

{
  const node = {
    type: "object",
    patternProperties: {
      [NUL_CLASS]: { type: "string" },
      [PATH_LOOKAHEAD]: { type: "number" },
    },
  }
  sanitizePatternFields(node)
  check("patternProperties: translatable key is rewritten, invalid key is dropped",
    Object.keys(node.patternProperties).length === 1
      && Object.hasOwn(node.patternProperties, NUL_CLASS_RE2)
      && (node.description || "").includes("dropped patternProperties"),
    JSON.stringify(node))
}

{
  const node = {
    type: "object",
    additionalProperties: false,
    patternProperties: {
      "^(?!x)": { type: "string" },
    },
  }
  sanitizePatternFields(node)
  check("dropping every patternProperties key does not leave additionalProperties:false (reject-all)",
    node.patternProperties === undefined
      && node.additionalProperties !== false
      && (node.description || "").includes("dropped patternProperties")
      && (node.description || "").includes("additionalProperties:false was lifted"),
    JSON.stringify(node))
}

{
  const schema = sanitizeInputSchema({
    type: "object",
    properties: {
      sourcePath: { type: "string", description: "source", pattern: NUL_CLASS },
      path: { type: "string", description: "unix path", pattern: PATH_LOOKAHEAD },
      nested: {
        type: "object",
        properties: {
          inner: { type: "string", pattern: NUL_CLASS },
        },
      },
      list: {
        type: "array",
        items: { type: "string", pattern: PATH_LOOKAHEAD },
      },
      either: {
        anyOf: [
          { type: "string", pattern: NUL_CLASS },
          { type: "string", pattern: PATH_LOOKAHEAD },
        ],
      },
    },
    required: ["sourcePath"],
  })
  const source = schema.properties.sourcePath
  const pathNode = schema.properties.path
  const inner = schema.properties.nested.properties.inner
  const item = schema.properties.list.items
  const [okBranch, badBranch] = schema.properties.either.anyOf
  check("sanitizeInputSchema rewrites nested sourcePath",
    source.pattern === NUL_CLASS_RE2, JSON.stringify(source))
  check("sanitizeInputSchema drops nested lookahead path and hints",
    pathNode.pattern === undefined && /pattern: /.test(pathNode.description || ""),
    JSON.stringify(pathNode))
  check("sanitizeInputSchema rewrites items / anyOf / nested objects",
    inner.pattern === NUL_CLASS_RE2
      && item.pattern === undefined
      && okBranch.pattern === NUL_CLASS_RE2
      && badBranch.pattern === undefined,
    JSON.stringify({ inner, item, okBranch, badBranch }))
  const again = sanitizeInputSchema(schema)
  check("sanitizeInputSchema is idempotent on an already-sanitized tree",
    JSON.stringify(again) === JSON.stringify(schema))
}

// Recursion into propertyNames / contains / if/then/else / dependentSchemas / unevaluated*.
{
  const schema = sanitizeInputSchema({
    type: "object",
    propertyNames: { type: "string", pattern: "^(?!x)" },
    if: { type: "string", pattern: "^(?!if)" },
    then: { type: "string", pattern: "^(?!then)" },
    else: { type: "string", pattern: "^(?!else)" },
    dependentSchemas: {
      flag: { type: "string", pattern: "^(?!dep)" },
    },
    unevaluatedProperties: { type: "string", pattern: "^(?!uP)" },
    properties: {
      list: {
        type: "array",
        contains: { type: "string", pattern: "^(?!y)" },
        unevaluatedItems: { type: "string", pattern: "^(?!uI)" },
      },
    },
  })
  const spots = [
    schema.propertyNames,
    schema.if,
    schema.then,
    schema.else,
    schema.dependentSchemas.flag,
    schema.unevaluatedProperties,
    schema.properties.list.contains,
    schema.properties.list.unevaluatedItems,
  ]
  check("sanitizeInputSchema recurses into propertyNames/contains/if/then/else/dependentSchemas/unevaluated*",
    spots.every((node) => node && node.pattern === undefined && /pattern: /.test(node.description || "")),
    JSON.stringify(schema))
}

// Existing sanitizer behaviour should still hold (enum / union / dangling required).
{
  const schema = sanitizeInputSchema({
    type: "object",
    properties: {
      union_arr: { type: ["object", "array"], items: { type: "string" } },
      stale_items: { type: ["string", "number"], items: { type: "string" }, properties: { bad: { type: "string" } } },
      num_enum: { type: "integer", enum: [0, 1, 2] },
    },
    required: ["union_arr", "missing_field"],
  })
  check("existing union / stale / enum / required sanitizer still applies",
    schema.properties.union_arr.type === "array"
      && schema.properties.stale_items.items === undefined
      && schema.properties.stale_items.properties === undefined
      && schema.properties.num_enum.enum === undefined
      && /Allowed values: 0, 1, 2/.test(schema.properties.num_enum.description || "")
      && JSON.stringify(schema.required) === JSON.stringify(["union_arr"]),
    JSON.stringify(schema))
}

// Cross-check accepted patterns against Go's regexp.Compile when `go` is present.
{
  const helper = fileURLToPath(new URL("./re2-compile.go", import.meta.url))
  const corpus = [
    "^[a-z]+$",
    "(?:foo){1,3}",
    "\\p{L}+",
    "\\p{Greek}",
    "(?P<name>[a-z]+)",
    "(?<name>[a-z]+)",
    "(?i)abc",
    "^.{0,1000}$",
    "a{2}",
    "a{0,}",
    "a{0002}",
    "\\bword",
    "\\s+",
    "(a{3}){333}",
    "(a{10}b{10}){100}",
    "[\\x{41}-\\x{5A}]",
    "\\x{10FFFF}",
    translateUnicodeEscapes("\\uD83D\\uDE00"),
    translateUnicodeEscapes(NUL_CLASS),
    "^😀$",
  ]
  const rejected = [
    "^.{0,2000}$",
    "a{3,2}",
    "a{2}{3}",
    "{2}",
    "[\\b]",
    "[\\Qa]",
    "\\é",
    "\\p{Script=Greek}",
    "\\x{110000}",
    "a*+",
    "(?=a)",
    "(a)\\1",
    "(a{1000}){2}",
    "(a{32}){32}",
    "(a{10}b{10}){101}",
    "[z-a]",
    "[a--]",
    "[\\x{5A}-\\x{41}]",
    "[^é[:alpha:]",
    "[*?\\-[:alpha:]",
    "[[:alpha:]a-\\d",
  ]
  const input = [
    ...corpus.map((pattern) => JSON.stringify({ pattern })),
    JSON.stringify({ pattern: "\\x{1F600}", input: "😀" }),
    JSON.stringify({ pattern: "\\x{D83D}\\x{DE00}", input: "😀" }),
    ...rejected.map((pattern) => JSON.stringify({ pattern })),
  ].join("\n") + "\n"
  const result = spawnSync("go", ["run", helper], {
    input,
    encoding: "utf8",
    cwd: path.dirname(helper),
    timeout: 60_000,
  })
  if (result.error && result.error.code === "ENOENT") {
    // Keep this visible: a silent pass hid a missing toolchain.
    console.log("skip  Go regexp cross-check (go not on PATH)")
  } else if (result.status !== 0) {
    check("Go regexp cross-check runner", false, (result.stderr || result.stdout || result.error)?.toString())
  } else {
    const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    const byPattern = new Map(rows.filter((row) => !("match" in row) || row.input === undefined).map((row) => [row.pattern, row]))
    // The first corpus.length rows correspond to corpus (no input).
    const compiled = rows.slice(0, corpus.length)
    const joinMatch = rows.find((row) => row.pattern === "\\x{1F600}" && row.input === "😀")
    const splitMatch = rows.find((row) => row.pattern === "\\x{D83D}\\x{DE00}" && row.input === "😀")
    const rejectedRows = rows.slice(-rejected.length)
    check("every pattern isRE2Safe accepts is compiled by Go regexp",
      compiled.every((row) => row.ok) && compiled.length === corpus.length,
      JSON.stringify(compiled.filter((row) => !row.ok)))
    check("isRE2Safe is not true for any Go-rejected review case",
      rejected.every((pattern, i) => !isRE2Safe(pattern) && rejectedRows[i] && rejectedRows[i].ok === false),
      JSON.stringify(rejectedRows))
    check("Go matches 😀 against the joined \\x{1F600}",
      joinMatch && joinMatch.ok && joinMatch.match === true, JSON.stringify(joinMatch))
    check("Go does not match 😀 against split surrogate escapes",
      splitMatch && splitMatch.ok && splitMatch.match === false, JSON.stringify(splitMatch))
    void byPattern
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nALL OK")
