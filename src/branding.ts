// The demo page's name and logo (#542). Default: "Equalify Iris - Uploader", no logo.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { IrisConfig } from "./config.ts";

export const DEFAULT_NAME = "Equalify Iris - Uploader";

// No SVG: an SVG served from this origin can run script.
const LOGO_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export interface Brand {
  name: string;
  logo?: { type: string; bytes: Buffer; hash: string };
  // Set when the logo is configured but cannot be used. Startup prints it.
  warning?: string;
}

// Read once at startup. A logo that is missing or of an unknown type is dropped with a
// warning, so a branding mistake never stops the server.
export function loadBrand(cfg: IrisConfig): Brand {
  const name = cfg.branding?.name?.trim() || DEFAULT_NAME;
  const file = cfg.branding?.logo_file?.trim();
  if (!file) return { name };
  const type = LOGO_TYPES[extname(file).toLowerCase()];
  if (!type) return { name, warning: `WARNING: branding.logo_file must be .png, .jpg or .webp; showing no logo.` };
  try {
    const bytes = readFileSync(file);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    return { name, logo: { type, bytes, hash } };
  } catch {
    return { name, warning: `WARNING: branding.logo_file ${file} cannot be read; showing no logo.` };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The demo page with the brand filled in. The logo is decorative (alt=""), because the
// heading next to it already says the name. Its URL carries a hash of the file, so a new
// logo shows at once despite the long cache.
export function brandDemo(html: string, brand: Brand): string {
  const name = escapeHtml(brand.name);
  const logo = brand.logo ? `<img class="brand-logo" src="/brand-logo?v=${brand.logo.hash}" alt="">` : "";
  return html
    .replace(`<title>${DEFAULT_NAME}</title>`, `<title>${name}</title>`)
    .replace(`<h1>${DEFAULT_NAME}</h1>`, `<h1>${logo}${name}</h1>`);
}
