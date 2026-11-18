import { startServer } from "./server.js";

// Magpie can overlap short-lived and persistent plugin hosts. Keep trying in
// the surviving host after the previous listener exits.
let starting: Promise<void> | undefined;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

async function listen(port: number): Promise<void> {
  for (;;) {
    try {
      await startServer({ port });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await delay(1000);
    }
  }
}

export default {
  id: "magpie-github-stats",
  server: async (_input: unknown, options?: { port?: number }) => {
    starting ??= listen(Number(options?.port) || 3498).catch((error) => {
      starting = undefined;
      console.error("GitHub Stats service:", error.message);
    });
    return {};
  },
};
