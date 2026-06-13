import type { BlacksmithPlugin, BlacksmithRuntime } from "@blacksmith/core";

export type HealthCheckStatus = "up" | "down";

export interface HealthCheckResult {
  status: HealthCheckStatus;
  details?: Record<string, unknown>;
}

export type HealthCheck = () => HealthCheckResult | Promise<HealthCheckResult>;

export interface HealthPluginOptions {
  checks?: Record<string, HealthCheck>;
  basePath?: string;
}

export class HealthPlugin implements BlacksmithPlugin {
  readonly name = "health";
  private readonly checks: Record<string, HealthCheck>;
  private readonly basePath: string;

  constructor(options: HealthPluginOptions = {}) {
    this.checks = options.checks ?? {};
    this.basePath = options.basePath ?? "";
  }

  register(runtime: BlacksmithRuntime): void {
    const startedAt = Date.now();
    runtime.registry.set("health.checks", this.checks);

    runtime.get(`${this.basePath}/health`, async (_req, res) => {
      respond(res, 200, {
        status: "up",
        service: runtime.serviceName,
        uptimeSeconds: uptimeSeconds(startedAt)
      });
    });

    runtime.get(`${this.basePath}/liveness`, async (_req, res) => {
      respond(res, 200, {
        status: "up",
        uptimeSeconds: uptimeSeconds(startedAt)
      });
    });

    runtime.get(`${this.basePath}/readiness`, async (_req, res) => {
      const checks = await runChecks(this.checks);
      const ready = Object.values(checks).every((check) => check.status === "up");

      respond(res, ready ? 200 : 503, {
        status: ready ? "up" : "down",
        checks,
        uptimeSeconds: uptimeSeconds(startedAt)
      });
    });
  }
}

async function runChecks(checks: Record<string, HealthCheck>) {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        return [name, await check()] as const;
      } catch (error) {
        return [
          name,
          {
            status: "down",
            details: {
              error: error instanceof Error ? error.message : String(error)
            }
          }
        ] as const;
      }
    })
  );

  return Object.fromEntries(entries);
}

function uptimeSeconds(startedAt: number) {
  return (Date.now() - startedAt) / 1000;
}

function respond(
  res: {
    statusCode?: number;
    setHeader?: (name: string, value: string) => void;
    json?: (body: unknown) => unknown;
    send?: (body: unknown) => unknown;
    end?: (body?: unknown) => unknown;
  },
  statusCode: number,
  body: unknown
) {
  res.statusCode = statusCode;
  if (typeof res.json === "function") {
    res.json(body);
    return;
  }

  res.setHeader?.("content-type", "application/json");
  const payload = JSON.stringify(body);
  res.send?.(payload) ?? res.end?.(payload);
}
