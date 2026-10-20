import { check } from "../../scripts/middleware.mjs"
import * as mod from "./grok-x-search-bridge.middleware.js"

check(import.meta.dir, mod)
