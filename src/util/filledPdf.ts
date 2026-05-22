import { JSDOM } from "jsdom";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE_HEIGHT = 792;
const PAGE_WIDTH = 612;
const MARGIN = 50;
const LINE = 22;
const FIELD_H = 18;

interface FormControl {
  name: string;
  label: string;
  kind: "text" | "checkbox";
}

function controlsFromHtml(html: string): FormControl[] {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const controls: FormControl[] = [];
  const seen = new Set<string>();

  const labelFor = (id: string | null): string => {
    if (!id) return "";
    const el = doc.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
    return el?.textContent?.trim() ?? "";
  };

  for (const input of doc.querySelectorAll("input")) {
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button") continue;
    const key = input.getAttribute("id") || input.getAttribute("name");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = labelFor(input.getAttribute("id")) || key;
    controls.push({ name: key, label, kind: type === "checkbox" || type === "radio" ? "checkbox" : "text" });
  }

  for (const ta of doc.querySelectorAll("textarea")) {
    const key = ta.getAttribute("id") || ta.getAttribute("name");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = labelFor(ta.getAttribute("id")) || key;
    controls.push({ name: key, label, kind: "text" });
  }

  return controls;
}

/** Build a fillable PDF from accessible HTML form controls (stacked layout). */
export async function htmlToFilledPdf(html: string, title: string): Promise<Uint8Array | null> {
  const controls = controlsFromHtml(html);
  if (controls.length === 0) return null;

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} (fillable)`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const form = pdf.getForm();

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  page.drawText(title, { x: MARGIN, y, size: 14, font, color: rgb(0, 0, 0) });
  y -= LINE * 2;

  for (const c of controls) {
    if (y < MARGIN + FIELD_H * 2) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }

    const label = c.label.length > 90 ? c.label.slice(0, 87) + "…" : c.label;
    page.drawText(label, { x: MARGIN, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
    y -= LINE;

    if (c.kind === "checkbox") {
      const box = form.createCheckBox(c.name);
      box.addToPage(page, { x: MARGIN, y: y - 2, width: 14, height: 14 });
    } else {
      const field = form.createTextField(c.name);
      field.addToPage(page, { x: MARGIN, y: y - FIELD_H, width: PAGE_WIDTH - MARGIN * 2, height: FIELD_H });
      field.setFontSize(10);
    }
    y -= LINE * 2;
  }

  return pdf.save();
}

export function htmlHasFormControls(html: string): boolean {
  return controlsFromHtml(html).length > 0;
}
