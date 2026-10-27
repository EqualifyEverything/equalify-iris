// The run log's index in docs/run-log.md, as `{ type: { summary, anchor } }`, for the /how-it-works page
// (public/how-it-works.html). Read from the doc rather than copied, so the page's one-line meaning of
// an event is the reference's own: test/config-agents.test.ts already fails when the index and the
// events src/ emits disagree, and that check now covers the page too.
//
// A row is `| [`a` / `b`](#anchor) | summary |`; every event named in the link shares the row.

export type EventIndex = Record<string, { summary: string; anchor: string }>;

export function eventIndex(apiMd: string): EventIndex {
  const lines = apiMd.split("\n");
  const from = lines.indexOf("## Run log");
  if (from === -1) return {};
  const out: EventIndex = {};
  for (const line of lines.slice(from + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("### ")) break; // the index ends where the first section starts
    const m = /^\| \[(.+?)\]\(#([^)]+)\) \| (.+) \|$/.exec(line);
    if (!m) continue;
    const summary = m[3].replace(/\*\*/g, "").replace(/`/g, "");
    for (const name of m[1].match(/`[^`]+`/g) ?? []) out[name.slice(1, -1)] = { summary, anchor: m[2] };
  }
  return out;
}

// public/how-it-works.html with the index put where its placeholder is. `<` is escaped so no summary
// can close the script it is put in.
export function howItWorksPage(html: string, apiMd: string): string {
  return html.replace("/*IRIS_EVENT_INDEX*/{}", () => JSON.stringify(eventIndex(apiMd)).replace(/</g, "\\u003c"));
}
