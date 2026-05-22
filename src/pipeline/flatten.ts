import { JSDOM } from "jsdom";

// Produce a flattened, text-only view of an HTML chunk that approximates what a
// screen reader announces, in order (PRD §7.8). The Reader cross-checks this
// against the HTML structure to surface reading-order problems.
export function flatten(html: string): string {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const doc = dom.window.document;
  const out: string[] = [];

  const walk = (node: Node): void => {
    const ELEMENT = 1;
    const TEXT = 3;
    if (node.nodeType === TEXT) {
      const t = node.textContent?.replace(/\s+/g, " ").trim();
      if (t) out.push(t);
      return;
    }
    if (node.nodeType !== ELEMENT) return;
    const el = node as unknown as { tagName: string; getAttribute(n: string): string | null; childNodes: NodeListOf<Node> };
    const tag = el.tagName.toLowerCase();
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        out.push(`[Heading ${tag[1]}] ${text}`);
        return;
      case "img":
        out.push(`[Image] alt="${el.getAttribute("alt") ?? "(missing)"}"`);
        return;
      case "a":
        out.push(`[Link] ${text}`);
        return;
      case "li":
        out.push(`[List item] ${text}`);
        return;
      case "table":
        out.push(`[Table] ${(node as unknown as { querySelector(s: string): { textContent: string } | null }).querySelector("caption")?.textContent?.trim() ?? "(no caption)"}`);
        return;
      case "label":
        out.push(`[Label] ${text}`);
        return;
      case "input": case "textarea": case "select":
        out.push(`[Field ${tag}] ${el.getAttribute("type") ?? ""}`.trim());
        return;
      case "blockquote":
        out.push(`[Quote] ${text}`);
        return;
      case "figcaption": case "caption":
        out.push(`[Caption] ${text}`);
        return;
      default:
        for (const child of Array.from(el.childNodes)) walk(child);
    }
  };

  for (const child of Array.from(doc.body.childNodes)) walk(child);
  dom.window.close();
  return out.join("\n");
}
