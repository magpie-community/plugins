import { createRunner, listModels } from './lib/runner.mjs';
import { createArenaService } from './lib/service.mjs';

export default {
  id: 'worktree-compare',
  async server(_input, options = {}) {
    const port = Number(options.port ?? 3497);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service port.');
    const runnerOptions = {codexPath: options.codexPath};
    await createArenaService({port, options, listModels: () => listModels(runnerOptions), runCandidate: createRunner(runnerOptions)});
    return {};
  },
};
