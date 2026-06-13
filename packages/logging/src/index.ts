import pino, { type Logger, type LoggerOptions } from "pino";
import type { BlacksmithPlugin, BlacksmithRuntime } from "@blacksmith/core";

export interface LoggingPluginOptions {
  logger?: Logger;
  pino?: LoggerOptions;
}

export class LoggingPlugin implements BlacksmithPlugin {
  readonly name = "logging";
  private readonly logger: Logger;

  constructor(options: LoggingPluginOptions = {}) {
    this.logger = options.logger ?? pino(options.pino ?? {});
  }

  register(runtime: BlacksmithRuntime): void {
    runtime.registry.set("logger", this.logger);

    runtime.use((req, res, next) => {
      const startedAt = process.hrtime.bigint();
      const requestId = req.blacksmith?.requestId;

      setResponseHeader(res, "x-request-id", requestId);
      res.on?.("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        this.logger.info(
          {
            requestId,
            method: req.method,
            path: req.originalUrl ?? req.url ?? req.path,
            statusCode: res.statusCode,
            durationMs
          },
          "request completed"
        );
      });

      next();
    });
  }
}

function setResponseHeader(
  res: { setHeader?: (name: string, value: string) => void; header?: (name: string, value: string) => unknown },
  name: string,
  value: string | undefined
) {
  if (!value) {
    return;
  }

  if (typeof res.setHeader === "function") {
    res.setHeader(name, value);
    return;
  }

  res.header?.(name, value);
}

export type { Logger };
