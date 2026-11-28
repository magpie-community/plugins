import { makePlugin } from "./provider.mjs"

export const OpenCodeGoAccountPlugin = async (input = {}) => makePlugin("go", input)
export const OpenCodeConsoleAccountPlugin = async (input = {}) => makePlugin("console", input)
