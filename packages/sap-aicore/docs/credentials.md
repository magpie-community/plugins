# Credentials and accounts

The plugin accepts a JSON credential file with `authUrl`, `baseUrl`, `clientId`, `clientSecret`, and `resourceGroup`. Every field must be a nonempty string. Sign in using an absolute file path; store the file outside the repository with mode `0600`.

## Service-key mapping

Create the file manually from an SAP AI Core client-secret service key:

| Service-key field | Credential-file field |
|---|---|
| `url` | `authUrl` |
| `serviceurls.AI_API_URL` | `baseUrl` |
| `clientid` | `clientId` |
| `clientsecret` | `clientSecret` |
| Your chosen existing resource group | `resourceGroup` |

Service-binding JSON and x.509 certificate service keys are not accepted. See SAP's [Create a Service Key](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/create-a-service-key-7323ff4.md).

## Field requirements

- `authUrl`: HTTPS OAuth root on a supported `*.authentication.<region>.hana.ondemand.com` host, without `/oauth/token`.
- `baseUrl`: HTTPS AI Core root on a supported `api.ai.*.hana.ondemand.com` host, without `/v2`.
- URLs must not contain embedded credentials, nondefault ports, extra paths, query strings, or fragments.
- `clientId` must not contain a colon. `clientSecret` must not contain a colon or control characters.
- `resourceGroup` must identify the group used for both discovery and inference.

OAuth uses raw UTF-8 HTTP Basic authentication, form content type, and only `grant_type=client_credentials` in the form body. The plugin does not try alternate authentication encodings. See SAP's [Use a Service Key](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/use-a-service-key-3a97465.md).

## Accounts and credential updates

```sh
magpie plugin login sap-aicore
magpie accounts sap-aicore --json
```

Sign in each credential-file path separately. Reusing the same normalized path replaces its account after successful authorization; different paths represent different accounts, even if their contents describe the same SAP identity.

After credential rotation, update your external file and sign in again. Credentials are loaded once per account generation, not watched continuously. Another running gateway does not observe cross-process reauthorization at the same file path; restart it to load the changed credentials.

To pin a gateway request, set `X-Magpie-Account` to the account's displayed user label from the account listing. Labels can look like `API key …abcd`. JavaScript Fetch headers require byte strings; encode a non-ASCII label with `Buffer.from(label,"utf8").toString("latin1")`. Magpie removes the pin header before SAP dispatch. A pinned request does not select another account in its place.

## Persistence and token lifecycle

Magpie persists only API authentication type, an opaque key derived from the normalized credential-file path, and credential-file metadata. Client secrets and SAP tokens are not copied into the account store.

Tokens stay in account-scoped memory. Renewal is on demand 60 seconds before expiry, or halfway through short token lifetimes. Both monotonic elapsed time and wall-clock deadlines bound reuse: system sleep cannot extend a SAP token's lifetime, and a backward wall-clock adjustment cannot extend its monotonic lifetime. Concurrent callers share acquisition; cancelling one waiter does not cancel acquisition still needed by another. File reads and token exchanges have 15-second bounds.

Only verified OAuth client-credential refusal expires sign-in. Network errors, cancellation, timeouts, malformed responses, and discovery/inference failures do not by themselves expire the account. See [error handling](troubleshooting.md#error-handling).

[Back to setup](../README.md)
