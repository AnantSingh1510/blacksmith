import { describe, expect, it, vi } from "vitest";
import type { BlacksmithRuntime } from "@blacksmith/core";
import { EventBus, RuntimeRegistry } from "@blacksmith/core";
import { CacheClient, CachePlugin, MemoryCacheStore } from "./index.js";

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
