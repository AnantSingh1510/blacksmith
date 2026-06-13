import { describe, expect, it } from "vitest";
import type { BlacksmithRuntime, RouteHandler } from "@blacksmith/core";
import { EventBus, RuntimeRegistry } from "@blacksmith/core";
import { HealthPlugin } from "./index.js";

describe("HealthPlugin", () => {
  it("registers health, liveness, and readiness endpoints", async () => {
    const runtime = fakeRuntime();
    const plugin = new HealthPlugin({
      checks: {
        database: () => ({ status: "up" })
      }
    });

    plugin.register(runtime);

    expect(runtime.routes.has("/health")).toBe(true);
    expect(runtime.routes.has("/liveness")).toBe(true);
    expect(runtime.routes.has("/readiness")).toBe(true);

    const readiness = createJsonResponse();
    await runtime.routes.get("/readiness")?.({}, readiness);

    expect(readiness.statusCode).toBe(200);
    expect(readiness.body).toMatchObject({
      status: "up",
      checks: {
        database: { status: "up" }
      }
    });
  });

  it("marks readiness down when a check throws", async () => {
    const runtime = fakeRuntime();
    const plugin = new HealthPlugin({
      checks: {
        redis: () => {
          throw new Error("redis unavailable");
        }
      }
    });

    plugin.register(runtime);
    const readiness = createJsonResponse();
    await runtime.routes.get("/readiness")?.({}, readiness);

    expect(readiness.statusCode).toBe(503);
    expect(readiness.body).toMatchObject({
      status: "down",
      checks: {
        redis: {
          status: "down",
          details: { error: "redis unavailable" }
        }
      }
    });
  });
});

function fakeRuntime() {
  const routes = new Map<string, RouteHandler>();
  return {
    app: {},
    adapter: { name: "test", use: () => undefined, get: () => undefined },
    events: new EventBus(),
    registry: new RuntimeRegistry(),
    serviceName: "test-service",
    routes,
    use: () => undefined,
    get: (path: string, handler: RouteHandler) => routes.set(path, handler),
    stop: async () => undefined
  } satisfies BlacksmithRuntime & { routes: Map<string, RouteHandler> };
}

function createJsonResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    json(body: unknown) {
      this.body = body;
    }
  };
}
