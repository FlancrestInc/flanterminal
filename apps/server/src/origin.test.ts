import { describe, expect, it } from 'vitest';

import { authorizeUpgrade, websocketSessionPath } from './origin.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('authorizeUpgrade', () => {
  it.each([
    ['http://example.test', 'http://example.test'],
    ['http://example.test:80', 'http://example.test'],
    ['https://example.test:443', 'https://example.test'],
    ['https://example.test:8443', 'https://example.test:8443'],
  ])('accepts the exact normalized origin %s', (origin, publicOrigin) => {
    expect(
      authorizeUpgrade(
        {
          origin,
          requestUrl: `/terminal/ws/sessions/${SESSION_ID}`,
        },
        { publicOrigin, basePath: '/terminal' },
      ),
    ).toEqual({ allowed: true, sessionId: SESSION_ID });
  });

  it.each([
    undefined,
    'null',
    'not a url',
    'file:///tmp/app',
    'ws://example.test',
    'https://example.test',
    'http://other.test',
    'http://example.test:8080',
    'http://example.test/',
    'http://example.test?',
    'http://example.test#',
    'http://example.test/path',
    'http://user@example.test',
  ])(
    'rejects an untrusted origin without inspecting the path: %s',
    (origin) => {
      expect(
        authorizeUpgrade(
          { origin, requestUrl: '/private-invalid-path' },
          { publicOrigin: 'http://example.test', basePath: '/terminal' },
        ),
      ).toEqual({ allowed: false, status: 403 });
    },
  );

  it.each([
    ' http://example.test',
    'http://example.test ',
    'http://exa\tmple.test',
    'http://example.test\t',
    'http://exa\rmple.test',
    'http://example.test\r',
    'http://exa\nmple.test',
    'http://example.test\n',
    'http://example.test\u0000',
    'http://example.test\u001f',
    'http://example.test\u007f',
  ])('rejects ASCII whitespace or controls in Origin: %j', (origin) => {
    expect(
      authorizeUpgrade(
        { origin, requestUrl: `/terminal/ws/sessions/${SESSION_ID}` },
        { publicOrigin: 'http://example.test', basePath: '/terminal' },
      ),
    ).toEqual({ allowed: false, status: 403 });
  });

  it.each([
    `/ws/sessions/${SESSION_ID}`,
    `/terminal/sessions/${SESSION_ID}`,
    '/terminal/ws/sessions/not-a-uuid',
    '/terminal/ws/sessions/123E4567-e89b-42d3-a456-426614174000',
    `/terminal/ws/sessions/${SESSION_ID}?session=other`,
    `/terminal/ws/sessions/${SESSION_ID}/`,
    '/terminal/ws/sessions/%2e%2e',
    `/terminal/ws/sessions/%2F${SESSION_ID}`,
    '/terminal/ws/sessions/123e4567%2de89b%2d42d3%2da456%2d426614174000',
    `//terminal/ws/sessions/${SESSION_ID}`,
    `http://other.test/terminal/ws/sessions/${SESSION_ID}`,
  ])('rejects a non-canonical websocket route: %s', (requestUrl) => {
    expect(
      authorizeUpgrade(
        { origin: 'http://example.test', requestUrl },
        { publicOrigin: 'http://example.test', basePath: '/terminal' },
      ),
    ).toEqual({ allowed: false, status: 404 });
  });

  it('supports the root base path', () => {
    expect(websocketSessionPath('/', SESSION_ID)).toBe(
      `/ws/sessions/${SESSION_ID}`,
    );
    expect(
      authorizeUpgrade(
        {
          origin: 'http://example.test',
          requestUrl: `/ws/sessions/${SESSION_ID}`,
        },
        { publicOrigin: 'http://example.test', basePath: '/' },
      ),
    ).toEqual({ allowed: true, sessionId: SESSION_ID });
  });

  it.each([
    [
      'duplicate Origin fields',
      ['Origin', 'http://example.test', 'Origin', 'http://example.test'],
    ],
    ['oversized Origin', ['Origin', `http://${'a'.repeat(2_048)}.test`]],
    ['odd raw header list', ['Origin']],
  ])('rejects %s before inspecting the websocket path', (_case, rawHeaders) => {
    expect(
      authorizeUpgrade(
        {
          origin: 'http://example.test',
          rawHeaders,
          requestUrl: '/private-invalid-path',
        },
        { publicOrigin: 'http://example.test', basePath: '/terminal' },
      ),
    ).toEqual({ allowed: false, status: 403 });
  });
});
