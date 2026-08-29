import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import {
  isValidCimdClientId,
  validateCimdClientMetadata,
  type ValidatedClient,
} from "./client-metadata";

const CIMD_TIMEOUT_MS = 3_000;
const CIMD_MAX_BYTES = 32 * 1024;
const CIMD_CACHE_TTL_MS = 5 * 60 * 1_000;

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
};

export type CimdTransport = (
  url: URL,
  options: CimdTransportOptions,
) => Promise<CimdHttpResponse>;

export type CimdFetcherDependencies = {
  resolve?: CimdDnsResolver;
  transport?: CimdTransport;
  now?: () => number;
};

export class CimdFetchError extends Error {
  constructor(message = "CIMD client metadata could not be validated") {
    super(message);
    this.name = "CimdFetchError";
  }
}

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

async function readJson(response: CimdHttpResponse, signal: AbortSignal): Promise<unknown> {
  if (response.statusCode >= 300 && response.statusCode < 400) throw new CimdFetchError();
  if (response.statusCode < 200 || response.statusCode >= 300 || !isJsonMediaType(contentType(response.headers))) {
    throw new CimdFetchError();
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of response.body) {
    if (signal.aborted) throw new CimdFetchError("CIMD fetch timeout");
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    byteLength += bytes.byteLength;
    if (byteLength > CIMD_MAX_BYTES) throw new CimdFetchError();
    chunks.push(bytes);
  }
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(json) as unknown;
  } catch {
    throw new CimdFetchError();
  }
}

export function createCimdFetcher(dependencies: CimdFetcherDependencies = {}) {
  const resolveDns = dependencies.resolve ?? defaultResolve;
  const transport = dependencies.transport ?? defaultTransport;
  const now = dependencies.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; client: ValidatedClient }>();

  return async function fetchClient(clientId: string): Promise<ValidatedClient> {
    if (!isValidCimdClientId(clientId)) throw new CimdFetchError();
    const cached = cache.get(clientId);
    if (cached && cached.expiresAt > now()) return cached.client;
    cache.delete(clientId);

    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new CimdFetchError("CIMD fetch timeout"));
      }, CIMD_TIMEOUT_MS);
    });

    const fetchPromise = (async () => {
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await resolveDns(new URL(clientId).hostname);
      } catch {
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
        throw new CimdFetchError();
      }
      if (abortController.signal.aborted) throw new CimdFetchError("CIMD fetch timeout");
      const document = await readJson(response, abortController.signal);
      return validateCimdClientMetadata(document, clientId);
    })();

    try {
      const client = await Promise.race([fetchPromise, timeoutPromise]);
      cache.set(clientId, { client, expiresAt: now() + CIMD_CACHE_TTL_MS });
      return client;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

export const fetchCimdClient = createCimdFetcher();
