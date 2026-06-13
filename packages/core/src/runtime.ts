import { nanoid } from "nanoid";
import { detectHttpAdapter, type HttpAdapter, type Middleware } from "@blacksmith/adapters";
import { EventBus } from "./events.js";
import { RuntimeRegistry } from "./registry.js";

export interface BlacksmithPlugin {
  readonly name: string;
  register(runtime: BlacksmithRuntime): void | Promise<void>;
  start?(runtime: BlacksmithRuntime): void | Promise<void>;
  stop?(runtime: BlacksmithRuntime): void | Promise<void>;
}

export interface ForgeOptions {
  plugins?: BlacksmithPlugin[];
  serviceName?: string;
}

export interface BlacksmithRuntime {
  readonly app: unknown;
  readonly adapter: HttpAdapter;
  readonly events: EventBus;
  readonly registry: RuntimeRegistry;
  readonly serviceName: string;
  use(middleware: Middleware): void;
  get(path: string, handler: Parameters<HttpAdapter["get"]>[1]): void;
  stop(): Promise<void>;
}

export async function forge(
  app: unknown,
  options: ForgeOptions = {}
): Promise<BlacksmithRuntime> {
  const adapter = detectHttpAdapter(app);
  const events = new EventBus();
  const registry = new RuntimeRegistry();
  const plugins = options.plugins ?? [];
  const serviceName = options.serviceName ?? "blacksmith-service";

  const runtime: BlacksmithRuntime = {
    app,
    adapter,
    events,
    registry,
    serviceName,
    use: (middleware) => adapter.use(middleware),
    get: (path, handler) => adapter.get(path, handler),
    stop: async () => {
      await events.emit("runtime.stopping", { serviceName });
      for (const plugin of [...plugins].reverse()) {
        await plugin.stop?.(runtime);
      }
      await events.emit("runtime.stopped", { serviceName });
    }
  };

  registry.set("blacksmith.startedAt", new Date());
  registry.set("blacksmith.plugins", plugins.map((plugin) => plugin.name));

  runtime.use(async (req, _res, next) => {
    const incomingRequestId = req.get?.("x-request-id") ?? header(req, "x-request-id");
    req.blacksmith = {
      requestId: incomingRequestId ?? nanoid(),
      startTime: process.hrtime.bigint()
    };
    next();
  });

  for (const plugin of plugins) {
    await plugin.register(runtime);
  }

  await events.emit("runtime.registered", {
    adapter: adapter.name,
    pluginCount: plugins.length,
    serviceName
  });

  for (const plugin of plugins) {
    await plugin.start?.(runtime);
  }

  await events.emit("runtime.started", {
    adapter: adapter.name,
    pluginCount: plugins.length,
    serviceName
  });

  return runtime;
}

function header(req: { headers?: Record<string, string | string[] | undefined> }, name: string) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}
