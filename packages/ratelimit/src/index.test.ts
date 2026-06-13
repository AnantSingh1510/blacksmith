import { describe, expect, it, vi } from "vitest";
import type {
  BlacksmithRuntime,
  HttpRequestLike,
  HttpResponseLike,
  Middleware
} from "@blacksmith/core";
import { EventBus, RuntimeRegistry } from "@blacksmith/core";
import {
  MemoryRateLimitStore,
  RateLimitPlugin,
  RedisRateLimitStore,
  type RedisRateLimitClient,
  type RateLimitStore
} from "./index.js";

describe("MemoryRateLimitStore", () => {
  it("resets counters after the window expires", async () => {
    vi.useFakeTimers();
    const store = new MemoryRateLimitStore();

    expect(await store.increment("global:client", 1000)).toMatchObject({ count: 1 });
    expect(await store.increment("global:client", 1000)).toMatchObject({ count: 2 });

    vi.advanceTimersByTime(1001);

    expect(await store.increment("global:client", 1000)).toMatchObject({ count: 1 });

    vi.useRealTimers();
  });
});

describe("RedisRateLimitStore", () => {
  it("increments shared Redis counters with an expiry window", async () => {
    vi.useFakeTimers();
    const client = new FakeRedisRateLimitClient();
    const store = new RedisRateLimitStore({ client });

    const first = await store.increment("global:client", 1000);
    const second = await store.increment("global:client", 1000);

    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(client.expirations.get("blacksmith:ratelimit:global:client")).toBe(1000);

    vi.advanceTimersByTime(1001);

    await expect(store.increment("global:client", 1000)).resolves.toMatchObject({ count: 1 });

    vi.useRealTimers();
  });
});

describe("RateLimitPlugin", () => {
  it("allows requests within the limit and sets headers", async () => {
    const runtime = fakeRuntime();
    const plugin = new RateLimitPlugin({
      identity: () => "client-1",
      limit: 2,
      windowMs: 60_000
    });

    plugin.register(runtime);
    const res = createResponse();
    const next = vi.fn();

    await runtime.middleware[0]?.(request(), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers["x-ratelimit-limit"]).toBe("2");
    expect(res.headers["x-ratelimit-remaining"]).toBe("1");
  });

  it("blocks requests over the limit", async () => {
    const runtime = fakeRuntime();
    const blockedEvents: Record<string, unknown>[] = [];
    runtime.events.on("rate_limit.blocked", (payload) => {
      blockedEvents.push(payload);
    });
    const plugin = new RateLimitPlugin({
      identity: () => "client-1",
      limit: 1,
      windowMs: 60_000
    });

    plugin.register(runtime);
    await runtime.middleware[0]?.(request(), createResponse(), vi.fn());

    const res = createResponse();
    const next = vi.fn();
    await runtime.middleware[0]?.(request(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: "Too many requests" });
    expect(res.headers["retry-after"]).toBeDefined();
    expect(blockedEvents).toHaveLength(1);
  });

  it("uses custom identity resolvers", async () => {
    const runtime = fakeRuntime();
    const plugin = new RateLimitPlugin({
      identity: (req) => req.headers?.["x-api-key"] as string,
      keyPrefix: "api",
      limit: 1
    });

    plugin.register(runtime);
    await runtime.middleware[0]?.(
      request({ headers: { "x-api-key": "key-1" } }),
      createResponse(),
      vi.fn()
    );

    const store = runtime.registry.require<MemoryRateLimitStore>("ratelimit.store");
    expect(store.size()).toBe(1);
  });

  it("skips matching requests", async () => {
    const runtime = fakeRuntime();
    const plugin = new RateLimitPlugin({
      limit: 0,
      skip: (req) => req.path === "/health"
    });

    plugin.register(runtime);

    const next = vi.fn();
    await runtime.middleware[0]?.(request({ path: "/health" }), createResponse(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("fails open when the store errors and failOpen is enabled", async () => {
    const runtime = fakeRuntime();
    const plugin = new RateLimitPlugin({
      failOpen: true,
      store: failingStore()
    });

    plugin.register(runtime);

    const next = vi.fn();
    await runtime.middleware[0]?.(request(), createResponse(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed when the store errors and failOpen is disabled", async () => {
    const runtime = fakeRuntime();
    const plugin = new RateLimitPlugin({
      failOpen: false,
      store: failingStore()
    });

    plugin.register(runtime);

    const res = createResponse();
    const next = vi.fn();
    await runtime.middleware[0]?.(request(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
  });
});

function fakeRuntime() {
  const middleware: Middleware[] = [];
  return {
    app: {},
    adapter: { name: "test", use: () => undefined, get: () => undefined },
    events: new EventBus(),
    registry: new RuntimeRegistry(),
    serviceName: "test-service",
    middleware,
    use: (handler: Middleware) => {
      middleware.push(handler);
    },
    get: () => undefined,
    stop: async () => undefined
  } satisfies BlacksmithRuntime & { middleware: Middleware[] };
}

function request(overrides: Partial<HttpRequestLike> = {}): HttpRequestLike {
  return {
    headers: {},
    method: "GET",
    path: "/users",
    ...overrides
  };
}

function createResponse(): HttpResponseLike & {
  body?: unknown;
  headers: Record<string, string>;
} {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    json(body: unknown) {
      this.body = body;
    },
    send(body: unknown) {
      this.body = body;
    }
  };
}

function failingStore(): RateLimitStore {
  return {
    async increment() {
      throw new Error("store unavailable");
    }
  };
}

class FakeRedisRateLimitClient implements RedisRateLimitClient {
  readonly values = new Map<string, number>();
  readonly expirations = new Map<string, number>();
  private readonly expiresAt = new Map<string, number>();

  async incr(key: string): Promise<number> {
    this.prune(key);
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async pExpire(key: string, milliseconds: number): Promise<boolean> {
    this.expirations.set(key, milliseconds);
    this.expiresAt.set(key, Date.now() + milliseconds);
    return true;
  }

  async pTTL(key: string): Promise<number> {
    this.prune(key);
    const expiresAt = this.expiresAt.get(key);
    if (expiresAt === undefined) {
      return this.values.has(key) ? -1 : -2;
    }

    return Math.max(expiresAt - Date.now(), 0);
  }

  async del(key: string): Promise<number> {
    const deleted = this.values.delete(key) ? 1 : 0;
    this.expiresAt.delete(key);
    return deleted;
  }

  private prune(key: string): void {
    const expiresAt = this.expiresAt.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.values.delete(key);
      this.expiresAt.delete(key);
    }
  }
}
