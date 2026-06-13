import { describe, expect, it } from "vitest";
import {
  createExpressAdapter,
  detectHttpAdapter,
  type Middleware,
  type RouteHandler
} from "./index.js";

class FakeExpressApp {
  readonly middleware: Middleware[] = [];
  readonly routes = new Map<
    string,
    (req: Parameters<RouteHandler>[0], res: Parameters<RouteHandler>[1], next: () => void) => void
  >();

  use(handler: Middleware): void {
    this.middleware.push(handler);
  }

  get(
    path: string,
    handler: (req: Parameters<RouteHandler>[0], res: Parameters<RouteHandler>[1], next: () => void) => void
  ): void {
    this.routes.set(path, handler);
  }
}

describe("HTTP adapters", () => {
  it("detects Express-like apps", () => {
    const app = new FakeExpressApp();
    const adapter = detectHttpAdapter(app);

    expect(adapter.name).toBe("express");
  });

  it("registers Express middleware and routes", () => {
    const app = new FakeExpressApp();
    const adapter = createExpressAdapter(app);

    adapter.use((_req, _res, next) => next());
    adapter.get("/health", () => undefined);

    expect(app.middleware).toHaveLength(1);
    expect(app.routes.has("/health")).toBe(true);
  });
});
