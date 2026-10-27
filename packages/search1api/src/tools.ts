export interface Schema {
  type: "string" | "integer" | "array";
  description?: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: "uri";
  items?: Schema;
}
export interface ArgumentsSchema {
  type: "object";
  properties: Record<string, Schema>;
  required: string[];
  additionalProperties: false;
}

// Magpie forwards JSON Schema arguments unchanged, so validate on execute too.
export function validate(schema: ArgumentsSchema, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tool arguments must be an object.");
  const args = value as Record<string, unknown>;
  for (const key of schema.required) {
    if (args[key] === undefined) throw new Error(`${key} is required.`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!Object.hasOwn(schema.properties, key))
      throw new Error(`Unknown argument: ${key}.`);
    if (value === undefined) continue;
    if (field.type === "string") {
      if (typeof value !== "string") throw new Error(`${key} must be a string.`);
      const text = key === "query" ? value.trim() : value;
      if ((field.minLength !== undefined && text.length < field.minLength) ||
          (field.maxLength !== undefined && text.length > field.maxLength))
        throw new Error(`${key} has an invalid length.`);
      if (field.enum && !field.enum.includes(text))
        throw new Error(`${key} must be one of: ${field.enum.join(", ")}.`);
      if (field.format === "uri") {
        try { new URL(text); } catch { throw new Error(`${key} must be a URL.`); }
      }
      result[key] = text;
    } else if (field.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) ||
          (field.minimum !== undefined && value < field.minimum) ||
          (field.maximum !== undefined && value > field.maximum))
        throw new Error(`${key} must be an integer from ${field.minimum} to ${field.maximum}.`);
      result[key] = value;
    } else {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw new Error(`${key} must be an array of strings.`);
      result[key] = value;
    }
  }
  return result;
}

export const query: Schema = { type: "string", minLength: 1, description: "Search query (trimmed)." };
export const maxResults: Schema = { type: "integer", minimum: 1, maximum: 50 };
export const filters: Record<string, Schema> = {
  maxResults,
  crawlResults: { type: "integer", minimum: 0, maximum: 50 },
  includeSites: { type: "array", items: { type: "string" } },
  excludeSites: { type: "array", items: { type: "string" } },
  timeRange: { type: "string", enum: ["day", "week", "month", "year"] },
};

export function searchBody(args: Record<string, unknown>, service: string) {
  return {
    query: args.query,
    search_service: args.searchService ?? service,
    max_results: args.maxResults ?? 10,
    crawl_results: args.crawlResults ?? 0,
    ...(args.page === undefined ? {} : { page: args.page }),
    ...(args.includeSites === undefined ? {} : { include_sites: args.includeSites }),
    ...(args.excludeSites === undefined ? {} : { exclude_sites: args.excludeSites }),
    ...(args.timeRange === undefined ? {} : { time_range: args.timeRange }),
  };
}
