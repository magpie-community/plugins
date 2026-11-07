import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayConnection } from './gateway.js';
import type { SkillEditor, ToolEditor } from './opencode.js';

/** The image models Magpie draws with: only a caller that asks (X-Magpie-Drawers) is told of them. */
export const listImageModels = async (
  connection: GatewayConnection,
  signal?: AbortSignal,
): Promise<{ id: string; name: string }[]> => {
  await connection.ensure();
  const response = await fetch(`${connection.baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${connection.token}`,
      'X-Magpie-Drawers': '1',
      'X-Magpie-Agent': connection.agentID ?? 'opencode',
      'User-Agent': `${connection.agentID ?? 'opencode'}/opencode-magpie-provider`,
    },
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new Error(`Magpie 模型列表失败：HTTP ${response.status}`);
  const body = (await response.json().catch(() => undefined)) as
    | { data?: { id?: unknown; kind?: unknown; display_name?: unknown }[] }
    | undefined;
  const rows = (body?.data ?? []).flatMap((row) =>
    row.kind === 'image' && typeof row.id === 'string'
      ? [{ id: row.id, name: typeof row.display_name === 'string' ? row.display_name : row.id }]
      : [],
  );
  // Another Magpie's copy of a model this one lists too adds nothing to choose from.
  const ids = new Set(rows.map((row) => row.id));
  return rows.filter((row) => !(row.id.startsWith('remote-magpie/') && ids.has(row.id.slice(14))));
};

const extension = (bytes: Buffer): string =>
  bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    ? '.png'
    : bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      ? '.jpg'
      : bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
          bytes.subarray(8, 12).toString('latin1') === 'WEBP'
        ? '.webp'
        : bytes.subarray(0, 3).toString('latin1') === 'GIF'
          ? '.gif'
          : '.png';

export type DrawInput = { prompt: string; model?: string; size?: string; quality?: string };

/** Draws one image through Magpie's /images/generations and keeps it in the temp folder. */
export const drawImage = async (
  connection: GatewayConnection,
  input: DrawInput,
  signal?: AbortSignal,
): Promise<{ path: string; model?: string }> => {
  await connection.ensure();
  const response = await fetch(`${connection.baseURL}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.token}`,
      'Content-Type': 'application/json',
      'X-Magpie-Agent': connection.agentID ?? 'opencode',
      'User-Agent': `${connection.agentID ?? 'opencode'}/opencode-magpie-provider`,
    },
    // Without a model Magpie draws with the one chosen in its Settings.
    body: JSON.stringify({ ...input, n: 1, response_format: 'b64_json' }),
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(signal ? [signal] : [])]),
  });
  const body = (await response.json().catch(() => undefined)) as
    | {
        model?: string;
        data?: { b64_json?: string; url?: string }[];
        error?: { message?: string };
      }
    | undefined;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Magpie 生图失败：HTTP ${response.status}`);
  }
  const image = body?.data?.[0];
  let bytes: Buffer | undefined;
  if (image?.b64_json) bytes = Buffer.from(image.b64_json, 'base64');
  else if (image?.url) {
    const download = await fetch(image.url, { redirect: 'error', signal });
    if (download.ok) bytes = Buffer.from(await download.arrayBuffer());
  }
  if (!bytes?.length) throw new Error('Magpie 没有返回图片。');
  const folder = join(tmpdir(), 'magpie-images');
  await mkdir(folder, { recursive: true });
  const path = join(folder, `image-${Date.now()}${extension(bytes)}`);
  await writeFile(path, bytes);
  return { path, model: body?.model ?? input.model };
};

/** `![]()` for the saved file; a path with spaces or brackets goes in angle brackets so it still parses. */
export const markdownImage = (path: string): string =>
  `![image](${/[\s()[\]]/.test(path) ? `<${path}>` : path})`;

const NAMESPACE = 'magpie';

/** One call to the model's code mode: found with `search`, never listed in its context. */
export const registerImageTools = (editor: ToolEditor, connection: GatewayConnection): void => {
  editor.namespace({ name: NAMESPACE, description: 'Magpie image generation.' });
  const options = { namespace: NAMESPACE, codemode: true } as const;
  editor.add({
    name: 'image_list',
    description: 'List the image models Magpie can draw with, one provider/model id per line.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    options,
    execute: async (_input, context) => {
      const models = await listImageModels(connection, context.signal);
      return {
        content: models.length
          ? models.map((model) => `${model.id}  ${model.name}`).join('\n')
          : 'No image model is available in Magpie.',
      };
    },
  });
  editor.add({
    name: 'image_gen',
    description:
      'Draw one image through Magpie and save it. Returns it as a Markdown image. Load skill magpie-image-generate first.',
    input: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1 },
        model: {
          type: 'string',
          description: 'provider/model from image_list; omit for Magpie’s default.',
        },
        size: { type: 'string', description: '16:9, 9:16, 1:1 or WIDTHxHEIGHT.' },
        quality: { type: 'string', description: 'low, medium, high or auto.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    options,
    execute: async (input, context) => {
      const { path, model } = await drawImage(connection, input as DrawInput, context.signal);
      return { content: `${markdownImage(path)}${model ? `\n(${model})` : ''}` };
    },
  });
};

export const IMAGE_SKILL_ID = 'magpie-image-generate';

const SKILL = [
  '# Magpie image generation',
  '',
  'Tools: `tools.magpie.image_list`, `tools.magpie.image_gen` (code mode).',
  '',
  '1. Pick the model. Use the one the user named; otherwise omit `model` and Magpie draws with its default. To see what exists, call `image_list` and copy an id from it.',
  '   Done when you hold a model id or have chosen the default.',
  '2. Write the prompt: subject, style, composition, colours, and any text to render verbatim. Size `16:9`, `9:16`, `1:1` or `WIDTHxHEIGHT`; quality `low` for drafts, `high` for finals.',
  '   Some models take only an exact `WIDTHxHEIGHT` such as `1024x1024`: after a size error, retry with that.',
  '   Done when the prompt is non-empty.',
  '3. Call `image_gen` once. It waits until the image is saved, which can take minutes, and returns a Markdown image `![image](<path>)`.',
  '   If it fails because that model is unavailable (quota, credits, a reset time, not served, unsupported size), do not retry it: call `image_list`, pick another model, preferably from another provider, and call `image_gen` again. Try at most three models.',
  '   Done when you have a Markdown image line, or every tried model has failed.',
  '4. Put the Markdown image in your reply body as it is, and name the model that drew it. Copy the file into the project with the shell when the user wants it there. If every model failed, tell the user each failure as written, including any reset time.',
  '',
  'Each image spends the user’s credits: after a success, generate again only if the user asks.',
].join('\n');

export const registerImageSkill = (editor: SkillEditor, path: string): void => {
  editor.add({
    id: IMAGE_SKILL_ID,
    name: IMAGE_SKILL_ID,
    description:
      'Magpie image generation: load before drawing or generating any image, picture, illustration or icon.',
    path,
    content: SKILL,
  });
};
