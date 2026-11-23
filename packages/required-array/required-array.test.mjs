import { test, expect } from "bun:test"
import { onRequest } from "./required-array.middleware.js"

const clone = (value) => JSON.parse(JSON.stringify(value))

test("fills a missing required array on an OpenAI Chat function tool", () => {
  const body = {
    tools: [
      { type: "function", function: { name: "get_goal", parameters: { type: "object", properties: {} } } },
    ],
  }
  const out = onRequest(clone(body))
  expect(out.tools[0].function.parameters.required).toEqual([])
})

test("keeps an existing required array", () => {
  const body = {
    tools: [
      {
        type: "function",
        function: {
          name: "create_goal",
          parameters: { type: "object", properties: { objective: { type: "string" } }, required: ["objective"] },
        },
      },
    ],
  }
  const out = onRequest(clone(body))
  expect(out.tools[0].function.parameters.required).toEqual(["objective"])
})

test("leaves tools without parameters and built-in tools alone", () => {
  const body = {
    tools: [
      { type: "function", function: { name: "no_params_tool" } },
      { type: "web_search" },
    ],
  }
  const out = onRequest(clone(body))
  expect(out.tools[0].function.parameters).toBeUndefined()
  expect(out.tools[1]).toEqual({ type: "web_search" })
})

test("recurses into nested objects, array items and unions", () => {
  const body = {
    tools: [
      {
        type: "function",
        function: {
          name: "ask",
          parameters: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    options: {
                      type: "array",
                      items: { type: "object", properties: { label: { type: "string" } } },
                    },
                  },
                },
              },
            },
            anyOf: [{ type: "object", properties: { a: { type: "string" } } }],
          },
        },
      },
    ],
  }
  const out = onRequest(clone(body))
  const params = out.tools[0].function.parameters
  expect(params.required).toEqual([])
  expect(params.properties.questions.items.required).toEqual([])
  expect(params.properties.questions.items.properties.options.items.required).toEqual([])
  expect(params.anyOf[0].required).toEqual([])
})

test("handles OpenAI Responses flat function tools", () => {
  const body = {
    tools: [
      { type: "function", name: "get_goal", parameters: { type: "object", properties: {} } },
      { type: "web_search" },
    ],
  }
  const out = onRequest(clone(body))
  expect(out.tools[0].parameters.required).toEqual([])
  expect(out.tools[1]).toEqual({ type: "web_search" })
})

test("handles Anthropic input_schema tools", () => {
  const body = { tools: [{ name: "get_goal", description: "d", input_schema: { type: "object", properties: {} } }] }
  const out = onRequest(clone(body))
  expect(out.tools[0].input_schema.required).toEqual([])
})

test("leaves Gemini alone", () => {
  const body = {
    tools: [{ functionDeclarations: [{ name: "get_goal", parameters: { type: "object", properties: {} } }] }],
  }
  const out = onRequest(clone(body))
  expect(out.tools[0].functionDeclarations[0].parameters.required).toBeUndefined()
})

test("is idempotent", () => {
  const body = {
    tools: [{ type: "function", function: { name: "get_goal", parameters: { type: "object", properties: {} } } }],
  }
  const once = onRequest(clone(body))
  const twice = onRequest(clone(once))
  expect(twice).toEqual(once)
})

test("ignores requests without tools or with a null body", () => {
  expect(onRequest({ model: "m" })).toBeUndefined()
  expect(onRequest(null)).toBeUndefined()
})
