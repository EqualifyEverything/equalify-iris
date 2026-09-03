// Take the label off a page-break marker that names the page's POSITION instead of the number the
// page prints (issue #333).
//
// The delivered document announced "Page 52" at the head of the sheet that prints 38. `agents/page.md`
// forbids exactly this, by name, in one sentence — "use the number the page shows (iv, 5, A-3), never
// the position of the image you were given in the file" (:99) — and has forbidden it at every prompt
// blob there is a round for. It happened anyway on 6 of 88 markers on the shipped page model and 5 of
// 90 on another vendor's, on the same document and the same blob, while a third vendor scored 0; both
// failing arms did it on the same two pages. Two vendors violating one specific sentence is not a
// sentence problem, so this is not answered with more prose. It is answered here because the marker is
// the one thing on a page whose number Iris can check for itself, with no model call and no image.
//
// **The number is checkable because Iris is the one who supplied it.** The page agent is handed
// `filename: acir-p052.png, page 2 of 25` in its user message (extraction.ts), so there are exactly two
// positional numbers a page could be leaking, and both of them are known here. The one tested is the
// FILENAME's — its last integer, which is the part Iris writes. A label is only touched when it repeats
// that number, AND the rest of the document's markers say the folio is something else, AND those markers
// name their own folios from somewhere other than their own filenames. That is evidence rather than
// inference: the model was told this number, it put it in the label, and 20-odd other pages disagree
// about what page that sheet is while demonstrating that a true label here does not read like this one.
//
// The `page N of M` half of the message is deliberately not tested, and the reason is measured. Replayed
// over 61 chunks of already-paid rounds, 29 of the 30 labels this removed repeated the filename's number;
// the 30th repeated `order` alone — and it was CORRECT. That round re-submitted a non-contiguous subset
// of an already-rendered document, so the sheet printing `iv` arrived 4th, and a check reading `order`
// convicted a true label on the coincidence. Testing `order` costs a real page its number in exchange
// for nothing observed: no arm in any round leaked `order` where the two numbers differed. It also loses
// very little, because where Iris rasterizes a whole PDF itself the two numbers are the same one —
// `util/pdf.ts` names the pages `<base>-p<N>.png` with N the submitted position, so on that path a leak
// of `order` is a leak of the filename. What is left uncovered is a caller who uploads images whose names
// carry no position, where a leak of the stated `page N of M` is invisible from here; those markers are
// counted as `unchecked` rather than passed off as agreeing.
//
// The disagreement is read as an OFFSET, per numbering system. A document's markers sit at a constant
// distance from their positions wherever its numbering is regular — the reference corpus prints roman
// front matter and then restarts at arabic 1, so 78 of its 91 pages fix `position - printed` at 14 —
// and the offset is a fact about the session rather than the file, so it survives a document submitted
// in batches: the same defect leaks the FILENAME's number (32) where `order` says 7, which is a
// departure from that batch's own offset of -25 all the same. Roman and arabic are counted separately
// because a document using both has two offsets, and a check that pooled them would read correct front
// matter as a departure — and because an arabic-only reading is how a `Page xv` leak on a page printing
// `PART I` went unseen: a roman leak contributes to no arabic bucket at all (#333 §C).
//
// **The label is removed, not corrected.** The derived folio is right where it can be checked — the
// four the derivation named on the reference corpus are the four read off the scans — but delivering it
// would have Iris assert a number nobody saw printed, on a page whose own model just proved it was
// guessing. Removing the name leaves a break that says only that something ended, which is what the
// prompt prescribes for a page whose number is not known (:114), and is the one-directional error: the
// cost is a reader losing an anchor's name, against a reader being told the page in their hand is a
// different page. The derived number is logged, so the round that wants to weigh the other direction
// has it.
//
// **The `id` is kept.** `id="page-52"` on that sheet is the same wrong number, and taking it out would
// break a reference that resolves today — a `#page-52` written on some other page would go from landing
// on the wrong sheet to landing nowhere, and this pass cannot see which. The announced claim goes and
// the machine handle stays; nothing in Iris reads `page-N` ids, and `internal_links` measures where
// references land on the delivered bytes.
//
// What this cannot see, stated because each one reads as a clean document:
//   - A model that leaks on EVERY page. Then the leak IS the modal offset, the document is internally
//     consistent, and nothing here has anything to disagree with it. The check can only ever act on a
//     minority of a system's markers, because it needs a strict majority to hold the offset it acts on.
//   - A sectioned folio — `A-3`, `M-16`, `3-14`. Those parse as no numeral at all, so they are counted
//     as unreadable and left alone. Luna's `Page M-16` on a cover (#333 §D) is one, and it is a
//     different defect anyway: the page really does print `M — 16` and put it nowhere a reader gets it.
//   - A document whose ARABIC numbering restarts partway through, where the minority run's folios
//     coincide with the numbers in their own filenames while the majority's do not. Those labels are true
//     and are removed, because from here they are indistinguishable from the defect: the label repeats a
//     number Iris handed the model and the majority of the document contradicts it. It is an active
//     removal of true labels and not a missed leak, so `departures` reports the shape the removals form:
//     a restart takes out a block of consecutive positions with no surviving label among them, a leak is
//     interleaved with the labels that contradict it, and a corpus which pays for this can count the two
//     apart even though the check cannot act on the difference. The commoner shapes of
//     this are caught: where the honest majority repeats its filenames too, the system is refused
//     outright, and sectioned numbering — the usual way a document restarts per chapter — is unreadable
//     above.
//   - Any document where the positional test is refused: the check is off there, so a real leak on it is
//     missed as well. That is the trade this makes on purpose, and `systems` names it every time.
//   - A positional number announced as `aria-labelledby` instead, pointing at an element whose text is
//     `Page 52`. Only `aria-label` is read. #333's shape is `aria-label` on both failing arms, and
//     resolving an ID reference into another element's text is a different pass on a different input —
//     what the review loop reads for the same claim is the delivered body, not one page's fragment.
//
// A document with nothing to strip comes back byte-identical: this rewrites the matched `aria-label`
// inside a matched start tag and touches nothing else. The review loop decides a round changed nothing
// by comparing two body strings, and `anchors.ts` records the pages it declined to reserialize
// precisely because a round trip through a DOM can lose markup.
//
// This pass can only live at the join. It needs every page's marker at once to derive an offset, and by
// the time the review loop has the body there is one string with the pages' provenance already spent —
// which is also why a marker the Copy Editor introduces later is not reached, unlike the role strips
// that run at three stages.

// A start tag, with its attributes read as text-or-quoted-string so a `>` inside an attribute value
// does not end the tag early. Same shape as `roles.ts`'s scan, and the same limitation: where it is
// fooled it ends the slice early and finds no marker in it, and it cannot mangle a tag it mis-sliced,
// because the only edit made is to an attribute found INSIDE the slice.
const START_TAG = /<([a-z][a-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
// Cheap pre-check, so a document with no marker does no scanning work. `role=` rather than the role
// name, since the name is what the scan below has to establish properly.
const ANY_ROLE = /role\s*=/i;

const WS = /\s/;
// A `/` between attributes is a separator and not part of a name — what the parser does with it, and
// the same reading `roles.ts` takes: `<hr/role="doc-pagebreak">` really does carry that role.
const SEP = /[\s/]/;

interface Attr {
  name: string; // lower-cased
  value: string;
  index: number; // offset into the attribute text, including the whitespace that introduced it
  length: number; // how much to splice out to remove the attribute and its separator
}

// The attributes of a start tag, walked as a sequence of `name(=value)?` pairs from position 0 the way
// a parser reads them, rather than searched for. `roles.ts` carries the long version of why that
// matters and it is the same argument here: a search for `aria-label\s*=` matches inside another
// attribute's VALUE, and the values on these elements are prose out of a document — an `alt` reading
// "the aria-label = the page number" would have a word cut out of the middle of it, a loss nothing in
// the gate can report. The walk is not shared with `roles.ts` because that one answers a question about
// the `role` attribute specifically (which copy the parser keeps, what an emptied value promotes) and
// this one needs two named attributes off the same tag.
//
// `null` means the tag is declined: a bare value ran into a quote, so it cannot be read to its end.
// That is the JSON-escaping leak's shape (#233/#234/#257) — `<hr role=\"doc-pagebreak\" …>`, where the
// unquoted value reads as the single character `\` — and editing an attribute located inside it would
// mangle markup worse than the label it was taking off. The leak's other symptoms are the ones worth
// having and they are untouched.
function readAttrs(attrs: string): Attr[] | null {
  const out: Attr[] = [];
  let i = 0;
  while (i < attrs.length) {
    const start = i;
    while (i < attrs.length && SEP.test(attrs[i]!)) i++;
    if (i >= attrs.length) break;
    const nameStart = i;
    while (i < attrs.length && !SEP.test(attrs[i]!) && attrs[i] !== "=") i++;
    const name = attrs.slice(nameStart, i).toLowerCase();
    // The `=` may be separated from the name by whitespace, and so may the value from the `=`.
    let j = i;
    while (j < attrs.length && WS.test(attrs[j]!)) j++;
    if (attrs[j] !== "=") {
      // A valueless attribute. `i` already sits after the name, so the next turn reads the separator
      // before whatever follows.
      out.push({ name, value: "", index: start, length: i - start });
      continue;
    }
    j++;
    while (j < attrs.length && WS.test(attrs[j]!)) j++;
    const quote = attrs[j];
    if (quote === '"' || quote === "'") {
      const end = attrs.indexOf(quote, j + 1);
      // Unreachable from START_TAG, whose quoted branches only match closed pairs, so this is for a
      // caller passing attribute text of its own: a value with no end cannot be read.
      if (end === -1) return null;
      out.push({ name, value: attrs.slice(j + 1, end), index: start, length: end + 1 - start });
      i = end + 1;
    } else {
      let k = j;
      while (k < attrs.length && !WS.test(attrs[k]!) && attrs[k] !== '"' && attrs[k] !== "'" && attrs[k] !== ">") k++;
      if (k < attrs.length && !WS.test(attrs[k]!)) return null;
      out.push({ name, value: attrs.slice(j, k), index: start, length: k - start });
      i = k;
    }
  }
  return out;
}

// The first spelling of an attribute wins, which is what a parser does with a repeated one.
function attr(list: Attr[], name: string): Attr | undefined {
  return list.find((a) => a.name === name);
}

// Cut ranges out of a start tag's attribute text, by position. `attrs` is the last thing in the tag
// before its `>`, so the prefix carrying the element's name is fixed by the two lengths and everything
// else in the tag — including a trailing `/`, which the scan reads as part of the attribute text — is
// carried through untouched. Nothing is searched for, so a value that happens to contain the attribute
// text cannot be edited instead. Cut from the back, so the positions read off the original text still
// hold as the text shrinks under them.
function cutAttrs(tag: string, attrs: string, cuts: { index: number; length: number }[]): string {
  let text = attrs;
  for (const cut of [...cuts].sort((a, b) => b.index - a.index)) {
    text = text.slice(0, cut.index) + text.slice(cut.index + cut.length);
  }
  return tag.slice(0, tag.length - 1 - attrs.length) + text + ">";
}

const PAGE_BREAK = "doc-pagebreak";

export type Numerals = "arabic" | "roman";

export interface Folio {
  value: number;
  system: Numerals;
}

// The number a marker's label carries, or `null` for a label that is not a numeral this can read.
//
// The label the prompt asks for is `Page 5`, and the corpus also produced `27` with the word dropped
// and a lower-case `page 50` — deviations with no measured consequence, and each still a number to
// check. A leading `page`/`pg`/`p.` is therefore optional, and what follows it has to be the whole of
// the rest: `Page 5 of 25` names something other than this page and is not read as 5.
//
// Roman numerals are read because the front matter is where the defect hides, and validated by
// spelling the value back out rather than by summing letters. Round-tripping is what keeps most
// ordinary words out: `civil`, `mild` and `did` are all made of roman letters and all sum to
// something, and none of them spells back the same way. `mix` does — it is M + IX — so a label of
// `mix` reads as 1009 here, which costs nothing on its own: a number has to be written in the page's
// own filename before any label is touched.
const LABEL = /^(?:p(?:g|age|\.)?\s*)?([0-9]{1,4}|[ivxlcdm]+)$/i;
const ROMAN = [
  ["m", 1000], ["cm", 900], ["d", 500], ["cd", 400], ["c", 100], ["xc", 90],
  ["l", 50], ["xl", 40], ["x", 10], ["ix", 9], ["v", 5], ["iv", 4], ["i", 1],
] as const;
function spellRoman(value: number): string {
  let left = value;
  let out = "";
  for (const [letters, worth] of ROMAN) {
    while (left >= worth) {
      out += letters;
      left -= worth;
    }
  }
  return out;
}
function readRoman(letters: string): number {
  let value = 0;
  for (let i = 0; i < letters.length; i++) {
    const here = ROMAN.find(([l]) => l === letters[i])?.[1] ?? 0;
    const next = ROMAN.find(([l]) => l === letters[i + 1])?.[1] ?? 0;
    value += next > here ? -here : here;
  }
  return value;
}
export function folio(label: string): Folio | null {
  const m = LABEL.exec(label.trim().replace(/\s+/g, " "));
  if (!m) return null;
  const text = m[1]!;
  if (/^[0-9]+$/.test(text)) {
    const value = parseInt(text, 10);
    return value > 0 ? { value, system: "arabic" } : null;
  }
  const letters = text.toLowerCase();
  const value = readRoman(letters);
  return value > 0 && spellRoman(value) === letters ? { value, system: "roman" } : null;
}

// The positional number written in the image's own filename: the LAST integer in the name, with the
// extension dropped. `acir-p052.png` gives 52.
//
// The last one and not every one, because the rest of the name is the document's, not the page's.
// `util/pdf.ts` renders a PDF as `<base>-p<N>.png` where `<base>` is the UPLOADED FILE'S OWN NAME, so
// `volume-1.pdf` produces `volume-1-p13.png` — and a check reading every integer in that would find the
// label `Page 1` written in the filename of the thirteenth sheet and take a true page number off a
// document whose only sin was being called `volume-1`. `part 2.pdf`, `doc_1.pdf` and `M-16.pdf` all do
// that. The last integer is also where a hand-named file puts its position (`page-13.png`,
// `scan_013.png`); where a name carries no position at all, this finds a number that means something
// else, which is what the majority test below is for.
//
// A page with no filename recorded contributes no number rather than throwing: the name is the one input
// here that comes from the store rather than from this pass, and a document is not worth losing over a
// missing one. What it costs is this check on that page, which is the right direction — with no name
// there is nothing to say the label repeats. Those markers are counted (`unchecked`) so a run cannot
// read as checked-and-agreed when nothing could be checked.
function filenamePosition(name: string): number | null {
  const digits = (name ?? "").replace(/\.[a-z0-9]+$/i, "").match(/[0-9]+/g);
  if (!digits) return null;
  const value = parseInt(digits[digits.length - 1]!, 10);
  return value > 0 ? value : null;
}

interface Marker {
  page: number; // the page's `order`, 1-based, which is `page N of M` as the model was told it
  occurrence: number; // which marker this is within its page, in document order
  label: string | null; // `null` for a marker carrying no `aria-label` at all
  folio: Folio | null;
  position: number | null; // the number in the page's own filename, or `null` where it carries none
  positional: boolean; // the label repeats that number
}

// Every page-break marker in one page's fragment, with its label read. The whole fragment is scanned
// rather than only its first top-level node: the prompt asks for the marker first and at top level, and
// a marker written somewhere else carries the same wrong number to the same reader.
function readMarkers(page: MarkerPage): Marker[] {
  if (!ANY_ROLE.test(page.html)) return [];
  const position = filenamePosition(page.name);
  const out: Marker[] = [];
  let occurrence = 0;
  START_TAG.lastIndex = 0;
  for (let m = START_TAG.exec(page.html); m; m = START_TAG.exec(page.html)) {
    const list = readAttrs(m[2]!);
    if (!list) continue;
    const role = attr(list, "role");
    if (!role || !role.value.split(/\s+/).some((t) => t.toLowerCase() === PAGE_BREAK)) continue;
    const label = attr(list, "aria-label");
    const read = label ? folio(label.value) : null;
    out.push({
      page: page.order,
      occurrence: occurrence++,
      label: label?.value ?? null,
      folio: read,
      position,
      positional: read !== null && position !== null && read.value === position,
    });
  }
  return out;
}

// Take the `aria-label` off the named markers of one page, located the same way they were read.
function stripLabels(html: string, occurrences: Set<number>): string {
  let occurrence = 0;
  return html.replace(START_TAG, (tag, _name: string, attrs: string) => {
    const list = readAttrs(attrs);
    if (!list) return tag;
    const role = attr(list, "role");
    if (!role || !role.value.split(/\s+/).some((t) => t.toLowerCase() === PAGE_BREAK)) return tag;
    const at = occurrence++;
    // Every copy of the attribute, not the one the parser keeps. Deleting only the first promotes a
    // repeated `aria-label` into its place, so a model that wrote the label twice would go on announcing
    // the number while `stripped` reported it removed — and that line is the only trace this leaves, so a
    // round would be reading a claim about a page that still says 52. `roles.ts` answers the same
    // promotion problem by emptying the value; here the whole attribute goes, however many there are.
    const labels = list.filter((a) => a.name === "aria-label");
    if (labels.length === 0 || !occurrences.has(at)) return tag;
    return cutAttrs(tag, attrs, labels);
  });
}

// How many markers one numbering system needs before an offset is derived from it at all.
const MIN_MARKERS = 3;
// How many of them have to AGREE before that offset is acted on. Both gates are needed and they are not
// the same gate: a strict majority of three markers is two, and two agreeing markers are a pair rather
// than a run — `Page 1`, `Page 2`, `Page 9` would have the first two delete the third's number. A page's
// number is being removed on the strength of this, so the run has to be a run. The smallest document that
// can lose a label is therefore four markers: three holding the offset and one departing from it.
const MIN_AGREED = 3;
// A label is logged, and a label that reaches this length is not a folio — `folio` above only reads a
// numeral with an optional word in front of it, so this is a bound rather than a cut anything real
// meets.
const LABEL_CHARS = 40;

export interface MarkerReport {
  markers: number; // markers found, labelled or not
  readable: number; // labels that are a numeral this can read
  unreadable: number; // labels that are not (`A-3`, `M-16`), plus markers carrying no label at all
  // One entry per numbering system that produced enough markers to be asked, written as
  // `arabic: offset 14 on 23 of 25` — or, where nothing was acted on, one of the two ways that happens:
  // `arabic: no offset holds 12 markers (best: 5)`, or `arabic: offset 0 on 8 of 10, 8 of them repeating
  // their own filename`. The denominators are here on purpose: without them a run cannot tell a document
  // with no leak from one this could not decide, and the two look identical from `stripped: []`.
  systems: string[];
  // One entry per label removed, `page 52: "Page 52" → 38`, with the derived folio omitted where the
  // derivation names a number below 1.
  stripped: string[];
  // The SHAPE the removals form, one entry per offset they sat at: `arabic: 1 removed at offset 0,
  // page 2`, against `arabic: 6 removed at offset 0, pages 1-6 (every marker in that span)`. This is
  // what separates the defect from the blind spot below it, because both log removals beside one derived
  // offset and nothing else here tells them apart. A leak is interleaved with the labels that contradict
  // it; a document whose numbering restarts with the leading run in the minority takes out a block of
  // consecutive positions with no honest label among them, which is a restart's signature and not a
  // model's. The check acts either way — it cannot read a signature — but a corpus round paying for this
  // can now count the two apart.
  departures: string[];
  // Readable labels that disagree with their system's offset and were NOT touched, because they repeat
  // no number in the page's own filename: a page printing `ix` labelled `Page 9` is
  // one. A wrong label all the same, and this count is the only trace of it — nothing here can tell a
  // misread folio from a numbering irregularity, so it is counted and left.
  offMode: number;
  // Labels that repeat a positional number where the check could not decide anything: too few markers in
  // that numbering system, no offset holding a run of them, or a document whose honest labels repeat
  // their own filenames so the positional test carries no information (`systems` says which). The check's
  // own blind spot, and the figure that says how big it was on this document.
  undecided: number;
  // Readable labels on a page whose filename carries no number to check them against — no name was
  // recorded for the page, or the name has no digits in it. They still count towards the offset, since
  // the label is evidence about the document's numbering either way, but nothing on those pages can be
  // acted on. Here so that a document this could not check does not read as one it checked and agreed
  // with: `readable: 25, stripped: []` says the same thing in both cases and this is what separates them.
  unchecked: number;
}

export interface MarkerPage {
  order: number;
  name: string; // the image filename, as the model was told it
  html: string;
}

export function emptyMarkerReport(): MarkerReport {
  return {
    markers: 0,
    readable: 0,
    unreadable: 0,
    systems: [],
    stripped: [],
    departures: [],
    offMode: 0,
    undecided: 0,
    unchecked: 0,
  };
}

// The offset the most of a numbering system's markers sit at, and how many of them do. `null` only for
// an empty list; whether that plurality is enough to act on is the caller's question, because a
// plurality that fails the gates is still worth logging as the best there was.
function modalOffset(offsets: number[]): { offset: number; agreed: number } | null {
  const counts = new Map<number, number>();
  for (const o of offsets) counts.set(o, (counts.get(o) ?? 0) + 1);
  let best: { offset: number; agreed: number } | null = null;
  for (const [offset, agreed] of counts) {
    if (!best || agreed > best.agreed) best = { offset, agreed };
  }
  return best;
}

export function stripPositionalMarkers(pages: MarkerPage[]): { pages: string[]; report: MarkerReport } {
  const found = pages.map((p) => readMarkers(p));
  const report = emptyMarkerReport();
  const all = found.flat();
  report.markers = all.length;
  const derived = new Map<Numerals, { offset: number; agreed: number } | null>();
  for (const system of ["arabic", "roman"] as const) {
    const mine = all.filter((m) => m.folio?.system === system);
    if (mine.length < MIN_MARKERS) continue;
    const mode = modalOffset(mine.map((m) => m.page - m.folio!.value));
    // A document whose numbering restarts, or a model that got it wrong about as often as it got it
    // right, has nothing here to act on: the pages keep their labels and the count says how close it came.
    if (!mode || mode.agreed < MIN_AGREED || mode.agreed * 2 <= mine.length) {
      derived.set(system, null);
      report.systems.push(
        `${system}: no offset holds ${mine.length} markers${mode ? ` (best: ${mode.agreed})` : ""}`,
      );
      continue;
    }
    // Whether the positional test can say anything about THIS document, asked of the run itself. The
    // whole rule rests on a true label not repeating the number in its own filename — and there are
    // ordinary inputs where it does: a plain report submitted whole prints 1 on the sheet Iris named
    // `-p1.png`, and a caller who names their images after the printed folios does it by construction.
    // Where the markers holding the offset are themselves positional, a label repeating its filename is
    // the shape of a CORRECT label here, the test carries no information, and the system is refused
    // rather than acted on. Asked of the agreeing run and not of the document, because the departures are
    // the labels in question: counting them would let the defect vote to protect itself.
    const agreedPositional = mine.filter((m) => m.page - m.folio!.value === mode.offset && m.positional).length;
    if (agreedPositional * 2 > mode.agreed) {
      derived.set(system, null);
      report.systems.push(
        `${system}: offset ${mode.offset} on ${mode.agreed} of ${mine.length}, ` +
          `${agreedPositional} of them repeating their own filename`,
      );
      continue;
    }
    derived.set(system, mode);
    report.systems.push(`${system}: offset ${mode.offset} on ${mode.agreed} of ${mine.length}`);
  }
  const strip = new Map<number, Set<number>>();
  const cuts = new Map<string, { system: Numerals; offset: number; pages: number[] }>();
  for (const m of all) {
    if (!m.folio) {
      report.unreadable++;
      continue;
    }
    report.readable++;
    if (m.position === null) report.unchecked++;
    const mode = derived.get(m.folio.system) ?? null;
    if (!mode) {
      if (m.positional) report.undecided++;
      continue;
    }
    const offset = m.page - m.folio.value;
    if (offset === mode.offset) continue;
    if (!m.positional) {
      report.offMode++;
      continue;
    }
    const folio = m.page - mode.offset;
    report.stripped.push(
      `page ${m.page}: "${(m.label ?? "").slice(0, LABEL_CHARS)}"${folio > 0 ? ` → ${folio}` : ""}`,
    );
    const mine = strip.get(m.page) ?? new Set<number>();
    mine.add(m.occurrence);
    strip.set(m.page, mine);
    const key = `${m.folio.system} ${offset}`;
    const cut = cuts.get(key) ?? { system: m.folio.system, offset, pages: [] };
    cut.pages.push(m.page);
    cuts.set(key, cut);
  }
  for (const cut of cuts.values()) {
    const first = Math.min(...cut.pages);
    const last = Math.max(...cut.pages);
    // Every marker of that system inside the span, so the entry can say whether the removals took all of
    // it — a block with no surviving label in it — or sit among labels that disagreed with them.
    const inSpan = all.filter((m) => m.folio?.system === cut.system && m.page >= first && m.page <= last).length;
    report.departures.push(
      `${cut.system}: ${cut.pages.length} removed at offset ${cut.offset}, ` +
        (first === last ? `page ${first}` : `pages ${first}-${last}`) +
        (first !== last && inSpan === cut.pages.length ? " (every marker in that span)" : ""),
    );
  }
  return {
    pages: pages.map((p) => {
      const mine = strip.get(p.order);
      return mine ? stripLabels(p.html, mine) : p.html;
    }),
    report,
  };
}
