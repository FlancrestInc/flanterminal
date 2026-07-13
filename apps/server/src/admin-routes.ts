import {
  parseAdminActionRequest,
  parseAdminSnapshot,
  parseCleanupResult,
  tabIdSchema,
  type AdminAction,
  type AdminSnapshot,
  type CleanupResult,
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
  type AuthEventLogger,
  type AuthMiddlewareOptions,
} from './auth-middleware.js';
import type { AdminLifecycleError } from './admin-service.js';
import { SessionManagerError } from './session-manager.js';
import { CleanupDisabledError } from './stale-session-cleaner.js';

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

export interface AdminRouteService {
  snapshot(): Promise<AdminSnapshot>;
  recordLifecycleError(id: string, error: AdminLifecycleError): void;
  clearLifecycleError(id: string): void;
}

export interface AdminRouteSessions {
  restartBridge(id: string): Promise<unknown>;
  terminate(id: string): Promise<unknown>;
  recreate(id: string): Promise<unknown>;
  restart(id: string): Promise<unknown>;
}

export interface AdminRouteCleanup {
  runNow(): Promise<CleanupResult>;
}

export interface AdminRouteLogger extends AuthEventLogger {
  info(event: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export type AdminRouterOptions = Omit<AuthMiddlewareOptions, 'logger'> &
  Readonly<{
    admin: AdminRouteService;
    sessions: AdminRouteSessions;
    cleanup: AdminRouteCleanup;
    logger?: AdminRouteLogger;
  }>;

export function createAdminRouter(options: AdminRouterOptions): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const parseJson = express.json({ limit: MAX_JSON_BYTES, strict: true });
  const authOptions: AuthMiddlewareOptions = {
    ...options,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
  const requireAuth = requireAuthentication(authOptions);
  const requireMutation = requireMutationSecurity(authOptions);
  const touch = touchHttpActivity(authOptions);

  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!request.baseUrl.endsWith('/api')) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (hasEncodedPath(request)) {
      sendError(response, 400, 'invalid_request');
      return;
    }
    next();
  });

  router.get(
    '/admin',
    markOperation('read'),
    requireAuth,
    touch,
    async (_request, response) => {
      response.json(parseAdminSnapshot(await options.admin.snapshot()));
    },
  );

  router.post(
    '/admin/sessions/:id',
    markOperation('session'),
    requireAuth,
    requireMutation,
    parseRequestBody(parseJson),
    validateId,
    validateAction,
    touch,
    async (_request, response) => {
      const id = validatedId(response);
      const action = validatedAction(response);
      await dispatchSessionAction(options.sessions, id, action);
      contain(() => options.admin.clearLifecycleError(id));
      log(options.logger, 'info', 'administration_action_succeeded', {
        sessionId: id,
        category: action,
      });
      response.status(204).end();
    },
  );

  router.post(
    '/admin/cleanup',
    markOperation('cleanup'),
    requireAuth,
    requireMutation,
    parseRequestBody(parseJson),
    validateEmptyBody,
    touch,
    async (_request, response) => {
      const result = parseCleanupResult(await options.cleanup.runNow());
      log(options.logger, 'info', 'administration_cleanup_succeeded', {
        category: 'cleanup_completed',
      });
      response.json(result);
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
      const operation = response.locals.adminOperation as string | undefined;
      const id = response.locals.validatedAdminId as string | undefined;
      if (
        operation === 'session' &&
        id !== undefined &&
        (mapped.code === 'invalid_session_state' ||
          mapped.code === 'operation_failed')
      ) {
        const lifecycleError: AdminLifecycleError = mapped.code;
        contain(() => options.admin.recordLifecycleError(id, lifecycleError));
      }
      log(
        options.logger,
        'error',
        operation === 'cleanup'
          ? 'administration_cleanup_failed'
          : operation === 'session'
            ? 'administration_action_failed'
            : 'administration_read_failed',
        {
          ...(id === undefined ? {} : { sessionId: id }),
          category: mapped.code,
        },
      );
      sendError(response, mapped.status, mapped.code);
    },
  );

  return router;
}

function markOperation(
  operation: 'read' | 'session' | 'cleanup',
): express.RequestHandler {
  return (_request, response, next) => {
    response.locals.adminOperation = operation;
    next();
  };
}

async function dispatchSessionAction(
  sessions: AdminRouteSessions,
  id: string,
  action: AdminAction,
): Promise<void> {
  if (action === 'restart_bridge') {
    await sessions.restartBridge(id);
  } else if (action === 'terminate') {
    await sessions.terminate(id);
  } else if (action === 'recreate') {
    await sessions.recreate(id);
  } else {
    await sessions.restart(id);
  }
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
  response.locals.validatedAdminId = parsed.data;
  next();
}

function validateAction(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  try {
    response.locals.validatedAdminAction = parseAdminActionRequest(
      request.body,
    ).action;
    next();
  } catch {
    next(new InvalidRequestError());
  }
}

function validateEmptyBody(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  if (
    typeof request.body !== 'object' ||
    request.body === null ||
    Array.isArray(request.body) ||
    Object.keys(request.body as object).length !== 0
  ) {
    next(new InvalidRequestError());
    return;
  }
  next();
}

function validatedId(response: Response): string {
  const id = response.locals.validatedAdminId as string | undefined;
  if (id === undefined) throw new Error('Validated administration id missing');
  return id;
}

function validatedAction(response: Response): AdminAction {
  const action = response.locals.validatedAdminAction as
    AdminAction | undefined;
  if (action === undefined) {
    throw new Error('Validated administration action missing');
  }
  return action;
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

class InvalidRequestError extends Error {}

function mapError(error: unknown): {
  status: number;
  code:
    | 'invalid_request'
    | 'tab_not_found'
    | 'invalid_session_state'
    | 'operation_failed'
    | 'cleanup_disabled';
} {
  if (error instanceof InvalidRequestError) {
    return { status: 400, code: 'invalid_request' };
  }
  if (error instanceof CleanupDisabledError) {
    return { status: 409, code: 'cleanup_disabled' };
  }
  const code = error instanceof SessionManagerError ? error.code : undefined;
  if (code === 'tab_not_found') return { status: 404, code };
  if (code === 'invalid_session_state') return { status: 409, code };
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

function log(
  logger: AdminRouteLogger | undefined,
  level: 'info' | 'error',
  event: string,
  metadata: Readonly<Record<string, unknown>>,
): void {
  contain(() => logger?.[level](event, metadata));
}

function contain(operation: () => unknown): void {
  try {
    operation();
  } catch {
    // Route outcomes cannot depend on optional metrics or logging callbacks.
  }
}

function sendError(response: Response, status: number, error: string): void {
  response.status(status).json({ error });
}
