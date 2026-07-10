import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const FIXED_SESSION_ID = 'phase-1-main' as const;
export const MAX_WS_PAYLOAD_BYTES = 65_536;
export const MAX_INPUT_BYTES = 16_384;
export const MIN_COLS = 2;
export const MAX_COLS = 500;
export const MIN_ROWS = 2;
export const MAX_ROWS = 200;

const sessionIdSchema = z.literal(FIXED_SESSION_ID);
const utf8Encoder = new TextEncoder();
const inputDataSchema = z
  .string()
  .refine((value) => utf8Encoder.encode(value).byteLength <= MAX_INPUT_BYTES);

const clientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      type: z.literal('input'),
      sessionId: sessionIdSchema,
      data: inputDataSchema,
    })
    .strict(),
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      type: z.literal('resize'),
      sessionId: sessionIdSchema,
      cols: z.number().int().min(MIN_COLS).max(MAX_COLS),
      rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS),
    })
    .strict(),
]);

const serverMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      type: z.literal('ready'),
      sessionId: sessionIdSchema,
    })
    .strict(),
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      type: z.literal('output'),
      sessionId: sessionIdSchema,
      data: z.string(),
    })
    .strict(),
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      type: z.literal('error'),
      sessionId: sessionIdSchema,
      code: z.string().min(1).max(100),
    })
    .strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ProtocolParseErrorCode =
  'binary_payload' | 'payload_too_large' | 'invalid_json' | 'invalid_message';

export type ProtocolParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: { readonly code: ProtocolParseErrorCode };
    };

export function isSessionId(value: unknown): value is typeof FIXED_SESSION_ID {
  return value === FIXED_SESSION_ID;
}

function parseMessage<T>(
  input: unknown,
  schema: z.ZodType<T>,
): ProtocolParseResult<T> {
  if (typeof input !== 'string') {
    return { success: false, error: { code: 'binary_payload' } };
  }

  if (utf8Encoder.encode(input).byteLength > MAX_WS_PAYLOAD_BYTES) {
    return { success: false, error: { code: 'payload_too_large' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return { success: false, error: { code: 'invalid_json' } };
  }

  const result = schema.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: { code: 'invalid_message' } };
}

export function parseClientMessage(
  input: unknown,
): ProtocolParseResult<ClientMessage> {
  return parseMessage(input, clientMessageSchema);
}

export function parseServerMessage(
  input: unknown,
): ProtocolParseResult<ServerMessage> {
  return parseMessage(input, serverMessageSchema);
}
