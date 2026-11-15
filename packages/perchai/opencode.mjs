// OpenCode 1.x rejects an entry module that exports anything besides plugins,
// so the host entry is this re-export and the implementation lives in
// index.mjs, where the helpers stay behind _internal.
export { PerchAuthPlugin } from "./index.mjs"
