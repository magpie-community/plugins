# HarnessWeight

A magpie page for comparing the agents behind your gateway: requests, input and output tokens, cache reads, failures, latency and estimated tool-definition size. The dashboard groups requests by agent, not model. A read-only gateway hook records tool counts and JSON sizes after each response and observes in-flight request counts in memory.

[Project, screenshots and demo](https://github.com/webkubor/harnessweight)

## Install

```sh
magpie plugin add @magpie-community/page-harnessweight
```

Open **HarnessWeight** in magpie. Usage history is read from magpie's existing local ledger; tool-size samples accumulate after installation. The service listens on loopback, port **3496** by default. Change the `port` plugin option if that port is in use.

## Reading the dashboard

- **Input** includes fresh input, cache reads and cache writes. Cache rates and input tokens are usage measurements, not a currency amount; pricing depends on the model and provider.
- **Tool-definition tokens** are an estimate: the serialized JSON byte count divided by 3.5. They are not measured with the model's tokenizer. Tool definitions may be cached; their size is not a direct bill.
- **In flight** is derived from hook start and response callbacks. Missing callbacks may leave counts visible until expiry (15 minutes). It does not reflect activity outside the gateway.
- **Session duration** is the span between the first and last recorded request for a session in the chosen period, including idle time. Sessions longer than six hours are excluded from duration aggregates; a missing session ID cannot be measured.
- Protocols are inferred from recorded endpoints for the selected period. They are not a list of the agent's current configuration.

## Data and security

The sandboxed page asks for no bridge reads; it navigates to the plugin's local service. The service reads magpie's local usage ledger and queries its local gateway for agent display names and icon keys. The hook writes request metadata, tool names, counts and sizes locally. It does not store prompts, tool arguments or credentials and does not modify the request.

The local service validates Host and Origin and requires a per-process random token on data APIs. No telemetry is sent by this plugin.

Configuration options include `port`, `usageLog`, `dataDir`, `gatewayUrl` and `agents`; see the [project documentation](https://github.com/webkubor/harnessweight) for details.

## Development

```sh
bun test
```

Agent icons are from the community page-agent-office icon collection and LobeHub; see [app/icons/NOTICE](app/icons/NOTICE). Brand marks belong to their respective owners.

MIT © webkubor
