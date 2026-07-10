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
      expect(parseClientMessage(JSON.stringify(message))).toEqual({
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
    expect(parseClientMessage('{secret terminal contents')).toEqual({
      success: false,
      error: { code: 'invalid_json' },
    });
  });

  it.each([
    [{ v: 2, type: 'input', sessionId: FIXED_SESSION_ID, data: 'x' }],
    [{ v: 1, type: 'future', sessionId: FIXED_SESSION_ID }],
  ])('rejects unknown versions and message types', (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual({
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

    expect(parseClientMessage(output)).toEqual({
      success: false,
      error: { code: 'invalid_message' },
    });
  });

  it('rejects binary websocket payloads', () => {
    expect(parseClientMessage(new Uint8Array([123, 125]))).toEqual({
      success: false,
      error: { code: 'binary_payload' },
    });
  });

  it('rejects websocket payloads larger than 64 KiB', () => {
    expect(MAX_WS_PAYLOAD_BYTES).toBe(65_536);
    expect(parseClientMessage(' '.repeat(MAX_WS_PAYLOAD_BYTES + 1))).toEqual({
      success: false,
      error: { code: 'payload_too_large' },
    });
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

    expect(parseClientMessage(accepted).success).toBe(true);
    expect(parseClientMessage(rejected)).toEqual({
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
      ).success,
    ).toBe(true);
  });

  it('only accepts the fixed phase-one session id', () => {
    expect(FIXED_SESSION_ID).toBe('phase-1-main');
    expect(isSessionId(FIXED_SESSION_ID)).toBe(true);
    expect(isSessionId('phase-1-other')).toBe(false);
    expect(
      parseServerMessage(
        JSON.stringify({ v: 1, type: 'ready', sessionId: '../phase-1-main' }),
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
});
