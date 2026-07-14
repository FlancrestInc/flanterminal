import { z } from 'zod';

import { safeNormalizedStringSchema, utf8ByteLength } from './safe-string.js';

function boundedDisplayString(maximumBytes: number) {
  return safeNormalizedStringSchema({ maxUtf8Bytes: maximumBytes });
}

const secretStringSchema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 4_096);
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

const setupBootstrapSchema = z
  .object({
    authenticated: z.literal(false),
    mode: z.literal('local'),
    setupRequired: z.literal(true),
    username: boundedDisplayString(128),
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

export const authBootstrapSchema = z.union([
  setupBootstrapSchema,
  z.discriminatedUnion('authenticated', [
    unauthenticatedBootstrapSchema,
    authenticatedBootstrapSchema,
  ]),
]);

export type AuthBootstrap =
  | Readonly<{
      authenticated: false;
      mode: 'local' | 'cloudflare-access' | 'trusted-header';
    }>
  | Readonly<{
      authenticated: false;
      mode: 'local';
      setupRequired: true;
      username: string;
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

export const setupRequestSchema = z
  .object({
    password: z
      .string()
      .refine((value) => !value.includes('\0'), {
        message: 'Password must not contain NUL',
      })
      .refine(
        (value) => {
          const byteLength = utf8ByteLength(value);
          return byteLength >= 12 && byteLength <= 72;
        },
        { message: 'Password must be between 12 and 72 UTF-8 bytes' },
      ),
  })
  .strict();

export type SetupRequest = Readonly<z.infer<typeof setupRequestSchema>>;

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

export function parseSetupRequest(value: unknown): SetupRequest {
  return immutableCopy(setupRequestSchema.parse(value));
}

export function parsePasswordChangeRequest(
  value: unknown,
): PasswordChangeRequest {
  return immutableCopy(passwordChangeRequestSchema.parse(value));
}

function immutableCopy<T>(value: T): T {
  return Object.freeze(structuredClone(value));
}
