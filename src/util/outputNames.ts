import { basename, extname } from "node:path";

// Output filename helpers. Adapted from PR #10 (filename preservation, by
// @Alcray); the fillable-PDF portion of that PR is intentionally not included.

/** Strip the extension and sanitize a name for safe use as a filename. */
export function sanitizeBasename(name: string): string {
  const stem = basename(name, extname(name));
  return stem.replace(/[^A-Za-z0-9._-]/g, "_") || "document";
}

/** Derive the output basename from uploaded files (first file wins). */
export function outputBasenameFromUploads(files: { originalname: string }[]): string {
  if (files.length === 0) return "document";
  return sanitizeBasename(files[0].originalname);
}

/** The downloadable HTML filename for a given source basename. */
export function convertedHtmlFilename(base: string): string {
  return `${base}_converted.html`;
}
