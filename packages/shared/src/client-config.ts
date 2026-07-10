import { z } from 'zod';

import { basePathSchema } from './base-path.js';
import { FIXED_SESSION_ID } from './protocol.js';

export const clientConfigSchema = z
  .object({
    basePath: basePathSchema,
    sessionId: z.literal(FIXED_SESSION_ID),
    fontSize: z.number().int().min(8).max(32),
    scrollback: z.number().int().min(0).max(100_000),
    resizeDebounceMs: z.number().int().min(25).max(1_000),
    reconnectMaxSeconds: z.number().int().min(1).max(60),
  })
  .strict();

export type ClientConfig = z.infer<typeof clientConfigSchema>;

export function parseClientConfig(value: unknown): ClientConfig {
  return clientConfigSchema.parse(value);
}
