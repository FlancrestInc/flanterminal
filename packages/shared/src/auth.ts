import { z } from 'zod';

const utf8Encoder = new TextEncoder();
const forbiddenDisplayCharacterPattern = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;

function boundedDisplayString(maximumBytes: number) {
  return z
    .string()
    .min(1)
    .refine((value) => !forbiddenDisplayCharacterPattern.test(value))
    .refine((value) => utf8Encoder.encode(value).byteLength <= maximumBytes);
}

const secretStringSchema = z
  .string()
  .min(1)
  .refine((value) => utf8Encoder.encode(value).byteLength <= 4_096);
const csrfTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/);
const utcTimestampSchema = z.iso.datetime({ offset: false });

export const authModeSchema = z.enum([
  'local',
  'cloudflare-access',
  'trusted-header',
  'none',
]);

export type AuthMode = z.infer<typeof authModeSchema>;

const unauthenticatedBootstrapSchema = z
  .object({
    authenticated: z.literal(false),
    mode: z.enum(['local', 'cloudflare-access', 'trusted-header']),
  })
  .strict();

const authenticatedBootstrapSchema = z
  .object({
    authenticated: z.literal(true),
    mode: authModeSchema,
    identityLabel: boundedDisplayString(128),
    csrfToken: csrfTokenSchema,
    upstreamExpiresAt: utcTimestampSchema.optional(),
  })
  .strict();

export const authBootstrapSchema = z.discriminatedUnion('authenticated', [
  unauthenticatedBootstrapSchema,
  authenticatedBootstrapSchema,
]);

export type AuthBootstrap =
  | Readonly<{
      authenticated: false;
      mode: 'local' | 'cloudflare-access' | 'trusted-header';
    }>
  | Readonly<{
      authenticated: true;
      mode: AuthMode;
      identityLabel: string;
      csrfToken: string;
      upstreamExpiresAt?: string;
    }>;

export const loginRequestSchema = z
  .object({
    username: boundedDisplayString(128),
    password: secretStringSchema,
  })
  .strict();

export type LoginRequest = Readonly<z.infer<typeof loginRequestSchema>>;

export const passwordChangeRequestSchema = z
  .object({
    currentPassword: secretStringSchema,
    newPassword: secretStringSchema,
  })
  .strict();

export type PasswordChangeRequest = Readonly<
  z.infer<typeof passwordChangeRequestSchema>
>;

export function parseAuthBootstrap(value: unknown): AuthBootstrap {
  const parsed = authBootstrapSchema.parse(value);
  if (!parsed.authenticated) return immutableCopy(parsed);
  return immutableCopy({
    authenticated: true,
    mode: parsed.mode,
    identityLabel: parsed.identityLabel,
    csrfToken: parsed.csrfToken,
    ...(parsed.upstreamExpiresAt === undefined
      ? {}
      : { upstreamExpiresAt: parsed.upstreamExpiresAt }),
  });
}

export function parseLoginRequest(value: unknown): LoginRequest {
  return immutableCopy(loginRequestSchema.parse(value));
}

export function parsePasswordChangeRequest(
  value: unknown,
): PasswordChangeRequest {
  return immutableCopy(passwordChangeRequestSchema.parse(value));
}

function immutableCopy<T>(value: T): T {
  return Object.freeze(structuredClone(value));
}
