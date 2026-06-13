import { describe, expect, it, vi } from "vitest";
import type { BlacksmithRuntime, Middleware } from "@blacksmith/core";
import { EventBus, RuntimeRegistry } from "@blacksmith/core";
import { LoggingPlugin, type Logger } from "./index.js";

describe("LoggingPlugin", () => {
  it("logs completed requests with correlation data", () => {
    const runtime = fakeRuntime();
    const logger = { info: vi.fn() } as unknown as Logger;
    const plugin = new LoggingPlugin({ logger });

    plugin.register(runtime);

    const response = createResponse();
    runtime.middleware[0]?.(
      {
        method: "GET",
        originalUrl: "/users/123",
        blacksmith: {
          requestId: "request-1",
          startTime: process.hrtime.bigint()
        }
      },
      response,
      () => undefined
    );
    response.finish();

    expect(response.headers["x-request-id"]).toBe("request-1");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        method: "GET",
        path: "/users/123",
        statusCode: 200
      }),
      "request completed"
    );
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
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
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
