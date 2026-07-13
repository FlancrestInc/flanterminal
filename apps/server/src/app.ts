import { extname, join } from 'node:path';

import express, {
  type Express,
  type Request,
  type RequestHandler,
} from 'express';
import helmet from 'helmet';

import {
  requireAuthentication,
  touchHttpActivity,
  type AuthMiddlewareOptions,
} from './auth-middleware.js';
import { createAuthRouter, type AuthRouterOptions } from './auth-routes.js';
import { toClientConfig, type AppConfig } from './config.js';
import {
  createSettingsRouter,
  type SettingsRouterOptions,
} from './settings-routes.js';
import { createTabRouter, type TabRouterOptions } from './tab-routes.js';

export interface RuntimeReadiness {
  isReady(): boolean | Promise<boolean>;
}

export interface RuntimeMetrics {
  activeSessionCount(): number;
  connectedWebSocketCount(): number;
}

export type Phase3HttpOptions = Readonly<{
  auth: Omit<AuthRouterOptions, 'basePath' | 'publicOrigin' | 'secureCookie'>;
  settings: Omit<SettingsRouterOptions, keyof AuthMiddlewareOptions>;
  tabs: Omit<TabRouterOptions, keyof AuthMiddlewareOptions>;
}>;

export type CreateAppOptions = Readonly<{
  config: AppConfig;
  readiness: RuntimeReadiness;
  metrics: RuntimeMetrics;
  clientDist: string;
  http?: Phase3HttpOptions;
}>;

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  const clientConfig = toClientConfig(options.config);
  const apiPrefix = withBase(options.config.basePath, '/api');

  app.disable('x-powered-by');
  app.enable('case sensitive routing');
  app.set('trust proxy', options.config.trustProxy);
  app.use(securityHeaders(options.config));

  app.use((request, response, next) => {
    const pathname = canonicalPath(request);
    if (pathname === undefined || isUnsafePath(pathname)) {
      response.sendStatus(404);
      return;
    }
    response.locals.canonicalPath = pathname;
    next();
  });

  app.get('/health', (_request, response) => {
    const memory = process.memoryUsage();
    response.json({
      status: 'ok',
      uptimeSeconds: process.uptime(),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
      activeSessions: options.metrics.activeSessionCount(),
      connectedWebSockets: options.metrics.connectedWebSocketCount(),
    });
  });

  app.get('/ready', async (_request, response) => {
    const ready = await options.readiness.isReady();
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      ready,
    });
  });

  if (options.http !== undefined) {
    const authOptions: AuthRouterOptions = {
      ...options.http.auth,
      publicOrigin: options.config.publicOrigin,
      basePath: options.config.basePath,
      secureCookie: new URL(options.config.publicUrl).protocol === 'https:',
    };
    const sharedAuth: AuthMiddlewareOptions = {
      mode: authOptions.mode,
      publicOrigin: authOptions.publicOrigin,
      authService: authOptions.authService,
      ...(authOptions.cloudflareAccessProvider === undefined
        ? {}
        : { cloudflareAccessProvider: authOptions.cloudflareAccessProvider }),
      ...(authOptions.trustedHeaderProvider === undefined
        ? {}
        : { trustedHeaderProvider: authOptions.trustedHeaderProvider }),
      ...(authOptions.logger === undefined
        ? {}
        : { logger: authOptions.logger }),
    };
    const requireAuth = requireAuthentication(sharedAuth);
    const touch = touchHttpActivity(sharedAuth);

    app.use(
      apiPrefix,
      dispatchNamespace('/auth', createAuthRouter(authOptions)),
    );
    app.get(
      withBase(options.config.basePath, '/api/config'),
      noStore,
      requireAuth,
      touch,
      (_request, response) => response.json(clientConfig),
    );
    app.use(
      apiPrefix,
      dispatchNamespace(
        '/settings',
        createSettingsRouter({
          ...sharedAuth,
          ...options.http.settings,
        }),
      ),
    );
    app.use(
      apiPrefix,
      dispatchNamespace(
        '/tabs',
        createTabRouter({
          ...sharedAuth,
          ...options.http.tabs,
        }),
      ),
    );
  }

  app.use(
    options.config.basePath,
    express.static(options.clientDist, {
      dotfiles: 'deny',
      fallthrough: true,
      index: false,
      redirect: false,
    }),
  );

  app.use((_request, response, next) => {
    const pathname = response.locals.canonicalPath as string;
    if (isReservedPath(pathname, options.config.basePath)) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    next();
  });

  app.get('*path', (_request, response) => {
    const pathname = response.locals.canonicalPath as string;
    const workspaceRoot =
      options.config.basePath === '/' ? '/' : `${options.config.basePath}/`;
    if (
      !isWithinBase(pathname, options.config.basePath) ||
      pathname === apiPrefix ||
      pathname.startsWith(`${apiPrefix}/`) ||
      hasExtension(pathname)
    ) {
      response.sendStatus(404);
      return;
    }
    if (pathname !== workspaceRoot) {
      response.redirect(308, workspaceRoot);
      return;
    }
    response.sendFile(join(options.clientDist, 'index.html'));
  });

  app.use((_request, response) => response.sendStatus(404));
  return app;
}

function withBase(basePath: string, path: string): string {
  return basePath === '/' ? path : `${basePath}${path}`;
}

function securityHeaders(config: AppConfig): RequestHandler {
  const publicUrl = new URL(config.publicUrl);
  const websocketProtocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const websocketEndpoint = `${websocketProtocol}//${publicUrl.host}${withBase(
    config.basePath,
    '/ws',
  )}/`;
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", websocketEndpoint],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        // xterm 6 injects style elements and uses element.style at runtime.
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: null,
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity:
      publicUrl.protocol === 'https:'
        ? { maxAge: 31_536_000, includeSubDomains: false }
        : false,
  });
}

function noStore(
  _request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  response.set('Cache-Control', 'no-store');
  next();
}

function dispatchNamespace(
  namespace: string,
  handler: RequestHandler,
): RequestHandler {
  return (request, response, next) => {
    if (
      request.path !== namespace &&
      !request.path.startsWith(`${namespace}/`)
    ) {
      next();
      return;
    }
    handler(request, response, next);
  };
}

function isWithinBase(pathname: string, basePath: string): boolean {
  return (
    basePath === '/' ||
    pathname === basePath ||
    pathname.startsWith(`${basePath}/`)
  );
}

function isReservedPath(pathname: string, basePath: string): boolean {
  if (!isWithinBase(pathname, basePath)) return false;
  const relative =
    basePath === '/' ? pathname : pathname.slice(basePath.length);
  const namespace = relative.split('/').filter(Boolean)[0];
  return (
    namespace === 'api' ||
    namespace === 'assets' ||
    namespace === 'static' ||
    namespace === 'ws'
  );
}

function hasExtension(pathname: string): boolean {
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return extname(segment) !== '';
}

function canonicalPath(request: Request): string | undefined {
  const rawPathname = request.originalUrl.split('?', 1)[0] ?? '';
  if (/%(?:2f|5c)/i.test(rawPathname)) return undefined;
  try {
    const decoded = decodeURIComponent(rawPathname);
    return decoded === rawPathname ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isUnsafePath(pathname: string): boolean {
  if (pathname.includes('\\') || pathname.includes('\0')) return true;
  const segments = pathname.toLowerCase().split('/').filter(Boolean);
  return segments.some(
    (segment) =>
      segment === '.' ||
      segment === '..' ||
      segment === 'home' ||
      segment === '.ssh' ||
      segment === 'keys' ||
      segment === 'id_rsa' ||
      segment === 'id_ed25519' ||
      segment.endsWith('.key') ||
      segment.endsWith('.pem'),
  );
}
