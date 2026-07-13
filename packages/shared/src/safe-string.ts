import { z } from 'zod';

const utf8Encoder = new TextEncoder();
const forbiddenCharacterPattern = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const formatControlPattern = /\p{Cf}/u;
const allowedJoinControls = new Set(['\u200c', '\u200d']);

type SafeNormalizedStringOptions = Readonly<{
  maxUtf8Bytes?: number;
  trim?: boolean;
  allowJoinControls?: boolean;
}>;

export function safeNormalizedStringSchema(
  options: SafeNormalizedStringOptions = {},
) {
  return z
    .string()
    .refine(
      (value) =>
        [...value].every(
          (character) =>
            !forbiddenCharacterPattern.test(character) &&
            (!formatControlPattern.test(character) ||
              (options.allowJoinControls === true &&
                allowedJoinControls.has(character))),
        ),
      { message: 'String contains unsafe Unicode characters' },
    )
    .transform((value) =>
      (options.trim === true ? value.trim() : value).normalize('NFC'),
    )
    .refine((value) => utf8ByteLength(value) >= 1, {
      message: 'String must not be empty',
    })
    .refine(
      (value) =>
        options.maxUtf8Bytes === undefined ||
        utf8ByteLength(value) <= options.maxUtf8Bytes,
      { message: 'String exceeds UTF-8 byte limit' },
    );
}

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}
