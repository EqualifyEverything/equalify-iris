import type { PdfField } from "../util/taggedPdf.ts";
import { decodeEntities } from "../util/html.ts";

// Naming a PDF's form controls after its own fields (#483).
//
// When tagged PDFs are on, iris-pdf tags each form field where its control sits in the
// HTML, and it finds the control by `name`. The page image does not show field names, so
// the upload reads them from the PDF (`iris-pdf fields`) and they are listed in the page
// agent's prompt, the way links.ts lists link targets. `missingFields` checks the reply.
// A field with no control is logged, not yet corrected.

export const MAX_FIELDS_PER_PAGE = 40;

// Choice lists longer than this, or with longer entries, are left out of the prompt.
const MAX_OPTIONS = 10;
const MAX_OPTION_CHARS = 40;
const CHOICE_TYPES = new Set(["radio", "combobox", "listbox"]);

function describe(f: PdfField): string {
  const parts: string[] = [];
  // iris-pdf's own type word. Anything else is not printed.
  if (/^[a-z]+$/.test(f.type ?? "")) parts.push(f.type);
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
    `Do not invent names for controls that are not listed. If you cannot tell which control a ` +
    `field belongs to, say so in the "log" field.\n`;
  return { section, shown, dropped };
}

// Every name attribute's value in a fragment of HTML. A scan, like links.ts's `hrefsIn`,
// and preceded by whitespace or a quote so `data-name=` does not count.
function namesIn(html: string): Set<string> {
  const found = new Set<string>();
  for (const m of html.matchAll(/(?<=[\s"'])name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
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
