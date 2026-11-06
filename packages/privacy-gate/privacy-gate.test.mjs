import * as mod from "./privacy-gate.middleware.js"
import { check } from "../../scripts/middleware.mjs"

check(import.meta.dir, mod)
