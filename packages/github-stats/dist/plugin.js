import { startServer } from "./server.js";
let started;
export default {
    id: "magpie-github-stats",
    server: async (_input, options) => {
        if (!started)
            started = startServer({ port: Number(options?.port) || 3498 }).catch((error) => {
                started = undefined;
                throw error;
            });
        await started;
        return {};
    },
};
