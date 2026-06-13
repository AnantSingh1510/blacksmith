import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry
} from "prom-client";
import type { BlacksmithPlugin, BlacksmithRuntime } from "@blacksmith/core";

export interface MetricsPluginOptions {
  endpoint?: string;
  registry?: Registry;
  collectDefaultMetrics?: boolean;
}

export class MetricsPlugin implements BlacksmithPlugin {
  readonly name = "metrics";
  private readonly endpoint: string;
  private readonly registry: Registry;
  private readonly httpRequestsTotal: Counter<string>;
  private readonly httpRequestDuration: Histogram<string>;
  private readonly serviceUptime: Gauge<string>;

  constructor(options: MetricsPluginOptions = {}) {
    this.endpoint = options.endpoint ?? "/metrics";
    this.registry = options.registry ?? new Registry();

    if (options.collectDefaultMetrics ?? true) {
      collectDefaultMetrics({
        register: this.registry,
        prefix: "blacksmith_"
      });
    }

    this.httpRequestsTotal = new Counter({
      name: "blacksmith_http_requests_total",
      help: "Total HTTP requests observed by Blacksmith.",
      labelNames: ["method", "route", "status_code"],
      registers: [this.registry]
    });

    this.httpRequestDuration = new Histogram({
      name: "blacksmith_http_request_duration_seconds",
      help: "HTTP request duration observed by Blacksmith.",
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      labelNames: ["method", "route", "status_code"],
      registers: [this.registry]
    });

    this.serviceUptime = new Gauge({
      name: "blacksmith_service_uptime_seconds",
      help: "Service uptime in seconds.",
      labelNames: ["service"],
      registers: [this.registry]
    });
  }

  register(runtime: BlacksmithRuntime): void {
    const startedAt = Date.now();
    runtime.registry.set("metrics.registry", this.registry);

    runtime.use((req, res, next) => {
      const started = process.hrtime.bigint();

      res.on?.("finish", () => {
        const labels = {
          method: req.method ?? "UNKNOWN",
          route: req.blacksmith?.route ?? req.path ?? req.url ?? "unknown",
          status_code: String(res.statusCode ?? 0)
        };
        const durationSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;

        this.httpRequestsTotal.inc(labels);
        this.httpRequestDuration.observe(labels, durationSeconds);
      });

      next();
    });

    runtime.get(this.endpoint, async (_req, res) => {
      this.serviceUptime.set({ service: runtime.serviceName }, (Date.now() - startedAt) / 1000);
      const body = await this.registry.metrics();

      res.type?.(this.registry.contentType);
      if (typeof res.setHeader === "function") {
        res.setHeader("content-type", this.registry.contentType);
      }
      res.send?.(body) ?? res.end?.(body);
    });
  }
}

export { Registry };
