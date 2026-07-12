import {
  createTabBodySchema,
  renameTabBodySchema,
  reorderTabsBodySchema,
  tabIdSchema,
  type TabCollection,
  type TabCollectionResponse,
  type TabRecord,
  type TabView,
} from '@flanterminal/shared';
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';

import { SessionManagerError } from './session-manager.js';
import { TabStoreError } from './tab-store.js';

const MAX_JSON_BYTES = 16 * 1024;

export interface TabRouteStore {
  create(displayName?: string): Promise<TabRecord>;
  rename(id: string, displayName: string): Promise<TabRecord>;
  reorder(
    structureRevision: number,
    ids: readonly string[],
  ): Promise<TabCollection>;
}

export interface TabRouteSessions {
  collectionView(): Promise<TabCollectionResponse>;
  view(id: string): Promise<TabView>;
  terminate(id: string): Promise<TabView>;
  recreate(id: string): Promise<TabView>;
  restart(id: string): Promise<TabView>;
  restartBridge(id: string): Promise<TabView>;
  closeTab(id: string): Promise<void>;
}

export type TabRouterOptions = Readonly<{
  publicOrigin: string;
  store: TabRouteStore;
  sessions: TabRouteSessions;
}>;

export function createTabRouter(options: TabRouterOptions): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const parseJson = express.json({ limit: MAX_JSON_BYTES, strict: true });

  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!isMutation(request.method)) {
      if (!hasCanonicalApiMount(request)) {
        response.status(404).json({ error: 'not_found' });
        return;
      }
      if (hasEncodedPath(request)) {
        sendError(response, 400, 'invalid_request');
        return;
      }
      next();
      return;
    }
    if (!hasExactOrigin(request, options.publicOrigin)) {
      sendError(response, 403, 'origin_forbidden');
      return;
    }
    if (!hasCanonicalApiMount(request)) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (hasEncodedPath(request)) {
      sendError(response, 400, 'invalid_request');
      return;
    }
    if (request.method === 'DELETE') {
      next();
      return;
    }
    if (!request.is('application/json')) {
      sendError(response, 415, 'json_required');
      return;
    }
    parseJson(request, response, next);
  });

  router.get('/tabs', async (_request, response) => {
    response.json(await options.sessions.collectionView());
  });

  router.post('/tabs', async (request, response) => {
    const body = parseBody(createTabBodySchema, request.body);
    const tab = await options.store.create(body.displayName);
    response.status(201).json(await options.sessions.view(tab.id));
  });

  router.put('/tabs/order', async (request, response) => {
    const body = parseBody(reorderTabsBodySchema, request.body);
    await options.store.reorder(body.structureRevision, body.ids);
    response.json(await options.sessions.collectionView());
  });

  router.patch('/tabs/:id', async (request, response) => {
    const id = parseId(request.params.id);
    const body = parseBody(renameTabBodySchema, request.body);
    await options.store.rename(id, body.displayName);
    response.json(await options.sessions.view(id));
  });

  router.delete('/tabs/:id', async (request, response) => {
    const id = parseId(request.params.id);
    await options.sessions.closeTab(id);
    response.status(204).end();
  });

  router.get('/tabs/:id/session', async (request, response) => {
    response.json(await options.sessions.view(parseId(request.params.id)));
  });

  router.post('/tabs/:id/session/terminate', async (request, response) => {
    parseEmptyBody(request.body);
    response.json(await options.sessions.terminate(parseId(request.params.id)));
  });

  router.post('/tabs/:id/session/recreate', async (request, response) => {
    parseEmptyBody(request.body);
    response.json(await options.sessions.recreate(parseId(request.params.id)));
  });

  router.post('/tabs/:id/session/restart', async (request, response) => {
    parseEmptyBody(request.body);
    response.json(await options.sessions.restart(parseId(request.params.id)));
  });

  router.post('/tabs/:id/session/bridge/restart', async (request, response) => {
    parseEmptyBody(request.body);
    response.json(
      await options.sessions.restartBridge(parseId(request.params.id)),
    );
  });

  router.use((_request, response) => {
    response.status(404).json({ error: 'not_found' });
  });

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      void _next;
      const mapped = mapError(error);
      sendError(response, mapped.status, mapped.code);
    },
  );

  return router;
}

const emptyBodySchema = createTabBodySchema.pick({}).strict();

function parseEmptyBody(value: unknown): void {
  parseBody(emptyBodySchema, value);
}

function parseBody<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidRequestError();
  return parsed.data;
}

function parseId(value: string | undefined): string {
  const parsed = tabIdSchema.safeParse(value);
  if (!parsed.success) throw new InvalidRequestError();
  return parsed.data;
}

function isMutation(method: string): boolean {
  return (
    method === 'POST' ||
    method === 'PATCH' ||
    method === 'PUT' ||
    method === 'DELETE'
  );
}

function hasExactOrigin(request: Request, expected: string): boolean {
  const origins: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'origin') {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) origins.push(value);
    }
  }
  return origins.length === 1 && origins[0] === expected;
}

function hasEncodedPath(request: Request): boolean {
  return request.originalUrl.split('?', 1)[0]?.includes('%') === true;
}

function hasCanonicalApiMount(request: Request): boolean {
  return request.baseUrl.endsWith('/api');
}

class InvalidRequestError extends Error {}

function mapError(error: unknown): {
  status: number;
  code:
    | 'invalid_request'
    | 'tab_not_found'
    | 'session_limit'
    | 'order_conflict'
    | 'invalid_session_state'
    | 'operation_failed';
} {
  if (error instanceof InvalidRequestError || isJsonParseError(error)) {
    return { status: 400, code: 'invalid_request' };
  }
  const code =
    error instanceof TabStoreError || error instanceof SessionManagerError
      ? error.code
      : undefined;
  if (code === 'tab_not_found') return { status: 404, code };
  if (
    code === 'session_limit' ||
    code === 'order_conflict' ||
    code === 'invalid_session_state'
  ) {
    return { status: 409, code };
  }
  return { status: 500, code: 'operation_failed' };
}

function isJsonParseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const type = Reflect.get(error, 'type');
  return type === 'entity.parse.failed' || type === 'entity.too.large';
}

function sendError(response: Response, status: number, error: string): void {
  response.status(status).json({ error });
}
