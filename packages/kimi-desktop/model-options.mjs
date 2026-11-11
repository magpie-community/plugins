// Pure capability policy for a model's catalog-declared options.
// No provider defaults are invented here: '' asks the provider/Magpie for its
// default reasoning effort, and null adds no input budget. A numeric budget
// is validated against the catalog's explicitly published context cap.

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => {
  const error = Error(code);
  error.code = code;
  throw error;
};

export function validateModelOptions(options = {}, capabilities) {
  if (!isRecord(options)) fail('invalid_model_options');

  const { reasoningEfforts, contextWindow } = capabilities;

  let reasoningEffort = '';
  if (options.reasoningEffort !== undefined) {
    if (typeof options.reasoningEffort !== 'string') fail('invalid_model_options');
    reasoningEffort = options.reasoningEffort;
    if (reasoningEffort !== '' && !reasoningEfforts.includes(reasoningEffort)) {
      fail('unsupported_reasoning_effort');
    }
  }

  let contextTokens = null;
  if (options.contextTokens !== undefined && options.contextTokens !== null) {
    if (!Number.isSafeInteger(options.contextTokens) || options.contextTokens <= 0) fail('invalid_model_options');
    contextTokens = options.contextTokens;
    if (contextWindow === null || contextTokens > contextWindow) fail('unsupported_context_length');
  }

  return { reasoningEffort, contextTokens };
}

// Preserve the legacy connection untouched unless an options object is present.
// A present config always strips Kimi's top-level thinking controls; an empty
// effort intentionally adds none. Context selection is never translated into a
// payload field; the caller checks an input-count copy separately.
export function applyReasoningOptions(payload, options) {
  if (options === null || options === undefined) return payload;

  const { reasoning_effort: _ignoredEffort, reasoning: _ignoredReasoning, thinking: _ignoredThinking, ...rest } = payload;
  const applied = { ...rest };
  if (options.reasoningEffort) applied.reasoning_effort = options.reasoningEffort;
  return applied;
}
