#!/usr/bin/env node

import { AtomCodePlugin } from "../index.mjs";
import {
  defaultAuthFilePath,
  readAuthFile,
} from "../auth-file.mjs";
import { redactText } from "../internal.mjs";

const MAX_REQUESTS = 9;

if (process.env.ATOMCODE_LIVE !== "1") {
  console.error("Refusing live calls. Set ATOMCODE_LIVE=1 and run again.");
  process.exit(2);
}

const realFetch = globalThis.fetch;
let requestCount = 0;
globalThis.fetch = (...args) => {
  requestCount += 1;
  if (requestCount > MAX_REQUESTS) {
    throw new Error(`live smoke exceeded its ${MAX_REQUESTS}-request budget`);
  }
  return realFetch(...args);
};

const client = {
  auth: {
    set: async () => {},
  },
  app: {
    log: () => {},
  },
};

try {
  const auth = await readAuthFile(defaultAuthFilePath());
  const getAuth = async () => auth;
  const plugin = await AtomCodePlugin(
    { client },
    {
      autoClaim: false,
      autoVersion: false,
      locale: "en",
    },
  );

  const models = await plugin.provider.models({}, { auth });
  const modelEntries = Object.values(models).filter(
    (model) => model && typeof model === "object" && model.api?.id,
  );
  if (!modelEntries.length) throw new Error("live model catalog was empty");

  const usage = await plugin.auth.usage(getAuth);
  if (usage.signIn === "expired") throw new Error("live sign-in expired");

  const { fetch: patched } = await plugin.auth.loader(getAuth);
  const chatResults = [];
  for (const model of modelEntries.slice(0, 3)) {
    const response = await patched("https://llm-api.atomgit.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.api.id,
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`live chat returned HTTP ${response.status}`);
    const stream = await response.text();
    chatResults.push({
      model: model.name,
      sawUsage: /"usage"\s*:/.test(stream),
      sawDone: /\[DONE\]/.test(stream),
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        requests: requestCount,
        models: modelEntries.map((model) => model.name),
        quotaWindows: usage.windows?.length ?? 0,
        chat: chatResults,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`live smoke failed: ${redactText(error?.message ?? error)}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
}
