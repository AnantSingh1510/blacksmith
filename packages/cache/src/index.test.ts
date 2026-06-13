import { describe, expect, it, vi } from "vitest";
import type { BlacksmithRuntime } from "@blacksmith/core";
import { EventBus, RuntimeRegistry } from "@blacksmith/core";
import {
  CacheClient,
  CachePlugin,
  MemoryCacheStore,
  RedisCacheStore,
  type RedisCacheClient
} from "./index.js";

describe("MemoryCacheStore", () => {
  it("stores values until their TTL expires", async () => {
    vi.useFakeTimers();
    const store = new MemoryCacheStore();

    await store.set("default:user:1", { id: "1" }, { ttlMs: 1000 });

    expect(await store.get("default:user:1")).toEqual({ id: "1" });

    vi.advanceTimersByTime(1001);

    expect(await store.get("default:user:1")).toBeUndefined();
    expect(store.size()).toBe(0);

    vi.useRealTimers();
  });

  it("clears a single namespace", async () => {
    const store = new MemoryCacheStore();

    await store.set("users:1", "user");
    await store.set("products:1", "product");
    await store.clear("users");

    expect(await store.get("users:1")).toBeUndefined();
    expect(await store.get("products:1")).toBe("product");
  });
});

describe("RedisCacheStore", () => {
  it("stores serialized values in Redis with TTL support", async () => {
    vi.useFakeTimers();
    const client = new FakeRedisCacheClient();
    const store = new RedisCacheStore({ client });

    await store.set("users:1", { id: "1" }, { ttlMs: 1000 });

    expect(client.lastSetOptions).toEqual({ PX: 1000 });
    await expect(store.get("users:1")).resolves.toEqual({ id: "1" });

    vi.advanceTimersByTime(1001);

    await expect(store.get("users:1")).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it("clears only matching namespaced Redis keys", async () => {
    const client = new FakeRedisCacheClient();
    const store = new RedisCacheStore({ client });

    await store.set("users:1", "user");
    await store.set("products:1", "product");
    await store.clear("users");

    await expect(store.get("users:1")).resolves.toBeUndefined();
    await expect(store.get("products:1")).resolves.toBe("product");
  });
});

describe("CacheClient", () => {
  it("emits hit, miss, set, delete, and invalidate events", async () => {
    const emit = vi.fn();
    const cache = new CacheClient(new MemoryCacheStore(), {
      namespace: "users",
      emit
    });

    await cache.get("1");
    await cache.set("1", { id: "1" });
    await cache.get("1");
    await cache.delete("1");
    await cache.invalidate();

    expect(emit).toHaveBeenNthCalledWith(
      1,
      "cache.miss",
      expect.objectContaining({ key: "1", namespace: "users" })
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      "cache.set",
      expect.objectContaining({ key: "1", namespace: "users" })
    );
    expect(emit).toHaveBeenNthCalledWith(
      3,
      "cache.hit",
      expect.objectContaining({ key: "1", namespace: "users" })
    );
    expect(emit).toHaveBeenNthCalledWith(
      4,
      "cache.delete",
      expect.objectContaining({ key: "1", namespace: "users", deleted: true })
    );
    expect(emit).toHaveBeenNthCalledWith(
      5,
      "cache.invalidate",
      expect.objectContaining({ namespace: "users" })
    );
  });

  it("loads once with getOrSet when a value is cached", async () => {
    const cache = new CacheClient(new MemoryCacheStore());
    const loader = vi.fn(async () => ({ id: "1" }));

    await expect(cache.getOrSet("user:1", loader)).resolves.toEqual({ id: "1" });
    await expect(cache.getOrSet("user:1", loader)).resolves.toEqual({ id: "1" });

    expect(loader).toHaveBeenCalledOnce();
  });

  it("reloads with getOrSet when forceRefresh is enabled", async () => {
    const cache = new CacheClient(new MemoryCacheStore());
    const loader = vi
      .fn<() => Promise<{ version: number }>>()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });

    await expect(cache.getOrSet("config", loader)).resolves.toEqual({ version: 1 });
    await expect(cache.getOrSet("config", loader, { forceRefresh: true })).resolves.toEqual({
      version: 2
    });

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("CachePlugin", () => {
  it("registers cache handles and emits through the runtime event bus", async () => {
    const runtime = fakeRuntime();
    const events: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
    runtime.events.on("cache.set", (payload) => {
      events.push({ eventName: "cache.set", payload });
    });
    const plugin = new CachePlugin({ namespace: "users" });

    plugin.register(runtime);

    const cache = runtime.registry.require<CacheClient>("cache");
    await cache.set("1", { id: "1" });

    expect(runtime.registry.get("cache.store")).toBeInstanceOf(MemoryCacheStore);
    expect(events).toEqual([
      {
        eventName: "cache.set",
        payload: expect.objectContaining({
          key: "1",
          namespace: "users",
          namespacedKey: "users:1"
        }) as Record<string, unknown>
      }
    ]);
  });
});

function fakeRuntime() {
  return {
    app: {},
    adapter: { name: "test", use: () => undefined, get: () => undefined },
    events: new EventBus(),
    registry: new RuntimeRegistry(),
    serviceName: "test-service",
    use: () => undefined,
    get: () => undefined,
    stop: async () => undefined
  } satisfies BlacksmithRuntime;
}

class FakeRedisCacheClient implements RedisCacheClient {
  readonly values = new Map<string, { value: string; expiresAt?: number }>();
  lastSetOptions?: { PX?: number };

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, options?: { PX?: number }): Promise<void> {
    this.lastSetOptions = options;
    this.values.set(key, {
      value,
      expiresAt: options?.PX === undefined ? undefined : Date.now() + options.PX
    });
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let deleted = 0;
    for (const item of keys) {
      if (this.values.delete(item)) {
        deleted += 1;
      }
    }

    return deleted;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}
