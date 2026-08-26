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

// The delivered document's title mirrors the uploaded file's name, so what a screen reader
// announces on arrival — and what a browser puts in the tab and in a bookmark — is the document
// the reader asked for rather than the shell's placeholder (WCAG 2.4.2).
//
// The element's attributes are kept, except for the one this function invalidates. A pattern that
// matched only a bare `<title>` silently did nothing on a document whose title carries `lang="en"`,
// which is how the shell labels it when the document's own language is not English (#163) — so
// exactly the documents that had just been given a truthful root language were the ones delivered
// with no name at all.
//
// And `lang` is dropped as the text is replaced, because the shell's claim was about the shell's own
// string. `lang="en"` vouched for "Accessible document"; the name of an uploaded file is in whatever
// language the person who named it used, and on a Korean document it is usually Korean — so keeping
// the label would assert English over a Korean title in the one place a reader hears the document's
// name. Dropping it leaves the title inheriting the root, which is the same policy the root itself
// follows: fall back to the containing default rather than assert a language nobody can vouch for.
// One attribute at a time, matched from its leading whitespace so that each match begins where the
// last one ended and the scan can never land inside a value. Searching the attribute string for
// ` lang=` instead would find the string in another attribute's value and edit that — dropping two
// words out of a `data-note` while leaving the claim it meant to drop in place.
const ATTRIBUTE = /\s+([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/g;
function withoutLang(attrs: string): string {
  return attrs.replace(ATTRIBUTE, (whole, name: string) => (name.toLowerCase() === "lang" ? "" : whole));
}
export function titledAs(html: string, base: string): string {
  return html.replace(
    /<title([^>]*)>[^<]*<\/title>/,
    // A function rather than a replacement string: `$&` in a filename is a filename, not a
    // backreference, and `base` is user input.
    (_m, attrs: string) =>
      `<title${withoutLang(attrs)}>${base.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>`,
  );
}
