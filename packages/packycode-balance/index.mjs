const PROVIDER = "packycode-balance"
const QUOTA_PER_USD = 500_000
const REQUEST_TIMEOUT_MS = 10_000

const CONSOLE_HOSTS = Object.freeze({
  "www.packyapi.ai": "https://www.packyapi.ai",
  "www.packyapi.com": "https://www.packyapi.com",
})

function credentials(auth) {
  const host = auth?.metadata?.consoleHost
  const userId = auth?.metadata?.userId
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.trim()) return null
  if (typeof userId !== "string" || !/^\d+$/.test(userId)) return null
  if (typeof host !== "string" || !Object.hasOwn(CONSOLE_HOSTS, host)) return null
  return { accessToken: auth.key.trim(), userId, host }
}

async function accountSelf({ accessToken, userId, host }) {
  const base = CONSOLE_HOSTS[host]
  if (!base) return { ok: false, kind: "invalid-host" }

  let response
  try {
    response = await fetch(`${base}/api/user/self`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "New-Api-User": userId,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, kind: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network" }
  }

  if (!response.ok) return { ok: false, kind: "http", status: response.status }

  let body
  try {
    body = await response.json()
  } catch {
    return { ok: false, kind: "invalid-response" }
  }
  if (
    body?.success !== true ||
    !body.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data)
  ) {
    return { ok: false, kind: "invalid-response" }
  }

  const quota = body.data.quota
  if (!Number.isSafeInteger(quota)) return { ok: false, kind: "invalid-quota" }
  if (quota < 0) return { ok: false, kind: "negative-quota" }
  return { ok: true, quota }
}

function failureMessage(result) {
  if (result.kind === "http" && result.status === 401) {
    return "PackyAPI rejected the credentials (HTTP 401). Check the selected host, system access token, and matching numeric user ID, then sign in again."
  }
  if (result.kind === "http" && result.status === 403) {
    return "PackyAPI denied account-balance access (HTTP 403). Check that the selected host and user ID match the account, and that the system token permits account queries."
  }
  if (result.kind === "http") return `PackyAPI account endpoint returned HTTP ${result.status}.`
  if (result.kind === "timeout") return "PackyAPI account-balance request timed out."
  if (result.kind === "network") return "PackyAPI account-balance request failed. Check the network and selected PackyAPI host."
  if (result.kind === "negative-quota") return "PackyAPI returned a negative account quota; the balance is not shown."
  if (result.kind === "invalid-quota") return "PackyAPI returned an invalid account quota; the balance is not shown."
  if (result.kind === "invalid-response") return "PackyAPI returned an unexpected account response."
  return "PackyAPI sign-in is incomplete. Sign in again with a system access token and user ID."
}

function createPlugin() {
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {
        name: "PackyAPI account balance",
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "PackyAPI system access token",
          keyless: true,
          prompts: [
            {
              type: "select",
              key: "consoleHost",
              message: "PackyAPI account host (select the domain, not a /console path)",
              options: [
                { label: "www.packyapi.ai (recommended by the current docs)", value: "www.packyapi.ai" },
                { label: "www.packyapi.com (for accounts on this domain)", value: "www.packyapi.com" },
              ],
            },
            {
              type: "password",
              key: "systemAccessToken",
              message: "System access token (Personal Settings → Security Settings; not a model API key)",
              validate: (value) => (String(value ?? "").trim() ? undefined : "A system access token is required."),
            },
            {
              type: "text",
              key: "userId",
              message: "Numeric User ID at the top of Personal Settings (not email)",
              validate: (value) => (/^\d+$/.test(String(value ?? "").trim()) ? undefined : "Enter the numeric user ID shown in PackyAPI personal settings."),
            },
          ],
          async authorize(inputs = {}) {
            const accessToken = String(inputs.systemAccessToken ?? "").trim()
            const userId = String(inputs.userId ?? "").trim()
            const host = inputs.consoleHost
            if (!accessToken) return { type: "failed", error: "A PackyAPI system access token is required." }
            if (!/^\d+$/.test(userId)) return { type: "failed", error: "Enter the numeric PackyAPI user ID." }
            if (typeof host !== "string" || !Object.hasOwn(CONSOLE_HOSTS, host)) {
              return { type: "failed", error: "Choose one of the supported PackyAPI console hosts." }
            }

            const result = await accountSelf({ accessToken, userId, host })
            if (!result.ok) return { type: "failed", error: failureMessage(result) }

            // Magpie also stores prompt answers in metadata. Keep the token
            // only in auth.key, not a second time in metadata.
            return {
              type: "success",
              key: accessToken,
              metadata: { systemAccessToken: undefined, userId, consoleHost: host },
            }
          },
        },
      ],
      async loader() {
        return {}
      },
      async usage(getAuth) {
        const auth = await getAuth()
        const cred = credentials(auth)
        if (!cred) return { error: failureMessage({ kind: "incomplete" }) }

        const result = await accountSelf(cred)
        if (!result.ok) {
          return {
            ...(result.kind === "http" && result.status === 401 ? { signIn: "expired" } : {}),
            error: failureMessage(result),
          }
        }

        return {
          windows: [
            {
              name: "Account balance",
              balance: result.quota / QUOTA_PER_USD,
              unit: "USD",
            },
          ],
        }
      },
    },
  }
}

export async function PackyCodeBalancePlugin() {
  return createPlugin()
}
