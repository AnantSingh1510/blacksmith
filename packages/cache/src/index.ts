import type { BlacksmithPlugin, BlacksmithRuntime } from "@blacksmith/core";

export interface CacheEntry<TValue = unknown> {
  value: TValue;
  expiresAt?: number;
}

export interface CacheSetOptions {
  ttlMs?: number;
}

export interface CacheGetOrSetOptions extends CacheSetOptions {
  forceRefresh?: boolean;
}

export interface CacheStore {
  get<TValue>(key: string): Promise<TValue | undefined>;
  set<TValue>(key: string, value: TValue, options?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(namespace?: string): Promise<void>;
}

export interface CacheSerializer {
  serialize<TValue>(value: TValue): string;
  deserialize<TValue>(value: string): TValue;
}

export interface RedisCacheClient {
  get(key: string): Promise<string | null | undefined>;
  set(
    key: string,
    value: string,
    options?: {
      PX?: number;
    }
  ): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  keys?(pattern: string): Promise<string[]>;
  scanIterator?(options: { MATCH: string; COUNT?: number }): AsyncIterable<string | string[]>;
}

export interface RedisCacheStoreOptions {
  client: RedisCacheClient;
  keyPrefix?: string;
  serializer?: CacheSerializer;
  scanCount?: number;
}

export interface CacheClientOptions {
  defaultTtlMs?: number;
  namespace?: string;
  emit?: (eventName: string, payload: Record<string, unknown>) => void | Promise<void>;
}

export interface CachePluginOptions extends CacheClientOptions {
  store?: CacheStore;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  async get<TValue>(key: string): Promise<TValue | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (isExpired(entry, Date.now())) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value as TValue;
  }

  async set<TValue>(key: string, value: TValue, options: CacheSetOptions = {}): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: options.ttlMs === undefined ? undefined : Date.now() + options.ttlMs
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async clear(namespace?: string): Promise<void> {
    if (!namespace) {
      this.entries.clear();
      return;
    }

    const prefix = `${namespace}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (isExpired(entry, now)) {
        this.entries.delete(key);
      }
    }
  }
}

export class RedisCacheStore implements CacheStore {
  private readonly client: RedisCacheClient;
  private readonly keyPrefix: string;
  private readonly serializer: CacheSerializer;
  private readonly scanCount: number;

  constructor(options: RedisCacheStoreOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? "blacksmith:cache";
    this.serializer = options.serializer ?? jsonSerializer;
    this.scanCount = options.scanCount ?? 100;
  }

  async get<TValue>(key: string): Promise<TValue | undefined> {
    const value = await this.client.get(this.key(key));
    if (value === null || value === undefined) {
      return undefined;
    }

    return this.serializer.deserialize<TValue>(value);
  }

  async set<TValue>(key: string, value: TValue, options: CacheSetOptions = {}): Promise<void> {
    const storageKey = this.key(key);
    const serialized = this.serializer.serialize(value);

    if (options.ttlMs === undefined) {
      await this.client.set(storageKey, serialized);
      return;
    }

    await this.client.set(storageKey, serialized, { PX: options.ttlMs });
  }

  async delete(key: string): Promise<boolean> {
    return (await this.client.del(this.key(key))) > 0;
  }

  async clear(namespace?: string): Promise<void> {
    const pattern = namespace
      ? `${this.key(`${namespace}:`)}*`
      : `${this.key("")}*`;
    const keys = await this.findKeys(pattern);

    if (keys.length > 0) {
      await this.client.del(keys);
    }
  }

  key(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  private async findKeys(pattern: string): Promise<string[]> {
    if (this.client.scanIterator) {
      const keys: string[] = [];
      for await (const item of this.client.scanIterator({
        COUNT: this.scanCount,
        MATCH: pattern
      })) {
        if (Array.isArray(item)) {
          keys.push(...item);
        } else {
          keys.push(item);
        }
      }

      return keys;
    }

    if (this.client.keys) {
      return this.client.keys(pattern);
    }

    throw new Error("Redis cache store requires scanIterator or keys to clear namespaces.");
  }
}

export class CacheClient {
  private readonly store: CacheStore;
  private readonly defaultTtlMs?: number;
  private readonly namespace: string;
  private readonly emit?: CacheClientOptions["emit"];

  constructor(store: CacheStore, options: CacheClientOptions = {}) {
    this.store = store;
    this.defaultTtlMs = options.defaultTtlMs;
    this.namespace = options.namespace ?? "default";
    this.emit = options.emit;
  }

  async get<TValue>(key: string): Promise<TValue | undefined> {
    const namespacedKey = this.key(key);
    const value = await this.store.get<TValue>(namespacedKey);
    await this.emitCacheEvent(value === undefined ? "cache.miss" : "cache.hit", {
      key,
      namespacedKey,
      namespace: this.namespace
    });

    return value;
  }

  async set<TValue>(key: string, value: TValue, options: CacheSetOptions = {}): Promise<void> {
    const namespacedKey = this.key(key);
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    await this.store.set(namespacedKey, value, { ttlMs });
    await this.emitCacheEvent("cache.set", {
      key,
      namespacedKey,
      namespace: this.namespace,
      ttlMs
    });
  }

  async delete(key: string): Promise<boolean> {
    const namespacedKey = this.key(key);
    const deleted = await this.store.delete(namespacedKey);
    await this.emitCacheEvent("cache.delete", {
      key,
      namespacedKey,
      namespace: this.namespace,
      deleted
    });

    return deleted;
  }

  async invalidate(namespace = this.namespace): Promise<void> {
    await this.store.clear(namespace);
    await this.emitCacheEvent("cache.invalidate", { namespace });
  }

  async getOrSet<TValue>(
    key: string,
    loader: () => TValue | Promise<TValue>,
    options: CacheGetOrSetOptions = {}
  ): Promise<TValue> {
    if (!options.forceRefresh) {
      const cached = await this.get<TValue>(key);
      if (cached !== undefined) {
        return cached;
      }
    }

    const fresh = await loader();
    await this.set(key, fresh, options);
    return fresh;
  }

  key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private async emitCacheEvent(eventName: string, payload: Record<string, unknown>) {
    await this.emit?.(eventName, payload);
  }
}

export class CachePlugin implements BlacksmithPlugin {
  readonly name = "cache";
  private readonly store: CacheStore;
  private readonly defaultTtlMs?: number;
  private readonly namespace: string;

  constructor(options: CachePluginOptions = {}) {
    this.store = options.store ?? new MemoryCacheStore();
    this.defaultTtlMs = options.defaultTtlMs;
    this.namespace = options.namespace ?? "default";
  }

  register(runtime: BlacksmithRuntime): void {
    const cache = new CacheClient(this.store, {
      defaultTtlMs: this.defaultTtlMs,
      namespace: this.namespace,
      emit: (eventName, payload) => runtime.events.emit(eventName, payload)
    });

    runtime.registry.set("cache", cache);
    runtime.registry.set("cache.store", this.store);
  }
}

function isExpired(entry: CacheEntry, now: number): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= now;
}

const jsonSerializer: CacheSerializer = {
  serialize(value) {
    return JSON.stringify(value);
  },
  deserialize(value) {
    return JSON.parse(value);
  }
};
