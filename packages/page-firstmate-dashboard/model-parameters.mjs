// MagPie 19794cc10ce5c96ef3d2f88020c970a62376fe97:
// internal/agent/{pi.go,agents.go,claude.go,codex.go,grok.go,agy.go}.
// These field functions depend on the chosen model. The state API's single
// current effort field is not a schema for every other model.
const piLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const claudeLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
const optionList = values => values.map(value => ({ value }));
export function parameterChoices(agent, model, entry, fields, gatewayModel) {
  const field = fields?.find(f => f.key === 'effort');
  if (!field) return { parameterKnown: true, parameters: [] };
  const efforts = entry?.efforts || [];
  if (agent === 'pi') {
    if (!model.ref) return { parameterKnown: true, parameters: optionList(piLevels) };
    if (!gatewayModel || typeof gatewayModel.reasoning !== 'boolean') return { parameterKnown: false, parameters: [] };
    const reasoning = gatewayModel.reasoning || efforts.length > 0;
    let values;
    if (!reasoning) values = ['off'];
    else if (!efforts.length) values = piLevels.slice(0, 5);
    else {
      const aliases = { light: 'low', extra_high: 'xhigh', none: 'off' };
      const levels = new Set(efforts.map(e => aliases[e.toLowerCase()] || e));
      values = piLevels.filter(level => levels.has(level));
    }
    return { parameterKnown: true, parameters: optionList(values) };
  }
  if (agent === 'claude') {
    const value = model.value.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
    let levels = claudeLevels;
    if (value === 'claude-opus-4-5') levels = claudeLevels.slice(0, 3);
    else if (['claude-opus-4-6', 'claude-sonnet-4-6'].includes(value)) levels = ['low', 'medium', 'high', 'max'];
    else if (['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4', 'claude-sonnet-4'].includes(value) || value.includes('claude-3')) levels = [];
    return { parameterKnown: true, parameters: optionList(levels) };
  }
  if (agent === 'codex') return { parameterKnown: true, parameters: optionList(efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh']) };
  if (agent === 'grok') return { parameterKnown: true, parameters: optionList(efforts.length ? efforts : ['low', 'medium', 'high']) };
  // agy's effortField is a gateway override whose choices are the union of
  // the catalog, not the efforts of the current model (pickedEfforts).
  if (agent === 'agy') return { parameterKnown: true, parameters: field.options };
  return { parameterKnown: false, parameters: [] };
}

export async function piParameters() {
  const [{ readFile, stat }, { homedir }, { join, isAbsolute }] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path')]);
  const wanted = (process.env.PI_CODING_AGENT_DIR || '').replace(/^~(?=\/)/, homedir());
  const file = join(wanted && isAbsolute(wanted) ? wanted : join(homedir(), '.pi/agent'), 'models.json');
  try {
    if ((await stat(file)).size > 16 * 1024 * 1024) return [];
    const data = JSON.parse(await readFile(file, 'utf8'));
    // Provider blocks may contain keys. Only the levels Pi actually offers
    // leave this boundary, never the block or any of its connection fields.
    return (data.providers?.magpie?.models || []).map(model => {
      const map = model.thinkingLevelMap || {};
      const levels = model.reasoning ? piLevels.filter(l => Object.hasOwn(map, l) ? map[l] !== null : !['xhigh', 'max'].includes(l)) : ['off'];
      return { id: model.id, parameters: optionList(levels) };
    });
  } catch { return []; }
}
