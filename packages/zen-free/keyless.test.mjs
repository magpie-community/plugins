import {test,expect} from "bun:test"
import {ZenFreePlugin} from "./index.mjs"

test("Zen Free declares one keyless public identity without changing authorize",async()=>{
 const hooks=await ZenFreePlugin({client:{auth:{set:async()=>{throw Error("unexpected auth write")}}}})
 expect(hooks.auth.single).toBe(true)
 expect(hooks.auth.methods[0].keyless).toBe(true)
 expect(await hooks.auth.methods[0].authorize({})).toEqual({type:"success",key:"public"})
 expect(await hooks.auth.methods[0].authorize({key:"personal-fixture"})).toEqual({type:"success",key:"public"})
})
