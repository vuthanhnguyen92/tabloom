import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import {
  isValidCimdClientId,
  validateCimdClientMetadata,
  type ValidatedClient,
} from "./client-metadata";
import { CimdFetchError, CimdUnavailableError } from "./cimd-errors";

export { CimdFetchError, CimdUnavailableError } from "./cimd-errors";

const CIMD_TIMEOUT_MS = 3_000;
const CIMD_MAX_BYTES = 32 * 1024;
const CIMD_CACHE_TTL_MS = 5 * 60 * 1_000;
export const CIMD_CACHE_MAX_ENTRIES = 128;
export const CIMD_CACHE_MAX_BYTES = 512 * 1024;

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type CimdDnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;
export type CimdLookup = LookupFunction;

export type CimdTransportOptions = {
  address: string;
  family: 4 | 6;
  servername: string;
  lookup: CimdLookup;
  signal: AbortSignal;
};

export type CimdHttpResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array | string>;
  destroy(): void;
};

export type CimdTransport = (
  url: URL,
  options: CimdTransportOptions,
) => Promise<CimdHttpResponse>;

export type CimdFetcherDependencies = {
  resolve?: CimdDnsResolver;
  transport?: CimdTransport;
  now?: () => number;
  cachePolicy?: Readonly<{
    maxEntries: number;
    maxBytes: number;
  }>;
};

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((result, octet) => (result * 256) + Number(octet), 0) >>> 0;
}

function inIpv4Range(address: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

function ipv6Bytes(address: string): Uint8Array | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  if (normalized.includes(".")) {
    const ipv4 = ipv4Number(normalized.slice(lastColon + 1));
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const pieces = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (pieces.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < pieces.length; index += 1) {
    const value = Number.parseInt(pieces[index]!, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function hasIpv6Prefix(address: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = 0xff << (8 - remaining);
  return (address[wholeBytes]! & mask) === ((prefix[wholeBytes] ?? 0) & mask);
}

export function isPublicIpAddress(address: string): boolean {
  const ipv4 = ipv4Number(address);
  if (ipv4 !== null) {
    const blocked: ReadonlyArray<readonly [number, number]> = [
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
      [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
      [0xe0000000, 4], [0xf0000000, 4],
    ];
    return !blocked.some(([base, bits]) => inIpv4Range(ipv4, base, bits));
  }

  const ipv6 = ipv6Bytes(address);
  if (!ipv6) return false;
  // Only global-unicast space is eligible, with reserved transition and documentation blocks removed.
  if (!hasIpv6Prefix(ipv6, [0x20], 3)) return false;
  if (hasIpv6Prefix(ipv6, [0x20, 0x01, 0x00], 23) ||
      hasIpv6Prefix(ipv6, [0x20, 0x01, 0x0d, 0xb8], 32) ||
      hasIpv6Prefix(ipv6, [0x20, 0x02], 16) ||
      hasIpv6Prefix(ipv6, [0x3f, 0xfe], 16) ||
      hasIpv6Prefix(ipv6, [0x3f, 0xff, 0x00], 20)) return false;
  return true;
}

const defaultResolve: CimdDnsResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

const defaultTransport: CimdTransport = (url, options) => new Promise((resolve, reject) => {
  const request = httpsRequest(url, {
    method: "GET",
    headers: { accept: "application/json, application/*+json" },
    lookup: options.lookup,
    servername: options.servername,
    signal: options.signal,
  }, (response) => {
    resolve({
      statusCode: response.statusCode ?? 0,
      headers: response.headers,
      body: response,
      destroy: () => response.destroy(),
    });
  });
  request.once("error", reject);
  request.end();
});

function contentType(headers: CimdHttpResponse["headers"]): string | null {
  const raw = headers["content-type"];
  if (Array.isArray(raw)) return raw.length === 1 ? raw[0] ?? null : null;
  return raw ?? null;
}

function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

async function readJson(
  response: CimdHttpResponse,
  signal: AbortSignal,
): Promise<{ document: unknown; byteLength: number }> {
  if (response.statusCode >= 300 && response.statusCode < 400) throw new CimdFetchError();
  if (response.statusCode < 200 || response.statusCode >= 300 || !isJsonMediaType(contentType(response.headers))) {
    throw new CimdFetchError();
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw new CimdFetchError("CIMD fetch timeout");
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      byteLength += bytes.byteLength;
      if (byteLength > CIMD_MAX_BYTES) throw new CimdFetchError();
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CimdFetchError) throw error;
    throw new CimdFetchError();
  }
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return { document: JSON.parse(json) as unknown, byteLength };
  } catch {
    throw new CimdFetchError();
  }
}

export function createCimdFetcher(dependencies: CimdFetcherDependencies = {}) {
  const resolveDns = dependencies.resolve ?? defaultResolve;
  const transport = dependencies.transport ?? defaultTransport;
  const now = dependencies.now ?? Date.now;
  const cachePolicy = dependencies.cachePolicy ?? {
    maxEntries: CIMD_CACHE_MAX_ENTRIES,
    maxBytes: CIMD_CACHE_MAX_BYTES,
  };
  if (!Number.isSafeInteger(cachePolicy.maxEntries) || cachePolicy.maxEntries < 1 ||
      !Number.isSafeInteger(cachePolicy.maxBytes) || cachePolicy.maxBytes < 1) {
    throw new TypeError("Invalid CIMD cache policy");
  }
  type CacheEntry = { expiresAt: number; byteLength: number; client: ValidatedClient };
  const cache = new Map<string, CacheEntry>();
  let cacheBytes = 0;

  const deleteCached = (clientId: string) => {
    const entry = cache.get(clientId);
    if (!entry) return;
    cache.delete(clientId);
    cacheBytes -= entry.byteLength;
  };
  const sweepExpired = (currentTime: number) => {
    for (const [cachedClientId, entry] of cache) {
      if (entry.expiresAt <= currentTime) deleteCached(cachedClientId);
    }
  };
  const cacheClient = (
    clientId: string,
    client: ValidatedClient,
    byteLength: number,
    currentTime: number,
  ) => {
    sweepExpired(currentTime);
    deleteCached(clientId);
    if (byteLength > cachePolicy.maxBytes) return;
    cache.set(clientId, {
      client,
      byteLength,
      expiresAt: currentTime + CIMD_CACHE_TTL_MS,
    });
    cacheBytes += byteLength;
    while (cache.size > cachePolicy.maxEntries || cacheBytes > cachePolicy.maxBytes) {
      const leastRecentlyUsed = cache.keys().next().value as string | undefined;
      if (leastRecentlyUsed === undefined) break;
      deleteCached(leastRecentlyUsed);
    }
  };

  return async function fetchClient(clientId: string): Promise<ValidatedClient> {
    if (!isValidCimdClientId(clientId)) throw new CimdFetchError();
    const requestTime = now();
    sweepExpired(requestTime);
    const cached = cache.get(clientId);
    if (cached) {
      cache.delete(clientId);
      cache.set(clientId, cached);
      return cached.client;
    }

    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new CimdUnavailableError("CIMD fetch timeout"));
      }, CIMD_TIMEOUT_MS);
    });

    const fetchPromise = (async () => {
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await resolveDns(new URL(clientId).hostname);
      } catch (error) {
        if (error && typeof error === "object" &&
            "code" in error && error.code === "EAI_AGAIN") {
          throw new CimdUnavailableError();
        }
        throw new CimdFetchError("CIMD DNS resolution failed");
      }
      if (addresses.length === 0 || addresses.some(({ address, family }) =>
        isIP(address) !== family || !isPublicIpAddress(address))) {
        throw new CimdFetchError();
      }
      if (abortController.signal.aborted) throw new CimdFetchError("CIMD fetch timeout");
      const selected = addresses[0]!;
      const hostname = new URL(clientId).hostname;
      const lookup: CimdLookup = (requestedHostname, _options, callback) => {
        if (requestedHostname !== hostname) {
          const error = new Error("CIMD pinned lookup hostname mismatch") as NodeJS.ErrnoException;
          error.code = "ENOTFOUND";
          callback(error, "", 0);
          return;
        }
        if (_options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      };
      let response: CimdHttpResponse;
      try {
        response = await transport(new URL(clientId), {
          address: selected.address,
          family: selected.family,
          servername: hostname,
          lookup,
          signal: abortController.signal,
        });
      } catch {
        throw new CimdUnavailableError();
      }
      let destroyed = false;
      const destroyResponse = () => {
        if (destroyed) return;
        destroyed = true;
        try {
          response.destroy();
        } catch {
          // Cleanup must not expose transport-specific details.
        }
      };
      abortController.signal.addEventListener("abort", destroyResponse, { once: true });
      let accepted = false;
      try {
        if (abortController.signal.aborted) {
          throw new CimdFetchError("CIMD fetch timeout");
        }
        const { document, byteLength } = await readJson(response, abortController.signal);
        let client: ValidatedClient;
        try {
          client = validateCimdClientMetadata(document, clientId);
        } catch {
          throw new CimdFetchError();
        }
        accepted = true;
        return { client, byteLength };
      } finally {
        abortController.signal.removeEventListener("abort", destroyResponse);
        if (!accepted) destroyResponse();
      }
    })();

    try {
      const { client, byteLength } = await Promise.race([fetchPromise, timeoutPromise]);
      cacheClient(clientId, client, byteLength, now());
      return client;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

export const fetchCimdClient = createCimdFetcher();
