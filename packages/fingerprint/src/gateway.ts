import type { Account, Model, Provenance } from './types';
import { boundedText } from './http';
/**
 * X-Magpie-Account's value for an account. A header value is ASCII on the
 * wire and fetch refuses to send any other, so a name that isn't (北冥,
 * plugins#615) goes percent-encoded, which Magpie reads back decoded. An
 * ASCII name goes as it is, as every Magpie before that reads it.
 */
export function accountHeader(account: string) {
  return /^[\x20-\x7e]*$/.test(account) ? account : encodeURIComponent(account);
}
export class Gateway {
  constructor(
    readonly url: string,
    private key = '',
  ) {}
  headers(extra: Record<string, string> = {}) {
    return {
      'content-type': 'application/json',
      ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
      ...extra,
    };
  }
  redact(message: unknown) {
    return String(message instanceof Error ? message.message : message)
      .replaceAll(this.key || '\u0000', '[redacted]')
      .slice(0, 500);
  }
  async catalog(): Promise<{ models: Model[]; accounts: Account[] }> {
    const res = await fetch(`${this.url}/v1/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Magpie model catalog returned HTTP ${res.status}.`);
    }
    const data = JSON.parse(await boundedText(res, 4 * 1024 * 1024)) as {
      data?: Record<string, any>[];
    };
    const models = (data.data || [])
      .filter((m) => {
        if (typeof m.id !== 'string' || !m.id.includes('/') || m.id.startsWith('group/'))
          return false;
        if (/^(embedding|image|audio)(_|$)/.test(m.type || '')) return false;
        if (Array.isArray(m.modalities?.output) && !m.modalities.output.includes('text'))
          return false;
        const native = Array.isArray(m.native_endpoints) ? m.native_endpoints : [];
        return (
          !native.length ||
          !native.every(
            (endpoint: unknown) =>
              typeof endpoint === 'string' && /\/(images|embeddings|audio)\b/.test(endpoint),
          )
        );
      })
      .map((m) => ({
        id: m.id,
        name: String(m.display_name || m.name || m.id),
        provider: m.id.split('/')[0],
        efforts: (Array.isArray(m.reasoning_levels)
          ? m.reasoning_levels
          : (m.supported_reasoning_levels || []).map((v: any) => v.effort)
        ).filter((v: unknown) => typeof v === 'string'),
        nativeEndpoints: Array.isArray(m.native_endpoints)
          ? m.native_endpoints.filter((v: unknown) => typeof v === 'string')
          : [],
      }));
    // kept=1 reads Magpie's cached report; opening this page must never probe
    // upstream accounts just to populate a selector.
    const accounts: Account[] = [];
    try {
      const quotas = await fetch(`${this.url}/v1/magpie/quotas?kept=1`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(2500),
        redirect: 'error',
      });
      if (quotas.ok) {
        const report = JSON.parse(await boundedText(quotas, 1024 * 1024));
        for (const item of report.data || [])
          if (
            typeof item.provider === 'string' &&
            typeof item.user === 'string' &&
            item.user &&
            (!item.kind || item.kind === 'subscription')
          ) {
            if (!accounts.some((a) => a.provider === item.provider && a.id === item.user))
              // name is the provider's (WorkBuddy); alias is the account's own
              accounts.push({
                id: item.user,
                name: String(item.alias || item.user),
                provider: item.provider,
              });
          }
      } else {
        await quotas.body?.cancel();
      }
    } catch {
      /* Account enumeration is optional and may be denied by a scoped key. */
    }
    return { models, accounts };
  }
  async route(provenance: Provenance) {
    try {
      const res = await fetch(
        `${this.url}/v1/magpie/route?session=${encodeURIComponent(provenance.session)}`,
        { headers: this.headers(), signal: AbortSignal.timeout(2500), redirect: 'error' },
      );
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`Route metadata HTTP ${res.status}`);
      }
      provenance.route = JSON.parse(await boundedText(res, 256 * 1024));
      const route = (provenance.route as any)?.route ?? (provenance.route as any);
      if (route?.model && typeof route.model === 'string') {
        provenance.model ??= route.model;
        if (route.model !== provenance.requestedModel) provenance.mismatch = true;
      }
    } catch (e) {
      provenance.routeError = this.redact(e);
    }
  }
}
