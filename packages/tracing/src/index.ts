import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer
} from "@opentelemetry/api";
import type { BlacksmithPlugin, BlacksmithRuntime } from "@blacksmith/core";

export interface TracingPluginOptions {
  tracer?: Tracer;
  tracerName?: string;
}

export class TracingPlugin implements BlacksmithPlugin {
  readonly name = "tracing";
  private readonly tracer: Tracer;

  constructor(options: TracingPluginOptions = {}) {
    this.tracer = options.tracer ?? trace.getTracer(options.tracerName ?? "blacksmith");
  }

  register(runtime: BlacksmithRuntime): void {
    runtime.registry.set("tracing.tracer", this.tracer);

    runtime.use((req, res, next) => {
      const method = req.method ?? "UNKNOWN";
      const route = req.blacksmith?.route ?? req.path ?? req.url ?? "unknown";
      const span = this.tracer.startSpan(`${method} ${route}`, {
        kind: SpanKind.SERVER,
        attributes: {
          "service.name": runtime.serviceName,
          "http.request.method": method,
          "url.path": route,
          "blacksmith.request_id": req.blacksmith?.requestId ?? ""
        }
      });

      res.on?.("finish", () => {
        finishSpan(span, res.statusCode);
      });

      next();
    });
  }
}

function finishSpan(span: Span, statusCode: number | undefined) {
  const code = statusCode ?? 0;
  span.setAttribute("http.response.status_code", code);
  span.setStatus({
    code: code >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK
  });
  span.end();
}
