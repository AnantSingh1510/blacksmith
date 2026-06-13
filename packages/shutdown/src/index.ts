import type { BlacksmithPlugin, BlacksmithRuntime } from "@blacksmith/core";

export type ShutdownSignal = "SIGINT" | "SIGTERM";
export type ShutdownHook = () => void | Promise<void>;

export interface ShutdownPluginOptions {
  signals?: ShutdownSignal[];
  timeoutMs?: number;
  hooks?: Record<string, ShutdownHook>;
  exitProcess?: boolean;
}

export class ShutdownPlugin implements BlacksmithPlugin {
  readonly name = "shutdown";
  private readonly signals: ShutdownSignal[];
  private readonly timeoutMs: number;
  private readonly hooks: Record<string, ShutdownHook>;
  private readonly exitProcess: boolean;
  private readonly listeners = new Map<ShutdownSignal, () => void>();
  private stopping = false;

  constructor(options: ShutdownPluginOptions = {}) {
    this.signals = options.signals ?? ["SIGTERM", "SIGINT"];
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.hooks = options.hooks ?? {};
    this.exitProcess = options.exitProcess ?? true;
  }

  register(runtime: BlacksmithRuntime): void {
    runtime.registry.set("shutdown.hooks", this.hooks);
  }

  start(runtime: BlacksmithRuntime): void {
    for (const signal of this.signals) {
      const listener = () => {
        void this.shutdown(runtime, signal);
      };
      process.once(signal, listener);
      this.listeners.set(signal, listener);
    }
  }

  stop(): void {
    for (const [signal, listener] of this.listeners) {
      process.off(signal, listener);
    }
    this.listeners.clear();
  }

  private async shutdown(runtime: BlacksmithRuntime, signal: ShutdownSignal): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Graceful shutdown timed out.")), this.timeoutMs).unref();
    });

    try {
      await Promise.race([
        (async () => {
          await runtime.events.emit("shutdown.signal", { signal });
          for (const hook of Object.values(this.hooks)) {
            await hook();
          }
          await runtime.stop();
        })(),
        timeout
      ]);
      if (this.exitProcess) {
        process.exit(0);
      }
    } catch (error) {
      const logger = runtime.registry.get<{ error: (payload: unknown, message?: string) => void }>(
        "logger"
      );
      logger?.error({ error, signal }, "graceful shutdown failed");
      if (this.exitProcess) {
        process.exit(1);
      }
    }
  }
}
