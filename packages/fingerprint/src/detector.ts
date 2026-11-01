import {
  generateChallenges,
  requestSample,
  type Detector,
  type DetectConfig,
  type Sample,
} from '../vendor/lmfpd-sdk/index.js';
import type { Account, Api, Challenge, Job, Model, RunConfig, Target, TargetResult } from './types.js';

const APIS: Api[] = ['responses', 'chat_completions', 'messages'];
const SDK_VERSION = '0.2.0';

type SampleRequest = (
  config: DetectConfig,
  challenge: Challenge,
  signal?: AbortSignal,
) => Promise<Sample>;

export interface RunDeps {
  detector: Detector;
  signal: AbortSignal;
  sampleEndpoint: (result: TargetResult, index: number) => { baseUrl: string; apiKey: string };
  onUpdate: () => void | Promise<void>;
  /** Test hook; production uses the SDK requestSample implementation. */
  sample?: SampleRequest;
  /** Wait for proxy route/provenance collection after a sample response. */
  afterSample?: (result: TargetResult, index: number) => void | Promise<void>;
}

function fail(message: string): never {
  throw new Error(message);
}

function validate(config: RunConfig, models: Model[]): void {
  if (!Array.isArray(config.targets) || config.targets.length < 1 || config.targets.length > 24)
    fail('targets must contain 1 to 24 items');
  const keys = config.targets.map((target) => `${target.model}\0${target.account ?? ''}`);
  if (new Set(keys).size !== keys.length) fail('duplicate targets are not allowed');
  if (
    !Number.isInteger(config.targetParallel) ||
    config.targetParallel < 1 ||
    config.targetParallel > 3
  )
    fail('targetParallel must be 1 to 3');
  if (
    !Number.isInteger(config.sampleParallel) ||
    config.sampleParallel < 1 ||
    config.sampleParallel > 3
  )
    fail('sampleParallel must be 1 to 3');
  if (
    !Number.isFinite(config.deadlineSeconds) ||
    config.deadlineSeconds < 10 ||
    config.deadlineSeconds > 900
  )
    fail('deadlineSeconds must be 10 to 900');
  if (typeof config.effort !== 'string' || config.effort.length > 64)
    fail('effort must be at most 64 characters');
  if (typeof config.strict !== 'boolean') fail('strict must be boolean');
  if (!['default', 'flex', 'fast', 'ultrafast'].includes(config.serviceTier))
    fail('unknown service tier');
  if (!['auto', ...APIS].includes(config.api)) fail('unknown API');
  if (
    config.account !== undefined &&
    (typeof config.account !== 'string' || config.account.length > 256)
  )
    fail('account must be at most 256 characters');
  for (const target of config.targets) {
    if (typeof target.model !== 'string' || !target.model.trim()) fail('target model must be text');
    if (
      target.account !== undefined &&
      (typeof target.account !== 'string' || target.account.length > 256)
    )
      fail('account must be at most 256 characters');
    const model = models.find((candidate) => candidate.id === target.model);
    if (!model) fail(`unknown model: ${target.model}`);
  }
}

function chooseApi(configured: RunConfig['api'], model: Model): Api {
  if (configured !== 'auto') return configured;
  const endpoints = (model.nativeEndpoints ?? []).map((value) => value.toLowerCase());
  for (const api of APIS) {
    if (
      endpoints.some(
        (endpoint) =>
          endpoint === api ||
          endpoint.includes(`/${api === 'chat_completions' ? 'chat/completions' : api}`) ||
          endpoint.includes(api),
      )
    )
      return api;
  }
  return 'chat_completions';
}

function queuedSample(challenge: Challenge): Sample {
  return {
    state: 'queued',
    text: '',
    raw_text: '',
    count: 0,
    expected_count: challenge.expected_count,
    first_byte_ms: null,
    response_model: null,
    response_id: null,
    error: null,
  };
}

/**
 * A target as the job keeps it: the account named (its own, else the
 * config's) as Magpie names it, by the catalog's id when the name matches
 * one of the model's provider's accounts by id or, alone, by its name, and
 * that account's name beside it.
 */
function pinned(target: Target, fallback: string | undefined, model: Model, accounts: Account[]) {
  const named = target.account || fallback;
  if (!named) return { model: target.model };
  const mine = accounts.filter((a) => a.provider === model.provider);
  const byName = mine.filter((a) => a.name === named);
  const hit =
    mine.find((a) => a.id.toLowerCase() === named.toLowerCase()) ??
    (byName.length === 1 ? byName[0] : undefined);
  return {
    model: target.model,
    account: hit?.id ?? named,
    ...(hit ? { accountName: hit.name } : {}),
  };
}

export function createJob(
  config: RunConfig,
  models: Model[],
  builtAt: string,
  accounts: Account[] = [],
): Job {
  validate(config, models);
  const targets: Target[] = config.targets.map((target) =>
    pinned(
      target,
      config.account,
      models.find((candidate) => candidate.id === target.model)!,
      accounts,
    ),
  );
  const keys = targets.map((target) => `${target.model}\0${target.account ?? ''}`);
  if (new Set(keys).size !== keys.length) fail('duplicate targets are not allowed');
  // the account every target is pinned to, for a reader of the job file
  // that asks which seat it measured (plugins#615)
  const one =
    targets[0].account !== undefined && targets.every((t) => t.account === targets[0].account)
      ? targets[0]
      : undefined;
  const normalizedConfig: RunConfig = {
    targets,
    ...(one
      ? { account: one.account, ...(one.accountName ? { accountName: one.accountName } : {}) }
      : {}),
    api: config.api,
    effort: config.effort,
    serviceTier: config.serviceTier,
    strict: config.strict,
    targetParallel: config.targetParallel,
    sampleParallel: config.sampleParallel,
    deadlineSeconds: config.deadlineSeconds,
  };
  const challenges = generateChallenges(3);
  const results: TargetResult[] = normalizedConfig.targets.map((target, index) => {
    const model = models.find((candidate) => candidate.id === target.model)!;
    return {
      id: `target-${index + 1}-${crypto.randomUUID()}`,
      target,
      api: chooseApi(config.api, model),
      state: 'queued',
      samples: challenges.map(queuedSample),
      provenance: challenges.map(() => ({ session: '', requestedModel: target.model })),
      analysis: null,
      error: null,
    };
  });
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    state: 'queued',
    config: normalizedConfig,
    challenges,
    results,
    bank: { builtAt, sdk: SDK_VERSION },
  };
}

function cancelledSample(
  challenge: Challenge,
  message = 'Cancelled. This round was not scored.',
): Sample {
  return { ...queuedSample(challenge), state: 'cancelled', error: message };
}

async function update(deps: RunDeps): Promise<void> {
  await deps.onUpdate();
}

export async function runJob(job: Job, deps: RunDeps): Promise<void> {
  job.state = 'running';
  await update(deps);
  const sampleFn = deps.sample ?? ((config, challenge) => requestSample(config, challenge));
  let cursor = 0;
  const targetWorker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= job.results.length) return;
      const result = job.results[index];
      result.state = 'running';
      await update(deps);
      let sampleCursor = 0;
      const sampleWorker = async () => {
        while (true) {
          const sampleIndex = sampleCursor++;
          if (sampleIndex >= job.challenges.length) return;
          const challenge = job.challenges[sampleIndex];
          if (deps.signal.aborted) {
            result.samples[sampleIndex] = cancelledSample(challenge);
            await update(deps);
            continue;
          }
          try {
            // Credentials and the proxy route are scoped to each target/challenge.
            const endpoint = deps.sampleEndpoint(result, sampleIndex);
            const baseConfig: DetectConfig = {
              baseUrl: endpoint.baseUrl,
              apiKey: endpoint.apiKey,
              model: result.target.model,
              api: result.api,
              effort: job.config.effort,
              serviceTier: job.config.serviceTier,
              strict: job.config.strict,
              count: 3,
              parallel: 1,
              stream: true,
            };
            result.samples[sampleIndex] = { ...result.samples[sampleIndex], state: 'waiting' };
            await update(deps);
            const sample = await sampleFn(baseConfig, challenge, deps.signal);
            result.samples[sampleIndex] = sample;
            if (deps.afterSample) await deps.afterSample(result, sampleIndex);
            await update(deps);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.samples[sampleIndex] = {
              ...result.samples[sampleIndex],
              state: deps.signal.aborted ? 'cancelled' : 'failed',
              error: message,
            };
            result.error ??= message;
            await update(deps);
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(job.config.sampleParallel, job.challenges.length) },
          sampleWorker,
        ),
      );
      const cancelled = result.samples.some((sample) => sample.state === 'cancelled');
      const aborted = deps.signal.aborted;
      const mismatch = result.provenance.some((item) => item.mismatch);
      const scoreable = result.samples.filter(
        (sample) =>
          sample.state === 'complete' || (!job.config.strict && sample.state === 'truncated'),
      );
      const strictInvalid =
        job.config.strict &&
        (result.samples.length !== 3 ||
          result.samples.some((sample) => sample.state !== 'complete'));
      if (!aborted && !cancelled && !mismatch && !strictInvalid && scoreable.length > 0) {
        result.analysis = deps.detector.analyze(
          scoreable.map((sample) => ({ text: sample.text, expected_count: sample.expected_count })),
          { strict: job.config.strict },
        );
      } else if (aborted || cancelled) {
        result.error =
          deps.signal.reason instanceof Error
            ? deps.signal.reason.message
            : 'Cancelled. This round was not scored.';
      } else if (mismatch) {
        result.error =
          'Provider/model response does not match the requested target; result was not scored.';
      } else if (strictInvalid) {
        result.error = 'Strict mode requires three complete, untruncated samples.';
      }
      result.state =
        aborted || cancelled
          ? 'cancelled'
          : mismatch || result.samples.some((sample) => sample.state === 'failed') || strictInvalid
            ? 'failed'
            : 'completed';
      await update(deps);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(job.config.targetParallel, job.results.length) }, targetWorker),
  );
  job.finishedAt = new Date().toISOString();
  if (deps.signal.aborted || job.results.some((result) => result.state === 'cancelled')) {
    job.state = 'cancelled';
    if (deps.signal.aborted)
      job.error = deps.signal.reason instanceof Error ? deps.signal.reason.message : 'Cancelled';
  } else if (job.results.some((result) => result.state === 'failed')) job.state = 'failed';
  else job.state = 'completed';
  await update(deps);
}
