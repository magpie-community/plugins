import { fetchImages, type ToolArgs, type ToolContext } from "./tool.ts";

export const CamPlugin = async (_input: unknown, options: Record<string, unknown> = {}) => ({
  tool: {
    cam_view_image: {
      description: "Fetch original images that Magpie omitted from earlier turns. Pass ids such as [\"IMG-001\"] and the session value shown beside that attachment placeholder. Use only when earlier descriptions are insufficient.",
      args: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8, description: "Image ids shown in the conversation, for example [\"IMG-001\"]." },
          session: { type: "string", minLength: 32, description: "The exact [Magpie CAM session: …] value beside the omitted image. Required because tool calls do not carry a session id." },
        },
        required: ["ids", "session"],
        additionalProperties: false,
      },
      execute: async (args: ToolArgs, ctx: ToolContext) => fetchImages(args, ctx, options),
    },
  },
});

export default CamPlugin;
