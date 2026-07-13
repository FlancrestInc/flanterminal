import { z } from 'zod';

const TAB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_DISPLAY_NAME_PATTERN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const FORMAT_CONTROL_PATTERN = /\p{Cf}/u;
const ALLOWED_FORMAT_CONTROLS = new Set(['\u200c', '\u200d']);

function hasForbiddenDisplayNameCharacter(value: string): boolean {
  return [...value].some(
    (character) =>
      FORBIDDEN_DISPLAY_NAME_PATTERN.test(character) ||
      (FORMAT_CONTROL_PATTERN.test(character) &&
        !ALLOWED_FORMAT_CONTROLS.has(character)),
  );
}

export const TAB_DOCUMENT_FORMAT_VERSION = 1 as const;
export const SESSION_REPLACED = 4001;
export const BRIDGE_RESTART = 4010;
export const SESSION_STOPPED = 4011;
export const SESSION_RESTARTING = 4012;

export const tabIdSchema = z.string().regex(TAB_ID_PATTERN);

export const displayNameSchema = z
  .string()
  .refine((value) => !hasForbiddenDisplayNameCharacter(value))
  .transform((value) => value.trim().normalize('NFC'))
  .refine((value) => [...value].length >= 1 && [...value].length <= 80);

export const desiredStateSchema = z.enum(['active', 'stopped']);
export const sessionStateSchema = z.enum(['running', 'stopped', 'unknown']);

export type DesiredState = z.infer<typeof desiredStateSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;

export type TabRecord = Readonly<{
  id: string;
  displayName: string;
  position: number;
  createdAt: string;
  lastActivityAt: string;
  desiredState: DesiredState;
}>;

const utcTimestampSchema = z.iso.datetime({ offset: false });

export const tabRecordSchema = z
  .object({
    id: tabIdSchema,
    displayName: displayNameSchema,
    position: z.number().int().nonnegative(),
    createdAt: utcTimestampSchema,
    lastActivityAt: utcTimestampSchema,
    desiredState: desiredStateSchema,
  })
  .strict();

export const sessionHealthSchema = z
  .object({
    state: sessionStateSchema,
    attached: z.boolean(),
    bridgePid: z.number().int().nullable(),
  })
  .strict();

export type SessionHealth = z.infer<typeof sessionHealthSchema>;

export const tabViewSchema = tabRecordSchema.extend({
  session: sessionHealthSchema,
});

export type TabView = z.infer<typeof tabViewSchema>;

export const persistedTabsDocumentSchema = z
  .object({
    formatVersion: z.literal(TAB_DOCUMENT_FORMAT_VERSION),
    structureRevision: z.number().int().nonnegative(),
    tabs: z.array(tabRecordSchema),
  })
  .strict()
  .superRefine(({ tabs }, context) => {
    const ids = new Set<string>();
    const positions = new Set<number>();

    tabs.forEach((tab, index) => {
      if (ids.has(tab.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Tab IDs must be unique',
          path: ['tabs', index, 'id'],
        });
      }
      ids.add(tab.id);

      if (positions.has(tab.position)) {
        context.addIssue({
          code: 'custom',
          message: 'Tab positions must be unique',
          path: ['tabs', index, 'position'],
        });
      }
      positions.add(tab.position);

      if (tab.position !== index) {
        context.addIssue({
          code: 'custom',
          message: 'Tab position must match its ordered array index',
          path: ['tabs', index, 'position'],
        });
      }
    });
  });

export type PersistedTabsDocument = z.infer<typeof persistedTabsDocumentSchema>;

export const tabCollectionSchema = z
  .object({
    structureRevision: z.number().int().nonnegative(),
    tabs: z.array(tabRecordSchema),
  })
  .strict();

export type TabCollection = z.infer<typeof tabCollectionSchema>;

export const tabCollectionResponseSchema = z
  .object({
    structureRevision: z.number().int().nonnegative(),
    tabs: z.array(tabViewSchema),
  })
  .strict();

export type TabCollectionResponse = z.infer<typeof tabCollectionResponseSchema>;

export const createTabBodySchema = z
  .object({ displayName: displayNameSchema.optional() })
  .strict();

export type CreateTabBody = z.infer<typeof createTabBodySchema>;

export const renameTabBodySchema = z
  .object({ displayName: displayNameSchema })
  .strict();

export type RenameTabBody = z.infer<typeof renameTabBodySchema>;

export const reorderTabsBodySchema = z
  .object({
    structureRevision: z.number().int().nonnegative(),
    ids: z.array(tabIdSchema),
  })
  .strict();

export type ReorderTabsBody = z.infer<typeof reorderTabsBodySchema>;

export const apiErrorCodeSchema = z.enum([
  'invalid_request',
  'origin_forbidden',
  'tab_not_found',
  'session_limit',
  'order_conflict',
  'invalid_session_state',
  'json_required',
  'operation_failed',
  'authentication_required',
  'authentication_failed',
  'csrf_invalid',
  'rate_limited',
  'password_invalid',
  'settings_invalid',
  'durability_uncertain',
  'cleanup_disabled',
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorResponseSchema = z
  .object({ error: apiErrorCodeSchema })
  .strict();

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
