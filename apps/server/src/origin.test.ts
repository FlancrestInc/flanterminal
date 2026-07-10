import { describe, expect, it } from 'vitest';

import { authorizeUpgrade, websocketSessionPath } from './origin.js';

describe('authorizeUpgrade', () => {
  it.each([
    ['http://example.test', 'http://example.test'],
    ['http://example.test:80', 'http://example.test'],
    ['https://example.test:443', 'https://example.test'],
    ['https://example.test:8443', 'https://example.test:8443'],
  ])('accepts the exact normalized origin %s', (origin, publicOrigin) => {
    expect(
      authorizeUpgrade(
        { origin, requestUrl: '/terminal/ws/sessions/phase-1-main' },
        { publicOrigin, basePath: '/terminal' },
      ),
    ).toEqual({ allowed: true, sessionId: 'phase-1-main' });
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
          { origin, requestUrl: '/terminal/ws/sessions/phase-1-main' },
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
        { origin, requestUrl: '/terminal/ws/sessions/phase-1-main' },
        { publicOrigin: 'http://example.test', basePath: '/terminal' },
      ),
    ).toEqual({ allowed: false, status: 403 });
  });

  it.each([
    '/ws/sessions/phase-1-main',
    '/terminal/sessions/phase-1-main',
    '/terminal/ws/sessions/other',
    '/terminal/ws/sessions/phase-1-main?session=other',
    '/terminal/ws/sessions/phase-1-main/',
    '/terminal/ws/sessions/%2e%2e',
    '/terminal/ws/sessions/%2Fphase-1-main',
    '/terminal/ws/sessions/phase%2d1%2dmain',
    '//terminal/ws/sessions/phase-1-main',
    'http://other.test/terminal/ws/sessions/phase-1-main',
  ])('rejects a non-canonical websocket route: %s', (requestUrl) => {
    expect(
      authorizeUpgrade(
        { origin: 'http://example.test', requestUrl },
        { publicOrigin: 'http://example.test', basePath: '/terminal' },
      ),
    ).toEqual({ allowed: false, status: 404 });
  });

  it('supports the root base path', () => {
    expect(websocketSessionPath('/')).toBe('/ws/sessions/phase-1-main');
    expect(
      authorizeUpgrade(
        {
          origin: 'http://example.test',
          requestUrl: '/ws/sessions/phase-1-main',
        },
        { publicOrigin: 'http://example.test', basePath: '/' },
      ),
    ).toEqual({ allowed: true, sessionId: 'phase-1-main' });
  });
});
