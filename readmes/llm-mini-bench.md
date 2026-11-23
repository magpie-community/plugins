# LLM Mini Bench

[中文](README.zh.md)

**A quick, low-cost first look at a language model's capabilities.**

Run 12 focused tasks to compare models, accounts, and Thinking settings, with full answers, tool traces, and estimated costs ready to inspect. Works inside Magpie or standalone.

## What it tests

| Area | Tasks (12 total) |
| --- | --- |
| Knowledge | HTTP conditional caching, IEEE 754 floating-point & SQL three-valued logic |
| Reasoning | Algebraic morphism induction, conservation law & state tracking |
| Code semantics | Async generator `finally` overrides, MVCC savepoints & serializable snapshots |
| Evidence synthesis | Multi-track audit reconciliation, tight-budget document audit |
| Instruction following | Multi-agent DAG scheduling rules, contextual polysemy translation audit |
| Tool use | Adaptive fault diagnosis, delegated authority release |

Built for quick screening rather than a leaderboard. All answers are submitted through a fixed tool schema and graded as data; model code is never executed, and tools run only in local simulators.

## Start with Magpie

Install **one** source from Magpie's Plugins page:

- **npm**: `npm:llm-mini-bench`
- **GitHub**: `github:FibonaAI/llm-mini-bench`

Open **LLM Mini Bench** after installation. Magpie manages the runtime, connects locally, and loads your model catalog automatically.

### Run a comparison

1. Open **Tasks** and pick one or more models and Thinking settings.
2. Pick **1 round** for a quick pass (12 samples) or keep the default **3 rounds** (36 samples) to check consistency.
3. Review the sample count and timeout, then click **Start evaluation**.
4. Open **Analysis** to compare scores against cost, tokens, or elapsed time, and inspect individual answers below.

You can cancel a run or task at any time, or manually retry failed, timed-out, interrupted, or cancelled samples in task history without rerunning completed ones. To target specific local accounts instead of automatic selection, see [account binding](magpie/README.md#local-account-and-multi-key-bindings).

## Read the results

The chart plots the **equal-weight mean of all 12 tasks (0 to 100)** against **estimated USD, total tokens, or elapsed time per round**. Circles are runs and squares are baselines; filled points are latest and hollow points are history.

- **Chart eligibility**: Only complete 12-task runs across all planned rounds appear. API failures never score zero; runs with timeouts or incomplete usage carry an anomaly badge and stay off the Pareto frontier.
- **Fair comparisons**: Compare matching banks and Thinking settings. Account and model labels reflect requested routing, not verified upstream identity.
- **Baselines**: Workspaces start empty. Save complete, gradable runs as baselines to compare against future results.

See [task and grading details](docs/ASSESSMENT_BANK.md) and the [execution guide](docs/BENCH_EXECUTION.md) for chart rules, retries, and CLI usage.

## Run without Magpie

Requires [Bun](https://bun.com/) 1.4.0 or later. Clone the repo and [configure upstream routes](docs/BENCH_EXECUTION.md#configure-two-routes), then start the service:

```sh
git clone https://github.com/FibonaAI/llm-mini-bench.git
cd llm-mini-bench
export MAGPIE_BENCH_TOKEN="$(openssl rand -hex 32)"
bun benchmark/bench.ts serve
```

Open `http://127.0.0.1:3481/#token=YOUR_TOKEN` (using your `MAGPIE_BENCH_TOKEN`). Starting the service sends no model requests.

## Costs and privacy

- **Billing & limits**: Requests may incur charges, and displayed costs are estimates, not bills. New tasks cap only per-sample time (600s default).
- **Privacy**: Prompts and answers go through your selected upstream. Use the top-bar account mask toggle before taking screenshots; local results (including full transcripts) live in `~/.local/share/magpie-mini-bench/`, so review before sharing.
- **Security**: The service binds to loopback only. Do not expose the port or share the token.

More docs: [documentation index](docs/README.md).
