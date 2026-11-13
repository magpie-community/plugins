import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { clientDecode } from './vendor/trae-client-codec.mjs';
import { encodeCredential, readNativeCredentialProfile } from './trae-local-token.mjs';

const ORIGIN = 'https://trae-api-cn.mchost.guru';
export const FUNCTIONS = ['chat_v3', 'solo_work_lite', 'solo_agent', 'solo_agent_lite', 'solo_coder'];

export function readSession({ home = os.homedir(), roaming = process.env.APPDATA, local = process.env.LOCALAPPDATA } = {}) {
  const file = path.join(roaming || path.join(home, 'AppData/Roaming'), 'Trae CN/User/globalStorage/storage.json');
  const storage = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = storage['iCubeAuthInfo://icube.cloudide'];
  if (typeof raw !== 'string') throw new Error('trae_not_signed_in');
  const auth = JSON.parse(raw.trim().startsWith('{') ? raw : clientDecode(raw));
  if (!auth.token || !auth.userId) throw new Error('trae_not_signed_in');
  const claims = JSON.parse(Buffer.from(auth.token.split('.')[1], 'base64url').toString());
  if (!claims.exp || claims.exp * 1000 <= Date.now() + 30000) throw new Error('trae_sign_in_expired');
  const devices = Object.keys(storage).filter(k => /^iCubeAuthInfo:\/\/icube-dc:\d+$/.test(k));
  if (devices.length !== 1) throw new Error('trae_device_unavailable');
  const product = JSON.parse(fs.readFileSync(path.join(local, 'Programs/Trae CN/resources/app/product.json'), 'utf8'));
  const region = typeof auth.userRegion === 'string' ? auth.userRegion : auth.userRegion?.region;
  return {
    account: createHash('sha256').update(String(auth.userId)).digest('hex'),
    headers: { Authorization: `Cloud-IDE-JWT ${auth.token}`, 'Content-Type': 'application/json',
      'X-Cloudide-Token': auth.token, 'x-ide-token': auth.token, 'x-uid': String(auth.userId),
      'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8', 'x-device-id': devices[0].split(':').at(-1),
      'x-app-version': product.appVersion, 'x-ide-version': product.appVersion,
      'x-device-type': 'windows', 'x-user-region': region || 'CN' },
  };
}

export class TraeAPI {
  constructor(session, { request = fetch, origin = ORIGIN,
    encodeEmptySecret = () => encodeCredential('', readNativeCredentialProfile()) } = {}) {
    this.session = session; this.request = request; this.origin = origin; this.encodeEmptySecret = encodeEmptySecret;
  }
  async call(method, body) {
    if (!['batch_get_detail_param', 'add_custom_model', 'update_custom_model'].includes(method)) throw new Error('unsupported_trae_operation');
    // Trae encrypts both credential fields, including the unused empty SK.
    // A plaintext empty SK is accepted by model CRUD but fails real chat as
    // "invalid ak". Keep the caller's recovery journal immutable.
    if (['add_custom_model', 'update_custom_model'].includes(method) && body.sk === '') {
      body = { ...body, sk: this.encodeEmptySecret() };
    }
    const response = await this.request(`${this.origin}/api/ide/v1/${method}`, {
      method: 'POST', headers: this.session.headers, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    let result; try { result = await response.json(); } catch { throw new Error(`trae_response_${response.status}`); }
    if (!response.ok || (result.code !== undefined && result.code !== 0)) throw new Error(`trae_api_${result.code ?? response.status}`);
    return result;
  }
  async list() {
    const result = await this.call('batch_get_detail_param', { functions: FUNCTIONS, agent_type: '',
      current_config_info: { config_name: '', is_custom_model: false }, mode_type: 0, access_type: 0,
      ab_force_vids: '', ab_autotest_advanced_mode: 0, show_custom_model: true });
    if (!Array.isArray(result.function_configs)) throw new Error('trae_catalog_unknown');
    const entries = new Map();
    for (const group of result.function_configs) {
      if (group.error_code) throw new Error(`trae_catalog_${group.error_code}`);
      for (const info of group.config_info_list || []) {
        for (const detail of info.model_detail_list || []) {
          const c = detail.custom_config;
          if (!c?.custom_model_id) continue;
          entries.set(String(c.custom_model_id), { id: String(c.custom_model_id), model: detail.model_name,
            provider: detail.provider, name: info.display_config?.display_name || info.config_name,
            ak: c.ak, baseURL: c.base_url, status: c.status !== false, config: c,
            detail: { multimodal: !!info.display_config?.multimodal,
              model_hyper_params: { max_tokens: detail.max_tokens, prompt_max_tokens: detail.prompt_max_tokens,
                thinking_enable: c.thinking_enable, reasoning_param: c.reasoning_param }, max_turn: detail.max_turn || 500 } });
        }
      }
    }
    return [...entries.values()];
  }
}
