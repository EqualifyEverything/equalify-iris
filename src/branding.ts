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
  logo?: { type: string; bytes: Buffer; hash: string; alt: string };
  // Set when a branding value is wrong or incomplete. Startup prints it. The logo may still
  // be shown: `logo` says whether it is.
  warning?: string;
}

// Read once at startup. A logo that is missing or of an unknown type is dropped with a
// warning, so a branding mistake never stops the server.
export function loadBrand(cfg: IrisConfig): Brand {
  const name = cfg.branding?.name?.trim() || DEFAULT_NAME;
  const file = cfg.branding?.logo_file?.trim();
  const alt = cfg.branding?.logo_alt?.trim() ?? "";
  if (!file) return alt ? { name, warning: `WARNING: branding.logo_alt is set but logo_file is not; showing no logo.` } : { name };
  const type = LOGO_TYPES[extname(file).toLowerCase()];
  if (!type) return { name, warning: `WARNING: branding.logo_file must be .png, .jpg or .webp; showing no logo.` };
  try {
    const bytes = readFileSync(file);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    // A logo names who runs the page, so it is not decoration (#553). Without alt text it is
    // still shown, as alt="", and startup says so.
    const missingAlt = alt ? {} : { warning: `WARNING: branding.logo_alt is not set; the logo has no alt text.` };
    return { name, logo: { type, bytes, hash, alt }, ...missingAlt };
  } catch {
    return { name, warning: `WARNING: branding.logo_file ${file} cannot be read; showing no logo.` };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The demo page with the brand filled in. The logo's alt text comes first in the heading, so
// it reads "UIC Equalify Iris - Uploader". Its URL carries a hash of the file, so a new logo
// shows at once despite the long cache.
export function brandDemo(html: string, brand: Brand): string {
  const name = escapeHtml(brand.name);
  const logo = brand.logo
    ? `<img class="brand-logo" src="/brand-logo?v=${brand.logo.hash}" alt="${escapeHtml(brand.logo.alt)}">`
    : "";
  // Functions, not strings: a string replacement treats `$'` and `$&` in the name as patterns.
  return html
    .replace(`<title>${DEFAULT_NAME}</title>`, () => `<title>${name}</title>`)
    .replace(`<h1>${DEFAULT_NAME}</h1>`, () => `<h1>${logo}${name}</h1>`);
}
