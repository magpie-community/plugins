// SpecStream's Search API and Extract API, as tools for every agent and as a
// web search API in magpie's Settings. The tools read SPECSTREAM_API_KEY; the
// search entry uses the key magpie keeps for it.
import { extract, search } from "./specstream.mjs"

const envKey = () => {
  const k = (process.env.SPECSTREAM_API_KEY || "").trim()
  if (!k) throw new Error("SpecStream needs an API key: set SPECSTREAM_API_KEY")
  return k
}

const sources = (data) =>
  (data.sources || []).map((s) => ({ title: s.title || s.site || s.url, url: s.url, text: s.snippet, age: s.published }))

export const SpecStreamTools = async () => ({
  tool: {
    web_search: {
      description:
        "Searches the live web with SpecStream and returns an answer when the evidence supports one, the rows found with the page each value was read from, and the sources in rank order.",
      args: {
        type: "object",
        properties: {
          query: { type: "string", description: "the question or request in everyday words, 1 to 2,000 characters" },
          count: { type: "number", description: "how many sources to return, 1 to 100 (10 when left out; more than 10 costs more)" },
        },
        required: ["query"],
      },
      async execute(args, ctx) {
        if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query is a string")
        const d = await search({ query: args.query, count: args.count, key: envKey(), signal: ctx?.abort })
        return { answer: d.answer ?? null, rows: d.rows ?? [], sources: d.sources ?? [] }
      },
    },
    extract: {
      description:
        "Reads the main text of up to 20 web pages with SpecStream, as markdown or plain text, with each page's title and the date it says it was published.",
      args: {
        type: "object",
        properties: {
          urls: { type: "array", items: { type: "string" }, description: "1 to 20 http or https addresses" },
          format: { type: "string", enum: ["markdown", "text"], description: "markdown (default) or text" },
        },
        required: ["urls"],
      },
      async execute(args, ctx) {
        const d = await extract({ urls: args.urls, format: args.format, key: envKey(), signal: ctx?.abort })
        return { results: d.results ?? [] }
      },
    },
  },
  search: {
    specstream: {
      name: "SpecStream",
      keysURL: "https://specstream.ai/workspace/agents?tab=keys",
      async execute({ query, count, key }, ctx) {
        const found = sources(await search({ query, count, key, signal: ctx?.abort }))
        const n = Math.trunc(Number(count))
        return n >= 1 ? found.slice(0, n) : found
      },
    },
  },
})
