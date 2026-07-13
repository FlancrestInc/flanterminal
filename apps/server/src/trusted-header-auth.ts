import { type IncomingMessage } from 'node:http';
import { inspect } from 'node:util';
import ipaddr from 'ipaddr.js';
import proxyaddr from 'proxy-addr';

import {
  UpstreamProviderError,
  type UpstreamHeaderValue,
  type UpstreamHeaderView,
  type UpstreamIdentityProvider,
} from './cloudflare-access.js';
import { type UpstreamIdentity } from './auth-types.js';

const MAX_HEADER_FIELDS = 128;
const MAX_HEADER_NAME_BYTES = 256;
const MAX_FORWARDED_FOR_BYTES = 4_096;
const MAX_FORWARDED_HOPS = 16;
const MAX_ADDRESS_BYTES = 128;
const MAX_IDENTITY_BYTES = 128;
const MAX_TRUST_RANGES = 64;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const unsafeIdentityPattern = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const utf8 = new TextEncoder();

export type TrustedHeaderRequest = Readonly<{
  remoteAddress: string | undefined;
  headers: UpstreamHeaderView;
}>;

export type TrustedHeaderAuthProviderOptions = Readonly<{
  trustProxy: false | number | readonly string[];
  identityHeader: string;
  publicOrigin: string;
}>;

export class TrustedHeaderAuthProvider implements UpstreamIdentityProvider<TrustedHeaderRequest> {
  readonly #trust: (address: string, index: number) => boolean;
  readonly #identityHeader: string;
  readonly #publicOrigin: string;
  readonly #publicProtocol: string;

  constructor(options: TrustedHeaderAuthProviderOptions) {
    try {
      if (
        !Array.isArray(options.trustProxy) ||
        options.trustProxy.length === 0 ||
        options.trustProxy.length > MAX_TRUST_RANGES
      )
        throw new Error();
      for (const range of options.trustProxy) validateTrustRange(range);
      this.#trust = proxyaddr.compile([...options.trustProxy]);
      if (
        typeof options.identityHeader !== 'string' ||
        utf8.encode(options.identityHeader).byteLength >
          MAX_HEADER_NAME_BYTES ||
        !headerNamePattern.test(options.identityHeader)
      )
        throw new Error();
      this.#identityHeader = options.identityHeader.toLowerCase();
      const publicUrl = validatePublicOrigin(options.publicOrigin);
      this.#publicOrigin = publicUrl.origin;
      this.#publicProtocol = publicUrl.protocol.slice(0, -1);
    } catch {
      throw new UpstreamProviderError();
    }
  }

  authenticate(request: TrustedHeaderRequest): UpstreamIdentity {
    try {
      const remoteAddress = validateAddress(request.remoteAddress);
      if (!this.#trust(remoteAddress, 0)) throw new Error();

      const names = headerNames(request.headers);
      const forwardedFor = optionalStringHeader(
        request.headers,
        names,
        'x-forwarded-for',
      );
      validateProxyChain(remoteAddress, forwardedFor, this.#trust);

      const forwardedProto = optionalStringHeader(
        request.headers,
        names,
        'x-forwarded-proto',
      );
      const forwardedHost = optionalStringHeader(
        request.headers,
        names,
        'x-forwarded-host',
      );
      const directHost = optionalStringHeader(request.headers, names, 'host');
      const forwarding =
        forwardedFor !== undefined ||
        forwardedProto !== undefined ||
        forwardedHost !== undefined;
      if (forwarding) {
        validateExternalOrigin(
          requiredForwardedProtocol(forwardedProto),
          requiredHost(forwardedHost),
          this.#publicOrigin,
        );
      } else {
        validateExternalOrigin(
          this.#publicProtocol,
          requiredHost(directHost),
          this.#publicOrigin,
        );
      }

      const rawIdentity = requiredStringHeader(
        request.headers,
        names,
        this.#identityHeader,
      );
      const identityLabel = normalizeIdentity(rawIdentity);
      return Object.freeze({ mode: 'trusted-header', identityLabel });
    } catch {
      throw new UpstreamProviderError();
    }
  }

  toJSON() {
    return Object.freeze({ type: 'TrustedHeaderAuthProvider' });
  }

  [inspect.custom]() {
    return 'TrustedHeaderAuthProvider {}';
  }
}

function headerNames(headers: UpstreamHeaderView): readonly string[] {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers))
    throw new Error();
  const names = Object.keys(headers);
  if (names.length > MAX_HEADER_FIELDS) throw new Error();
  for (const name of names) {
    if (
      utf8.encode(name).byteLength > MAX_HEADER_NAME_BYTES ||
      !headerNamePattern.test(name)
    )
      throw new Error();
  }
  return names;
}

function matchingHeaderValue(
  headers: UpstreamHeaderView,
  names: readonly string[],
  wanted: string,
): UpstreamHeaderValue {
  const matches = names.filter((name) => name.toLowerCase() === wanted);
  if (matches.length > 1) throw new Error();
  return matches.length === 0 ? undefined : headers[matches[0]!];
}

function optionalStringHeader(
  headers: UpstreamHeaderView,
  names: readonly string[],
  wanted: string,
): string | undefined {
  const value = matchingHeaderValue(headers, names, wanted);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error();
  return value;
}

function requiredStringHeader(
  headers: UpstreamHeaderView,
  names: readonly string[],
  wanted: string,
): string {
  const value = optionalStringHeader(headers, names, wanted);
  if (value === undefined) throw new Error();
  return value;
}

function validateProxyChain(
  remoteAddress: string,
  forwardedFor: string | undefined,
  trust: (address: string, index: number) => boolean,
) {
  const chain =
    forwardedFor === undefined ? [] : parseForwardedFor(forwardedFor);
  const request = {
    headers: { 'x-forwarded-for': chain.join(', ') },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
  const complete = proxyaddr.all(request);
  const accepted = proxyaddr.all(request, trust);
  if (complete.length !== accepted.length) throw new Error();
}

function parseForwardedFor(value: string): readonly string[] {
  if (
    value.length === 0 ||
    utf8.encode(value).byteLength > MAX_FORWARDED_FOR_BYTES
  )
    throw new Error();
  const addresses = value.split(',').map((part) => part.trim());
  if (
    addresses.length === 0 ||
    addresses.length > MAX_FORWARDED_HOPS ||
    addresses.some((address) => address.length === 0)
  )
    throw new Error();
  for (const address of addresses) validateAddress(address);
  return addresses;
}

function validateAddress(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('%') ||
    utf8.encode(value).byteLength > MAX_ADDRESS_BYTES ||
    !ipaddr.isValid(value)
  )
    throw new Error();
  return value;
}

function requiredForwardedProtocol(value: string | undefined): string {
  if (value === undefined || value !== value.trim() || value.includes(','))
    throw new Error();
  const protocol = value.toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') throw new Error();
  return protocol;
}

function requiredHost(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8.encode(value).byteLength > 255 ||
    /[,\s@/?#\\]/u.test(value)
  )
    throw new Error();
  return value;
}

function validateExternalOrigin(
  protocol: string,
  host: string,
  expectedOrigin: string,
) {
  const parsed = new URL(`${protocol}://${host}`);
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== expectedOrigin
  )
    throw new Error();
}

function normalizeIdentity(value: string): string {
  const normalized = value.normalize('NFC');
  if (
    normalized.length === 0 ||
    utf8.encode(normalized).byteLength > MAX_IDENTITY_BYTES ||
    unsafeIdentityPattern.test(normalized)
  )
    throw new Error();
  return normalized;
}

function validateTrustRange(value: string) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('%') ||
    utf8.encode(value).byteLength > MAX_ADDRESS_BYTES
  )
    throw new Error();
  if (value.includes('/')) ipaddr.parseCIDR(value);
  else ipaddr.parse(value);
}

function validatePublicOrigin(value: string): URL {
  if (typeof value !== 'string') throw new Error();
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    value !== url.origin ||
    url.username !== '' ||
    url.password !== ''
  )
    throw new Error();
  return url;
}
