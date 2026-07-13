import {
  loginRequestSchema,
  passwordChangeRequestSchema,
  type ApiErrorCode,
} from '@flanterminal/shared';
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';

import {
  authenticatedLocals,
  clearSessionCookie,
  requireAuthentication,
  requireMutationSecurity,
  requirePublicMutationSecurity,
  resolveAuthentication,
  setSessionCookie,
  touchHttpActivity,
  upstreamAuthentication,
  type AuthMiddlewareOptions,
  type AuthMiddlewareService,
} from './auth-middleware.js';
import type {
  AuthBootstrapResult,
  AuthenticatedSession,
  LocalLoginAttempt,
  UpstreamAuthentication,
  UpstreamIdentity,
} from './auth-types.js';
import type { AuthenticatedWorkspaceBootstrap } from './workspace-bootstrap.js';

const MAX_JSON_BYTES = 16 * 1024;
const INVALID_BODY_ERROR_TYPES = new Set([
  'entity.parse.failed',
  'entity.too.large',
  'encoding.unsupported',
  'charset.unsupported',
  'request.aborted',
]);

export interface AuthRouterService extends AuthMiddlewareService {
  bootstrap(input: UpstreamAuthentication): Promise<AuthBootstrapResult>;
  login(input: LocalLoginAttempt): Promise<AuthBootstrapResult>;
  resume(id: string): AuthBootstrapResult | undefined;
  refresh(
    id: string,
    upstream: UpstreamIdentity,
  ): AuthenticatedSession | undefined;
  logout(id: string): void;
  changePassword(
    id: string,
    current: string,
    replacement: string,
  ): Promise<boolean>;
}

export type AuthRouterOptions = Omit<AuthMiddlewareOptions, 'authService'> &
  Readonly<{
    authService: AuthRouterService;
    basePath: string;
    secureCookie: boolean;
    workspaceBootstrap: AuthenticatedWorkspaceBootstrap;
  }>;

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const parseJson = express.json({ limit: MAX_JSON_BYTES, strict: true });
  const requireAuth = requireAuthentication(options);
  const requireMutation = requireMutationSecurity(options);
  const touch = touchHttpActivity(options);

  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/auth/session', async (request, response) => {
    let existing;
    try {
      existing = await resolveAuthentication(options, request);
    } catch {
      sendError(response, 401, 'authentication_failed');
      return;
    }
    if (existing !== undefined) {
      response.locals.authSession = existing.authSession;
      if (existing.upstreamIdentity !== undefined)
        response.locals.upstreamIdentity = existing.upstreamIdentity;
      const resumed = options.authService.resume(existing.authSession.id);
      if (resumed === undefined) {
        sendError(response, 401, 'authentication_required');
        return;
      }
      await options.workspaceBootstrap.ensureForAuthenticatedSession();
      options.authService.touch(existing.authSession.id, 'http');
      response.json(resumed.bootstrap);
      return;
    }

    let upstream;
    try {
      upstream = await upstreamAuthentication(options, request);
    } catch {
      sendError(response, 401, 'authentication_failed');
      return;
    }
    const result = await options.authService.bootstrap(upstream);
    await publishBootstrap(options, response, result);
  });

  router.post(
    '/auth/login',
    requirePublicMutationSecurity(options),
    parseBody(parseJson),
    async (request, response) => {
      if (options.mode !== 'local') {
        sendError(response, 409, 'invalid_session_state');
        return;
      }
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new InvalidRequestError();
      const result = await options.authService.login({
        username: parsed.data.username,
        password: parsed.data.password,
        address: request.ip || request.socket.remoteAddress || 'unknown',
      });
      if (!result.bootstrap.authenticated) {
        if (result.failure === 'rate_limited') {
          sendError(response, 429, 'rate_limited');
          return;
        }
        sendError(response, 401, 'authentication_failed');
        return;
      }
      await publishBootstrap(options, response, result);
    },
  );

  router.post(
    '/auth/refresh',
    requireAuth,
    requireMutation,
    parseBody(parseJson),
    validateEmptyBody,
    touch,
    (request, response) => {
      void request;
      const locals = authenticatedLocals(response);
      if (locals === undefined) throw new AuthenticationRequiredError();
      if (locals.upstreamIdentity !== undefined) {
        const refreshed = options.authService.refresh(
          locals.authSession.id,
          locals.upstreamIdentity,
        );
        if (refreshed === undefined) throw new AuthenticationFailedError();
      }
      const resumed = options.authService.resume(locals.authSession.id);
      if (resumed === undefined) throw new AuthenticationRequiredError();
      response.json(resumed.bootstrap);
    },
  );

  router.post(
    '/auth/logout',
    requireAuth,
    requireMutation,
    parseBody(parseJson),
    validateEmptyBody,
    touch,
    (request, response) => {
      void request;
      const locals = authenticatedLocals(response);
      if (locals === undefined) throw new AuthenticationRequiredError();
      options.authService.logout(locals.authSession.id);
      clearSessionCookie(response, options.basePath, options.secureCookie);
      response.status(204).end();
    },
  );

  router.put(
    '/auth/password',
    requireAuth,
    requireMutation,
    parseBody(parseJson),
    requireLocalSession,
    validatePasswordBody,
    touch,
    async (request, response) => {
      const locals = authenticatedLocals(response);
      if (locals === undefined) throw new AuthenticationRequiredError();
      const parsed = passwordChangeRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new Error('validated body missing');
      const changed = await options.authService.changePassword(
        locals.authSession.id,
        parsed.data.currentPassword,
        parsed.data.newPassword,
      );
      if (!changed) {
        sendError(response, 400, 'password_invalid');
        return;
      }
      clearSessionCookie(response, options.basePath, options.secureCookie);
      response.status(204).end();
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
      try {
        if (mapped.status === 500)
          options.logger?.error('authentication_route_failed', {
            category: mapped.code,
          });
      } catch {
        // Error responses cannot depend on logging availability.
      }
      sendError(response, mapped.status, mapped.code);
    },
  );

  return router;
}

async function publishBootstrap(
  options: AuthRouterOptions,
  response: Response,
  result: AuthBootstrapResult,
): Promise<void> {
  if (!result.bootstrap.authenticated) {
    if (result.cookieValue !== undefined) throw new Error('Invalid bootstrap');
    response.json(result.bootstrap);
    return;
  }
  const cookieValue = result.cookieValue;
  if (cookieValue === undefined) throw new Error('Invalid bootstrap');
  const session = options.authService.authenticateCookie(cookieValue);
  if (
    session === undefined ||
    session.mode !== result.bootstrap.mode ||
    session.identityLabel !== result.bootstrap.identityLabel
  )
    throw new Error('Invalid bootstrap');
  try {
    await options.workspaceBootstrap.ensureForAuthenticatedSession();
  } catch (error) {
    try {
      options.authService.logout(session.id);
    } catch {
      // Preserve the bounded workspace failure after best-effort revocation.
    }
    throw error;
  }
  options.authService.touch(session.id, 'http');
  setSessionCookie(
    response,
    cookieValue,
    options.basePath,
    options.secureCookie,
  );
  response.json(result.bootstrap);
}

function parseBody(parser: express.RequestHandler): express.RequestHandler {
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

const emptyBodySchema = loginRequestSchema.pick({}).strict();

function validateEmptyBody(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  if (!emptyBodySchema.safeParse(request.body).success) {
    next(new InvalidRequestError());
    return;
  }
  next();
}

function validatePasswordBody(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  if (!passwordChangeRequestSchema.safeParse(request.body).success) {
    next(new InvalidRequestError());
    return;
  }
  next();
}

function requireLocalSession(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  const locals = authenticatedLocals(response);
  if (locals === undefined) {
    next(new AuthenticationRequiredError());
    return;
  }
  if (locals.authSession.mode !== 'local') {
    sendError(response, 409, 'invalid_session_state');
    return;
  }
  next();
}

class InvalidRequestError extends Error {}
class AuthenticationRequiredError extends Error {}
class AuthenticationFailedError extends Error {}

function mapError(error: unknown): {
  status: number;
  code: ApiErrorCode;
} {
  if (error instanceof InvalidRequestError)
    return { status: 400, code: 'invalid_request' };
  if (error instanceof AuthenticationRequiredError)
    return { status: 401, code: 'authentication_required' };
  if (error instanceof AuthenticationFailedError)
    return { status: 401, code: 'authentication_failed' };
  return { status: 500, code: 'operation_failed' };
}

function isBodyParserClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const type = Reflect.get(error, 'type');
  if (typeof type === 'string' && INVALID_BODY_ERROR_TYPES.has(type))
    return true;
  const status = Reflect.get(error, 'status');
  return typeof status === 'number' && status >= 400 && status < 500;
}

function sendError(
  response: Response,
  status: number,
  error: ApiErrorCode | 'not_found',
): void {
  response.status(status).json({ error });
}
