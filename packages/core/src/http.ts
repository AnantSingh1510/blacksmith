export interface HttpRequestLike {
  method?: string;
  path?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
  blacksmith?: RequestContext;
  get?(name: string): string | undefined;
}

export interface HttpResponseLike {
  statusCode?: number;
  setHeader?(name: string, value: string | number | readonly string[]): void;
  header?(name: string, value: string | number | readonly string[]): unknown;
  json?(body: unknown): unknown;
  send?(body: unknown): unknown;
  type?(contentType: string): HttpResponseLike;
  end?(body?: unknown): unknown;
  on?(eventName: "finish" | "close", handler: () => void): unknown;
}

export type NextFunctionLike = (error?: unknown) => void;

export type Middleware = (
  req: HttpRequestLike,
  res: HttpResponseLike,
  next: NextFunctionLike
) => void | Promise<void>;

export type RouteHandler = (
  req: HttpRequestLike,
  res: HttpResponseLike
) => void | Promise<void>;

export interface RequestContext {
  requestId: string;
  startTime: bigint;
  route?: string;
}

export interface HttpAdapter {
  readonly name: string;
  use(middleware: Middleware): void;
  get(path: string, handler: RouteHandler): void;
}

interface ExpressLike {
  use(
    handler: (
      req: HttpRequestLike,
      res: HttpResponseLike,
      next: NextFunctionLike
    ) => void
  ): void;
  get(
    path: string,
    handler: (
      req: HttpRequestLike,
      res: HttpResponseLike,
      next: NextFunctionLike
    ) => void
  ): void;
}

interface FastifyRequestLike {
  raw?: HttpRequestLike;
}

interface FastifyReplyLike {
  raw?: HttpResponseLike;
}

interface FastifyLike {
  addHook(
    name: "onRequest",
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void>
  ): void;
  get(
    path: string,
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void>
  ): void;
}

export function detectHttpAdapter(app: unknown): HttpAdapter {
  if (isExpressLike(app)) {
    return {
      name: "express",
      use: (middleware) => {
        app.use((req, res, next) => {
          void Promise.resolve(middleware(req, res, next)).catch(next);
        });
      },
      get: (path, handler) => {
        app.get(path, (req, res, next) => {
          void Promise.resolve(handler(req, res)).catch(next);
        });
      }
    };
  }

  if (isFastifyLike(app)) {
    return {
      name: "fastify",
      use: (middleware) => {
        app.addHook("onRequest", async (request, reply) => {
          await middleware(toHttpRequest(request), toHttpResponse(reply), () => undefined);
        });
      },
      get: (path, handler) => {
        app.get(path, async (request, reply) => {
          await handler(toHttpRequest(request), toHttpResponse(reply));
        });
      }
    };
  }

  throw new Error(
    "Blacksmith could not detect a supported HTTP adapter. Pass an Express- or Fastify-like app."
  );
}

function toHttpRequest(request: FastifyRequestLike): HttpRequestLike {
  return request.raw ?? (request as HttpRequestLike);
}

function toHttpResponse(reply: FastifyReplyLike): HttpResponseLike {
  return reply.raw ?? (reply as HttpResponseLike);
}

function isExpressLike(app: unknown): app is ExpressLike {
  return (
    (typeof app === "object" || typeof app === "function") &&
    app !== null &&
    "use" in app &&
    "get" in app &&
    typeof app.use === "function" &&
    typeof app.get === "function"
  );
}

function isFastifyLike(app: unknown): app is FastifyLike {
  return (
    (typeof app === "object" || typeof app === "function") &&
    app !== null &&
    "addHook" in app &&
    "get" in app &&
    typeof app.addHook === "function" &&
    typeof app.get === "function"
  );
}
