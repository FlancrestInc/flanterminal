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
const MAX_PRESERVED_HEADER_BYTES = 64 * 1024;
const MAX_RAW_HEADER_ITEMS = MAX_HEADER_FIELDS * 2;
const MAX_DISTINCT_HEADER_VALUES = 256;
const MAX_FORWARDED_FOR_BYTES = 4_096;
const MAX_FORWARDED_HOPS = 16;
const MAX_ADDRESS_BYTES = 128;
const MAX_IDENTITY_BYTES = 128;
const MAX_TRUST_RANGES = 64;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const unsafeIdentityPattern = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const utf8 = new TextEncoder();

export type TrustedHeaderRequestView = Readonly<{
  remoteAddress: string | undefined;
  headers: UpstreamHeaderView;
  headersDistinct?:
    Readonly<Record<string, readonly string[] | undefined>> | undefined;
  rawHeaders?: readonly string[] | undefined;
}>;
export type TrustedHeaderRequest = TrustedHeaderRequestView;

export type TrustedHeaderAuthProviderOptions = Readonly<{
  trustProxy: false | number | readonly string[];
  identityHeader: string;
  publicOrigin: string;
}>;

export class TrustedHeaderAuthProvider implements UpstreamIdentityProvider<TrustedHeaderRequestView> {
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

  authenticate(request: TrustedHeaderRequestView): UpstreamIdentity {
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

      const rawIdentity = originalIdentityHeader(
        request,
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

function originalIdentityHeader(
  request: TrustedHeaderRequestView,
  names: readonly string[],
  wanted: string,
): string {
  const merged = matchingHeaderValue(request.headers, names, wanted);
  const mergedValue = oneHeaderValue(merged);
  if (mergedValue.includes(',')) throw new Error();

  const preserved: string[] = [];
  if (request.headersDistinct !== undefined)
    preserved.push(identityFromDistinct(request.headersDistinct, wanted));
  if (request.rawHeaders !== undefined)
    preserved.push(identityFromRaw(request.rawHeaders, wanted));
  if (
    preserved.length === 0 ||
    preserved.some((value) => value !== mergedValue)
  )
    throw new Error();
  return mergedValue;
}

function oneHeaderValue(value: UpstreamHeaderValue): string {
  if (typeof value === 'string') return value;
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    typeof value[0] !== 'string'
  )
    throw new Error();
  return value[0];
}

function identityFromDistinct(
  distinct: Readonly<Record<string, readonly string[] | undefined>>,
  wanted: string,
): string {
  if (
    typeof distinct !== 'object' ||
    distinct === null ||
    Array.isArray(distinct)
  )
    throw new Error();
  const names = Object.keys(distinct);
  if (names.length > MAX_HEADER_FIELDS) throw new Error();
  let valueCount = 0;
  let byteCount = 0;
  for (const name of names) {
    validateHeaderName(name);
    const values = distinct[name];
    if (!Array.isArray(values)) throw new Error();
    valueCount += values.length;
    if (valueCount > MAX_DISTINCT_HEADER_VALUES) throw new Error();
    for (const value of values) {
      if (typeof value !== 'string') throw new Error();
      byteCount += utf8.encode(value).byteLength;
      if (byteCount > MAX_PRESERVED_HEADER_BYTES) throw new Error();
    }
  }
  const matches = names.filter((name) => name.toLowerCase() === wanted);
  if (matches.length !== 1) throw new Error();
  const values = distinct[matches[0]!];
  if (!Array.isArray(values) || values.length !== 1) throw new Error();
  return values[0]!;
}

function identityFromRaw(
  rawHeaders: readonly string[],
  wanted: string,
): string {
  if (
    !Array.isArray(rawHeaders) ||
    rawHeaders.length === 0 ||
    rawHeaders.length > MAX_RAW_HEADER_ITEMS ||
    rawHeaders.length % 2 !== 0
  )
    throw new Error();
  let byteCount = 0;
  const matches: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string')
      throw new Error();
    validateHeaderName(name);
    byteCount += utf8.encode(name).byteLength + utf8.encode(value).byteLength;
    if (byteCount > MAX_PRESERVED_HEADER_BYTES) throw new Error();
    if (name.toLowerCase() === wanted) matches.push(value);
  }
  if (matches.length !== 1) throw new Error();
  return matches[0]!;
}

function validateHeaderName(name: string) {
  if (
    utf8.encode(name).byteLength > MAX_HEADER_NAME_BYTES ||
    !headerNamePattern.test(name)
  )
    throw new Error();
}

function headerNames(headers: UpstreamHeaderView): readonly string[] {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers))
    throw new Error();
  const names = Object.keys(headers);
  if (names.length > MAX_HEADER_FIELDS) throw new Error();
  for (const name of names) {
    validateHeaderName(name);
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
