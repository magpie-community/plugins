import { fileURLToPath } from 'node:url';
import { normalizeOpenAICallIDs } from './call-ids.js';
import { buildInventory, hasUnpricedModel, parsePresentation } from './catalog.js';
import { type CatalogCache, loadCatalogCache } from './catalog-cache.js';
import { loadFastModelIDs } from './fast-models.js';
import { fetchModels, resolveConnection } from './gateway.js';
import { registerImageSkill, registerImageTools } from './image.js';
import { createTrackedSetup, type Plugin2, reloadProviderCatalog } from './opencode.js';

const plugin: Plugin2 = {
  id: 'magpie.providers',
  setup: (ctx) => setupPlugin(ctx),
};

export const setupPlugin: Plugin2['setup'] = async (ctx) => {
  if (!ctx.provider) throw new Error('Magpie 插件需要 OpenCode V2 provider.transform。');
  // Parsed once. The first catalog and the 30s refresh close over the same presentation.
  const presentation = parsePresentation(ctx.options);
  const connection = await resolveConnection(ctx.options);
  const { baseURL, token, agentID } = connection;
  const apiURL = new URL(baseURL);
  await connection.ensure();
  let catalog: CatalogCache = await loadCatalogCache();
  let inventory = buildInventory(await fetchModels(baseURL, token, agentID), baseURL, {
    apiKey: token,
    agentID,
    catalog: catalog.data,
    fastModelIDs: connection.remote ? undefined : await loadFastModelIDs(),
    presentation,
  });
  const { track, cleanup } = createTrackedSetup();
  let disposed = false;
  let refreshing = false;
  try {
    await track(
      ctx.provider.transform((editor) => {
        inventory.forEach((entry) => {
          editor.add(entry);
        });
      }),
    );
    for (const name of ['context', 'compaction', 'generate', 'title'] as const) {
      await track(ctx.session.hook(name, normalizeOpenAICallIDs, { providerID: 'openai' }));
    }
    if (ctx.tool && ctx.skill) {
      await track(ctx.tool.transform((editor) => registerImageTools(editor, connection)));
      await track(
        ctx.skill.transform((editor) =>
          registerImageSkill(editor, fileURLToPath(new URL('./', import.meta.url))),
        ),
      );
    }
    await track(
      ctx.session.hook('http.request', async (event) => {
        const url = new URL(event.request.url);
        if (
          url.origin !== apiURL.origin ||
          !url.pathname.startsWith(`${apiURL.pathname.replace(/\/$/, '')}/`)
        )
          return;
        await connection.ensure();
        event.request.headers.set('X-Magpie-Session', event.sessionID);
        event.request.headers.set('X-Magpie-Agent', agentID ?? 'opencode');
        event.request.headers.set('User-Agent', `${agentID ?? 'opencode'}/opencode-magpie-provider`);
      }),
    );
    await reloadProviderCatalog(ctx);
  } catch (error) {
    await cleanup();
    throw error;
  }
  // Magpie reprices a model it cannot cost by refetching models.dev; this does
  // the same, so a model it lists but prices nowhere gets one on the next refresh
  // rather than waiting out the day-long catalog age.
  const apply = async (next: typeof inventory): Promise<void> => {
    if (disposed || JSON.stringify(next) === JSON.stringify(inventory)) return;
    const previous = inventory;
    inventory = next;
    try {
      await reloadProviderCatalog(ctx);
    } catch (error) {
      inventory = previous;
      throw error;
    }
  };
  const refresh = async (): Promise<void> => {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      await connection.ensure();
      const rows = await fetchModels(baseURL, token, agentID);
      catalog = await loadCatalogCache(hasUnpricedModel(inventory));
      const next = buildInventory(rows, baseURL, {
        apiKey: token,
        agentID,
        catalog: catalog.data,
        fastModelIDs: connection.remote ? undefined : await loadFastModelIDs(),
        presentation,
      });
      await apply(next);
    } catch (error) {
      console.warn(
        '[magpie] 模型刷新失败，保留上次目录：',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => {
    void refresh();
  }, 30_000);
  timer.unref();
  return async () => {
    disposed = true;
    clearInterval(timer);
    await cleanup();
  };
};

export default plugin;
