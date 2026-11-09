// The latest inference-input batch, not the latest user task, owns the images.
const REMOVED = "[Historical user image omitted]";
const OMITTED = "[Historical image omitted]";

const isToolPart = part => part?.type === "tool_result" || !!part?.functionResponse || !!part?.function_response;

function isImage(part, protocol) {
  if (!part || typeof part !== "object") return false;
  switch (protocol) {
    case "chat": return ["image_url", "input_image", "image"].includes(part.type);
    case "responses": return ["input_image", "output_image", "image"].includes(part.type);
    case "anthropic": return part.type === "image";
    case "gemini": {
      const data = part.inlineData || part.fileData || part.inline_data || part.file_data;
      return !!data && /^image\//i.test(data.mimeType || data.mime_type || "");
    }
    default: return false;
  }
}

function isAssistantOutput(message, protocol) {
  if (!message || typeof message !== "object") return false;
  if (message.role === "assistant" || (protocol === "gemini" && message.role === "model")) return true;
  return protocol === "responses" && ["reasoning", "function_call", "custom_tool_call", "computer_call",
    "mcp_call", "mcp_list_tools", "mcp_approval_request", "web_search_call", "file_search_call",
    "code_interpreter_call", "image_generation_call", "tool_search_call", "compaction"].includes(message.type);
}

function isRequestInput(message, protocol) {
  if (!message || typeof message !== "object") return false;
  if (message.role === "user" || message.role === "tool" || message.role === "function") return true;
  if (protocol === "gemini" && message.role === undefined) return true;
  return protocol === "responses" && ["function_call_output", "custom_tool_call_output",
    "computer_call_output", "mcp_approval_response", "tool_search_output", "item_reference"].includes(message.type);
}

function isHumanInput(message, protocol, contentKey) {
  if (!message || (message.role !== "user" && !(protocol === "gemini" && message.role === undefined))) return false;
  if (protocol === "responses" && message.type !== undefined && message.type !== "message") return false;
  const content = message[contentKey];
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  const hasToolResult = content.some(isToolPart);
  return content.some(part => part && typeof part === "object" && !isToolPart(part)
    && (hasToolResult ? typeof part.text === "string" && part.text.trim().length > 0
      : typeof part.text !== "string" || part.text.trim().length > 0));
}

// Walk payload containers, not tools, arguments, schemas, text or cache metadata.
const payloadKeys = ["content", "output", "parts", "functionResponse", "function_response", "response"];

export function visitImages(value, protocol, visit, path = []) {
  if (!value || typeof value !== "object") return;
  if (isImage(value, protocol)) { visit(value, path); return; }
  if (Array.isArray(value)) {
    value.forEach((child, index) => visitImages(child, protocol, visit, [...path, index]));
  } else {
    for (const key of payloadKeys) {
      if (value[key] && typeof value[key] === "object") visitImages(value[key], protocol, visit, [...path, key]);
    }
  }
}

function textMarker(protocol, legacy = false) {
  const text = legacy ? REMOVED : OMITTED;
  if (protocol === "gemini") return {text};
  return {type: protocol === "responses" ? "input_text" : "text", text};
}

export function filterRequest(body, protocol) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  let messagesKey;
  switch (protocol) {
    case "chat":
    case "anthropic": messagesKey = "messages"; break;
    case "responses": messagesKey = "input"; break;
    case "gemini": messagesKey = "contents"; break;
    default: return;
  }
  const contentKey = protocol === "gemini" ? "parts" : "content";
  const messages = body[messagesKey];
  if (!Array.isArray(messages)) return;

  let currentStart = 0;
  for (let index = 0; index < messages.length; index++) {
    if (isAssistantOutput(messages[index], protocol)) currentStart = index + 1;
  }
  // A new human submission can follow tool replies without an intervening
  // assistant message. Preserve adjacent text/attachment messages as one batch.
  let latestHuman = -1;
  for (let index = currentStart; index < messages.length; index++) {
    if (isHumanInput(messages[index], protocol, contentKey)) latestHuman = index;
  }
  if (latestHuman >= 0) {
    while (latestHuman > currentStart && isHumanInput(messages[latestHuman - 1], protocol, contentKey)) latestHuman--;
    currentStart = latestHuman;
  }
  // All tool replies after the latest model output belong to the same request.
  // Identical request retries retain this batch; no session-wide image hashes
  // can accidentally suppress a newly captured identical screenshot.

  const removedParts = [];
  const images = [];
  let removedImages = 0;
  let affectedMessages = 0;
  let placeholderMessages = 0;
  let keptCurrentImages = 0;
  const filtered = messages.map((message, index) => {
    visitImages(message, protocol, part => images.push(part));
    if (index >= currentStart && isRequestInput(message, protocol)) {
      visitImages(message, protocol, () => keptCurrentImages++);
      return message;
    }
    let changed = false;
    let placeholder = false;
    function remove(value, path) {
      if (!value || typeof value !== "object") return value;
      if (isImage(value, protocol)) {
        changed = true;
        removedImages++;
        removedParts.push({messageIndex: index, partIndex: path.find(item => typeof item === "number") ?? 0,
          path, role: message.role || message.type || "user", part: value});
        if (value.cache_control || value.prompt_cache_breakpoint) {
          placeholder = true;
          return {...textMarker(protocol),
            ...(value.cache_control ? {cache_control: value.cache_control} : {}),
            ...(value.prompt_cache_breakpoint ? {prompt_cache_breakpoint: value.prompt_cache_breakpoint} : {})};
        }
        const directUserImage = path.length === 2 && path[0] === contentKey
          && (message.role === "user" || (protocol === "gemini" && message.role === undefined))
          && !message[contentKey].some(isToolPart);
        if (!directUserImage) {
          // A later model must not mistake stripped screenshots for tools that
          // never returned an image in the original turn.
          placeholder = true;
          return textMarker(protocol);
        }
        return undefined;
      }
      if (Array.isArray(value)) {
        const kept = [];
        let different = false;
        value.forEach((child, childIndex) => {
          const next = remove(child, [...path, childIndex]);
          if (next !== child) different = true;
          if (next !== undefined || child === undefined) kept.push(next);
        });
        if (!different) return value;
        if (!kept.length) {
          placeholder = true;
          const legacy = path.length === 1 && path[0] === contentKey && message.role === "user";
          kept.push(textMarker(protocol, legacy || (protocol === "gemini" && message.role === undefined)));
        }
        return kept;
      }
      let next = value;
      for (const key of payloadKeys) {
        if (!value[key] || typeof value[key] !== "object") continue;
        const child = remove(value[key], [...path, key]);
        if (child !== value[key]) {
          if (next === value) next = {...value};
          next[key] = child ?? textMarker(protocol);
          if (child === undefined) placeholder = true;
        }
      }
      return next;
    }
    const next = remove(message, []);
    if (changed) affectedMessages++;
    if (placeholder) placeholderMessages++;
    return next;
  });
  return {
    body: removedImages > 0 ? {...body, [messagesKey]: filtered} : body,
    policy: "latest-request-input", currentInputStart: currentStart,
    stats: {protocol, removedImages, affectedMessages, placeholderMessages, keptCurrentImages},
    removedParts,
    images,
  };
}
