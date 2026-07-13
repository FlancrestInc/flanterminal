import {
  createTabBodySchema,
  renameTabBodySchema,
  reorderTabsBodySchema,
  tabIdSchema,
  type CreateTabBody,
  type RenameTabBody,
  type ReorderTabsBody,
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

import {
  requireAuthentication,
  requireMutationSecurity,
  touchHttpActivity,
  type AuthMiddlewareOptions,
} from './auth-middleware.js';
import { SessionManagerError } from './session-manager.js';
import { TabStoreError } from './tab-store.js';

const MAX_JSON_BYTES = 16 * 1024;
const INVALID_BODY_ERROR_TYPES = new Set([
  'charset.unsupported',
  'encoding.unsupported',
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
  'request.aborted',
  'request.size.invalid',
]);
const INVALID_COMPRESSION_ERROR_CODES = new Set([
  'Z_BUF_ERROR',
  'Z_DATA_ERROR',
  'Z_NEED_DICT',
]);

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

export type TabRouterOptions = AuthMiddlewareOptions &
  Readonly<{
    store: TabRouteStore;
    sessions: TabRouteSessions;
  }>;

export function createTabRouter(options: TabRouterOptions): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const parseJson = express.json({ limit: MAX_JSON_BYTES, strict: true });
  const requireAuth = requireAuthentication(options);
  const requireMutation = requireMutationSecurity(options);
  const touch = touchHttpActivity(options);

  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!hasCanonicalApiMount(request)) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (hasEncodedPath(request)) {
      sendError(response, 400, 'invalid_request');
      return;
    }
    next();
  });

  router.get('/tabs', requireAuth, touch, async (_request, response) => {
    response.json(await options.sessions.collectionView());
  });

  router.post(
    '/tabs',
    requireAuth,
    requireMutation,
    parseRequestBody(parseJson),
    validateBody(createTabBodySchema),
    touch,
    async (_request, response) => {
      const body = validatedBody<CreateTabBody>(response);
      const tab = await options.store.create(body.displayName);
      response.status(201).json(await options.sessions.view(tab.id));
    },
  );

  router.put(
    '/tabs/order',
    requireAuth,
    requireMutation,
    parseRequestBody(parseJson),
    validateBody(reorderTabsBodySchema),
    touch,
    async (_request, response) => {
      const body = validatedBody<ReorderTabsBody>(response);
      await options.store.reorder(body.structureRevision, body.ids);
      response.json(await options.sessions.collectionView());
    },
  );

  router.patch(
    '/tabs/:id',
    requireAuth,
    requireMutation,
    parseRequestBody(parseJson),
    validateId,
    validateBody(renameTabBodySchema),
    touch,
    async (_request, response) => {
      const id = validatedId(response);
      const body = validatedBody<RenameTabBody>(response);
      await options.store.rename(id, body.displayName);
      response.json(await options.sessions.view(id));
    },
  );

  router.delete(
    '/tabs/:id',
    requireAuth,
    requireMutation,
    validateId,
    touch,
    async (_request, response) => {
      const id = validatedId(response);
      await options.sessions.closeTab(id);
      response.status(204).end();
    },
  );

  router.get(
    '/tabs/:id/session',
    requireAuth,
    validateId,
    touch,
    async (_request, response) => {
      response.json(await options.sessions.view(validatedId(response)));
    },
  );

  router.post(
    '/tabs/:id/session/terminate',
    ...securedJsonMutation(options, parseJson, touch),
    async (_request, response) => {
      response.json(await options.sessions.terminate(validatedId(response)));
    },
  );

  router.post(
    '/tabs/:id/session/recreate',
    ...securedJsonMutation(options, parseJson, touch),
    async (_request, response) => {
      response.json(await options.sessions.recreate(validatedId(response)));
    },
  );

  router.post(
    '/tabs/:id/session/restart',
    ...securedJsonMutation(options, parseJson, touch),
    async (_request, response) => {
      response.json(await options.sessions.restart(validatedId(response)));
    },
  );

  router.post(
    '/tabs/:id/bridge/restart',
    ...securedJsonMutation(options, parseJson, touch),
    async (_request, response) => {
      response.json(
        await options.sessions.restartBridge(validatedId(response)),
      );
    },
  );

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

function securedJsonMutation(
  options: TabRouterOptions,
  parser: express.RequestHandler,
  touch: express.RequestHandler,
): express.RequestHandler[] {
  return [
    requireAuthentication(options),
    requireMutationSecurity(options),
    parseRequestBody(parser),
    validateId,
    validateBody(emptyBodySchema),
    touch,
  ];
}

function validateBody<T>(schema: {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}): express.RequestHandler {
  return (request, response, next) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      next(new InvalidRequestError());
      return;
    }
    response.locals.validatedTabBody = parsed.data;
    next();
  };
}

function validateId(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const parsed = tabIdSchema.safeParse(request.params.id);
  if (!parsed.success) {
    next(new InvalidRequestError());
    return;
  }
  response.locals.validatedTabId = parsed.data;
  next();
}

function validatedBody<T>(response: Response): T {
  if (!Object.hasOwn(response.locals, 'validatedTabBody')) {
    throw new Error('Validated tab body missing');
  }
  return response.locals.validatedTabBody as T;
}

function validatedId(response: Response): string {
  const id = response.locals.validatedTabId as string | undefined;
  if (id === undefined) throw new Error('Validated tab id missing');
  return id;
}

function parseRequestBody(
  parser: express.RequestHandler,
): express.RequestHandler {
  return (request, response, next) => {
    parser(request, response, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }
      next(isBodyParserClientError(error) ? new InvalidRequestError() : error);
    });
  };
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
  if (error instanceof InvalidRequestError) {
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

function isBodyParserClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const type = Reflect.get(error, 'type');
  if (typeof type === 'string' && INVALID_BODY_ERROR_TYPES.has(type)) {
    return true;
  }
  const code = Reflect.get(error, 'code');
  return (
    typeof code === 'string' &&
    (INVALID_COMPRESSION_ERROR_CODES.has(code) ||
      code.startsWith('ERR__ERROR_FORMAT_'))
  );
}

function sendError(response: Response, status: number, error: string): void {
  response.status(status).json({ error });
}
