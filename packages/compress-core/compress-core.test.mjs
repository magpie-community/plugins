// The package's cases, run the way every other middleware in this repo runs
// them: cases.json in, check() from scripts/middleware.mjs, bun test picks it up.
import { check } from "../../scripts/middleware.mjs"
import * as mod from "./compress-core.middleware.js"

check(import.meta.dir, mod)
