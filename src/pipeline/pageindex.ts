// A compact, ordered index of the document's source pages: page number + a short
// excerpt of the HTML that was extracted from it.
//
// Two agents need to map something in the assembled document back to the page it
// came from without being resent the whole document: the Feedback Agent (which
// pages does this feedback concern?) and the Reader (which page is this issue on?).
// Page attribution is what lets the Copy Editor be handed only the images it
// actually needs, and provenance comments are stripped from the document, so this
// index is the only page map either one gets.

// Enough to recognize a page, far short of resending it. Callers that index on
// every model call (the Reader, once per chunk per round) pass a smaller value.
const EXCERPT_CHARS = 400;

export interface IndexedPage {
  order: number; // 1-based page order
  innerHtml: string;
}

export function pageIndex(pages: IndexedPage[], excerptChars = EXCERPT_CHARS): string {
  return [...pages]
    .sort((a, b) => a.order - b.order)
    .map((p) => {
      const excerpt = p.innerHtml.replace(/\s+/g, " ").trim().slice(0, excerptChars);
      return `### Page ${p.order}\n${excerpt}`;
    })
    .join("\n\n");
}

// Keep only page numbers that exist in this document, deduped and sorted. Model
// answers are the only source of page attribution, so a hallucinated page 99 must
// be dropped rather than acted on.
export function knownPages(claimed: unknown, pages: IndexedPage[]): number[] {
  const known = new Set(pages.map((p) => p.order));
  return [
    ...new Set(
      (Array.isArray(claimed) ? claimed : [])
        .map((p) => (typeof p === "number" ? p : Number(p)))
        .filter((p) => Number.isInteger(p) && known.has(p)),
    ),
  ].sort((a, b) => a - b);
}
