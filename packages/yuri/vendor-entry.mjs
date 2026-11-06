// Use the ESM build: the default UMD wrapper hides its relative require calls
// from the bundler and would leave runtime imports outside this package.
export { parse, parseTree, modify, applyEdits } from "jsonc-parser/lib/esm/main.js"
