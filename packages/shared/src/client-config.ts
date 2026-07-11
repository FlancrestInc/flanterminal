import { z } from 'zod';

import { basePathSchema } from './base-path.js';
import { tabIdSchema } from './tabs.js';

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export const MIN_SCROLLBACK = 0;
export const MAX_SCROLLBACK = 100_000;
export const MIN_RESIZE_DEBOUNCE_MS = 25;
export const MAX_RESIZE_DEBOUNCE_MS = 1_000;
export const MIN_RECONNECT_SECONDS = 1;
export const MAX_RECONNECT_SECONDS = 60;

export const clientConfigSchema = z
  .object({
    basePath: basePathSchema,
    sessionId: tabIdSchema,
    fontSize: z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE),
    scrollback: z.number().int().min(MIN_SCROLLBACK).max(MAX_SCROLLBACK),
    resizeDebounceMs: z
      .number()
      .int()
      .min(MIN_RESIZE_DEBOUNCE_MS)
      .max(MAX_RESIZE_DEBOUNCE_MS),
    reconnectMaxSeconds: z
      .number()
      .int()
      .min(MIN_RECONNECT_SECONDS)
      .max(MAX_RECONNECT_SECONDS),
  })
  .strict();

export type ClientConfig = z.infer<typeof clientConfigSchema>;

export function parseClientConfig(value: unknown): ClientConfig {
  return clientConfigSchema.parse(value);
}
