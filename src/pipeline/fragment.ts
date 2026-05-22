// One extracted page's accessible HTML plus its provenance. Provenance is kept
// in the session's fragments.json, not in the delivered HTML.
export interface Fragment {
  image: string; // source page image filename
  order: number; // page order, for assembly sequencing
  agent: string; // agent that produced it (e.g. "page.md")
  region: string; // region id (e.g. "page")
  innerHtml: string; // the accessible HTML for the page
  edges: string[]; // edges where content appears cut off
  log: string; // extraction log entry
}
