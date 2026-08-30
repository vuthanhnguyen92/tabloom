import { describe, expect, it, vi } from "vitest";

import {
  createCimdFetcher,
  isPublicIpAddress,
  type CimdHttpResponse,
  type CimdTransport,
} from "../../services/tabloom-mcp/src/oauth/cimd";

const CLIENT_ID = "https://client.example/oauth/client.json";
const VALID_DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: "Example MCP Client",
  redirect_uris: ["https://client.example/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

function documentFor(clientId: string, clientName = "Example MCP Client") {
  return {
    ...VALID_DOCUMENT,
    client_id: clientId,
    client_name: clientName,
  };
}

function response(overrides: Partial<CimdHttpResponse> = {}): CimdHttpResponse {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: (async function* () { yield Buffer.from(JSON.stringify(VALID_DOCUMENT)); })(),
    destroy: vi.fn(),
    ...overrides,
  };
}

function responseFor(clientId: string, clientName?: string): CimdHttpResponse {
  return response({
    body: (async function* () {
      yield Buffer.from(JSON.stringify(documentFor(clientId, clientName)));
    })(),
  });
}

function callsFor(
  transport: ReturnType<typeof vi.fn>,
  clientId: string,
): number {
  return transport.mock.calls.filter(([url]) => (url as URL).href === clientId).length;
}

describe("CIMD hardened fetching", () => {
  it("classifies a transport failure as retryable without exposing its details", async () => {
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => {
        throw new Error("socket reset at private-host.example");
      },
    });

    await expect(fetchClient(CLIENT_ID)).rejects.toMatchObject({
      name: "CimdUnavailableError",
      message: "CIMD client metadata is temporarily unavailable",
    });
    await expect(fetchClient(CLIENT_ID)).rejects.not.toThrow(/private-host|socket reset/i);
  });

  it.each([
    [{ address: "93.184.216.34", family: 4 as const }],
    [{ address: "2606:4700:4700::1111", family: 6 as const }],
  ])("accepts a document reached through a public address", async (resolved) => {
    const fetchClient = createCimdFetcher({
      resolve: async () => [resolved],
      transport: async () => response(),
    });
    await expect(fetchClient(CLIENT_ID)).resolves.toMatchObject({
      clientId: CLIENT_ID,
      source: "cimd",
    });
  });

  it("resolves once and pins one validated address while retaining TLS hostname validation", async () => {
    const resolve = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "2606:4700:4700::1111", family: 6 as const },
    ]);
    const transport: CimdTransport = async (url, options) => {
      expect(url.href).toBe(CLIENT_ID);
      expect(options).toMatchObject({
        address: "93.184.216.34",
        family: 4,
        servername: "client.example",
      });
      await expect(new Promise((resolveLookup, rejectLookup) => {
        options.lookup("client.example", {}, (error, address, family) => {
          if (error) rejectLookup(error);
          else resolveLookup({ address, family });
        });
      })).resolves.toEqual({ address: "93.184.216.34", family: 4 });
      await expect(new Promise((resolveLookup, rejectLookup) => {
        options.lookup("client.example", { all: true }, (error, addresses) => {
          if (error) rejectLookup(error);
          else resolveLookup(addresses);
        });
      })).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
      return response();
    };
    const fetchClient = createCimdFetcher({ resolve, transport });

    await fetchClient(CLIENT_ID);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not start transport after DNS failure or an empty answer", async () => {
    const transport = vi.fn(async () => response());
    await expect(createCimdFetcher({
      resolve: async () => { throw new Error("dns host details"); },
      transport,
    })(CLIENT_ID)).rejects.toThrow(/CIMD/);
    await expect(createCimdFetcher({ resolve: async () => [], transport })(CLIENT_ID)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "http://client.example/oauth/client.json",
    "https://user:password@client.example/oauth/client.json",
    "https://client.example/oauth/client.json#fragment",
    " https://client.example/oauth/client.json",
  ])("rejects invalid CIMD identity %s before DNS", async (clientId) => {
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    await expect(createCimdFetcher({ resolve })(clientId)).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1",
    "192.88.99.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
    "::", "::1", "::ffff:192.0.2.1", "100::1", "2001:db8::1", "3fff::1", "fc00::1", "fe80::1", "ff00::1",
  ])("rejects non-public address %s", async (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
    const family = address.includes(":") ? 6 as const : 4 as const;
    const transport = vi.fn(async () => response());
    await expect(createCimdFetcher({ resolve: async () => [{ address, family }], transport })(CLIENT_ID)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects the complete DNS answer when any address is non-public", async () => {
    const transport = vi.fn(async () => response());
    await expect(createCimdFetcher({
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      transport,
    })(CLIENT_ID)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308])("rejects HTTP redirect status %s", async (statusCode) => {
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => response({ statusCode, headers: { location: "https://other.example/client.json" } }),
    });
    await expect(fetchClient(CLIENT_ID)).rejects.toThrow();
  });

  it.each([
    ["redirect", { statusCode: 302, headers: { location: "https://other.example/client.json" } }],
    ["non-success status", { statusCode: 503 }],
    ["invalid content type", { headers: { "content-type": "text/html" } }],
    ["oversized body", {
      body: (async function* () {
        yield Buffer.alloc(32 * 1024);
        yield Buffer.from("x");
      })(),
    }],
    ["malformed JSON", {
      body: (async function* () { yield Buffer.from("{"); })(),
    }],
    ["invalid metadata", {
      body: (async function* () { yield Buffer.from(JSON.stringify({
        ...VALID_DOCUMENT,
        client_id: "https://different.example/client.json",
      })); })(),
    }],
  ])("destroys the response after rejected %s", async (_label, overrides) => {
    const destroy = vi.fn();
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => response({ ...overrides, destroy }),
    });

    await expect(fetchClient(CLIENT_ID)).rejects.toThrow();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("times out the entire fetch after three seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetchClient = createCimdFetcher({
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => new Promise<CimdHttpResponse>(() => undefined),
      });
      const result = fetchClient(CLIENT_ID);
      const rejection = expect(result).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(3_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys an established response when its body stalls past the deadline", async () => {
    vi.useFakeTimers();
    try {
      let rejectRead!: (error: Error) => void;
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
              rejectRead = reject;
            }),
          };
        },
      };
      const destroy = vi.fn(() => rejectRead(new Error("response destroyed")));
      const fetchClient = createCimdFetcher({
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => response({ body, destroy }),
      });

      const result = fetchClient(CLIENT_ID);
      const rejection = expect(result).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(3_001);
      await rejection;
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start transport when DNS completes after the deadline", async () => {
    vi.useFakeTimers();
    try {
      let finishResolution!: (addresses: [{ address: string; family: 4 }]) => void;
      const transport = vi.fn(async () => response());
      const fetchClient = createCimdFetcher({
        resolve: async () => new Promise((resolve) => { finishResolution = resolve; }),
        transport,
      });
      const result = fetchClient(CLIENT_ID);
      const rejection = expect(result).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(3_001);
      await rejection;
      finishResolution([{ address: "93.184.216.34", family: 4 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a body over 32 KiB while streaming", async () => {
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => response({
        body: (async function* () {
          yield Buffer.alloc(32 * 1024);
          yield Buffer.from("x");
        })(),
      }),
    });
    await expect(fetchClient(CLIENT_ID)).rejects.toThrow();
  });

  it("normalizes response-stream failures without exposing transport details", async () => {
    const destroy = vi.fn();
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => response({
        body: (async function* () {
          yield Buffer.from("{");
          throw new Error("provider socket reset at internal-host.example");
        })(),
        destroy,
      }),
    });
    const result = fetchClient(CLIENT_ID);
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject({
      name: "CimdFetchError",
      message: "CIMD client metadata could not be validated",
    });
    await expect(result).rejects.not.toThrow(/internal-host|socket reset/i);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["text/html", JSON.stringify(VALID_DOCUMENT)],
    ["application/json", "not-json"],
    ["application/json", "[]"],
  ])("rejects content type %s with body %s", async (contentType, document) => {
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => response({
        headers: { "content-type": contentType },
        body: (async function* () { yield Buffer.from(document); })(),
      }),
    });
    await expect(fetchClient(CLIENT_ID)).rejects.toThrow();
  });

  it("accepts structured JSON media types", async () => {
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => response({ headers: { "content-type": "application/client-metadata+json" } }),
    });
    await expect(fetchClient(CLIENT_ID)).resolves.toMatchObject({ clientId: CLIENT_ID });
  });

  it.each([
    ["malformed metadata", {
      ...VALID_DOCUMENT,
      client_name: "sensitive-metadata-detail\u0000",
    }],
    ["mismatched client identity", {
      ...VALID_DOCUMENT,
      client_id: "https://different.example/private-client.json",
    }],
  ])("normalizes %s validation failures", async (_label, document) => {
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => response({
        body: (async function* () { yield Buffer.from(JSON.stringify(document)); })(),
      }),
    });
    const result = fetchClient(CLIENT_ID);

    await expect(result).rejects.toMatchObject({
      name: "CimdFetchError",
      message: "CIMD client metadata could not be validated",
    });
    await expect(result).rejects.not.toThrow(/sensitive-metadata-detail|different\.example/i);
  });

  it("caches only successful exact documents for no more than five minutes", async () => {
    let now = 1_000;
    const transport = vi.fn(async () => response());
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
      now: () => now,
    });
    await fetchClient(CLIENT_ID);
    now += 299_999;
    await fetchClient(CLIENT_ID);
    expect(transport).toHaveBeenCalledTimes(1);
    now += 2;
    await fetchClient(CLIENT_ID);
    expect(transport).toHaveBeenCalledTimes(2);

    const failingTransport = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(response());
    const retryingFetcher = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: failingTransport,
    });
    await expect(retryingFetcher(CLIENT_ID)).rejects.toThrow();
    await expect(retryingFetcher(CLIENT_ID)).resolves.toMatchObject({ clientId: CLIENT_ID });
    expect(failingTransport).toHaveBeenCalledTimes(2);
  });

  it("globally sweeps expired entries before applying the entry cap", async () => {
    let now = 0;
    const clients = [
      "https://client-a.example/oauth/client.json",
      "https://client-b.example/oauth/client.json",
      "https://client-c.example/oauth/client.json",
    ];
    const transport = vi.fn(async (url: URL) => responseFor(url.href));
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
      now: () => now,
      cachePolicy: { maxEntries: 2, maxBytes: 1024 * 1024 },
    });

    await fetchClient(clients[0]!);
    now = 1;
    await fetchClient(clients[1]!);
    now = 2;
    await fetchClient(clients[0]!);
    now = 5 * 60 * 1_000;
    await fetchClient(clients[2]!);
    await fetchClient(clients[1]!);

    expect(callsFor(transport, clients[1]!)).toBe(1);
  });

  it("evicts the least-recently-used entry at the entry cap", async () => {
    const clients = [
      "https://client-a.example/oauth/client.json",
      "https://client-b.example/oauth/client.json",
      "https://client-c.example/oauth/client.json",
    ];
    const transport = vi.fn(async (url: URL) => responseFor(url.href));
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
      cachePolicy: { maxEntries: 2, maxBytes: 1024 * 1024 },
    });

    await fetchClient(clients[0]!);
    await fetchClient(clients[1]!);
    await fetchClient(clients[0]!);
    await fetchClient(clients[2]!);
    await fetchClient(clients[0]!);
    await fetchClient(clients[1]!);

    expect(callsFor(transport, clients[0]!)).toBe(1);
    expect(callsFor(transport, clients[1]!)).toBe(2);
    expect(callsFor(transport, clients[2]!)).toBe(1);
  });

  it("evicts least-recently-used entries until aggregate response bytes fit", async () => {
    const clientA = "https://client-a.example/oauth/client.json";
    const clientB = "https://client-b.example/oauth/client.json";
    const clientC = "https://client-c.example/oauth/client.json";
    const largeName = "C".repeat(100);
    const documents = new Map([
      [clientA, documentFor(clientA)],
      [clientB, documentFor(clientB)],
      [clientC, documentFor(clientC, largeName)],
    ]);
    const transport = vi.fn(async (url: URL) => response({
      body: (async function* () {
        yield Buffer.from(JSON.stringify(documents.get(url.href)));
      })(),
    }));
    const maxBytes = Buffer.byteLength(JSON.stringify(documents.get(clientA))) +
      Buffer.byteLength(JSON.stringify(documents.get(clientC)));
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
      cachePolicy: { maxEntries: 10, maxBytes },
    });

    await fetchClient(clientA);
    await fetchClient(clientB);
    await fetchClient(clientA);
    await fetchClient(clientC);
    await fetchClient(clientA);
    await fetchClient(clientB);

    expect(callsFor(transport, clientA)).toBe(1);
    expect(callsFor(transport, clientB)).toBe(2);
    expect(callsFor(transport, clientC)).toBe(1);
  });

  it("does not retain one document larger than the aggregate byte cap", async () => {
    const document = documentFor(CLIENT_ID);
    const transport = vi.fn(async () => response({
      body: (async function* () { yield Buffer.from(JSON.stringify(document)); })(),
    }));
    const fetchClient = createCimdFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
      cachePolicy: {
        maxEntries: 10,
        maxBytes: Buffer.byteLength(JSON.stringify(document)) - 1,
      },
    });

    await fetchClient(CLIENT_ID);
    await fetchClient(CLIENT_ID);

    expect(transport).toHaveBeenCalledTimes(2);
  });
});
