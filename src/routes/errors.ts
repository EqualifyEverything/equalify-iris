import type { Response } from "express";

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
