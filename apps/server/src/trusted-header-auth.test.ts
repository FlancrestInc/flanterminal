import {
  createServer,
  request as createHttpRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { UpstreamProviderError } from './cloudflare-access.js';
import {
  TrustedHeaderAuthProvider,
  type TrustedHeaderRequest,
} from './trusted-header-auth.js';

const PUBLIC_ORIGIN = 'https://terminal.example.test';

describe('TrustedHeaderAuthProvider', () => {
  it.each([false, 1, 8] as const)(
    'rejects disabled or numeric proxy trust: %s',
    (trustProxy) => {
      expect(
        () =>
          new TrustedHeaderAuthProvider({
            trustProxy,
            identityHeader: 'X-Auth-User',
            publicOrigin: PUBLIC_ORIGIN,
          }),
      ).toThrow(new UpstreamProviderError());
    },
  );

  it('rejects identity from an untrusted immediate peer before reading it', () => {
    const provider = setup();
    const identity = {
      toString: () => {
        throw new Error('identity was read');
      },
    } as unknown as string;

    expectProviderError(() =>
      provider.authenticate(
        request({ remoteAddress: '203.0.113.8', identity }),
      ),
    );
  });

  it.each([
    ['10.20.30.40', ['10.0.0.0/8']],
    ['2001:db8::42', ['2001:db8::/32']],
    ['::ffff:192.0.2.42', ['192.0.2.0/24']],
  ] as const)(
    'accepts an explicitly trusted immediate peer %s',
    (remoteAddress, trustProxy) => {
      const provider = setup({ trustProxy });
      expect(provider.authenticate(request({ remoteAddress }))).toEqual({
        mode: 'trusted-header',
        identityLabel: 'person@example.test',
      });
    },
  );

  it('validates the complete forwarded proxy chain with Express semantics', () => {
    const provider = setup({ trustProxy: ['10.0.0.0/8', '192.0.2.0/24'] });

    expect(
      provider.authenticate(
        request({
          remoteAddress: '10.0.0.2',
          xForwardedFor: '198.51.100.5, 192.0.2.7',
        }),
      ),
    ).toMatchObject({ identityLabel: 'person@example.test' });
    expectProviderError(() =>
      provider.authenticate(
        request({
          remoteAddress: '10.0.0.2',
          xForwardedFor: '198.51.100.5, 203.0.113.7',
        }),
      ),
    );
  });

  it.each([
    'not-an-ip',
    '198.51.100.1,,192.0.2.2',
    '198.51.100.1, unknown',
    '198.51.100.1%zone',
    Array.from({ length: 17 }, (_, index) => `192.0.2.${index + 1}`).join(','),
    '1'.repeat(4_097),
  ])('rejects malformed or oversized X-Forwarded-For %j', (xForwardedFor) => {
    expectProviderError(() => setup().authenticate(request({ xForwardedFor })));
  });

  it('rejects duplicate forwarded header arrays', () => {
    const provider = setup();
    for (const headers of [
      { 'x-forwarded-for': ['198.51.100.1', '198.51.100.2'] },
      { 'x-forwarded-proto': ['https', 'https'] },
      { 'x-forwarded-host': ['terminal.example.test', 'evil.example'] },
      { host: ['terminal.example.test', 'evil.example'] },
    ]) {
      expectProviderError(() =>
        provider.authenticate({
          ...request(),
          headers: { ...request().headers, ...headers },
        }),
      );
    }
  });

  it('requires external scheme and host to match the configured origin', () => {
    const provider = setup();

    expectProviderError(() =>
      provider.authenticate(request({ xForwardedProto: 'http' })),
    );
    expectProviderError(() =>
      provider.authenticate(request({ xForwardedHost: 'evil.example' })),
    );
    expectProviderError(() =>
      provider.authenticate(request({ xForwardedProto: 'https,http' })),
    );
    expectProviderError(() =>
      provider.authenticate(
        request({ xForwardedHost: 'terminal.example.test,evil.example' }),
      ),
    );
    expectProviderError(() =>
      provider.authenticate(
        request({ xForwardedHost: 'user@terminal.example.test' }),
      ),
    );
    expectProviderError(() =>
      provider.authenticate(
        request({ xForwardedHost: 'terminal.example.test/path' }),
      ),
    );
  });

  it('validates the direct Host against APP_PUBLIC_URL when not forwarded', () => {
    const provider = setup();
    const forwardedHeadersRemoved = request({
      xForwardedFor: undefined,
      xForwardedProto: undefined,
      xForwardedHost: undefined,
    });
    const direct = {
      ...forwardedHeadersRemoved,
      headers: {
        ...forwardedHeadersRemoved.headers,
        host: 'terminal.example.test',
      },
    };
    expect(provider.authenticate(direct)).toMatchObject({
      identityLabel: 'person@example.test',
    });
    expectProviderError(() =>
      provider.authenticate({
        ...direct,
        headers: { ...direct.headers, host: 'evil.example' },
      }),
    );
  });

  it('reads the configured identity header case-insensitively only after trust checks', () => {
    const provider = setup({ identityHeader: 'X-Forwarded-User' });
    const base = request({ identity: undefined });
    const result = provider.authenticate({
      ...base,
      headers: { ...base.headers, 'x-FoRwArDeD-uSeR': 'cafe\u0301' },
      headersDistinct: { 'x-forwarded-user': ['cafe\u0301'] },
    });

    expect(result).toEqual({
      mode: 'trusted-header',
      identityLabel: 'café',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    undefined,
    '',
    ['person', 'other'],
    'person,other',
    'a'.repeat(129),
    '\u0000person',
    'per\u200bson',
    'per\u2028son',
    'per\u2029son',
    '\ud800',
  ])('rejects absent, duplicate, or unsafe identity %j', (identity) => {
    expectProviderError(() => setup().authenticate(request({ identity })));
  });

  it('rejects case-variant duplicate identity fields', () => {
    const base = request();
    expectProviderError(() =>
      setup().authenticate({
        ...base,
        headers: {
          ...base.headers,
          'X-Auth-User': 'first',
          'x-auth-user': 'second',
        },
      }),
    );
  });

  it('requires one original identity field line from preserved headers', () => {
    const base = request();
    expectProviderError(() =>
      setup().authenticate({
        remoteAddress: base.remoteAddress,
        headers: base.headers,
      }),
    );
    expect(
      setup().authenticate({
        ...base,
        headers: { ...base.headers, 'x-auth-user': ['one'] },
        headersDistinct: { 'x-auth-user': ['one'] },
      }),
    ).toMatchObject({ identityLabel: 'one' });
    expect(
      setup().authenticate({
        ...base,
        headersDistinct: undefined,
        rawHeaders: ['X-Auth-User', 'person@example.test'],
      }),
    ).toMatchObject({ identityLabel: 'person@example.test' });
    expectProviderError(() =>
      setup().authenticate({
        ...base,
        headers: { ...base.headers, 'x-auth-user': 'first, second' },
        headersDistinct: undefined,
        rawHeaders: ['X-Auth-User', 'first', 'x-auth-user', 'second'],
      }),
    );
    expectProviderError(() =>
      setup().authenticate({
        ...base,
        headers: { ...base.headers, 'x-auth-user': 'first, second' },
        headersDistinct: { 'x-auth-user': ['first', 'second'] },
      }),
    );
    expectProviderError(() =>
      setup().authenticate({
        ...base,
        headers: { ...base.headers, 'x-auth-user': 'first, second' },
        headersDistinct: { 'x-auth-user': ['first', 'second'] },
        rawHeaders: ['X-Auth-User', 'first', 'x-auth-user', 'second'],
      }),
    );
  });

  it('rejects duplicate identity lines preserved by the Node HTTP parser', async () => {
    const provider = setup({ trustProxy: ['127.0.0.1/32'] });
    const observed: Array<
      Readonly<{
        merged: string | string[] | undefined;
        distinct: readonly string[] | undefined;
        rawIdentityValues: readonly string[];
      }>
    > = [];
    const server = createServer((incoming, response) => {
      observed.push({
        merged: incoming.headers['x-auth-user'],
        distinct: incoming.headersDistinct['x-auth-user'],
        rawIdentityValues: rawHeaderValues(incoming.rawHeaders, 'x-auth-user'),
      });
      try {
        provider.authenticate({
          remoteAddress: incoming.socket.remoteAddress,
          headers: incoming.headers,
          headersDistinct: incoming.headersDistinct,
          rawHeaders: incoming.rawHeaders,
        });
        response.writeHead(204).end();
      } catch {
        response.writeHead(401).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error();
      await expect(sendIdentityRequest(address.port, 'one')).resolves.toBe(204);
      await expect(
        sendIdentityRequest(address.port, ['first', 'second']),
      ).resolves.toBe(401);
      expect(observed).toEqual([
        {
          merged: 'one',
          distinct: ['one'],
          rawIdentityValues: ['one'],
        },
        {
          merged: 'first, second',
          distinct: ['first', 'second'],
          rawIdentityValues: ['first', 'second'],
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('returns generic errors without reflecting headers or private state', () => {
    const secret = 'sensitive-identity';
    const provider = setup();
    const error = captureError(() =>
      provider.authenticate(request({ identity: `${secret}\u0000` })),
    );

    expect(error).toEqual(new UpstreamProviderError());
    expect(String(error)).not.toContain(secret);
    expect(inspect(error)).not.toContain(secret);
    expect(Object.keys(provider)).toEqual([]);
    expect({ ...provider }).toEqual({});
    expect(inspect(provider)).not.toContain('X-Auth-User');
  });
});

function setup(
  overrides: Partial<
    ConstructorParameters<typeof TrustedHeaderAuthProvider>[0]
  > = {},
) {
  return new TrustedHeaderAuthProvider({
    trustProxy: ['10.0.0.0/8'],
    identityHeader: 'X-Auth-User',
    publicOrigin: PUBLIC_ORIGIN,
    ...overrides,
  });
}

function request(
  options: Readonly<{
    remoteAddress?: string;
    xForwardedFor?: string | readonly string[] | undefined;
    xForwardedProto?: string | readonly string[] | undefined;
    xForwardedHost?: string | readonly string[] | undefined;
    identity?: string | readonly string[] | undefined;
  }> = {},
): TrustedHeaderRequest {
  const identity =
    options.identity === undefined && !Object.hasOwn(options, 'identity')
      ? 'person@example.test'
      : options.identity;
  return {
    remoteAddress: options.remoteAddress ?? '10.0.0.2',
    headers: {
      host: 'internal:3000',
      'x-forwarded-for':
        options.xForwardedFor === undefined &&
        !Object.hasOwn(options, 'xForwardedFor')
          ? '198.51.100.1'
          : options.xForwardedFor,
      'x-forwarded-proto':
        options.xForwardedProto === undefined &&
        !Object.hasOwn(options, 'xForwardedProto')
          ? 'https'
          : options.xForwardedProto,
      'x-forwarded-host':
        options.xForwardedHost === undefined &&
        !Object.hasOwn(options, 'xForwardedHost')
          ? 'terminal.example.test'
          : options.xForwardedHost,
      'x-auth-user': identity,
    },
    headersDistinct: {
      'x-auth-user':
        identity === undefined
          ? undefined
          : typeof identity === 'string'
            ? [identity]
            : identity,
    },
  };
}

function sendIdentityRequest(
  port: number,
  identity: string | readonly string[],
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const headers: IncomingHttpHeaders = {
      host: 'internal:3000',
      'x-forwarded-for': '198.51.100.1',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'terminal.example.test',
      'X-Auth-User': [
        ...(typeof identity === 'string' ? [identity] : identity),
      ],
    };
    const outgoing = createHttpRequest(
      { host: '127.0.0.1', port, method: 'GET', headers },
      (incoming) => {
        incoming.resume();
        incoming.once('end', () => resolve(incoming.statusCode));
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function rawHeaderValues(rawHeaders: readonly string[], wanted: string) {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === wanted)
      values.push(rawHeaders[index + 1]!);
  }
  return values;
}

function expectProviderError(operation: () => unknown) {
  const error = captureError(operation);
  expect(error).toBeInstanceOf(UpstreamProviderError);
  expect(error).toMatchObject({
    message: 'Upstream identity validation failed',
  });
  expect(error).not.toHaveProperty('cause');
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
