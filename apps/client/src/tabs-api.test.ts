import { describe, expect, it, vi } from 'vitest';

import { TabApiError, createTabsApi } from './tabs-api.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const view = {
  id: ID,
  displayName: 'Terminal 1',
  position: 0,
  createdAt: '2026-07-11T00:00:00.000Z',
  lastActivityAt: '2026-07-11T00:00:00.000Z',
  desiredState: 'active' as const,
  session: { state: 'running' as const, attached: false, bridgePid: null },
};

describe('createTabsApi', () => {
  it('uses the configured base path and strict same-origin requests', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ structureRevision: 0, tabs: [view] }),
    );
    const api = createTabsApi('/terminal', fetchImpl);

    await expect(api.list()).resolves.toEqual({
      structureRevision: 0,
      tabs: [view],
    });
    expect(fetchImpl).toHaveBeenCalledWith('/terminal/api/tabs', {
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'GET',
    });
  });

  it('sends validated JSON mutations without setting Origin manually', async () => {
    const fetchImpl = vi.fn(async () => Response.json(view, { status: 201 }));
    const api = createTabsApi('/', fetchImpl);

    await expect(api.create('Shell')).resolves.toEqual(view);
    expect(fetchImpl).toHaveBeenCalledWith('/api/tabs', {
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Shell' }),
    });
  });

  it('supports rename, reorder, close, health, and lifecycle routes', async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith('/order')) {
          return Response.json({ structureRevision: 2, tabs: [view] });
        }
        if (path.endsWith(`/${ID}`) && init?.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        return Response.json(view);
      },
    );
    const api = createTabsApi('/terminal', fetchImpl);

    await api.rename(ID, 'Renamed');
    await api.reorder(1, [ID]);
    await api.health(ID);
    await api.terminate(ID);
    await api.recreate(ID);
    await api.restart(ID);
    await api.restartBridge(ID);
    await api.close(ID);

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `/terminal/api/tabs/${ID}`,
      '/terminal/api/tabs/order',
      `/terminal/api/tabs/${ID}/session`,
      `/terminal/api/tabs/${ID}/session/terminate`,
      `/terminal/api/tabs/${ID}/session/recreate`,
      `/terminal/api/tabs/${ID}/session/restart`,
      `/terminal/api/tabs/${ID}/bridge/restart`,
      `/terminal/api/tabs/${ID}`,
    ]);
  });

  it.each([
    new Response('private terminal response', { status: 500 }),
    Response.json(
      { error: 'order_conflict', private: 'secret' },
      { status: 409 },
    ),
    Response.json({ ...view, extra: 'private' }),
  ])(
    'returns a bounded error for failed or invalid responses',
    async (response) => {
      const api = createTabsApi(
        '/',
        vi.fn(async () => response.clone()),
      );
      const error = await api.list().catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(TabApiError);
      expect(String(error)).not.toMatch(/private|secret|terminal response/);
    },
  );

  it('preserves a recognized API error code for conflict recovery', async () => {
    const api = createTabsApi(
      '/',
      vi.fn(async () =>
        Response.json({ error: 'order_conflict' }, { status: 409 }),
      ),
    );

    await expect(api.reorder(3, [ID])).rejects.toMatchObject({
      name: 'TabApiError',
      code: 'order_conflict',
    });
  });

  it('bounds locally invalid mutation arguments before issuing a request', async () => {
    const fetchImpl = vi.fn();
    const api = createTabsApi('/', fetchImpl);

    const error = await api
      .rename('../private', '\u0000secret')
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TabApiError);
    expect(String(error)).not.toMatch(/private|secret|Zod|displayName/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
