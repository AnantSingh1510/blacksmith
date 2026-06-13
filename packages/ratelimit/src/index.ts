import type {
  BlacksmithPlugin,
  BlacksmithRuntime,
  HttpRequestLike,
  HttpResponseLike
} from "@blacksmith/core";

export interface RateLimitState {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitState>;
  reset?(key: string): Promise<void>;
}

export type RateLimitIdentityResolver = (
  req: HttpRequestLike
) => string | Promise<string>;

export type RateLimitSkip = (req: HttpRequestLike) => boolean | Promise<boolean>;

export interface RateLimitPluginOptions {
  limit?: number;
  windowMs?: number;
  keyPrefix?: string;
  store?: RateLimitStore;
  failOpen?: boolean;
  identity?: RateLimitIdentityResolver;
  skip?: RateLimitSkip;
  message?: string;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly states = new Map<string, RateLimitState>();

  async increment(key: string, windowMs: number): Promise<RateLimitState> {
    const now = Date.now();
    const existing = this.states.get(key);

    if (!existing || existing.resetAt <= now) {
      const state = {
        count: 1,
        resetAt: now + windowMs
      };
      this.states.set(key, state);
      return state;
    }

    existing.count += 1;
    return existing;
  }

  async reset(key: string): Promise<void> {
    this.states.delete(key);
  }

  size(): number {
    this.pruneExpired();
    return this.states.size;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, state] of this.states) {
      if (state.resetAt <= now) {
        this.states.delete(key);
      }
    }
  }
}

export class RateLimitPlugin implements BlacksmithPlugin {
  readonly name = "ratelimit";
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly keyPrefix: string;
  private readonly store: RateLimitStore;
  private readonly failOpen: boolean;
  private readonly identity: RateLimitIdentityResolver;
  private readonly skip?: RateLimitSkip;
  private readonly message: string;

  constructor(options: RateLimitPluginOptions = {}) {
    this.limit = options.limit ?? 100;
    this.windowMs = options.windowMs ?? 60_000;
    this.keyPrefix = options.keyPrefix ?? "global";
    this.store = options.store ?? new MemoryRateLimitStore();
    this.failOpen = options.failOpen ?? true;
    this.identity = options.identity ?? defaultIdentity;
    this.skip = options.skip;
    this.message = options.message ?? "Too many requests";
  }

  register(runtime: BlacksmithRuntime): void {
    runtime.registry.set("ratelimit.store", this.store);
    runtime.registry.set("ratelimit.policy", {
      failOpen: this.failOpen,
      keyPrefix: this.keyPrefix,
      limit: this.limit,
      windowMs: this.windowMs
    });

    runtime.use(async (req, res, next) => {
      if (await this.skip?.(req)) {
        next();
        return;
      }

      const identity = await this.identity(req);
      const key = `${this.keyPrefix}:${identity}`;

      try {
        const state = await this.store.increment(key, this.windowMs);
        const decision = decide(state, this.limit);
        setRateLimitHeaders(res, decision);

        await runtime.events.emit(decision.allowed ? "rate_limit.allowed" : "rate_limit.blocked", {
          identity,
          key,
          limit: decision.limit,
          remaining: decision.remaining,
          resetAt: decision.resetAt,
          retryAfterSeconds: decision.retryAfterSeconds
        });

        if (decision.allowed) {
          next();
          return;
        }

        respondTooManyRequests(res, this.message);
      } catch (error) {
        await runtime.events.emit("rate_limit.error", {
          error: error instanceof Error ? error.message : String(error),
          identity,
          key
        });

        if (this.failOpen) {
          next();
          return;
        }

        respondTooManyRequests(res, this.message);
      }
    });
  }
}

function decide(state: RateLimitState, limit: number): RateLimitDecision {
  const remaining = Math.max(limit - state.count, 0);
  return {
    allowed: state.count <= limit,
    limit,
    remaining,
    resetAt: state.resetAt,
    retryAfterSeconds: Math.max(Math.ceil((state.resetAt - Date.now()) / 1000), 0)
  };
}

function setRateLimitHeaders(res: HttpResponseLike, decision: RateLimitDecision): void {
  setHeader(res, "x-ratelimit-limit", String(decision.limit));
  setHeader(res, "x-ratelimit-remaining", String(decision.remaining));
  setHeader(res, "x-ratelimit-reset", String(Math.ceil(decision.resetAt / 1000)));

  if (!decision.allowed) {
    setHeader(res, "retry-after", String(decision.retryAfterSeconds));
  }
}

function respondTooManyRequests(res: HttpResponseLike, message: string): void {
  res.statusCode = 429;

  if (typeof res.json === "function") {
    res.json({ error: message });
    return;
  }

  setHeader(res, "content-type", "application/json");
  const payload = JSON.stringify({ error: message });
  res.send?.(payload) ?? res.end?.(payload);
}

function setHeader(res: HttpResponseLike, name: string, value: string): void {
  if (typeof res.setHeader === "function") {
    res.setHeader(name, value);
    return;
  }

  res.header?.(name, value);
}

function defaultIdentity(req: HttpRequestLike): string {
  const forwardedFor = firstHeader(req, "x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "anonymous";
  }

  return (
    firstHeader(req, "x-real-ip") ??
    getRequestProperty(req, "ip") ??
    getNestedRequestProperty(req, "socket", "remoteAddress") ??
    "anonymous"
  );
}

function firstHeader(req: HttpRequestLike, name: string): string | undefined {
  const value = req.get?.(name) ?? req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function getRequestProperty(req: HttpRequestLike, key: string): string | undefined {
  const value = (req as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getNestedRequestProperty(
  req: HttpRequestLike,
  parentKey: string,
  childKey: string
): string | undefined {
  const parent = (req as Record<string, unknown>)[parentKey];
  if (!parent || typeof parent !== "object") {
    return undefined;
  }

  const value = (parent as Record<string, unknown>)[childKey];
  return typeof value === "string" ? value : undefined;
}
