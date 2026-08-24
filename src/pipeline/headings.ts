import { JSDOM } from "jsdom";
import { SILENT } from "./flatten.ts";

// Two headings at the same level with the same words are ambiguous to anyone
// navigating by heading: the second announces the same subject as the first, or a
// copy of it (issues #111, #119). Finding them is the one heading defect no single
// call in this pipeline can see.
//
// The page agent is handed one page and no other, so a section title reprinted where
// its section continues looks exactly like a new section starting, and three
// same-worded <h2>s arrive one call apart with nothing to compare against. The Reader
// Agent does see the assembled document — but `runReader` sends it one CHUNK_BUDGET
// window at a time, so a pair further apart than the overlap straddles a cut at some
// offsets and neither call sees both headings. A reprinted title is separated by a
// full page of extracted HTML, which is exactly the distance that falls across a cut.
//
// So the finding half is done here instead, deterministically, over the whole body,
// and handed to the Reader as a list. What is left to the model is the part that needs
// judgement — which of the two cases a pair is, and which pages it is on — and that
// part does not depend on both headings being in the same window.
export interface HeadingRun {
  level: number;
  // As printed, from the first heading of the run: it is quoted back to the Reader,
  // which matches it against the source-page excerpts to attribute the issue.
  text: string;
  // How many headings are in the run. Three <h2>Operation</h2> in a row is one run of
  // three, not two overlapping pairs — the Reader should report it once.
  count: number;
  // Where in the outline this run starts: the heading immediately before its first
  // member, at whatever level, or null at the top of the document.
  //
  // A document can hold two runs of the SAME words at the SAME level with another
  // section between them — "Op Op … Other … Op Op" — and level + text + count alone
  // renders those as two identical lines. The Reader is told every entry is a real pair,
  // so a line indistinguishable from the one above it reads as a restatement of it and
  // one of the two pairs goes unreported. This is what tells them apart, and it is also
  // what the Reader needs anyway: it locates the run in the HTML it was given.
  after: { level: number; text: string } | null;
  // The words the run's first section opens with, truncated — the one field that does not
  // repeat when the outline does. `after` alone still collides on the doubled version of
  // #111's shape (a reprinted running title AND a reprinted subsection header: both <h3>
  // runs follow an <h2> called the same thing), and the content under two different
  // sections is what actually differs. Empty when the heading is followed by nothing.
  opening: string;
}

const HEADINGS = "h1, h2, h3, h4, h5, h6";
const ELEMENT = 1;
const TEXT = 3;

// More runs than this on one document is not a finding list, it is a symptom of
// something else (a template repeated per page, an extractor that lost its outline),
// and a prompt full of them crowds out the rest of the Reader's input.
const MAX_RUNS = 12;

// A heading longer than this is quoted truncated. The Reader matches on words, so the
// opening of a heading is enough to find it in a page excerpt.
const MAX_QUOTED = 120;

// And how much of the text under it is quoted. Long enough to match against a page
// excerpt (READER_INDEX_EXCERPT_CHARS is 200) and to read as a sentence, short enough
// that a dozen entries do not crowd out the rest of the Reader's input.
const MAX_OPENING = 80;

// What "the same words" means. Case is a typographic choice — a page that sets a
// running title in capitals and reprints it in title case is reprinting it — and so is
// the trailing colon or full stop a heading may or may not carry. Anything more
// aggressive (stemming, dropping stop words) would start matching headings that are
// genuinely different, and this list is acted on.
function key(text: string): string {
  return text.toLowerCase().replace(/[\s.,:;–—-]+$/u, "").trim();
}

const textOf = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

// The words a heading's own section opens with: the text after it, in document order, up
// to the next heading, capped.
//
// Three things it must not do, all of which read as a distinct entry while being nothing of
// the kind.
//
// It must not run separate segments together. `el.textContent` on a spec table gives
// "SpeedTimeLow2 min" — matching no page excerpt and reading as no sentence, on exactly the
// manuals these issues came from. So every element boundary separates, which is what
// `flatten` does too: it collects a line's segments and joins them with a space
// (`norm(run.join(" "))`), so the two views the Reader is given agree on where a word ends.
// A boundary inside a phrase costs nothing — the spaces of "Press <strong>start</strong>
// now." are in its text nodes already — while <br> and two adjacent <span>s are exactly the
// case that needs one, and a page can carry hundreds of them.
//
// It must stop at the next heading wherever that heading is: a twin wrapped in its own
// <section> is not a sibling, while the run finder flattens the tree and pairs them anyway,
// so a heading with an empty section would otherwise be quoted its twin's content.
//
// And it must not quote what is never announced. SILENT is flatten's, for the same reason
// it exists there: leaked CSS is not content, and reading it as content flatters whatever
// is being measured.
function textUpToHeading(el: Element, out: string[]): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType === TEXT) {
      out.push(child.nodeValue ?? "");
      continue;
    }
    if (child.nodeType !== ELEMENT) continue;
    const e = child as Element;
    const tag = e.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return true;
    if (SILENT.has(tag)) continue;
    out.push(" ");
    if (textUpToHeading(e, out)) return true;
    out.push(" ");
  }
  return false;
}

function openingAfter(el: Element): string {
  const out: string[] = [];
  const collapsed = () => out.join("").replace(/\s+/g, " ").trim();
  try {
    for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
      const tag = next.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) break;
      if (SILENT.has(tag)) continue;
      out.push(" ");
      if (textUpToHeading(next, out)) break;
      if (collapsed().length >= MAX_OPENING) break;
    }
  } catch {
    // A pathologically nested section overflows the walk. This is a hint in a prompt, so
    // losing it costs an entry its opening words; it must not cost the caller its list.
    return "";
  }
  const text = collapsed();
  return text.length > MAX_OPENING ? `${text.slice(0, MAX_OPENING).trimEnd()}…` : text;
}

// The runs of same-worded, same-level headings in `body`, in document order.
//
// "Adjacent" is the load-bearing word and it is not a character distance: two headings
// are adjacent when the FIRST heading at or above their level after the first of them
// is the second of them. That is precisely "nothing between them but their own
// section's content", subsections included, which is the pair a reader cannot tell
// apart. Identical headings with another section in between are excluded on purpose —
// there, the intervening section tells a reader the two are different places.
export function sameWordedHeadingRuns(body: string): HeadingRun[] {
  let headings: { level: number; text: string; opening: string }[];
  try {
    const doc = new JSDOM(`<body>${body}</body>`).window.document;
    headings = [...doc.querySelectorAll(HEADINGS)].map((el) => ({
      level: Number(el.tagName[1]),
      text: textOf(el),
      opening: openingAfter(el),
    }));
  } catch {
    // The Reader's own rule about duplicate headings still applies to whatever it can
    // see; this list is an aid to it, so a parse failure costs the aid and not the review.
    return [];
  }

  const runs: HeadingRun[] = [];
  // Which headings a run already accounts for. Members only, NOT the headings between
  // them: a run of two <h2>Op</h2> spans everything under the first one, and a page that
  // reprints its running title AND a continued subsection header — #111's own shape —
  // puts an <h3> pair inside that span. Advancing the cursor to the run's last heading
  // instead would jump the interval and drop the inner pair from the list.
  const counted = new Set<number>();
  // An empty heading never begins a run: two headings with no words are a different
  // defect, and one axe reports as `empty-heading`. It is not skipped as a LINK in a
  // chain, though — it opens a section of its own, however little it names it, so it
  // ends the run the way any other intervening same-level heading does.
  for (let i = 0; i < headings.length; i++) {
    const first = headings[i];
    if (counted.has(i) || !key(first.text)) continue;
    const members = [i];
    for (;;) {
      // The heading that closes the section opened by the run's last member: the first
      // one after it at or above its level. Anything deeper than that belongs to it.
      const from = members[members.length - 1];
      let next = -1;
      for (let j = from + 1; j < headings.length; j++) {
        if (headings[j].level <= first.level) { next = j; break; }
      }
      if (next === -1 || headings[next].level !== first.level) break;
      if (key(headings[next].text) !== key(first.text)) break;
      members.push(next);
    }
    if (members.length > 1) {
      const prev = i > 0 ? headings[i - 1] : null;
      runs.push({
        level: first.level,
        text: first.text,
        count: members.length,
        after: prev ? { level: prev.level, text: prev.text } : null,
        opening: first.opening,
      });
      for (const m of members) counted.add(m);
    }
  }
  return runs;
}

// The list as the Reader is given it, or null when there is nothing to give — the
// section is omitted entirely then, rather than asserting an absence the model would
// have to take on trust. A truncated list says so: a silent cap reads as "these are
// all of them".
export function sameWordedHeadingNote(runs: HeadingRun[]): string | null {
  if (!runs.length) return null;
  const shown = runs.slice(0, MAX_RUNS);
  const quote = (t: string) => (t.length > MAX_QUOTED ? `${t.slice(0, MAX_QUOTED)}…` : t);
  // Numbered, so that every line is distinct even where an outline repeats so exactly
  // that both the preceding heading and the opening words match. The Reader is told each
  // entry is a real pair; two lines it cannot tell apart cost one of them a report.
  const lines = shown.map((r, n) => {
    const many = r.count > 2 ? ` (${r.count} of them)` : "";
    const where = r.after
      ? `, the first of them after [Heading ${r.after.level}] "${quote(r.after.text)}"`
      : ", at the start of the document";
    const opens = r.opening ? `, opening "${r.opening}"` : ", with nothing under it";
    return `${n + 1}. [Heading ${r.level}] "${quote(r.text)}"${many}${where}${opens}`;
  });
  if (runs.length > shown.length) {
    lines.push(`…and ${runs.length - shown.length} more, not listed here`);
  }
  return lines.join("\n");
}
