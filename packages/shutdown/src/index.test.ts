import { describe, expect, it, vi } from "vitest";
import type { BlacksmithRuntime } from "@blacksmith/core";
import { EventBus, RuntimeRegistry } from "@blacksmith/core";
import { ShutdownPlugin } from "./index.js";

describe("ShutdownPlugin", () => {
  it("runs hooks and stops the runtime when a signal is received", async () => {
    const hook = vi.fn();
    const stop = vi.fn(async () => undefined);
    const runtime = fakeRuntime(stop);
    const plugin = new ShutdownPlugin({
      exitProcess: false,
      hooks: { server: hook },
      signals: ["SIGTERM"]
    });

    plugin.register(runtime);
    plugin.start(runtime);
    process.emit("SIGTERM");
    await waitForMicrotasks();

    expect(hook).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();

    plugin.stop();
  });
});

function fakeRuntime(stop: () => Promise<void>) {
  return {
    app: {},
    adapter: { name: "test", use: () => undefined, get: () => undefined },
    events: new EventBus(),
    registry: new RuntimeRegistry(),
    serviceName: "test-service",
    use: () => undefined,
    get: () => undefined,
    stop
  } satisfies BlacksmithRuntime;
}

async function waitForMicrotasks() {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}
