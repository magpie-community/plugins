// Builds page/measure.js from fovea.middleware.js: the middleware is one
// file with one export and no imports, so the page's copy is the same
// source with the export turned into a global. magpie serves a page's own
// folder only — ../fovea.middleware.js is a 404 inside the sandbox — so
// the page needs this bundle beside it.
//
// The test suite regenerates and compares, so a stale bundle fails CI,
// not the page. Run after changing the middleware:
//
//   bun build.mjs
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, "fovea.middleware.js"), "utf8")
const out = src.replace(
  "export function onRequest(",
  "function onRequest(",
) + "\nglobalThis.FoveaOnRequest = onRequest;\n"
if (out === src) throw new Error("fovea.middleware.js no longer exports onRequest the way build.mjs expects")
writeFileSync(join(HERE, "page", "measure.js"), out)
console.log("page/measure.js written,", out.length, "bytes")
