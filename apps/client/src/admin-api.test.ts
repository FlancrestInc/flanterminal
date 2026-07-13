import type { AdminSnapshot } from '@flanterminal/shared';
import { describe, expect, it, vi } from 'vitest';

import { AdminApiError, createAdminApi } from './admin-api.js';

const TAB_ID = '123e4567-e89b-42d3-a456-426614174000';

const snapshot: AdminSnapshot = {
  generatedAt: '2026-07-13T12:00:00.000Z',
  uptimeSeconds: 3600,
  memory: { rss: 64_000_000, heapUsed: 24_000_000 },
  totals: { tabs: 1, runningSessions: 1, bridges: 1, webSockets: 1 },
  cleanup: { enabled: true, running: false, lastRunAt: null },
  sessions: [
    {
      id: TAB_ID,
      displayName: 'Gospel',
      tmuxSessionName: `webterm-${TAB_ID}`,
      desiredState: 'active',
      observedState: 'running',
      createdAt: '2026-07-13T11:00:00.000Z',
      lastActivityAt: '2026-07-13T11:59:00.000Z',
      ageSeconds: 3600,
      connectedWebSockets: 1,
      bridgePid: 402,
      cleanupEligible: false,
      lifecycleError: null,
    },
  ],
};

describe('admin api', () => {
  it('loads a strict immutable snapshot through the mounted private path', async () => {
    const privateFetch = vi.fn<typeof fetch>(async () =>
      Response.json(snapshot),
    );
    const api = createAdminApi(
      '/tools/terminal',
      privateFetch,
      'https://host.example/tools/terminal/',
    );

    const result = await api.load();

    expect(privateFetch).toHaveBeenCalledWith(
      new URL('https://host.example/tools/terminal/api/admin'),
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        credentials: 'include',
      }),
    );
    expect(result).toEqual(snapshot);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sessions)).toBe(true);
  });

  it('rejects malformed or extended snapshot payloads with a bounded error', async () => {
    const privateFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ ...snapshot, secret: 'must-not-cross-boundary' }),
    );
    const api = createAdminApi('/', privateFetch, 'https://host.example/');

    await expect(api.load()).rejects.toEqual(expect.any(AdminApiError));
    await expect(api.load()).rejects.toMatchObject({
      message: 'Administration request failed.',
    });
  });

  it.each([
    'restart_bridge',
    'terminate',
    'recreate',
    'restart_session',
  ] as const)('posts the exact %s session action body', async (action) => {
    const privateFetch = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    const api = createAdminApi('/terminal', privateFetch, 'https://host/');

    await api.sessionAction(TAB_ID, action);

    const [url, init] = privateFetch.mock.calls[0]!;
    expect(url).toEqual(
      new URL(`https://host/terminal/api/admin/sessions/${TAB_ID}`),
    );
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  });

  it('posts an exact empty cleanup body and strictly parses the result', async () => {
    const result = {
      disabled: false,
      examined: 2,
      terminated: 1,
      skipped: 1,
      failed: 0,
      startedAt: '2026-07-13T12:00:00.000Z',
      finishedAt: '2026-07-13T12:00:01.000Z',
    };
    const privateFetch = vi.fn<typeof fetch>(async () => Response.json(result));
    const api = createAdminApi('/terminal', privateFetch, 'https://host/');

    await expect(api.cleanup()).resolves.toEqual(result);
    const [, init] = privateFetch.mock.calls[0]!;
    expect(init?.body).toBe('{}');
  });

  it('validates IDs locally and preserves 401 status without exposing response data', async () => {
    const privateFetch = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: 'authentication_required', detail: 'secret' },
        { status: 401 },
      ),
    );
    const api = createAdminApi('/terminal', privateFetch, 'https://host/');

    await expect(
      api.sessionAction('../bad', 'terminate'),
    ).rejects.toMatchObject({
      message: 'Administration request failed.',
    });
    expect(privateFetch).not.toHaveBeenCalled();
    await expect(api.load()).rejects.toMatchObject({ status: 401 });
  });
});
