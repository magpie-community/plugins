import { findDim, readDim } from "./src/cli.mjs";
import { quotaFrom } from "./src/quota.mjs";

const ID = "dimagent-usage";

export default async () => ({
  config: async (config) => {
    config.provider ??= {};
    config.provider[ID] ??= { name: "DimAgent", models: {} };
  },
  provider: { id: ID, models: async () => ({}) },
  auth: {
    provider: ID,
    single: true,
    methods: [{
      type: "api", keyless: true, label: "读取本机 DimAgent 额度",
      async ask(inputs = {}) {
        if ("dimPath" in inputs) return null;
        try {
          await findDim();
          return null;
        } catch {
          return {
            type: "text", key: "dimPath", message: "未找到 dim，请填写它的绝对路径",
            placeholder: "/path/to/dim",
          };
        }
      },
      async authorize(inputs) {
        try {
          const dimPath = await findDim(inputs?.dimPath ?? "");
          const q = quotaFrom(await readDim(dimPath));
          return {
            type: "success", key: "local-cli-only",
            metadata: { dimPath, accountId: q.user, email: q.user },
          };
        } catch (e) { return { type: "failed", error: e.message }; }
      },
    }],
    async usage(getAuth) {
      try {
        const auth = await getAuth();
        const binding = auth?.metadata;
        if (!binding?.dimPath || !binding.accountId) throw new Error("请先连接本机 DimAgent 额度。");
        const q = quotaFrom(await readDim(binding.dimPath));
        if (q.user !== binding.accountId) throw new Error("DimAgent 的当前账户已改变，请重新连接额度插件。");
        return q;
      } catch (e) { return { error: e.message, windows: [] }; }
    },
    async loader() {
      return {
        async fetch() {
          return Response.json({ error: { message: "DimAgent 额度插件不提供模型调用。" } }, { status: 405 });
        },
      };
    },
  },
});
