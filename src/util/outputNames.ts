import { basename, extname } from "node:path";

/** Strip extension and sanitize for use in on-disk output filenames. */
export function sanitizeBasename(name: string): string {
  const stem = basename(name, extname(name));
  return stem.replace(/[^A-Za-z0-9._-]/g, "_") || "document";
}

/** Derive the output basename from uploaded multipart files (first file wins). */
export function outputBasenameFromUploads(files: { originalname: string }[]): string {
  if (files.length === 0) return "document";
  return sanitizeBasename(files[0].originalname);
}

export function convertedHtmlFilename(base: string): string {
  return `${base}_converted.html`;
}

export function filledPdfFilename(base: string): string {
  return `${base}_filled.pdf`;
}
