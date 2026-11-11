# Magpie DeepSeek Files API

Local Magpie provider that keeps Codex image history out of DeepSeek's 48 MiB
inline request body.

It adds:

- provider `deepseek-files`
- model `deepseek-files/deepseek-flash`
- Responses API only, using `@ai-sdk/openai`

Before each `/responses` request, the plugin:

1. finds `input_image` parts with `data:image/...;base64,...`;
2. hashes each image and uploads it once to `POST https://api.deepseek.com/files`;
3. replaces `image_url` with `file_id`;
4. reuses cached file ids for 30 days.

The original `deepseek` provider is left untouched.

## Install

```sh
magpie plugin add github:harlan-zhang/magpie-deepseek-files
magpie plugin login deepseek-files
magpie provider test deepseek-files
magpie codex deepseek-files/deepseek-flash
magpie sync
```

From a local checkout:

```sh
magpie plugin add /path/to/magpie-deepseek-files
magpie plugin login deepseek-files
magpie provider test deepseek-files
magpie codex deepseek-files/deepseek-flash
magpie sync
```

Use the model `deepseek-files/deepseek-flash` in Codex. Do not select the routing
group `auto/deepseek-flash`; the plugin only applies to its own provider.
`magpie sync` refreshes Codex's model catalog so it no longer warns that the
plugin model is unknown.

## How to check that it is working

- In Magpie, open `插件` and confirm `DeepSeek Files` is on and signed in.
- Or run `magpie plugin list` and look for `deepseek-files (DeepSeek Files, 1 models) signed in`.
- Run `magpie provider test deepseek-files`; a successful Responses check means the provider is reachable.
- Open the plugin page `DeepSeek 图片` in Magpie. It shows the provider, model,
  cache count, local preview count and the last image request's before/after body size.
- On an image request, Magpie's log contains a line like:

```text
deepseek-files: images=13 unique=13 uploaded=0 cacheHits=13 body=3.90 MiB->0.70 MiB
```

## Image management page

The plugin adds a Magpie page named `DeepSeek 图片` (`DeepSeek Files` in English).
Magpie's page sandbox cannot call arbitrary APIs, so the page is a launcher that
navigates to a local service on `127.0.0.1:3486`. The service provides:

- a list of every image recorded in the active DeepSeek account's Files API cache;
- thumbnails and metadata when a local preview has been saved;
- manual upload to DeepSeek Files;
- delete from both DeepSeek Files and the local cache;
- last-request statistics and plugin status.

Deleting an image does not rewrite old Codex history. If an old conversation
needs that image again, the plugin uploads it again from the Base64 still present
in Codex's session.

The page is only available on the computer running Magpie. If the page says the
service is not running, check that the plugin is on, then use `插件 → DeepSeek
Files` to reload it.

## Cache

File ids are cached at:

```text
~/.config/magpie/deepseek-files/cache.json
```

The file is mode `0600` and contains only account/image hashes, `file_id`,
MIME type, byte size, and expiry. It never contains image bytes or API keys.

To force a re-upload, remove that cache file. The next request will upload from
the Base64 image still present in Codex history.

You can override the location with `MAGPIE_DEEPSEEK_FILES_CACHE`.

## Limits and behavior

- Uploaded files expire after 30 days.
- A single upload is limited to 64 MiB.
- The API supports JPEG, PNG, GIF, and WebP.
- Uploads use at most 3 concurrent requests.
- 429 and 5xx uploads are retried once.
- A failed upload fails the model request; it never silently falls back to
  Base64.
- If the transformed request is still 48 MiB or larger, the request fails
  before reaching the model.
- If DeepSeek reports a missing `file_id`, the plugin clears the affected cache
  entries, uploads the images again, and retries once.

## Development

```sh
cd magpie-deepseek-files
npm run check
npm test
```
