import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
} from 'node:http';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { URL } from 'node:url';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const issuer = requiredEnvironment('CLOUDFLARE_FIXTURE_ISSUER');
const audience = requiredEnvironment('CLOUDFLARE_FIXTURE_AUDIENCE');
const appOrigin = new URL(requiredEnvironment('CLOUDFLARE_FIXTURE_APP_ORIGIN'));
const certificate = readFileSync(requiredEnvironment('TLS_CERT_FILE'));
const privateKey = readFileSync(requiredEnvironment('TLS_KEY_FILE'));
let signer = await createSigner();

const server = createServer(
  { cert: certificate, key: privateKey, minVersion: 'TLSv1.2' },
  async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', issuer);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/cdn-cgi/access/certs'
      ) {
        sendJson(response, 200, { keys: [signer.publicJwk] });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/control/token') {
        const kind = url.searchParams.get('kind');
        if (!['valid', 'expired', 'wrong-audience'].includes(kind ?? '')) {
          sendJson(response, 400, { error: 'invalid_kind' });
          return;
        }
        sendJson(response, 200, { token: await issueToken(kind) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/control/rotate') {
        signer = await createSigner();
        sendJson(response, 200, { token: await issueToken('valid') });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    } catch {
      sendJson(response, 500, { error: 'fixture_failed' });
    }
  },
);

const edge = createHttpServer((request, response) => {
  const upstream = proxyRequest(request, request.headers);
  upstream.once('response', (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(response);
  });
  upstream.once('error', () => {
    if (!response.headersSent)
      sendJson(response, 502, { error: 'edge_upstream_unavailable' });
    else response.destroy();
  });
  request.pipe(upstream);
});

edge.on('upgrade', (request, socket, head) => {
  socket.on('error', () => socket.destroy());
  void issueToken('valid')
    .then((assertion) => {
      const upstream = proxyRequest(request, {
        ...request.headers,
        'cf-access-jwt-assertion': assertion,
      });
      upstream.once(
        'upgrade',
        (upstreamResponse, upstreamSocket, upstreamHead) => {
          upstreamSocket.on('error', () => socket.destroy());
          socket.write(
            `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}\r\n`,
          );
          for (
            let index = 0;
            index < upstreamResponse.rawHeaders.length;
            index += 2
          ) {
            socket.write(
              `${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}\r\n`,
            );
          }
          socket.write('\r\n');
          if (upstreamHead.length > 0) socket.write(upstreamHead);
          if (head.length > 0) upstreamSocket.write(head);
          upstreamSocket.pipe(socket).pipe(upstreamSocket);
        },
      );
      upstream.once('response', (upstreamResponse) => {
        socket.end(
          `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`,
        );
        upstreamResponse.resume();
      });
      upstream.once('error', () => socket.destroy());
      upstream.end();
    })
    .catch(() => socket.destroy());
});

server.listen(443, '0.0.0.0', () => {
  process.stdout.write(
    `${JSON.stringify({ event: 'cloudflare_fixture_started' })}\n`,
  );
});

edge.listen(3001, '0.0.0.0');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    let remaining = 2;
    const closed = () => {
      remaining -= 1;
      if (remaining === 0) process.exit(0);
    };
    server.close(closed);
    edge.close(closed);
  });
}

function proxyRequest(request, headers) {
  return httpRequest({
    protocol: appOrigin.protocol,
    hostname: appOrigin.hostname,
    port: appOrigin.port,
    method: request.method,
    path: request.url,
    headers: { ...headers, host: appOrigin.host },
  });
}

async function createSigner() {
  const keyId = randomUUID();
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 });
  const publicJwk = await exportJWK(pair.publicKey);
  return Object.freeze({
    keyId,
    privateKey: pair.privateKey,
    publicJwk: Object.freeze({
      ...publicJwk,
      alg: 'RS256',
      kid: keyId,
      use: 'sig',
    }),
  });
}

async function issueToken(kind) {
  const now = Math.floor(Date.now() / 1_000);
  const expired = kind === 'expired';
  return await new SignJWT({ email: 'operator@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: signer.keyId, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(kind === 'wrong-audience' ? `${audience}-wrong` : audience)
    .setSubject('cloudflare-e2e-operator')
    .setIssuedAt(expired ? now - 180 : now)
    .setExpirationTime(expired ? now - 60 : now + 3_600)
    .sign(signer.privateKey);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing ${name}`);
  return value;
}
