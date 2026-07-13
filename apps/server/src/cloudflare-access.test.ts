import { inspect } from 'node:util';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type FetchImplementation,
  type JWTPayload,
} from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  CloudflareAccessProvider,
  UpstreamProviderError,
  type CloudflareJwtVerifier,
} from './cloudflare-access.js';

const TEAM = 'https://team.cloudflareaccess.com';
const AUDIENCE = 'audience_123';
const NOW = Date.UTC(2026, 6, 12, 12);

describe('CloudflareAccessProvider', () => {
  it('requires one bounded assertion header', async () => {
    const verifier = verifierFor({ exp: NOW / 1000 + 60, sub: 'person-1' });
    const provider = setup({ verifier });

    await expectProviderError(provider.authenticate({}));
    await expectProviderError(
      provider.authenticate({ 'cf-access-jwt-assertion': ['one', 'two'] }),
    );
    await expectProviderError(
      provider.authenticate({
        'Cf-Access-Jwt-Assertion': 'one',
        'cf-access-jwt-assertion': 'two',
      }),
    );
    await expectProviderError(
      provider.authenticate({
        'cf-access-jwt-assertion': 'x'.repeat(16 * 1024 + 1),
      }),
    );
    await expectProviderError(
      provider.authenticate({ 'cf-access-jwt-assertion': 'not a jwt' }),
    );
    expect(verifier).not.toHaveBeenCalled();
  });

  it('passes an RS256-only exact issuer and audience policy to verification', async () => {
    const verifier = verifierFor({
      exp: NOW / 1000 + 60,
      email: 'person@example.test',
      sub: 'ignored',
    });
    const provider = setup({ verifier });

    await expect(
      provider.authenticate({
        ...assertion('a.b.c'),
        'cf-access-authenticated-user-email': 'attacker@example.test',
      }),
    ).resolves.toEqual({
      mode: 'cloudflare-access',
      identityLabel: 'person@example.test',
      expiresAt: NOW + 60_000,
    });
    const options = verifier.mock.calls[0]?.[2];
    expect(options).toMatchObject({
      algorithms: ['RS256'],
      issuer: TEAM,
      audience: AUDIENCE,
      requiredClaims: ['exp'],
      clockTolerance: 5,
      currentDate: new Date(NOW),
    });
    expect(
      Object.isFrozen(await provider.authenticate(assertion('a.b.c'))),
    ).toBe(true);
  });

  it('uses jose to reject wrong algorithms, signatures, issuers, and audiences', async () => {
    const rsa = await signingKey('rsa');
    const other = await signingKey('rsa');
    const ec = await signingKey('ec');
    const provider = setup({ fetch: jwksFetch([rsa.publicJwk]) });
    const validClaims = { iss: TEAM, aud: AUDIENCE, exp: NOW / 1000 + 60 };
    const valid = await sign(rsa, validClaims);

    await expect(
      provider.authenticate(assertion(valid)),
    ).resolves.toMatchObject({
      identityLabel: 'person@example.test',
    });
    await expectProviderError(
      provider.authenticate(assertion(await sign(other, validClaims))),
    );
    await expectProviderError(
      provider.authenticate(assertion(await sign(ec, validClaims))),
    );
    await expectProviderError(
      provider.authenticate(
        assertion(await sign(rsa, { ...validClaims, iss: `${TEAM}/wrong` })),
      ),
    );
    await expectProviderError(
      provider.authenticate(
        assertion(await sign(rsa, { ...validClaims, aud: 'wrong' })),
      ),
    );
  });

  it('accepts the configured audience in a JWT audience array', async () => {
    const key = await signingKey('rsa');
    const provider = setup({ fetch: jwksFetch([key.publicJwk]) });
    const token = await sign(key, {
      iss: TEAM,
      aud: ['other', AUDIENCE],
      exp: NOW / 1000 + 60,
    });

    await expect(
      provider.authenticate(assertion(token)),
    ).resolves.toMatchObject({
      mode: 'cloudflare-access',
      expiresAt: NOW + 60_000,
    });
  });

  it.each<readonly [JWTPayload, string]>([
    [{ sub: 'person' }, 'missing expiration'],
    [{ exp: NOW / 1000 }, 'expired'],
    [{ exp: NOW / 1000 + 60, nbf: NOW / 1000 + 6 }, 'not active'],
    [{ exp: NOW / 1000 + 86_401 }, 'excessive lifetime'],
    [{ exp: Number.MAX_SAFE_INTEGER, sub: 'person' }, 'unsafe expiration'],
  ])('rejects invalid temporal claims: %s (%s)', async (claims) => {
    const provider = setup({ verifier: verifierFor(claims) });
    await expectProviderError(provider.authenticate(assertion('a.b.c')));
  });

  it('prefers a valid normalized email and otherwise requires a stable sub', async () => {
    const email = setup({
      verifier: verifierFor({
        exp: NOW / 1000 + 60,
        email: 'cafe\u0301@example.test',
        sub: 'subject',
      }),
    });
    const fallback = setup({
      verifier: verifierFor({
        exp: NOW / 1000 + 60,
        email: 'not-an-email',
        sub: 'stable-subject',
      }),
    });
    const absent = setup({
      verifier: verifierFor({ exp: NOW / 1000 + 60 }),
    });

    await expect(email.authenticate(assertion('a.b.c'))).resolves.toMatchObject(
      {
        identityLabel: 'café@example.test',
      },
    );
    await expect(
      fallback.authenticate(assertion('a.b.c')),
    ).resolves.toMatchObject({ identityLabel: 'stable-subject' });
    await expectProviderError(absent.authenticate(assertion('a.b.c')));
  });

  it.each([
    '',
    'a'.repeat(129),
    '\u0000person',
    'per\u200bson',
    'per\u2028son',
    'per\u2029son',
    '\ud800',
  ])('rejects unsafe identity claim %j', async (sub) => {
    const provider = setup({
      verifier: verifierFor({ exp: NOW / 1000 + 60, sub }),
    });
    await expectProviderError(provider.authenticate(assertion('a.b.c')));
  });

  it('bounds remote JWKS timeout and reports only a generic failure', async () => {
    const key = await signingKey('rsa', 'timeout-key');
    const token = await sign(key, {
      iss: TEAM,
      aud: AUDIENCE,
      exp: NOW / 1000 + 60,
    });
    let aborted = false;
    const fetch: FetchImplementation = vi.fn(
      async (_url, options) =>
        await new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error(`timed out while fetching ${token}`));
            },
            { once: true },
          );
        }),
    );
    const provider = setup({ fetch, jwksTimeoutMs: 20 });
    const startedAt = performance.now();

    const error = await provider
      .authenticate(assertion(token))
      .catch((caught: unknown) => caught);
    expect(fetch).toHaveBeenCalledOnce();
    expect(aborted).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(error).toEqual(new UpstreamProviderError());
    expect(String(error)).not.toContain(token);
    expect(inspect(error)).not.toContain(token);
  });

  it('caches successful JWKS fetches and refreshes for a rotated key', async () => {
    const first = await signingKey('rsa', 'first');
    const second = await signingKey('rsa', 'second');
    const fetch = rotatingJwksFetch([
      [first.publicJwk],
      [first.publicJwk, second.publicJwk],
    ]);
    const provider = setup({ fetch, jwksCooldownMs: 0 });
    const claims = { iss: TEAM, aud: AUDIENCE, exp: NOW / 1000 + 60 };
    const firstToken = await sign(first, claims);
    const secondToken = await sign(second, claims);

    await provider.authenticate(assertion(firstToken));
    await provider.authenticate(assertion(firstToken));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${TEAM}/cdn-cgi/access/certs`);
    await provider.authenticate(assertion(secondToken));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('validates constructor inputs and exposes no assertion or private state', async () => {
    expect(() =>
      setup({ teamOrigin: 'http://team.cloudflareaccess.com' }),
    ).toThrow(new UpstreamProviderError());
    expect(() => setup({ teamOrigin: `${TEAM}/path` })).toThrow(
      new UpstreamProviderError(),
    );
    for (const teamOrigin of [
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.1',
      'https://[::1]',
      'https://example.com',
      'https://cloudflareaccess.com',
      'https://a.b.cloudflareaccess.com',
      'https://team.cloudflareaccess.com.evil.test',
      'https://-team.cloudflareaccess.com',
      'https://team-.cloudflareaccess.com',
      `https://${'a'.repeat(64)}.cloudflareaccess.com`,
    ]) {
      expect(() => setup({ teamOrigin })).toThrow(new UpstreamProviderError());
    }
    expect(() =>
      setup({ teamOrigin: 'https://my-team.cloudflareaccess.com' }),
    ).not.toThrow();
    expect(() => setup({ audience: '' })).toThrow(new UpstreamProviderError());
    expect(() => setup({ clockToleranceSeconds: 31 })).toThrow(
      new UpstreamProviderError(),
    );
    expect(() => setup({ jwksTimeoutMs: 9 })).toThrow(
      new UpstreamProviderError(),
    );
    expect(() => setup({ jwksCooldownMs: 300_001 })).toThrow(
      new UpstreamProviderError(),
    );
    expect(() => setup({ jwksCacheMaxAgeMs: 999 })).toThrow(
      new UpstreamProviderError(),
    );

    const provider = setup({
      verifier: verifierFor({ exp: NOW / 1000 + 60, sub: 'person' }),
    });
    const token = 'secret.token.value';
    await provider.authenticate(assertion(token));
    expect(Object.keys(provider)).toEqual([]);
    expect({ ...provider }).toEqual({});
    expect(inspect(provider)).not.toContain(token);
  });
});

function setup(
  overrides: Partial<
    ConstructorParameters<typeof CloudflareAccessProvider>[0]
  > = {},
) {
  return new CloudflareAccessProvider({
    teamOrigin: TEAM,
    audience: AUDIENCE,
    clock: () => NOW,
    ...overrides,
  });
}

function assertion(value: string) {
  return { 'cf-access-jwt-assertion': value };
}

function verifierFor(payload: JWTPayload) {
  return vi.fn<CloudflareJwtVerifier>(async () => ({
    payload,
    protectedHeader: { alg: 'RS256' },
  }));
}

async function signingKey(kind: 'rsa' | 'ec', kid = 'key') {
  const algorithm = kind === 'rsa' ? 'RS256' : 'ES256';
  const pair = await generateKeyPair(algorithm, { extractable: true });
  return {
    algorithm,
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      ...(await exportJWK(pair.publicKey)),
      kid,
      alg: algorithm,
      use: 'sig',
    },
  };
}

async function sign(
  key: Awaited<ReturnType<typeof signingKey>>,
  claims: JWTPayload,
) {
  return await new SignJWT({
    email: 'person@example.test',
    sub: 'stable-subject',
    ...claims,
  })
    .setProtectedHeader({ alg: key.algorithm, kid: key.kid })
    .sign(key.privateKey);
}

function jwksFetch(keys: readonly JsonWebKey[]) {
  return vi.fn<FetchImplementation>(async () =>
    Response.json(
      { keys },
      { headers: { 'content-type': 'application/json' } },
    ),
  );
}

function rotatingJwksFetch(responses: readonly (readonly JsonWebKey[])[]) {
  let index = 0;
  return vi.fn<FetchImplementation>(async () => {
    const keys = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return Response.json(
      { keys },
      { headers: { 'content-type': 'application/json' } },
    );
  });
}

async function expectProviderError(promise: Promise<unknown>) {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(UpstreamProviderError);
  expect(caught).toMatchObject({
    message: 'Upstream identity validation failed',
  });
  expect(caught).not.toHaveProperty('cause');
}
