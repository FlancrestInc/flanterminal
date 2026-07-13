import {
  parseWorkspaceSettingsMutation,
  parseWorkspaceSettingsResponse,
  type SettingsResponse,
  type WorkspaceSettings,
  type WorkspaceSettingsConstraints,
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
import type { ReplaceResult } from './secure-json-file.js';

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

export interface SettingsRouteStore {
  snapshot(): WorkspaceSettings;
  replace(settings: WorkspaceSettings): Promise<ReplaceResult>;
}

export type SettingsRouterOptions = AuthMiddlewareOptions &
  Readonly<{
    store: SettingsRouteStore;
    constraints: WorkspaceSettingsConstraints;
  }>;

export function createSettingsRouter(options: SettingsRouterOptions): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const parseJson = express.json({ limit: MAX_JSON_BYTES, strict: true });
  const requireAuth = requireAuthentication(options);
  const requireMutation = requireMutationSecurity(options);
  const touch = touchHttpActivity(options);

  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/settings',
    requireAuth,
    prepareAuthoritativeResponse(options),
    touch,
    (_request, response) => {
      response.json(authoritativeResponse(response));
    },
  );

  router.put(
    '/settings',
    requireAuth,
    requireMutation,
    parseBody(parseJson),
    validateMutation(options.constraints),
    touch,
    async (_request, response) => {
      const result = await options.store.replace(validatedSettings(response));
      if (result.state === 'not_committed') {
        sendError(response, 500, 'operation_failed');
        return;
      }
      if (result.state === 'committed_durability_uncertain') {
        sendError(response, 500, 'durability_uncertain');
        return;
      }
      response.json(buildAuthoritativeResponse(options));
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
      const invalid = error instanceof InvalidRequestError;
      const status = invalid ? 400 : 500;
      const code = invalid ? 'invalid_request' : 'operation_failed';
      if (!invalid) {
        try {
          options.logger?.error('settings_route_failed', { category: code });
        } catch {
          // Error responses cannot depend on logging availability.
        }
      }
      sendError(response, status, code);
    },
  );

  return router;
}

function prepareAuthoritativeResponse(
  options: SettingsRouterOptions,
): express.RequestHandler {
  return (_request, response, next) => {
    try {
      response.locals.authoritativeSettings =
        buildAuthoritativeResponse(options);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function buildAuthoritativeResponse(
  options: SettingsRouterOptions,
): SettingsResponse {
  return parseWorkspaceSettingsResponse({
    settings: options.store.snapshot(),
    limits: options.constraints.limits,
    allowedShells: options.constraints.allowedShells,
  });
}

function validateMutation(
  constraints: WorkspaceSettingsConstraints,
): express.RequestHandler {
  return (request, response, next) => {
    try {
      response.locals.validatedSettings = parseWorkspaceSettingsMutation(
        request.body,
        constraints,
      ).settings;
      next();
    } catch {
      next(new InvalidRequestError());
    }
  };
}

function validatedSettings(response: Response): WorkspaceSettings {
  const settings = response.locals.validatedSettings as
    WorkspaceSettings | undefined;
  if (settings === undefined) throw new Error('Validated settings missing');
  return settings;
}

function authoritativeResponse(response: Response): SettingsResponse {
  const settings = response.locals.authoritativeSettings as
    SettingsResponse | undefined;
  if (settings === undefined) throw new Error('Authoritative settings missing');
  return settings;
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

class InvalidRequestError extends Error {}

function isBodyParserClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const type = Reflect.get(error, 'type');
  if (typeof type === 'string' && INVALID_BODY_ERROR_TYPES.has(type))
    return true;
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
