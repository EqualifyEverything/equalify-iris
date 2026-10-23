import type { PdfField } from "../util/taggedPdf.ts";
import { readFileSync } from "node:fs";
import { decodeEntities } from "../util/html.ts";
import type { Paths } from "../store/paths.ts";

// Naming a PDF's form controls after its own fields (#483).
//
// When tagged PDFs are on, iris-pdf tags each form field where its control sits in the
// HTML, and it finds the control by `name`. The page image does not show field names, so
// the upload reads them from the PDF (`iris-pdf fields`) and they are listed in the page
// agent's prompt, the way links.ts lists link targets. `missingFields` checks the reply.
// A field with no control is logged, not yet corrected.

export const MAX_FIELDS_PER_PAGE = 40;
export const MAX_NAME_CHARS = 100;

// Characters that would end the `name="…"` attribute the agent copies a name into, as for
// link hrefs (`UNSAFE_CHARS` in util/pdf.ts). A space is allowed: field names have them, and
// a space cannot leave a quoted value. A field refused here is tagged at the end of its
// page, as every field was before #483.
const UNSAFE_NAME = /["'<>`\u0000-\u001f\u007f]/;

export function usableFieldName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_NAME_CHARS && !UNSAFE_NAME.test(name);
}

// Choice lists longer than this, or with longer entries, are left out of the prompt.
const MAX_OPTIONS = 10;
const MAX_OPTION_CHARS = 40;
const CHOICE_TYPES = new Set(["radio", "combobox", "listbox"]);

const MAX_LABEL_CHARS = 80;
// A name's filter, less the apostrophe: labels say "Plaintiff's".
const UNSAFE_LABEL = /["<>`\u0000-\u001f\u007f]/;

function describe(f: PdfField): string {
  const parts: string[] = [];
  // iris-pdf's own type word. Anything else is not printed.
  if (/^[a-z]+$/.test(f.type ?? "")) parts.push(f.type);
  // The PDF's own label for the field, which helps match it to the control the page shows.
  // JSON-quoted like the name, and refused on nearly the same characters.
  const label = typeof f.label === "string" ? f.label.trim() : "";
  if (label && label.length <= MAX_LABEL_CHARS && !UNSAFE_LABEL.test(label)) {
    parts.push(`label: ${JSON.stringify(label)}`);
  }
  const options = Array.isArray(f.options) ? f.options : [];
  if (
    CHOICE_TYPES.has(f.type) &&
    options.length > 0 &&
    options.length <= MAX_OPTIONS &&
    options.every((o) => typeof o === "string" && o.length <= MAX_OPTION_CHARS)
  ) {
    parts.push(`options: ${options.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  return parts.length ? ` (${parts.join("; ")})` : "";
}

// The page's form fields, as the section of the page-agent prompt that carries them, plus
// what was dropped to bound it. Empty section when the page has none, so a deployment
// without iris-pdf sends exactly the prompt it sent before.
export function pageFieldContext(fields: PdfField[] = []): {
  section: string;
  shown: PdfField[];
  dropped: number;
} {
  if (fields.length === 0) return { section: "", shown: [], dropped: 0 };
  const shown = fields.slice(0, MAX_FIELDS_PER_PAGE);
  const dropped = fields.length - shown.length;
  const list = shown
    // JSON-quoted: the name is the PDF's, and a quote or newline in it must not end the quote.
    .map((f, i) => `${i + 1}. ${JSON.stringify(f.name)}${describe(f)}`)
    .join("\n");
  const section =
    `\n\n## Form fields on this page (from the source file's own form fields)\n` +
    `The source file is a fillable form, and these are its fields on this page. Give each ` +
    `field's control a name attribute holding the field's name EXACTLY as listed (the text ` +
    `inside the quotes). The names are not labels: keep the label the page prints.\n\n` +
    `${list}\n\n` +
    (dropped > 0 ? `(…and ${dropped} more field${dropped === 1 ? "" : "s"} on this page.)\n\n` : "") +
    `Do not add a control the image does not show, and do not invent names for controls that ` +
    `are not listed. If you cannot tell which control a field belongs to, say so in the "log" ` +
    `field.\n`;
  return { section, shown, dropped };
}

// Every name attribute's value in a fragment of HTML. A scan, like links.ts's `hrefsIn`,
// and preceded by whitespace or a quote so `data-name=` does not count.
function namesIn(html: string): Set<string> {
  const found = new Set<string>();
  for (const m of html.matchAll(/(?<=[\s"'])name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)(?=[\s>]))/gi)) {
    found.add(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""));
  }
  return found;
}

// The listed fields no control in the HTML is named after. Deduplicated by name: a radio
// group is one field with several controls.
export function missingFields(fields: PdfField[] = [], html: string): PdfField[] {
  if (fields.length === 0) return [];
  const present = namesIn(html);
  const seen = new Set<string>();
  const missing: PdfField[] = [];
  for (const f of fields.slice(0, MAX_FIELDS_PER_PAGE)) {
    if (present.has(f.name) || seen.has(f.name)) continue;
    seen.add(f.name);
    missing.push(f);
  }
  return missing;
}

// The delivered HTML's controls, renamed from the PDF's field names to readable ones (#593).
// A converted XFA form names its fields by path (`SC-100[0].Page2[0].PlaintiffCity1[0]`), and
// that is what a reader of the HTML file saw. The tagger matches controls by the PDF's names,
// but it reads the extracted pages, not this file, so only the delivered copy is renamed. Each
// field gets one name, so a radio group stays a group. The page agent also makes up path names
// for controls the PDF has no field for (SC-100's signature lines are static text), so any
// name shaped like a path is renamed too, and so is an array-style name like `options[0]`.
// Other names, such as one the page agent made for a flat form, are left as they are.
const MAX_READABLE_CHARS = 40;
const PATH_LIKE = /\[\d+\]/;
// A form control's name attribute. Only these are renamed, and only these count as taken.
const CONTROL_NAME =
  /(<(?:input|select|textarea|button)\b[^>]*?[\s"'])(name\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)(?=[\s>]))/gi;

function slug(s: string): string {
  const words = s
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > MAX_READABLE_CHARS) break;
    out = next;
  }
  return out || words[0]?.slice(0, MAX_READABLE_CHARS) || "";
}

function readableName(f: PdfField): string {
  const label = typeof f.label === "string" ? slug(f.label) : "";
  if (label) return label;
  const last = f.name.split(".").pop()!.replace(/\[\d+\]/g, "");
  return slug(last) || slug(f.name) || "field";
}

export function readableFieldNames(html: string, fields: PdfField[]): string {
  const renamed = new Map<string, string>();
  const pdfNames = new Set(fields.map((f) => f?.name));
  // A name already in the HTML that is not renamed is taken, so a new one cannot join it.
  const inHtml = [...new Set([...html.matchAll(CONTROL_NAME)].map((m) => decodeEntities(m[3] ?? m[4] ?? m[5] ?? "")))]
    .filter((n) => !pdfNames.has(n));
  const taken = new Set(inHtml.filter((n) => !PATH_LIKE.test(n)));
  // The PDF's fields first, so they get the plain names.
  const made = inHtml.filter((n) => PATH_LIKE.test(n)).map((name) => ({ name }) as PdfField);
  for (const f of [...fields, ...made]) {
    if (!usableFieldName(f?.name) || renamed.has(f.name)) continue;
    const base = readableName(f);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    renamed.set(f.name, name);
  }
  if (renamed.size === 0) return html;
  return html.replace(
    CONTROL_NAME,
    (all, head: string, eq: string, dq?: string, sq?: string, bare?: string) => {
      const to = renamed.get(decodeEntities(dq ?? sq ?? bare ?? ""));
      return to ? `${head}${eq}"${to}"` : all;
    },
  );
}

// The PDF's form fields kept at upload (stage.ts, `keepPdfFields`), in page order. None when
// there are none or the file cannot be read: the output then keeps the names it has.
export function keptFields(paths: Paths, id: string): PdfField[] {
  try {
    const byPage = JSON.parse(readFileSync(paths.sessionFields(id), "utf8")) as Record<string, PdfField[]>;
    return Object.keys(byPage)
      .sort((a, b) => Number(a) - Number(b))
      .flatMap((k) => (Array.isArray(byPage[k]) ? byPage[k] : []));
  } catch {
    return [];
  }
}
