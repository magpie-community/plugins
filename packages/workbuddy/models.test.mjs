import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { liveModels, modelOf, SITES } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const auth = { access: "a", uid: "u" }
const config = (data) => async () => Response.json({ code: 0, data })
const ids = (models) => models.map((m) => m.id)
const provider = { id: "workbuddy-ai" }

test("image models in modelPromotions are discovered with their tags", async () => {
  globalThis.fetch = config({
    agents: [{ name: "cli", models: ["chat-model"] }],
    models: [{ id: "chat-model", name: "Chat", supportsImages: false }],
    modelPromotions: [
      { id: "gpt-image-2.5-sunburst", name: "GPT-Image-2.5-Sunburst", tags: ["text-to-image", "image-to-image"] },
      { name: "promotion without a model id", tags: ["text-to-image"] },
      { id: "discount-with-id", kind: "discount", modelIds: ["chat-model"], discount: { factor: 0 } },
      { id: "seedance-2.5", name: "Seedance-2.5", tags: ["text-to-video", "image-to-video"] },
    ],
  })

  const models = await liveModels(SITES["workbuddy-ai"], auth)
  const image = models.find((m) => m.id === "gpt-image-2.5-sunburst")
  expect(ids(models)).toEqual(["chat-model", "gpt-image-2.5-sunburst"])
  expect(image).toMatchObject({
    name: "GPT-Image-2.5-Sunburst",
    images: true,
    tags: ["text-to-image", "image-to-image"],
  })
  expect(modelOf(SITES["workbuddy-ai"], provider, image).capabilities.output.image).toBe(true)
})

test("model capabilities follow image tags without changing chat models", async () => {
  const textToImage = modelOf(SITES["workbuddy-ai"], provider, {
    id: "text-image-only",
    name: "Text Image Only",
    tags: ["text-to-image"],
  })
  expect(textToImage.capabilities).toMatchObject({
    attachment: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: false, image: true, audio: false, video: false, pdf: false },
  })

  const imageToImage = modelOf(SITES["workbuddy-ai"], provider, {
    id: "image-edit",
    name: "Image Edit",
    tags: ["text-to-image", "image-to-image"],
  })
  expect(imageToImage.capabilities).toMatchObject({
    attachment: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: false, image: true, audio: false, video: false, pdf: false },
  })

  const chat = modelOf(SITES["workbuddy-ai"], provider, {
    id: "chat-model",
    name: "Chat",
    tags: [],
  })
  expect(chat.capabilities.input.image).toBe(false)
  expect(chat.capabilities.output).toEqual({
    text: true,
    image: false,
    audio: false,
    video: false,
    pdf: false,
  })
})

test("China image models in models stay deduplicated", async () => {
  globalThis.fetch = config({
    agents: [{ name: "cli", models: ["auto", "hunyuan-image-alpha-edit"] }],
    models: [
      { id: "auto", name: "Auto" },
      { id: "hunyuan-image-alpha", name: "Hunyuan Image Alpha", tags: ["text-to-image"] },
      { id: "hunyuan-image-alpha-edit", name: "Hunyuan Image Alpha Edit", tags: ["text-to-image", "image-to-image"] },
    ],
    modelPromotions: [
      { id: "hunyuan-image-alpha", name: "Hunyuan Image Alpha", tags: ["text-to-image"] },
    ],
  })

  const models = await liveModels(SITES.workbuddy, auth)
  expect(ids(models)).toEqual(["auto", "hunyuan-image-alpha-edit", "hunyuan-image-alpha"])
  expect(models[1]).toMatchObject({
    images: true,
    tags: ["text-to-image", "image-to-image"],
  })
})
