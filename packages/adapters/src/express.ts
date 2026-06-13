import type { Request } from "express";
import type { RequestContext } from "./index.js";

export type BlacksmithExpressRequest<
  TRequest extends Request = Request
> = TRequest & {
  blacksmith?: RequestContext;
};
