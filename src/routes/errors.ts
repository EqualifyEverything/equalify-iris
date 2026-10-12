import type { NextFunction, Request, Response } from "express";

// Standard error structure.
export function sendError(
  res: Response,
  httpStatus: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): void {
  res.status(httpStatus).json({ error: { code, message, details } });
}

// Last middleware. Express 5 sends a handler's thrown or rejected error here; without this
// the caller gets an HTML stack trace instead of the shape above.
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  const e = (err ?? {}) as { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
  const status = typeof e.status === "number" ? e.status : e.statusCode;
  // The body parser's own refusals, e.g. malformed JSON or a JSON body over 2 MB.
  if (typeof status === "number" && status >= 400 && status < 500) {
    const message = e.expose && typeof e.message === "string" ? e.message : "Bad request";
    sendError(res, status, status === 413 ? "body_too_large" : "invalid_request", message);
    return;
  }
  console.error("unhandled route error:", err);
  sendError(res, 500, "server_error", "Unexpected server error. See the server log.");
}

// After every route: a path nothing matched.
export function notFound(_req: Request, res: Response): void {
  sendError(res, 404, "not_found", "No such route");
}
