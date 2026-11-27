import { startServer } from "./server.js";
// Magpie can overlap short-lived and persistent plugin hosts. Keep trying in
// the surviving host after the previous listener exits.
let starting;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
async function listen(port) {
    for (;;) {
        try {
            await startServer({ port });
            return;
        }
        catch (error) {
            if (error.code !== "EADDRINUSE")
                throw error;
            await delay(1000);
        }
    }
}
export default {
    id: "magpie-github-stats",
    server: async (_input, options) => {
        starting ??= listen(Number(options?.port) || 3498).catch((error) => {
            starting = undefined;
            console.error("GitHub Stats service:", error.message);
        });
        return {};
    },
};
