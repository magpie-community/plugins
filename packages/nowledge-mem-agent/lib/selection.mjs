import { normalizeURL } from './api.mjs';

export function selectionFrom(value) {
  if (value === null) return null;
  // Magpie restores keys individually; a completely empty object is disconnect.
  if (value && typeof value === 'object' && !Array.isArray(value) && !value.model && !value.gateway?.key && !value.gateway?.baseURL) return null;
  if (!value || typeof value !== 'object' || typeof value.model !== 'string' || !value.model.trim() || typeof value.gateway?.key !== 'string' || !value.gateway.key.trim() || typeof value.gateway.baseURL !== 'string') throw new Error('Incomplete Magpie selection; refusing to change Nowledge.');
  const baseURL = normalizeURL(value.gateway.baseURL);
  if (!baseURL.endsWith('/v1')) throw new Error('Magpie gateway baseURL must end in /v1.');
  return {model:value.model, gateway:{baseURL,key:value.gateway.key}, metadata:value.metadata ?? {}};
}

export function providerConfig(selection, provider) {
  const n = selection.metadata;
  const body = {
    enabled:true, provider, provider_type:'magpie', display_name:'Magpie · Nowledge Agent',
    model:selection.model, api_key:selection.gateway.key, api_base:selection.gateway.baseURL,
    api_format:'chat_completions', temperature:0.7, max_tokens:8192, timeout:600,
    extra_params:{no_activate:true, preserve_enabled:true},
  };
  if (Number.isSafeInteger(n.context) && n.context > 0) body.context_window = n.context;
  if (Number.isSafeInteger(n.output) && n.output > 0) body.max_tokens = Math.min(8192,n.output);
  if (typeof n.images === 'boolean') body.extra_params._nmem_provider_capabilities = {vision:n.images,vision_model:{model:selection.model,supports_image_input:n.images}};
  return body;
}
