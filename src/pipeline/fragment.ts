// A single extracted content block plus its provenance (PRD §7.4).
export interface Fragment {
  image: string; // source image filename (or "a+b" once reconciled)
  order: number; // image order, for assembly sequencing
  agent: string; // agent file that produced it, e.g. "table.md"
  region: string; // region id within the image, e.g. "region-table-1"
  innerHtml: string; // the accessible HTML, without provenance comments
  edges: string[]; // edges where content appears cut off
  log: string; // fragment log entry
  reconciled?: boolean; // joined across an image boundary (PRD §7.6)
  suspectedContinuation?: boolean; // low-confidence continuation (PRD §7.6)
  copyEdited?: boolean; // touched by the Copy Editor (PRD §7.10)
}

// Renders a fragment with the provenance comments Assembly preserves (§7.4/§7.6).
export function renderFragment(f: Fragment): string {
  const lines: string[] = [];
  if (f.reconciled) {
    lines.push(`<!-- @reconciled: ${f.image} -->`);
    lines.push(`<!-- @agent: ${f.agent} (reconciled) -->`);
  } else {
    lines.push(`<!-- @source: ${f.image}#${f.region} -->`);
    lines.push(`<!-- @agent: ${f.agent}${f.copyEdited ? " (copy-edited)" : ""} -->`);
    for (const edge of f.edges) lines.push(`<!-- @fragment: ${edge} -->`);
    if (f.suspectedContinuation) lines.push(`<!-- @suspected-continuation -->`);
  }
  lines.push(f.innerHtml.trim());
  lines.push(`<!-- @end-source -->`);
  return lines.join("\n");
}
