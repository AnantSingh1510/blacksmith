import express from "express";
import type { BlacksmithExpressRequest } from "@blacksmith/adapters/express";
import { CachePlugin, type CacheClient } from "@blacksmith/cache";
import { forge } from "@blacksmith/core";
import { HealthPlugin } from "@blacksmith/health";
import { LoggingPlugin } from "@blacksmith/logging";
import { MetricsPlugin } from "@blacksmith/metrics";
import { ShutdownPlugin } from "@blacksmith/shutdown";
import { TracingPlugin } from "@blacksmith/tracing";

const app = express();
const port = Number(process.env.PORT ?? 3000);

const runtime = await forge(app, {
  serviceName: "blacksmith-express-example",
  plugins: [
    new LoggingPlugin(),
    new TracingPlugin(),
    new MetricsPlugin(),
    new CachePlugin({
      namespace: "example",
      defaultTtlMs: 30_000
    }),
    new HealthPlugin({
      checks: {
        database: async () => ({ status: "up" }),
        redis: async () => ({ status: "up" })
      }
    }),
    new ShutdownPlugin({
      hooks: {
        server: () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      }
    })
  ]
});

const cache = runtime.registry.require<CacheClient>("cache");

app.get("/users/:id", (req, res) => {
  const request = req as BlacksmithExpressRequest<typeof req>;

  res.json({
    id: req.params.id,
    requestId: request.blacksmith?.requestId
  });
});

app.get("/cached-users/:id", async (req, res) => {
  const user = await cache.getOrSet(`user:${req.params.id}`, async () => ({
    id: req.params.id,
    loadedAt: new Date().toISOString()
  }));

  res.json(user);
});

const server = app.listen(port, () => {
  console.log(`Blacksmith Express example listening on http://localhost:${port}`);
});
