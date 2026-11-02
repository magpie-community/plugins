// Adapted from opencode-copilot-auth 0.0.12 (MIT, copyright SST).
// Keep the upstream request signing and initiator detection; add magpie usage.
import { HEADERS, normalizeDomain, getUrls } from "./endpoints.mjs";
import { readUsage } from "./usage.mjs";

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function CopilotAuthPlugin({ client }) {
  const CLIENT_ID = "Iv1.b507a08c87ecfe98";
  const RESPONSES_API_ALTERNATE_INPUT_TYPES = [
    "file_search_call",
    "computer_call",
    "computer_call_output",
    "web_search_call",
    "function_call",
    "function_call_output",
    "image_generation_call",
    "code_interpreter_call",
    "local_shell_call",
    "local_shell_call_output",
    "mcp_list_tools",
    "mcp_approval_request",
    "mcp_approval_response",
    "mcp_call",
    "reasoning",
  ];

  return {
    auth: {
      provider: "github-copilot",
      usage: readUsage,
      loader: async (getAuth, provider) => {
        let info = await getAuth();
        if (!info || info.type !== "oauth") return {};

        if (provider && provider.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }
        }

        // Set baseURL based on deployment type
        const enterpriseUrl = info.enterpriseUrl;
        const baseURL = enterpriseUrl
          ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}`
          : "https://api.githubcopilot.com";

        return {
          baseURL,
          apiKey: "",
          async fetch(input, init) {
            const info = await getAuth();
            if (info?.type !== "oauth") return fetch(input, init);
            if (!info.access || info.expires < Date.now()) {
              const domain = info.enterpriseUrl
                ? normalizeDomain(info.enterpriseUrl)
                : "github.com";
              const urls = getUrls(domain);

              const response = await fetch(urls.COPILOT_API_KEY_URL, {
                headers: {
                  Accept: "application/json",
                  Authorization: `Bearer ${info.refresh}`,
                  ...HEADERS,
                },
              });

              if (!response.ok) {
                // GitHub's 401 here is the OAuth token itself turned away:
                // magpie marks the account to sign in again. Anything
                // else (no seat, a rate limit, an outage) leaves it as
                // it is.
                throw Object.assign(
                  new Error(`Token refresh failed: ${response.status}`),
                  response.status === 401 ? { signIn: "expired" } : {},
                );
              }

              const tokenData = await response.json();

              // Use the hook's provider id for both deployments. The host
              // scopes this write to the selected account (including #slots).
              const saveProviderID = "github-copilot";
              await client.auth.set({
                path: {
                  id: saveProviderID,
                },
                body: {
                  type: "oauth",
                  refresh: info.refresh,
                  access: tokenData.token,
                  expires: tokenData.expires_at * 1000 - 5 * 60 * 1000,
                  ...(info.enterpriseUrl && {
                    enterpriseUrl: info.enterpriseUrl,
                  }),
                },
              });
              info.access = tokenData.token;
            }
            let isAgentCall = false;
            let isVisionRequest = false;
            try {
              const body =
                typeof init?.body === "string"
                  ? JSON.parse(init.body)
                  : init?.body;
              if (body?.messages) {
                if (body.messages.length > 0) {
                  const lastMessage = body.messages[body.messages.length - 1];
                  isAgentCall = lastMessage.role && ["tool", "assistant"].includes(lastMessage.role);
                }
                isVisionRequest = body.messages.some(
                  (msg) =>
                    Array.isArray(msg.content) &&
                    msg.content.some((part) => part.type === "image_url"),
                );
              }

              if (body?.input) {
                const lastInput = body.input[body.input.length - 1];

                const isAssistant = lastInput?.role === "assistant";
                const hasAgentType = lastInput?.type
                  ? RESPONSES_API_ALTERNATE_INPUT_TYPES.includes(lastInput.type)
                  : false;
                isAgentCall = isAssistant || hasAgentType;

                isVisionRequest =
                  Array.isArray(lastInput?.content) &&
                  lastInput.content.some((part) => part.type === "input_image");
              }
            } catch {}
            const headers = new Headers(init?.headers);
            headers.delete("x-api-key");
            headers.delete("authorization");
            for (const [key, value] of Object.entries(HEADERS)) {
              headers.set(key, value);
            }
            headers.set("Authorization", `Bearer ${info.access}`);
            headers.set("Openai-Intent", "conversation-edits");
            headers.set("X-Initiator", isAgentCall ? "agent" : "user");
            if (isVisionRequest) {
              headers.set("Copilot-Vision-Request", "true");
            }

            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs) => inputs.deploymentType === "enterprise",
              validate: (value) => {
                if (!value) return "URL or domain is required";
                try {
                  const url = value.includes("://")
                    ? new URL(value)
                    : new URL(`https://${value}`);
                  if (!url.hostname)
                    return "Please enter a valid URL or domain";
                  normalizeDomain(value);
                  return undefined;
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)";
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com";

            let domain = "github.com";
            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl;
              domain = normalizeDomain(enterpriseUrl);
            }

            const urls = getUrls(domain);

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": HEADERS["User-Agent"],
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: "read:user",
              }),
            });

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization");
            }

            const deviceData = await deviceResponse.json();

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto",
              callback: async () => {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": HEADERS["User-Agent"],
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type:
                        "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  });

                  if (!response.ok) return { type: "failed" };

                  const data = await response.json();

                  if (data.access_token) {
                    const result = {
                      type: "success",
                      refresh: data.access_token,
                      access: "",
                      expires: 0,
                    };

                    if (deploymentType === "enterprise") {
                      result.enterpriseUrl = domain;
                    }

                    return result;
                  }

                  if (data.error === "authorization_pending") {
                    await new Promise((resolve) =>
                      setTimeout(resolve, deviceData.interval * 1000),
                    );
                    continue;
                  }

                  if (data.error) return { type: "failed" };

                  await new Promise((resolve) =>
                    setTimeout(resolve, deviceData.interval * 1000),
                  );
                  continue;
                }
              },
            };
          },
        },
      ],
    },
  };
}
