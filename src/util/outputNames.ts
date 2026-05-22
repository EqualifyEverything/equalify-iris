import { basename, extname } from "node:path";

/** Strip extension and sanitize for use in on-disk output filenames. */
export function sanitizeBasename(name: string): string {
  const stem = basename(name, extname(name)).replace(/-p\d+$/i, "");
  return stem.replace(/[^A-Za-z0-9._-]/g, "_") || "document";
}

/** Derive the output basename from the first persisted page image. */
export function outputBasenameFromInputName(name: string | undefined): string {
  return sanitizeBasename(name ?? "document");
}

export function convertedHtmlFilename(base: string): string {
  return `${base}_converted.html`;
}
