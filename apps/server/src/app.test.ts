import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { loadConfig } from './config.js';

let clientDist: string;
let server: Server | undefined;

beforeEach(async () => {
  clientDist = await mkdtemp(join(tmpdir(), 'flanterminal-app-'));
  await writeFile(join(clientDist, 'index.html'), '<main>terminal app</main>');
  await writeFile(join(clientDist, 'app.js'), 'console.log("app")');
  await writeFile(join(clientDist, '.ssh'), 'private');
  await mkdir(join(clientDist, 'assets'));
  await writeFile(join(clientDist, 'assets', 'manifest'), 'asset manifest');
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(clientDist, { recursive: true, force: true });
});

describe('createApp', () => {
  it('reports structured health metrics without configuration secrets', async () => {
    const response = await request('/health');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      activeSessions: 2,
      connectedWebSockets: 3,
      memory: { rss: expect.any(Number), heapUsed: expect.any(Number) },
      uptimeSeconds: expect.any(Number),
    });
    expect(JSON.stringify(body)).not.toContain('/bin/bash');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it.each([
    [true, 200, { status: 'ready', ready: true }],
    [false, 503, { status: 'not_ready', ready: false }],
  ])('maps readiness %s to HTTP %s', async (ready, status, body) => {
    const response = await request('/ready', { ready });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it('serves only strict browser-safe configuration with no-store', async () => {
    const response = await request('/terminal/api/config');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      basePath: '/terminal',
      sessionId: 'phase-1-main',
      fontSize: 14,
      scrollback: 10_000,
      resizeDebounceMs: 100,
      reconnectMaxSeconds: 15,
    });
  });

  it('sets helmet security headers', async () => {
    const response = await request('/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBeTruthy();
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('serves static assets and extensionless SPA navigation only under the base', async () => {
    expect((await request('/terminal/app.js')).status).toBe(200);
    expect(
      await (await request('/terminal/dashboard/session')).text(),
    ).toContain('terminal app');
    expect((await request('/terminal/missing.js')).status).toBe(404);
    expect((await request('/outside')).status).toBe(404);
    expect((await request('/terminal/api/unknown')).status).toBe(404);
  });

  it.each(['/terminal', '/terminal/dashboard/session', '/terminal/a/'])(
    'redirects noncanonical workspace path %s to the mounted root',
    async (path) => {
      const response = await request(path, {
        redirect: 'manual',
      });
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe('/terminal/');
    },
  );

  it.each([
    '/terminal/.ssh',
    '/terminal/home/user/id_rsa',
    '/terminal/%2e%2e/.ssh/id_rsa',
    '/terminal/%2Essh',
    '/terminal/private.key',
  ])('never serves sensitive or traversal-like path %s', async (path) => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('private');
  });

  it('supports static assets and navigation at the root base', async () => {
    expect((await request('/app.js', { basePath: '/' })).status).toBe(200);
    expect(
      await (await request('/sessions', { basePath: '/' })).text(),
    ).toContain('terminal app');
    expect((await request('/missing.css', { basePath: '/' })).status).toBe(404);
  });

  it.each(['/terminal/assets/missing', '/terminal/assets/nested/missing'])(
    'returns JSON 404 for an unknown extensionless asset under a nonroot base: %s',
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({ error: 'not_found' });
    },
  );

  it.each([
    ['/terminal/%61pi/unknown', '/terminal'],
    ['/terminal/%61ssets/missing', '/terminal'],
    ['/terminal/%73tatic/missing', '/terminal'],
    ['/terminal/%77s/unknown', '/terminal'],
    ['/terminal/missing%2ejs', '/terminal'],
    ['/%61pi/unknown', '/'],
    ['/%61ssets/missing', '/'],
    ['/%73tatic/missing', '/'],
    ['/%77s/unknown', '/'],
    ['/missing%2ejs', '/'],
    ['/terminal/%zz', '/terminal'],
    ['/%zz', '/'],
  ])(
    'never serves SPA fallback for encoded non-navigation path %s',
    async (path, basePath) => {
      const response = await request(path, { basePath });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('terminal app');
    },
  );

  it.each([
    ['/terminal/assets%2fmissing', '/terminal'],
    ['/terminal/assets%5cmissing', '/terminal'],
    ['/assets%2fmissing', '/'],
    ['/assets%5cmissing', '/'],
  ])(
    'rejects encoded path separators without double decoding: %s',
    async (path, basePath) => {
      const response = await request(path, { basePath });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('terminal app');
    },
  );

  it.each(['/assets/missing', '/assets/nested/missing'])(
    'returns JSON 404 for an unknown extensionless asset under the root base: %s',
    async (path) => {
      const response = await request(path, { basePath: '/' });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({ error: 'not_found' });
    },
  );

  it('serves an existing extensionless asset before the reserved namespace fallback', async () => {
    const response = await request('/terminal/assets/manifest');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('asset manifest');
  });

  it.each([
    ['/terminal/api/unknown', '/terminal'],
    ['/api/unknown', '/'],
    ['/terminal/static/missing', '/terminal'],
    ['/static/missing', '/'],
    ['/terminal/ws/unknown', '/terminal'],
    ['/ws/unknown', '/'],
  ])(
    'returns JSON 404 for an unknown reserved route: %s',
    async (path, basePath) => {
      const response = await request(path, { basePath });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({ error: 'not_found' });
    },
  );
});

async function request(
  path: string,
  options: {
    ready?: boolean;
    basePath?: string;
    redirect?: RequestRedirect;
  } = {},
): Promise<Response> {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  const app = createApp({
    config: config(options.basePath ?? '/terminal'),
    readiness: { isReady: vi.fn(() => options.ready ?? true) },
    metrics: {
      activeSessionCount: vi.fn(() => 2),
      connectedWebSocketCount: vi.fn(() => 3),
    },
    clientDist,
  });
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('listen failed');
  return fetch(
    `http://127.0.0.1:${address.port}${path}`,
    options.redirect === undefined ? {} : { redirect: options.redirect },
  );
}

function config(basePath: string) {
  return loadConfig({
    APP_BASE_PATH: basePath,
    DEFAULT_SHELL: '/bin/bash',
    HOME_DIR: '/home/secret',
  });
}
