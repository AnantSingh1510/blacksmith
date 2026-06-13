import { describe, expect, it } from "vitest";
import type { BlacksmithRuntime, Middleware, RouteHandler } from "@blacksmith/core";
import { EventBus, RuntimeRegistry } from "@blacksmith/core";
import { MetricsPlugin, Registry } from "./index.js";

describe("MetricsPlugin", () => {
  it("records completed HTTP requests and exposes metrics", async () => {
    const runtime = fakeRuntime();
    const registry = new Registry();
    const plugin = new MetricsPlugin({
      registry,
      collectDefaultMetrics: false
    });

    plugin.register(runtime);

    const response = createResponse();
    runtime.middleware[0]?.(
      {
        method: "GET",
        path: "/users/:id",
        blacksmith: {
          requestId: "request-1",
          startTime: process.hrtime.bigint()
        }
      },
      response,
      () => undefined
    );
    response.finish();

    const metricsResponse = createTextResponse();
    await runtime.routes.get("/metrics")?.({}, metricsResponse);

    expect(metricsResponse.body).toContain("blacksmith_http_requests_total");
    expect(metricsResponse.body).toContain('route="/users/:id"');
    expect(metricsResponse.body).toContain("blacksmith_service_uptime_seconds");
  });
});

function fakeRuntime() {
  const middleware: Middleware[] = [];
  const routes = new Map<string, RouteHandler>();
  return {
    app: {},
    adapter: { name: "test", use: () => undefined, get: () => undefined },
    events: new EventBus(),
    registry: new RuntimeRegistry(),
    serviceName: "test-service",
    middleware,
    routes,
    use: (handler: Middleware) => {
      middleware.push(handler);
    },
    get: (path: string, handler: RouteHandler) => {
      routes.set(path, handler);
    },
    stop: async () => undefined
  } satisfies BlacksmithRuntime & {
    middleware: Middleware[];
    routes: Map<string, RouteHandler>;
  };
}

function createResponse() {
  let finishHandler: () => void = () => undefined;
  return {
    statusCode: 200,
    on(eventName: "finish" | "close", handler: () => void) {
      if (eventName === "finish") {
        finishHandler = handler;
      }
    },
    finish() {
      finishHandler();
    }
  };
}

function createTextResponse() {
  return {
    body: "",
    type() {
      return this;
    },
    setHeader: () => undefined,
    send(body: string) {
      this.body = body;
    }
  };
}
