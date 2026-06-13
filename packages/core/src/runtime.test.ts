import { describe, expect, it } from "vitest";
import { forge, type Middleware, type RouteHandler } from "./index.js";

class FakeApp {
  readonly middleware: Middleware[] = [];
  readonly routes = new Map<string, RouteHandler>();

  use(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  get(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
  }
}

describe("forge", () => {
  it("registers plugins and exposes runtime services", async () => {
    const app = new FakeApp();

    const runtime = await forge(app, {
      serviceName: "test-service",
      plugins: [
        {
          name: "test-plugin",
          register(runtime) {
            runtime.registry.set("plugin.ready", true);
          }
        }
      ]
    });

    expect(runtime.serviceName).toBe("test-service");
    expect(runtime.registry.get("plugin.ready")).toBe(true);
    expect(runtime.registry.get("blacksmith.plugins")).toEqual(["test-plugin"]);
    expect(app.middleware).toHaveLength(1);
  });
});
