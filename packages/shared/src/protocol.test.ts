/// <reference types="node" />

import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  FIXED_SESSION_ID,
  MAX_INPUT_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  isSessionId,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js';

const OTHER_SESSION_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('terminal protocol', () => {
  it('parses valid direction-specific messages', () => {
    const clientMessages: ClientMessage[] = [
      { v: 1, type: 'input', sessionId: FIXED_SESSION_ID, data: 'ls\n' },
      {
        v: 1,
        type: 'resize',
        sessionId: FIXED_SESSION_ID,
        cols: 120,
        rows: 40,
      },
    ];
    const serverMessages: ServerMessage[] = [
      { v: 1, type: 'ready', sessionId: FIXED_SESSION_ID },
      { v: 1, type: 'output', sessionId: FIXED_SESSION_ID, data: 'hello' },
      {
        v: 1,
        type: 'error',
        sessionId: FIXED_SESSION_ID,
        code: 'terminal_unavailable',
      },
    ];

    for (const message of clientMessages) {
      expect(parseClientMessage(JSON.stringify(message), false)).toEqual({
        success: true,
        data: message,
      });
    }
    for (const message of serverMessages) {
      expect(parseServerMessage(JSON.stringify(message))).toEqual({
        success: true,
        data: message,
      });
    }
  });

  it('rejects malformed JSON with a stable safe category', () => {
    expect(parseClientMessage('{secret terminal contents', false)).toEqual({
      success: false,
      error: { code: 'invalid_json' },
    });
  });

  it.each([
    [{ v: 2, type: 'input', sessionId: FIXED_SESSION_ID, data: 'x' }],
    [{ v: 1, type: 'future', sessionId: FIXED_SESSION_ID }],
  ])('rejects unknown versions and message types', (message) => {
    expect(parseClientMessage(JSON.stringify(message), false)).toEqual({
      success: false,
      error: { code: 'invalid_message' },
    });
  });

  it('rejects messages sent in the wrong direction', () => {
    const output = JSON.stringify({
      v: 1,
      type: 'output',
      sessionId: FIXED_SESSION_ID,
      data: 'private output',
    });

    expect(parseClientMessage(output, false)).toEqual({
      success: false,
      error: { code: 'invalid_message' },
    });
  });

  it('accepts websocket text frames delivered as Buffer or Uint8Array', () => {
    const message: ClientMessage = {
      v: 1,
      type: 'input',
      sessionId: FIXED_SESSION_ID,
      data: 'echo ok\n',
    };
    const bytes = new TextEncoder().encode(JSON.stringify(message));

    expect(parseClientMessage(Buffer.from(bytes), false)).toEqual({
      success: true,
      data: message,
    });
    expect(parseClientMessage(bytes, false)).toEqual({
      success: true,
      data: message,
    });
  });

  it('concatenates split websocket text chunks before UTF-8 decoding', () => {
    const message: ClientMessage = {
      v: 1,
      type: 'input',
      sessionId: FIXED_SESSION_ID,
      data: 'é',
    };
    const bytes = new TextEncoder().encode(JSON.stringify(message));
    const split = bytes.indexOf(0xc3) + 1;

    expect(
      parseClientMessage(
        [bytes.subarray(0, split), bytes.subarray(split)],
        false,
      ),
    ).toEqual({ success: true, data: message });
  });

  it('rejects websocket frames marked as binary even when they contain JSON', () => {
    const bytes = Buffer.from(
      JSON.stringify({
        v: 1,
        type: 'input',
        sessionId: FIXED_SESSION_ID,
        data: 'secret',
      }),
    );

    expect(parseClientMessage(bytes, true)).toEqual({
      success: false,
      error: { code: 'binary_payload' },
    });
  });

  it('rejects unsupported and invalid UTF-8 text payloads safely', () => {
    expect(parseClientMessage({ terminal: 'secret' }, false)).toEqual({
      success: false,
      error: { code: 'invalid_message' },
    });
    expect(parseClientMessage(new Uint8Array([0xff]), false)).toEqual({
      success: false,
      error: { code: 'invalid_message' },
    });
  });

  it('rejects websocket payloads larger than 64 KiB', () => {
    expect(MAX_WS_PAYLOAD_BYTES).toBe(65_536);
    expect(
      parseClientMessage(' '.repeat(MAX_WS_PAYLOAD_BYTES + 1), false),
    ).toEqual({
      success: false,
      error: { code: 'payload_too_large' },
    });
    expect(
      parseClientMessage(new Uint8Array(MAX_WS_PAYLOAD_BYTES + 1), false),
    ).toEqual({ success: false, error: { code: 'payload_too_large' } });
  });

  it('limits input by UTF-8 bytes rather than JavaScript character count', () => {
    expect(MAX_INPUT_BYTES).toBe(16_384);
    const accepted = JSON.stringify({
      v: 1,
      type: 'input',
      sessionId: FIXED_SESSION_ID,
      data: 'é'.repeat(MAX_INPUT_BYTES / 2),
    });
    const rejected = JSON.stringify({
      v: 1,
      type: 'input',
      sessionId: FIXED_SESSION_ID,
      data: 'é'.repeat(MAX_INPUT_BYTES / 2 + 1),
    });

    expect(
      parseClientMessage(new TextEncoder().encode(accepted), false).success,
    ).toBe(true);
    expect(
      parseClientMessage(new TextEncoder().encode(rejected), false),
    ).toEqual({
      success: false,
      error: { code: 'invalid_message' },
    });
  });

  it.each([
    [1, 24],
    [501, 24],
    [80, 1],
    [80, 201],
    [80.5, 24],
    [80, 24.5],
  ])('requires integer resize dimensions within bounds', (cols, rows) => {
    const result = parseClientMessage(
      JSON.stringify({
        v: 1,
        type: 'resize',
        sessionId: FIXED_SESSION_ID,
        cols,
        rows,
      }),
      false,
    );

    expect(result).toEqual({
      success: false,
      error: { code: 'invalid_message' },
    });
  });

  it('accepts resize boundary values', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          v: 1,
          type: 'resize',
          sessionId: FIXED_SESSION_ID,
          cols: 2,
          rows: 200,
        }),
        false,
      ).success,
    ).toBe(true);
  });

  it('accepts canonical tab IDs while retaining a canonical compatibility ID', () => {
    expect(FIXED_SESSION_ID).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(isSessionId(FIXED_SESSION_ID)).toBe(true);
    expect(isSessionId(OTHER_SESSION_ID)).toBe(true);
    expect(
      parseServerMessage(
        JSON.stringify({ v: 1, type: 'ready', sessionId: OTHER_SESSION_ID }),
      ).success,
    ).toBe(true);
    expect(isSessionId('phase-1-main')).toBe(false);
    expect(
      parseServerMessage(
        JSON.stringify({
          v: 1,
          type: 'ready',
          sessionId: `../${FIXED_SESSION_ID}`,
        }),
      ),
    ).toEqual({ success: false, error: { code: 'invalid_message' } });
  });

  it('never reflects terminal payloads in errors', () => {
    const secret = 'password=do-not-return';
    const result = parseServerMessage(
      JSON.stringify({
        v: 1,
        type: 'output',
        sessionId: FIXED_SESSION_ID,
        data: secret,
        extra: 1,
      }),
    );

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    { v: 1, type: 'input', sessionId: FIXED_SESSION_ID, data: 'private input' },
    { v: 1, type: 'resize', sessionId: FIXED_SESSION_ID, cols: 80, rows: 24 },
  ])('rejects client messages parsed in the server direction', (message) => {
    expect(parseServerMessage(JSON.stringify(message))).toEqual({
      success: false,
      error: { code: 'invalid_message' },
    });
  });
});
