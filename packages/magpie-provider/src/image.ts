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
      'Draw one image through Magpie and save it. Returns a Markdown image and the model used.',
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
  '`magpie.image_list` lists the image model IDs currently available through the configured gateway.',
  '`magpie.image_gen` accepts prompt, optional model, size and quality; an omitted model uses Magpie’s configured default.',
  'Sizes are provider-dependent: aspect ratios or WIDTHxHEIGHT. Quality values are low, medium, high or auto.',
  'Generation can take minutes and consumes the account’s credits. Provider refusals and quota errors are returned as errors.',
  'A successful result contains a Markdown image pointing to the saved temporary file, followed by the model used.',
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
