import assert from "node:assert/strict"
import { test } from "node:test"
import { endpointChoice } from "./index.mjs"

// the npm packages the plugin names as its APIs (index.mjs:54-56)
const CHAT = "@ai-sdk/openai-compatible"
const MESSAGES = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"

// A model's API follows the endpoints it lists (#271). Chat completions comes
// first, as the built-in picks it; asking for the native Responses API takes it
// where the model offers both, and changes nothing where it does not.
test("endpointChoice keeps chat completions first by default", () => {
  assert.equal(endpointChoice(["/chat/completions", "/responses"]), CHAT)
  assert.equal(endpointChoice(["/responses"]), RESPONSES)
  assert.equal(endpointChoice(["/messages", "/responses"]), RESPONSES)
  assert.equal(endpointChoice(["/messages"]), MESSAGES)
})

test("endpointChoice takes native Responses where the model offers both", () => {
  assert.equal(endpointChoice(["/chat/completions", "/responses"], true), RESPONSES)
  // and changes nothing where it does not
  assert.equal(endpointChoice(["/chat/completions"], true), CHAT)
  assert.equal(endpointChoice(["/messages"], true), MESSAGES)
})

test("endpointChoice says nothing when no known endpoint is named", () => {
  assert.equal(endpointChoice([]), null)
  assert.equal(endpointChoice(["/something-else"]), null)
  assert.equal(endpointChoice([], true), null)
})
