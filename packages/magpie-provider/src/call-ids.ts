import { createHash } from 'node:crypto';

export type ModelMessages = {
  messages: { content: { type: string; id?: string }[] }[];
};

/** Normalize the outgoing semantic transcript before encoding, compression, or WS delta selection. */
export const normalizeOpenAICallIDs = ({ messages }: ModelMessages): void => {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'tool-call' && part.type !== 'tool-result') continue;
      if (typeof part.id !== 'string' || part.id.length <= 64) continue;
      part.id = `call_${createHash('sha256').update(part.id).digest('base64url')}`;
    }
  }
};
