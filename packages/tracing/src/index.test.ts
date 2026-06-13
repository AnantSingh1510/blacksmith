import { describe, expect, it, vi } from "vitest";
import type { Span, Tracer } from "@opentelemetry/api";
import type { BlacksmithRuntime, Middleware } from "@blacksmith/core";
import { EventBus, RuntimeRegistry } from "@blacksmith/core";
import { TracingPlugin } from "./index.js";

describe("TracingPlugin", () => {
  it("starts and finishes spans for completed requests", () => {
    const span = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn()
    } as unknown as Span;
    const tracer = {
      startSpan: vi.fn(() => span)
    } as unknown as Tracer;
    const runtime = fakeRuntime();
    const plugin = new TracingPlugin({ tracer });

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

    expect(tracer.startSpan).toHaveBeenCalledWith(
      "GET /users/:id",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "blacksmith.request_id": "request-1",
          "http.request.method": "GET",
          "service.name": "test-service"
        })
      })
    );
    expect(span.setAttribute).toHaveBeenCalledWith("http.response.status_code", 200);
    expect(span.end).toHaveBeenCalledOnce();
  });
});

function fakeRuntime() {
  const middleware: Middleware[] = [];
  return {
    app: {},
    adapter: { name: "test", use: () => undefined, get: () => undefined },
    events: new EventBus(),
    registry: new RuntimeRegistry(),
    serviceName: "test-service",
    middleware,
    use: (handler: Middleware) => {
      middleware.push(handler);
    },
    get: () => undefined,
    stop: async () => undefined
  } satisfies BlacksmithRuntime & { middleware: Middleware[] };
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
