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
