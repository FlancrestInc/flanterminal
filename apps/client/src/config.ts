import { parseClientConfig, type ClientConfig } from '@flanterminal/shared';

const SAFE_CONFIG_ERROR = 'Unable to load terminal configuration.';

export class ClientConfigLoadError extends Error {
  constructor() {
    super(SAFE_CONFIG_ERROR);
    this.name = 'ClientConfigLoadError';
  }
}

export interface LoadClientConfigOptions {
  readonly signal?: AbortSignal;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export async function loadClientConfig(
  options: LoadClientConfigOptions = {},
): Promise<ClientConfig> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? document.baseURI;

  try {
    const requestInit: RequestInit = {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const response = await fetchImpl(
      new URL('api/config', baseUrl),
      requestInit,
    );
    if (!response.ok) throw new ClientConfigLoadError();
    return parseClientConfig(await response.json());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new ClientConfigLoadError();
  }
}
