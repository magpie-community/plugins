# @magpie-community/opencode-antigravity-auth

Signs in to **Antigravity** with a Google account (Google AI Pro, Ultra or
the free tier) and calls the models Antigravity serves: Gemini, and the
Claude and GPT-OSS models Google hosts for it. Requests go through Google's
Code Assist API (`daily-cloudcode-pa.googleapis.com`) the way the
Antigravity app sends them. Provider id: `antigravity`. Ported from
magpie's built-in Antigravity account.

## Sign-in

There are two ways to sign in:

- **Sign in with Google (browser)** is Antigravity's own Google sign-in:
  1. The plugin listens on a port of `127.0.0.1` (and `::1`).
  2. It opens Google's consent page with PKCE and Antigravity's client and
     scopes.
  3. Google sends the browser back to `/oauth-callback` with a code, which
     the plugin trades for a refresh token.
- **Import an account** takes either a refresh token or the JSON an
  account manager exports:
  - one account (`{"email", "token": {"refresh_token", "project_id"}}`);
  - a list of accounts, or an `{"accounts": […]}` object;
  - plain lines of refresh tokens, where `#` starts a comment.

  The import signs in the first account it finds. An export of another
  subscription (a `type` other than Antigravity) is refused.

The sign-in is kept as an `oauth` entry:
- `refresh` is `<refresh token>|<project>`.
- `access` is the access token, minted again from the refresh token when
  less than two minutes of it are left.
- `accountId` is the account's email.

When Google refuses the refresh token (`invalid_grant`), magpie asks you to
sign in again.

## Project and plan

Code Assist serves an account under a project:

- `loadCodeAssist` names the project.
- An account without one is set up for its default tier through
  `onboardUser`, as the app does on first sign-in.
- The tiers are read again hourly, so a plan bought or lapsed shows up.
- The plan shown is the paid tier's name, else the current tier's.

## Models

`fetchAvailableModels` lists the account's models:

- The plugin names the account's paid and current tiers, as the app does.
- A tier Google refuses with a 400 is left out for a day.
- The list is kept for 10 minutes.
- Antigravity's internal and retired models are left out.
- The list keeps the order of the app's picker.

A model Antigravity lists at several levels (`gemini-3.7-flash-low`,
`-medium`, `-high`) is offered as one model, with a variant per level.
A request picks the level in this order:

1. magpie's `x-magpie-effort` header;
2. the variant's `thinkingLevel`;
3. the model's default level, which is high.

Asking for a level the model lacks picks the nearest one, and a tie goes
up.

## Requests

The plugin sends every request to `v1internal:streamGenerateContent`,
wrapped in the app's envelope (`{model, project, userAgent: "antigravity",
requestType: "agent", requestId, request}`):

- The User-Agent is `antigravity/hub/<version> <os>/<arch>`. The version is
  read from the app's update manifest every 6 hours.
- The session id is a number made from the conversation's first user
  message, so every turn of one conversation is one session.
- Each reply chunk (`{response: …}`) is unwrapped back into Gemini's own.
- A `generateContent` request gets the stream read whole.

The plugin also changes the request itself, as the built-in did:

- **System prompt:** lines Antigravity turns away (Claude Code's billing
  header, Codex's and Hermes Agent's own prompts) are broken up with a
  zero-width space.
- **Tool calls:**
  - Tool call ids are reduced to `[A-Za-z0-9_-]`.
  - A tool's `{output}` or `{error}` response becomes `{result}`.
- **Schemas:** a tool's schema is flattened to the subset Antigravity takes.
  - Unions keep their own shape.
  - Every array gets `items`.
  - `null` types become `nullable`.
  - `$ref` is resolved.
  - Blank enum values are dropped.
- **Claude:**
  - A tool's images follow every function response.
  - `AUTO` function calling becomes `VALIDATED`.
  - A model without "thinking" in its name loses `thinkingConfig`.
- **Gemini:**
  - `maxOutputTokens` is dropped.
  - Gemini 3 and later think at a `thinkingLevel`. Earlier models lose a
    level a variant put on them.

## Errors

| What Antigravity answers | What the plugin answers |
|---|---|
| 429 "Resource has been exhausted" to a system prompt with a turned-away line | 400 "turned this request away as from an unapproved channel", with what to change (it isn't a quota, so nothing is rested) |
| 429 from a plan's quota, the account having Google AI credits | with the Use AI credits switch on (off by default), the request is asked again once with `enabled_credit_types: ["GOOGLE_ONE_AI"]`, as the app's Use AI Credits does; with it off, the 429 says the switch would spend them |
| 401 | 401, sign-in kept |
| 404 | 404 "model … not found" |
| Refresh refused | 401, `x-magpie-sign-in: expired` |

## Usage

Each model has a window from its `quotaInfo`:

- The window reads 100% used when Antigravity leaves the fraction out.
- It says the model's family (Gemini, Claude, GPT-OSS).
- For a level, it also names the model magpie offers.

Then `retrieveUserQuotaSummary`'s groups give the pools that models share,
each with a 5-hour and a 7-day window (`aside`). Each model is put in the
pool it reads from:

- a group whose versioned name is the model's own (Gemini 4 Argon);
- else the group of its family, when the model reads like one of that
  group's windows;
- else a pool of its own, named for the model, when it reads otherwise.

## Not carried over from the built-in

- Resting an account that Antigravity turned away for 6 hours, and asking
  its other accounts first. The 400 above makes magpie try the next
  account at once.
- Google Search grounding, and image models (drawing).
- `countTokens` answers 404, so magpie estimates the count.
- Sending the system prompt as written: the plugin always breaks up the
  turned-away lines.
- Importing many accounts at once: an import signs in one account.
- Model names from models.dev: a model Antigravity leaves unnamed is named
  for its id.
