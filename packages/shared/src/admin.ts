import { z } from 'zod';

import { safeNormalizedStringSchema } from './safe-string.js';
import {
  desiredStateSchema,
  displayNameSchema,
  sessionStateSchema,
  tabIdSchema,
} from './tabs.js';

const utcTimestampSchema = z.iso.datetime({ offset: false });

function boundedDisplayString(maximumBytes: number) {
  return safeNormalizedStringSchema({ maxUtf8Bytes: maximumBytes });
}

const nonnegativeIntegerSchema = z.number().int().nonnegative();
const nonnegativeNumberSchema = z.number().finite().nonnegative();

export const adminActionSchema = z.enum([
  'restart_bridge',
  'terminate',
  'recreate',
  'restart_session',
]);

export type AdminAction = z.infer<typeof adminActionSchema>;

export const adminSessionRowSchema = z
  .object({
    id: tabIdSchema,
    displayName: displayNameSchema,
    tmuxSessionName: boundedDisplayString(128),
    desiredState: desiredStateSchema,
    observedState: sessionStateSchema,
    createdAt: utcTimestampSchema,
    lastActivityAt: utcTimestampSchema,
    ageSeconds: nonnegativeNumberSchema,
    connectedWebSockets: nonnegativeIntegerSchema,
    bridgePid: z.number().int().positive().nullable(),
    cleanupEligible: z.boolean(),
    lifecycleError: boundedDisplayString(128).nullable(),
  })
  .strict();

export type AdminSessionRow = Readonly<{
  id: string;
  displayName: string;
  tmuxSessionName: string;
  desiredState: z.infer<typeof desiredStateSchema>;
  observedState: z.infer<typeof sessionStateSchema>;
  createdAt: string;
  lastActivityAt: string;
  ageSeconds: number;
  connectedWebSockets: number;
  bridgePid: number | null;
  cleanupEligible: boolean;
  lifecycleError: string | null;
}>;

export const adminSnapshotSchema = z
  .object({
    generatedAt: utcTimestampSchema,
    uptimeSeconds: nonnegativeNumberSchema,
    memory: z
      .object({
        rss: nonnegativeIntegerSchema,
        heapUsed: nonnegativeIntegerSchema,
      })
      .strict(),
    totals: z
      .object({
        tabs: nonnegativeIntegerSchema,
        runningSessions: nonnegativeIntegerSchema,
        bridges: nonnegativeIntegerSchema,
        webSockets: nonnegativeIntegerSchema,
      })
      .strict(),
    cleanup: z
      .object({
        enabled: z.boolean(),
        running: z.boolean(),
        lastRunAt: utcTimestampSchema.nullable(),
      })
      .strict(),
    sessions: z.array(adminSessionRowSchema).max(20),
  })
  .strict();

export type AdminSnapshot = Readonly<{
  generatedAt: string;
  uptimeSeconds: number;
  memory: Readonly<{ rss: number; heapUsed: number }>;
  totals: Readonly<{
    tabs: number;
    runningSessions: number;
    bridges: number;
    webSockets: number;
  }>;
  cleanup: Readonly<{
    enabled: boolean;
    running: boolean;
    lastRunAt: string | null;
  }>;
  sessions: readonly AdminSessionRow[];
}>;

export const adminActionRequestSchema = z
  .object({ action: adminActionSchema })
  .strict();

export type AdminActionRequest = Readonly<
  z.infer<typeof adminActionRequestSchema>
>;

export const cleanupResultSchema = z
  .object({
    disabled: z.boolean(),
    examined: nonnegativeIntegerSchema,
    terminated: nonnegativeIntegerSchema,
    skipped: nonnegativeIntegerSchema,
    failed: nonnegativeIntegerSchema,
    startedAt: utcTimestampSchema,
    finishedAt: utcTimestampSchema,
  })
  .strict();

export type CleanupResult = Readonly<z.infer<typeof cleanupResultSchema>>;

export function parseAdminSnapshot(value: unknown): AdminSnapshot {
  return immutableCopy(adminSnapshotSchema.parse(value));
}

export function parseAdminActionRequest(value: unknown): AdminActionRequest {
  return immutableCopy(adminActionRequestSchema.parse(value));
}

export function parseCleanupResult(value: unknown): CleanupResult {
  return immutableCopy(cleanupResultSchema.parse(value));
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
