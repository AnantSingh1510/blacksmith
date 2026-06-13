import express from "express";
import type { BlacksmithExpressRequest } from "@blacksmith/adapters/express";
import { forge } from "@blacksmith/core";
import { HealthPlugin } from "@blacksmith/health";
import { LoggingPlugin } from "@blacksmith/logging";
import { MetricsPlugin } from "@blacksmith/metrics";
import { ShutdownPlugin } from "@blacksmith/shutdown";
import { TracingPlugin } from "@blacksmith/tracing";

const app = express();
const port = Number(process.env.PORT ?? 3000);

await forge(app, {
  serviceName: "blacksmith-express-example",
  plugins: [
    new LoggingPlugin(),
    new TracingPlugin(),
    new MetricsPlugin(),
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

app.get("/users/:id", (req, res) => {
  const request = req as BlacksmithExpressRequest<typeof req>;

  res.json({
    id: req.params.id,
    requestId: request.blacksmith?.requestId
  });
});

const server = app.listen(port, () => {
  console.log(`Blacksmith Express example listening on http://localhost:${port}`);
});
