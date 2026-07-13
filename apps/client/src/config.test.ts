import { describe, expect, it, vi } from 'vitest';

import { ClientConfigLoadError, loadClientConfig } from './config.js';

const validConfig = {
  basePath: '/terminal/',
  fontSize: 14,
  scrollback: 5_000,
  resizeDebounceMs: 100,
  reconnectMaxSeconds: 8,
};

describe('loadClientConfig', () => {
  it('loads strict config relative to the mounted document base', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(validConfig), { status: 200 }),
    );

    await expect(
      loadClientConfig({
        baseUrl: 'https://host.example/tools/terminal/',
        fetchImpl,
      }),
    ).resolves.toEqual({ ...validConfig, basePath: '/terminal' });

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://host.example/tools/terminal/api/config'),
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
      }),
    );
  });

  it.each([
    new Response('private response body', { status: 503 }),
    new Response('{"basePath":"/secret/","extra":"private"}', {
      status: 200,
    }),
  ])(
    'returns a bounded safe error without response details',
    async (response) => {
      const fetchImpl = vi.fn(async () => response.clone());

      const error = await loadClientConfig({
        baseUrl: 'https://host.example/terminal/',
        fetchImpl,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ClientConfigLoadError);
      expect(String(error)).toBe(
        'ClientConfigLoadError: Unable to load terminal configuration.',
      );
      expect(String(error)).not.toMatch(/private|secret|503|basePath/);
    },
  );

  it('passes through abort cancellation', async () => {
    const controller = new AbortController();
    const abortError = new DOMException(
      'cancelled request detail',
      'AbortError',
    );
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal);
        throw abortError;
      },
    );

    await expect(
      loadClientConfig({
        signal: controller.signal,
        baseUrl: 'https://host.example/terminal/',
        fetchImpl,
      }),
    ).rejects.toBe(abortError);
  });
});
