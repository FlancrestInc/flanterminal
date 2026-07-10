import { extname, join } from 'node:path';

import express, { type Express, type Request } from 'express';
import helmet from 'helmet';

import { toClientConfig, type AppConfig } from './config.js';

export interface RuntimeReadiness {
  isReady(): boolean | Promise<boolean>;
}

export interface RuntimeMetrics {
  activeSessionCount(): number;
  connectedWebSocketCount(): number;
}

export type CreateAppOptions = Readonly<{
  config: AppConfig;
  readiness: RuntimeReadiness;
  metrics: RuntimeMetrics;
  clientDist: string;
}>;

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  const clientConfig = toClientConfig(options.config);
  const apiPrefix = withBase(options.config.basePath, '/api');

  app.disable('x-powered-by');
  app.use(helmet());

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

  app.get(
    withBase(options.config.basePath, '/api/config'),
    (_request, response) => {
      response.set('Cache-Control', 'no-store').json(clientConfig);
    },
  );

  app.use((request, response, next) => {
    if (isUnsafePath(request)) {
      response.sendStatus(404);
      return;
    }
    next();
  });

  app.use(
    options.config.basePath,
    express.static(options.clientDist, {
      dotfiles: 'deny',
      fallthrough: true,
      index: false,
      redirect: false,
    }),
  );

  app.get('*path', (request, response) => {
    const pathname = request.path;
    if (
      !isWithinBase(pathname, options.config.basePath) ||
      pathname === apiPrefix ||
      pathname.startsWith(`${apiPrefix}/`) ||
      hasExtension(pathname)
    ) {
      response.sendStatus(404);
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

function isWithinBase(pathname: string, basePath: string): boolean {
  return (
    basePath === '/' ||
    pathname === basePath ||
    pathname.startsWith(`${basePath}/`)
  );
}

function hasExtension(pathname: string): boolean {
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return extname(segment) !== '';
}

function isUnsafePath(request: Request): boolean {
  let pathname: string;
  try {
    pathname = decodeURIComponent(request.originalUrl.split('?', 1)[0] ?? '');
  } catch {
    return true;
  }
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
