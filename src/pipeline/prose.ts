import { cutPoints } from "./sections.ts";

// A sentence the source printed across a page turn arrives here in two pieces, and neither page
// could have mended it: the page-break marker is the FIRST thing a page emits, so everything
// standing before it came off a sheet that call was never shown (issue #248, and `agents/page.md`,
// which tells a page to transcribe its own edge exactly and leave the join to a pass holding both
// halves). Measured on the last bench round's artifacts — 4 chunks × 25 pages, 90 markers — 22
// markers stood where a sentence carried on, 13 of those with the sentence's tail in the element
// immediately before the marker, and 2 of the 13 split a word:
//
//   "…tourist courts. Simi-"  ||  "larly, the more populous States do not tax…"
//
// A reader hears "Simi", then a page-break announcement, then "larly".
//
// This is a text question with no judgement in it, so no model call is spent on it — unlike the
// table join (tables.ts), which has to decide whether two headers describe one table.
//
// WHICH WAY THE TEXT MOVES is the decision this file embodies, and it is a decision about what a
// page anchor means. `<hr>` cannot sit inside a `<p>`, so the halves cannot be joined without text
// crossing the marker, and there are only two directions. The previous page's tail moves FORWARD,
// after the marker: the sentence is then whole and `#page-74` lands on the marker immediately
// before it, so a reader following that anchor hears a few words of page 73 before page 74's own
// text. The alternative — pulling page 74's head back before the marker — makes `#page-74` land
// AFTER the sentence it should open on, which costs that reader the beginning of it. A few words of
// provenance drift is the cheaper mistake.
//
// Nothing is created and nothing is dropped: every character of both halves is delivered, in order,
// and the only edit is which element holds them. That includes the hyphen a word-split leaves
// behind — see `joinAt`.

// What the join did, for the run log. Counted rather than argued because the before-numbers are on
// file (90 markers, 22 mid-sentence, 13 tail-adjacent, 2 word-splits): a round on a build carrying
// this should show `candidates` still around 22 with `joined` around 13, and the 9 the marker does
// not interrupt declined as `interrupted`.
export interface ProseJoinReport {
  // Page-break markers standing where a page begins, which is where `agents/page.md` puts them.
  markers: number;
  // Boundaries where the first thing on the next page is a `<p>` beginning with a lowercase letter
  // — the issue's own test for "a sentence carries on here", whatever stands before the marker.
  //
  // A lowercase letter is a signal only a cased script has, so this never fires on Hangul, Chinese,
  // Japanese, Arabic or Hebrew, and their sentences ship split as they do today. That is a join
  // missed rather than a join got wrong, and it is left that way deliberately: the 22 above were
  // measured on an English corpus, and what the signal should be for a caseless script is a
  // question no run has asked yet. `candidates: 0` on a document with many `markers` is what that
  // looks like in the log.
  candidates: number;
  joined: number;
  // Of the joins, how many had no marker between the halves at all: a page that prints no number
  // emits none, so a document of unnumbered scans has page turns with nothing marking them. Those
  // halves are already adjacent, so the join there is only a merge of two paragraphs into the one
  // sentence they hold, and no anchor moves.
  unmarked: number;
  // Joins where the break fell inside a word, so the tail ended with a hyphen.
  wordSplits: number;
  declined: {
    // Something other than a `<p>` stands immediately before the marker — a footnote list, in all
    // 9 of the measured cases. The marker is then not what interrupts the sentence, and moving
    // text across the notes would reorder the page.
    interrupted: number;
    // The `<p>` before the marker ends a sentence, so the lowercase start after it is something
    // else: a caption, a continued list item, a line of verse.
    notContinuing: number;
    // A page between the halves is missing — it failed extraction, or was reported blank — so the
    // middle of the sentence may be what is missing and these two edges do not meet.
    pageGap: number;
    // The tail cannot be cut out without unbalancing markup: the sentence begins inside an inline
    // element that opened earlier in the paragraph, or inside a footnote reference.
    noCut: number;
    // The whole paragraph is the tail, and it carries an attribute that would go with it. `id` is
    // the one that matters — dropping it breaks whatever refers to it, and `namespaceAnchors` has
    // just been repointing references at exactly these — but the guard is on any attribute, since
    // the words would arrive under the NEXT paragraph's attributes and this pass has no business
    // deciding which of them the words can do without.
    attrsKept: number;
    // The two paragraphs disagree about `lang`. Moving words between them would deliver them in a
    // language nothing said they were in, and `bodyLang` reads these same attributes to decide what
    // the document declares (assembly.ts, #163). Agreement is the ordinary case in a document that
    // declares one at all: `agents/page.md` puts it on every top-level element of such a page.
    langMismatch: number;
    // One of the two pages is being delivered exactly as its agent wrote it, because the parser and
    // its bytes disagree about the page's structure (`skipped_pages`, anchors.ts). A pass that reads
    // that structure to find the paragraph at its edge is reading the half of the disagreement the
    // browser will not honour, so it keeps its hands off the page entirely.
    asWritten: number;
  };
  // The joined words, for the two the corpus had and any others: a word split across a page turn is
  // the shape worth eyeballing, and the count alone cannot be checked against the document. Text
  // out of the user's own document, so bounded the way `emptyTableCaptions` bounds its examples,
  // and it never reaches `GET /v1/quality`.
  wordSplitExamples: string[];
}

const MAX_EXAMPLES = 5;
const MAX_EXAMPLE_CHARS = 40;

export function emptyProseJoin(): ProseJoinReport {
  return {
    markers: 0,
    candidates: 0,
    joined: 0,
    unmarked: 0,
    wordSplits: 0,
    declined: { interrupted: 0, notContinuing: 0, pageGap: 0, noCut: 0, attrsKept: 0, langMismatch: 0, asWritten: 0 },
    wordSplitExamples: [],
  };
}

// Attribute lists are read quote-aware rather than as `[^>]*`, because a `>` inside an attribute
// value is legal and a greedy read of it would take the rest of the document for a tag.
const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
const PARAGRAPH = new RegExp(`^(\\s*<p${ATTRS}>)([\\s\\S]*)(</p>\\s*)$`, "i");
const HR = new RegExp(`^\\s*<hr${ATTRS}>\\s*$`, "i");
const PAGE_BREAK_ROLE = /\brole\s*=\s*["']?\s*doc-pagebreak\b/i;
// Attributes on a start tag, read the way `bodyLang` reads them — attribute by attribute rather
// than searched for, because a search for ` lang=` finds one inside another attribute's value.
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const inner = tag.replace(/^\s*<[a-zA-Z][^\s/>]*/, "").replace(/\/?>\s*$/, "");
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(inner); m; m = ATTR.exec(inner)) {
    // The first spelling wins, which is what a parser does with a repeated attribute.
    if (!out.has(m[1]!.toLowerCase())) out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}
// The two a paragraph may carry and still move whole: they say how its words are read, and the
// paragraph it joins carries the same ones or the join is declined for disagreeing about them.
const TRAVELS = new Set(["lang", "dir"]);

// The top-level nodes of one page's fragment, as slices that concatenate back to exactly the string
// they came from — so a page nothing is done to comes back byte-identical, and the whitespace
// between nodes belongs to whichever slice held it.
function topLevelNodes(html: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const end of cutPoints(html)) {
    if (end <= start) continue;
    out.push(html.slice(start, end));
    start = end;
  }
  if (start < html.length) out.push(html.slice(start));
  return out;
}

// One character of a paragraph's text, with where it came from and what was open around it. The two
// questions the join has to answer are both about position — is this character inside an inline
// element, is it inside a footnote reference — and neither survives `replace(/<[^>]*>/g, "")`.
interface Char {
  ch: string;
  at: number; // index in the paragraph's inner HTML
  depth: number; // elements open at this character, within the paragraph
  inSup: boolean;
}

// Void elements cannot be open around anything, so they must not raise the depth. `<br>` inside a
// paragraph is the common one and a paragraph whose last line ends in one would otherwise look
// permanently nested.
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function scan(inner: string): Char[] {
  const out: Char[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner.startsWith("<!--", i)) {
      const end = inner.indexOf("-->", i);
      i = end < 0 ? inner.length : end + 3;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/.exec(inner.slice(i));
    if (tag) {
      const name = tag[2]!.toLowerCase();
      if (tag[1]) {
        const at = stack.lastIndexOf(name);
        if (at >= 0) stack.length = at;
      } else if (!tag[4] && !VOID.has(name)) {
        stack.push(name);
      }
      i += tag[0].length;
      continue;
    }
    out.push({
      ch: inner[i]!,
      at: i,
      depth: stack.length,
      // A footnote reference is `<sup><a href="#fn-N" id="fnref-N">N</a></sup>` (agents/page.md), so
      // its digit is the last character of a paragraph that ends a sentence and cites a note. Read
      // as text, "…tourist courts.<sup>1</sup>" ends in a digit and looks like a sentence still
      // running — which would move a whole finished sentence onto the next page.
      inSup: stack.includes("sup"),
    });
    i += 1;
  }
  return out;
}

// The paragraph's own words, with footnote references left out for the reasons above.
function words(chars: Char[]): Char[] {
  return chars.filter((c) => !c.inSup);
}

// Ends mid-sentence: the last thing the paragraph says is a letter, a digit, a comma or a hyphen.
// Deliberately a positive test rather than "not a full stop" — a paragraph ending in a colon
// introduces what follows rather than continuing into it, and one ending in a semicolon or a dash
// is its own clause, so neither is joined to the next page.
const CONTINUES = /[\p{L}\p{N},\-‐‑]$/u;
// The word-split case: the tail's last character is a hyphen the printer put there to fill a line.
const HYPHEN = /[-‐‑]$/;
// Where one sentence ends and the next begins, allowing for the punctuation that closes a quotation
// or a parenthesis first.
const SENTENCE_END = /[.?!]["'’”)\]]*\s+/g;

// The head of the paragraph and the tail that carries on into the next page, or null where the tail
// cannot be taken out without breaking markup.
//
// The cut lands immediately after the whitespace that separates the two sentences, and only where
// nothing is open at that point: everything after it is then balanced on its own, including any
// inline element the continuing sentence opens with. A sentence that begins INSIDE an element that
// opened earlier in the paragraph has no such cut, and is declined rather than cut anyway.
function splitTail(inner: string): { head: string; tail: string } | null {
  const chars = words(scan(inner));
  const text = chars.map((c) => c.ch).join("");
  let cut: number | null = null;
  let sawBoundary = false;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(text); m; m = SENTENCE_END.exec(text)) {
    sawBoundary = true;
    // The last whitespace character of the separator, in the paragraph's own indexing. The cut goes
    // after it, so the tail keeps any inline element the next sentence opens with.
    const last = chars[m.index + m[0].length - 1]!;
    if (last.depth === 0) cut = last.at + 1;
    SENTENCE_END.lastIndex = m.index + m[0].length;
  }
  // A boundary was found but every one of them sits inside an element that opened earlier, so there
  // is nowhere to cut that leaves both halves balanced.
  if (cut === null && sawBoundary) return null;
  // No boundary at all: the whole paragraph continues the sentence the previous page began, so the
  // whole of it moves.
  if (cut === null) return { head: "", tail: inner };
  // The whitespace that separated the two sentences goes to the seam rather than being left
  // dangling at the end of the head — `joinAt` puts one space back where the sentence continues.
  // The only characters this loses are ones no reader receives: whitespace at the end of a block
  // element is collapsed away before it reaches anybody.
  return { head: inner.slice(0, cut).replace(/\s+$/, ""), tail: inner.slice(cut) };
}

// Whether this page's fragment opens with the page-break marker, and where its first real content
// is. `agents/page.md` requires the marker to be the first thing a page emits, which is what makes
// the element after it the head of that page's text.
function opening(nodes: string[]): { marker: number | null; content: number | null } {
  const real = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.trim().length > 0);
  const first = real[0];
  if (!first) return { marker: null, content: null };
  const hr = HR.exec(first.n);
  if (hr && PAGE_BREAK_ROLE.test(hr[0])) {
    return { marker: first.i, content: real[1]?.i ?? null };
  }
  return { marker: null, content: first.i };
}

// One page's HTML with its order, which is what the page-gap rule is decided on: a page that failed
// extraction or came back blank contributes no fragment at all, so the only trace of it at this seam
// is a hole in the numbering.
export interface PageHtml {
  order: number;
  html: string;
  // Set where this page is being shipped byte for byte as its agent wrote it (`skipped_pages`,
  // anchors.ts). Carried on the page rather than passed as a separate set of numbers, so a caller
  // cannot hand over the pages and forget which of them are untouchable.
  asWritten?: boolean;
}

export function joinPageBreakProse(pages: PageHtml[]): { pages: string[]; report: ProseJoinReport } {
  const report = emptyProseJoin();
  const nodes = pages.map((p) => topLevelNodes(p.html));
  for (let i = 0; i + 1 < pages.length; i += 1) {
    const before = nodes[i]!;
    const after = nodes[i + 1]!;
    const { marker, content } = opening(after);
    if (marker !== null) report.markers += 1;
    if (content === null) continue;

    // Does the next page begin in the middle of a sentence? The measured test, and the one that
    // decides whether this boundary is counted at all.
    const head = PARAGRAPH.exec(after[content]!);
    if (!head) continue;
    const headText = words(scan(head[2]!)).map((c) => c.ch).join("").trimStart();
    if (!/^\p{Ll}/u.test(headText)) continue;
    report.candidates += 1;

    // And is the sentence's tail the thing immediately before it?
    const lastIdx = before.map((n, k) => ({ n, k })).filter(({ n }) => n.trim().length > 0).at(-1)?.k;
    const tailNode = lastIdx === undefined ? null : PARAGRAPH.exec(before[lastIdx]!);
    if (lastIdx === undefined || !tailNode) {
      report.declined.interrupted += 1;
      continue;
    }
    const tailChars = words(scan(tailNode[2]!));
    const tailText = tailChars.map((c) => c.ch).join("").trimEnd();
    if (!CONTINUES.test(tailText)) {
      report.declined.notContinuing += 1;
      continue;
    }
    // A page is missing between these two, so the middle of the sentence may be what is missing.
    // Both edges are then transcribed correctly and joining them would invent a sentence neither
    // page printed.
    if (pages[i + 1]!.order !== pages[i]!.order + 1) {
      report.declined.pageGap += 1;
      continue;
    }
    // Either page is being delivered exactly as written, so nothing may edit its bytes.
    if (pages[i]!.asWritten || pages[i + 1]!.asWritten) {
      report.declined.asWritten += 1;
      continue;
    }
    // The words would arrive under the other paragraph's `lang`/`dir`, so the two must agree about
    // them. Absent on both is agreement, and is the ordinary English document.
    const tailAttrs = attrs(tailNode[1]!);
    const headAttrs = attrs(head[1]!);
    if ([...TRAVELS].some((a) => tailAttrs.get(a) !== headAttrs.get(a))) {
      report.declined.langMismatch += 1;
      continue;
    }
    const split = splitTail(tailNode[2]!);
    if (!split) {
      report.declined.noCut += 1;
      continue;
    }
    // The whole paragraph would move, and it carries something the move cannot take with it. Its
    // `lang` and `dir` can go, since the paragraph it joins was just held to the same ones.
    if (!split.head.trim() && [...tailAttrs.keys()].some((a) => !TRAVELS.has(a))) {
      report.declined.attrsKept += 1;
      continue;
    }

    const joinedWord = HYPHEN.test(tailText);
    before[lastIdx] = split.head.trim()
      ? tailNode[1]! + split.head + tailNode[3]!
      : // Nothing of this paragraph stays behind, so the element goes with its text rather than
        // shipping as an empty `<p>`. Its whitespace is kept so the pages still read apart.
        (before[lastIdx]!.match(/^\s*/)?.[0] ?? "") + (before[lastIdx]!.match(/\s*$/)?.[0] ?? "");
    after[content] = head[1]! + joinAt(split.tail, head[2]!, joinedWord) + head[3]!;
    report.joined += 1;
    if (marker === null) report.unmarked += 1;
    if (joinedWord) {
      report.wordSplits += 1;
      if (report.wordSplitExamples.length < MAX_EXAMPLES) {
        report.wordSplitExamples.push(wordSplitExample(tailText, headText));
      }
    }
  }
  return { pages: pages.map((_, i) => nodes[i]!.join("")), report };
}

// The two halves in one paragraph. A space between them, except where the printer broke a word, and
// then nothing — so "Simi-" and "larly," are delivered as one word.
//
// THE HYPHEN STAYS. It is the one character where the printing itself is ambiguous: "Simi-" +
// "larly" wants it gone and "public-" + "sector" wants it kept, and nothing at this seam can tell
// which of the two a hyphen at a page's edge is — the page prompt reaches the same wall from the
// other side and answers it the same way ("Where you cannot tell whose hyphen it is, keep it — a
// hyphen too many is a printing some page might have, and two words run into one is a word no page
// printed"). Dropping it would also be the one place this pass deleted a character the source
// printed. What the join fixes is the interruption: a reader hears "Simi-larly" as one word instead
// of hearing "Simi", a page-break announcement, and then "larly". Whether the hyphen can be decided
// after all is a separate question, and `word_splits` in the run log is what makes it answerable.
function joinAt(tail: string, head: string, joinedWord: boolean): string {
  if (joinedWord) return tail + head.replace(/^\s+/, "");
  return tail.replace(/\s+$/, "") + " " + head.replace(/^\s+/, "");
}

// The word the two halves make, for the log: the last word of the tail and the first of the head,
// which is what a reader would have heard split in two.
function wordSplitExample(tailText: string, headText: string): string {
  const tail = /\S+$/.exec(tailText)?.[0] ?? "";
  const head = /^\S+/.exec(headText)?.[0] ?? "";
  return (tail + head).slice(0, MAX_EXAMPLE_CHARS);
}
