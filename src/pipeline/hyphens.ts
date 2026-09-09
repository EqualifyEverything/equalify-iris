import { decodeEntities } from "../util/html.ts";

// A page that writes one word both ways — `Compos-ite` in one place and `Composite` in another —
// has certainly got one of them wrong, whichever the paper prints (issue #334, part B).
//
// That is the whole argument, and what makes it worth running is what it does NOT need. Not a
// lexicon: the evidence is two spellings in one page's own output, so English never has to be
// consulted, and #334 measured what happens when it is — `/usr/share/dict/words` scored `totals`,
// `states` and `populations` as non-words while failing to match `manu-facturing` against
// `manufacturing`, wrong in both directions. Not a second model, not the image, and not another
// arm's output: the contradiction is internal, so it is decidable on the fragment in hand for $0.
//
// It also fires where the soft-hyphen strip does not. `stripSoftHyphens` covers the INVISIBLE break
// (U+00AD), which on #334's 100-page three-arm census is 63 occurrences on 9 pages from one arm and
// **zero from the model Iris ships**. This check's own column on that census — the self-contradiction
// column, one word written both ways on one page, which is the predicate implemented below and not
// the wider "retained visible hyphen" count beside it — is non-zero on all three arms:
// `kimi-k2.5` (shipped) 6 words on 4 pages, `claude-sonnet-4-6` 3 on 3, `gpt-5.6-luna` 2 on 2. Same
// clause of `agents/page.md`, and unlike the strip, no arm is clean on it:
//
// > a "condi-" ending one line with "tions" beginning the next is one word split to fit the column
// > — write it whole, "conditions", and do not carry the break into the markup.
//
// What this cannot see is a page that breaks a word and never writes it whole. #334's census calls
// that out as a floor rather than a count — its cross-arm version of the test asks whether ANOTHER
// arm delivered the word whole, and that is not available at run time with one arm running. So the
// rate this finds is a lower bound on the defect, and the reason to accept that is the other
// direction: a page carrying both spellings is wrong on the page's own evidence, which is what
// makes the correction request below defensible without an appeal to what the paper prints.
//
// The remedy is a re-ask rather than a repair, and that is the difference from `stripSoftHyphens`
// worth stating plainly: there is no output where a soft hyphen is right, so a strip cannot lose
// anything, while HERE Iris does not know which of the two spellings the page carries. Only the
// agent holding the image does. So this raises a problem and lets the correction pass settle it
// against the source, on the same terms as a missing link or a placeholder alt — and, like those,
// it costs a call only on a page that had no other reason to buy one.
//
// With one exception, added later and argued where it lives: `joinBrokenWords` at the foot of this
// file DOES repair, in the one case where the document settles the question without the image. The
// sentence above stays as written because it is the rule — a bare contradiction is not decidable here
// — and the exception is what it takes to earn a repair.

// Comments first, and stripped rather than read, for the reason alt.ts and links.ts strip them from
// the same bytes: a delivered document carries `@unresolved` and the other `@` markers, which are
// model-written prose ABOUT the document. Such a note quotes the page's words freely — it is where
// a model explains what it could not read — so a word discussed there and transcribed in the body
// is one word written twice by construction, and counting it would buy a correction for a page whose
// markup is fine.
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

// One tag, with quoted regions consumed as units — the generalization of alt.ts's `IMG_TAG`, and
// for its reason: `<img alt="a > b">` cut at the first `>` leaves ` b">` behind as text, which is
// attribute content entering a comparison over prose. Attributes are the false-positive surface
// here, since `href`, `id` and `class` values carry hyphens by convention (`id="non-tax"` beside the
// word `nontax` in the text is not a contradiction about anything a reader is shown).
//
// Text inside a tag's attributes is therefore not examined at all, `alt` included. An `alt` is a
// transcription surface — a model reading a chart writes words into it — so a split word can live
// there, and this will not find it. That is a stated limit rather than a claim it cannot: the check
// needs a word written BOTH ways to say anything, and an alt is one string beside a body that may
// use the other spelling, so admitting attributes means either accepting `href`/`id` as evidence or
// building a second attribute-aware reader. Neither is worth it for a case nothing has measured.
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;

// A run of letters and the WHOLE chain of hyphenated pieces after it, so a word is one token however
// many hyphens it carries. Letters only: `\p{L}` excludes digits, which keeps a printed range
// (`1962-63`) and a table's `12-4` out of it, and excludes `_`, which keeps an identifier that leaked
// out of a code span from being read as a broken word.
//
// The `*` is load-bearing and the first draft of this file had `?`, which is a different check than
// its own comment claimed. Matching is greedy and restarts after the match, so with `?` a two-hyphen
// word came out as its first two pieces PLUS its tail: `Con-struc-tion` became `Con-struc` and
// `tion`, and `state-by-state` became `state-by` and `state`. The tail then entered the whole-word
// map below as EVIDENCE, so a page writing `up-to-date` and `dat-e` reported a contradiction whose
// `joined` form (`date`) the page never writes on its own, and a page writing `state-by-state` beside
// `stateby` reported the very comparison the comment said was impossible. Consuming the chain is what
// makes "skipped" true.
//
// Skipped in BOTH roles, which is the whole of the limit: a word with more than one hyphen is
// neither a candidate nor evidence for another candidate. It still counts toward `words`, since that
// is how many words were looked at. #334 names the cost by name — `Con-struc-tion` and
// `Trans-porta-tion` carry two breaks each on `p032`, and its first detector missed them for exactly
// this reason. Accepted on two grounds. One, neither of those words is written whole anywhere on its
// own page, so on that census admitting them adds nothing HERE — a fact about one corpus, not about
// the pattern, and why this is a limit rather than a proof. Two, one hyphen is the shape of the
// common case (a line break splits a word in one place), and requiring exactly one is what keeps a
// printed compound out: `state-by-state` is not compared against a `statebystate` nothing writes,
// and its pieces do not vouch for anyone else's break either.
//
// The hyphen must be followed by a letter IMMEDIATELY, and that is a fifth limit of a different kind
// from the four above — those are about which tokens get compared, this one is about a break that
// never becomes a token at all. A fragment that soft-wraps its own source at the break
// (`Compos-\nite`) tokenises as two whole words, so `Compos` and `ite` both enter the map as
// evidence and nothing is a candidate. Under-detection, in the direction this rule already accepts.
//
// Not widened to `-\s*\p{L}+`, and the reason is measured rather than assumed. Making that case work
// needs whitespace out of the lookup key as well, and with the key normalized the same widening fires
// across an element boundary — `<td>Total-</td><td>farm</td>` beside a `Totalfarm` reports
// `Total- farm / Totalfarm`, because `textOf` renders every tag as a space and a widened pattern
// cannot tell that space from a wrapped line. It also breaks `split`'s contract: the reported string
// becomes `Compos- ite`, which is not a string the document contains, so a corrector sent looking for
// it finds nothing. A page that wraps at the break also SHOWS the reader `Compos- ite`, hyphen and
// space, which is a defect on its own terms and not the contradiction this rule is about.
const WORD = /\p{L}+(?:-\p{L}+)*/gu;

export interface SplitWord {
  // As the page wrote it, hyphen included, so the correction request can quote it back and the
  // model can find it. Not lowercased: a reader of the log is looking for this string in a document.
  split: string;
  // The other spelling, as the page wrote THAT — not as `split` with the hyphen removed. The two can
  // differ in case (`Compos-ite` at the start of a cell, `composite` mid-sentence) and quoting a
  // form the page does not contain would send the corrector looking for a string that is not there.
  joined: string;
}

// The text a reader is shown, with markup and comments out of it and entities resolved.
//
// Entities are decoded AFTER the tags are gone, which is the order that matters: decoding first
// turns a `&lt;` in prose into a `<` and the tag pattern above then eats the prose after it as an
// attribute-bearing tag. Decoded at all because a hyphen has spellings — `&#45;` and `&#x2d;` — and
// a page that writes one of them has still put the break in the markup.
function textOf(html: string): string {
  return decodeEntities(html.replace(COMMENT, " ").replace(TAG, " "));
}

// Every word this page writes both ways, and how many words were looked at to find them — the pair
// `idAudit` returns, for the reason it returns a pair: 0 contradictions out of 0 words says nothing
// about the rule, and 0 out of 900 says something. `words` counts occurrences and not distinct
// spellings, since what it is for is telling a fragment with prose in it from one without.
//
// `split` holds one entry per word, not per occurrence: the correction request names the word, and a
// page that broke `Compos-ite` twice has one thing to fix. That is the opposite of `genericAlts`,
// which keeps duplicates — two images described `"image"` are two descriptions to write, while two
// copies of one broken word are one spelling to settle.
// The unhyphenated spellings a text uses, first-written form kept, keyed case-folded so `Composite`
// at the start of a sentence answers for `composite`.
//
// Only unhyphenated words are evidence, so a page writing `Commu-nications` and
// `communications-related` and never the bare word finds nothing here. That is the under-reporting
// direction, and it is the one to take: the alternative is to read the parts of hyphenated words
// as whole words, which makes every compound its own corroboration and turns `non-property` —
// printed with the hyphen on all three of #334's arms — into a contradiction with itself.
//
// Its own function because `joinBrokenWords` consults exactly this index and consults it for a second
// thing — whether the fragment after a hyphen is a word at all — and two copies of it would be two
// sets of limits to keep in step.
function wholeWords(text: string): Map<string, string> {
  const whole = new Map<string, string>();
  for (const [word] of text.matchAll(WORD)) {
    if (word.includes("-")) continue;
    const key = word.toLowerCase();
    if (!whole.has(key)) whole.set(key, word);
  }
  return whole;
}

export function splitWordAudit(html: string): { words: number; split: SplitWord[] } {
  const text = textOf(html);
  const whole = wholeWords(text);
  const splits: string[] = [];
  let words = 0;
  for (const [word] of text.matchAll(WORD)) {
    words += 1;
    // Counted, then dropped from both roles above one hyphen. The three-way split is written out
    // rather than folded into `includes("-")` because the middle case is the limit `WORD` documents,
    // and a reader looking for where a two-hyphen word goes should find it here.
    const hyphens = word.split("-").length - 1;
    if (hyphens > 1) continue;
    if (hyphens === 1) splits.push(word);
  }
  const split: SplitWord[] = [];
  const seen = new Set<string>();
  for (const s of splits) {
    const key = s.replace("-", "").toLowerCase();
    const joined = whole.get(key);
    if (joined === undefined) continue;
    const dedupe = s.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    split.push({ split: s, joined });
  }
  return { words, split };
}

// The contradictions alone, which is what the page step and the recheck both want. The thin wrapper
// `duplicateIds` is over `idAudit`, and here for the same reason: a call site that reads a list is
// clearer than one that reads a field off a pair it does not otherwise use.
export function splitWordContradictions(html: string): SplitWord[] {
  return splitWordAudit(html).split;
}

// What the correction pass is asked to do about one, in the shape `missingLinkProblem` and
// `genericAltProblem` use: the exact defect, the exact repair, appended to the Feedback Agent's own
// problems and sent back with the source image.
//
// It does NOT say which spelling to keep, and that is the part to preserve through any rewording.
// Iris knows the page contradicts itself and cannot know which way the printing goes — #334 has
// `non-tax` and `Agri-culture` as the same shape with opposite answers — so a request naming the
// winner would be Iris guessing at a fact the image settles, which is exactly what `page.md:131`
// already tells the model how to decide.
//
// That is not a symmetry argued for tidiness. On #334's six self-contradictions from the shipped
// model, THREE are forms a 1962 report genuinely prints — `inter-state` (p020) and `non-farm`
// (p076, p078) — where the hyphenated spelling is the right one and the JOINED one is the defect.
// So "join them" would have been the wrong instruction on half of the measured cases, and an
// instruction to join is also how a page that legitimately prints both forms acquires a defect it
// did not have.
//
// The last sentence is the licence to disagree, in the wording `correctPage` establishes for it,
// because this problem has a real refusal case and the alternative is a model repairing a faithful
// transcription. A decline here is a legitimate answer and is counted as one.
export function splitWordProblem(w: SplitWord): string {
  return (
    `This page writes one word two ways: "${w.split}" in one place and "${w.joined}" in another. ` +
    `One of them is wrong whichever way the page prints it, and the likeliest cause is a word the ` +
    `printing broke at the end of a line being carried into the markup with its hyphen. Check both ` +
    `against the source image and make them agree with what the page shows — keep the hyphen if the ` +
    `word itself owns one, drop it if it was only there to break the line. If the page really does ` +
    `print both spellings, say so and change nothing. Change nothing else about the page.`
  );
}

// One word joined in code, and the two things that licensed it.
export interface JoinedWord {
  // The broken spelling as it stood, hyphen included, so a reader can find it in `fragments.json`.
  split: string;
  // What replaced it: the same string with the hyphen deleted, ITS OWN case kept. Not the evidence
  // spelling — `Govern-ment` heading a table column becomes `Government` and not the `government`
  // that corroborated it, because deleting a line-break hyphen is the whole of the repair and
  // adopting the other occurrence's case would be a second, unlicensed change.
  written: string;
  // The unhyphenated occurrence elsewhere in the document that made this decidable, as that place
  // writes it. This is the auditable half: a reader checking the log is asking whether the document
  // really contains it.
  evidence: string;
}

// Comments, tags, and the contents of the elements whose text is not prose. A rewrite has to know
// where the markup is in a way a comparison does not: `textOf` can flatten a tag to a space because it
// only reads, while this puts characters back and must not put them inside an `href` or a `<script>`.
//
// `pre` and `code` are here and not in `textOf`, which is the one asymmetry in this file. A hyphen in a
// code listing is a flag or an identifier and normalising it changes something a reader has to be able
// to copy, so the WRITE side must not enter one; the READ side is shared with
// `splitWordContradictions`, and narrowing it would quietly change what that check has always
// compared. The cost of the asymmetry is that a `foobar` inside a listing can still corroborate a
// `foo-bar` in prose, which is the same reading the existing check already has.
const MARKUP = /<!--[\s\S]*?(?:-->|$)|<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const OPENS_OPAQUE = /^<(script|style|pre|code)\b/i;
const CLOSES_OPAQUE = /^<\/(script|style|pre|code)\b/i;

// The two elements whose text the document does not SHOW, dropped from the evidence index — a class name
// in a `<style>` block or an identifier in a `<script>` is author metadata, and `evidence` in the log line
// has to name something a reader spot-checking it can find on the page. `pre` and `code` are deliberately
// not here: a listing is text the document shows, so a `foobar` in one is a spelling it prints. `textOf`
// itself is unchanged, because it is shared with `splitWordContradictions` and narrowing it would quietly
// change what that check has always compared. Zero joins on the 1,221-file corpus turn on this.
//
// Running to end-of-input when the closing tag never comes, on `COMMENT`'s `(?:-->|$)` reasoning and the
// `walk` below's: an unterminated `<style>` already makes every following character opaque to the WRITE
// side, so letting its selectors into the evidence index is the one combination that would license a join
// on text nothing shows. It swallows the rest of the DOCUMENT here and the rest of one PAGE there, which
// is a divergence in the conservative direction on both sides — fewer joins, never more.
const NOT_SHOWN = /<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
// Quoted and `name=value` text out of the markup — attribute VALUES, and see the comment note below —
// for the guard and never for the evidence. `alt` is prose a screen reader
// speaks, so a bare `state` living only there is still the document using the word — and a guard that
// cannot see it closes up `inter-state`, which is the one outcome the tail condition exists to prevent.
// Values and not attribute NAMES: a value is text somebody wrote, `colspan` is markup. Also zero cost on
// that corpus, measured, which is why it is a fix rather than a documented limit.
//
// Three quotings, because a guard has to be blind to nothing it could refuse on: double, single, and
// UNQUOTED. The third is the one worth stating — HTML allows `<td class=state>`, `MARKUP` matches such a
// tag perfectly well, and a guard that read only the quoted two would let `inter-state` through on exactly
// the failure the other two exist to stop. The unquoted alternative stops at whitespace and at the four
// characters HTML5 forbids in a bare value, so it cannot run past its own attribute or into the `>`.
//
// COMMENTS are in this width too, which the name of this function does not suggest and is deliberate.
// `MARKUP` matches `<!--…-->` as well as a tag, so a quoted span or a `name=value` run inside a comment
// lands in the guard — `<!-- @source "state" -->` refuses `inter-state`, where the same word as bare
// comment prose does not, since the unquoted alternative needs its `=`. Kept rather than tidied, on two
// grounds, and neither is that the input is dead: the `@` markers a delivered document carries are
// appended by `wrapDocument` AFTER this pass, so the only comment that reaches the guard is one a model
// wrote into a page fragment, which no prompt asks for and nothing strips. Rare, not impossible.
//
// The founding decision at the top of this file is that a model's `@` marker quotes the page's
// words freely, and a word it quotes may well be one the printing uses alone, so seeing it is the
// conservative reading — and the guard's only failure is not seeing a word. And it is free: excluding
// comments from this scan moves nothing on the 1,221-file corpus, 29 joins and 18 distinct words either
// way, so the tidier version would be a behaviour change bought with no measurement. The ragged edge
// (quoted yes, bare no) is therefore pinned by a test rather than smoothed, because smoothing it means
// widening the guard further on no evidence.
//
// Entity-decoded by the CALLER, not here, and the difference matters in one direction: an `alt` reading
// `st&#97;te` has to put `state` in the guard, or a numerically spelled tail word is a hole in exactly the
// blindness this function was added to close. Left to the caller because `textOf` already decodes AFTER
// stripping tags for a reason of its own, and this output has no tags to strip.
function attributeText(html: string): string {
  let out = "";
  for (const [tag] of html.matchAll(MARKUP)) {
    for (const m of tag.matchAll(/"([^"]*)"|'([^']*)'|=\s*([^\s"'=<>`]+)/g)) out += ` ${m[1] ?? m[2] ?? m[3] ?? ""}`;
  }
  return out;
}

// #334's remaining hyphen axis: a word the printing broke at a line end, carried into the markup with
// its hyphen, where the page it landed on never writes the word whole. `splitWordContradictions` is
// blind to it by construction — its evidence is one page's own two spellings — and the comment at the
// top of this file dismisses the alternative it considered, another ARM's output, as unavailable at run
// time with one arm running. It never considered another PAGE of the same submission, which IS
// available, and where the whole spelling usually is: measured over the 1,221 page files on disk,
// 42 (word, submission) cases — 20 distinct words — have their joined form on a different page of
// their own submission and nowhere on the page that broke them. Hand-reading all 42 puts 26 at a line
// break, 13 at a compound joint the printing owns, and 3 in the model's own map prose. The 42 is the
// mechanical count and the 26 is a reading of it; neither substitutes for the other.
//
// So this is a REPAIR where part B is a re-ask, which overturns a decision this file argues for above
// — that Iris cannot know which of two spellings the page carries, and only the agent holding the
// image can. That argument is right about a bare contradiction and wrong about the case below, and the
// difference is one condition. A hyphen the word owns is a COMPOUND JOINT, and a compound joins words;
// so a hyphen whose right-hand fragment is not a word the document prints on its own cannot be one,
// whatever the image shows. `ment`, `laneous`, `vidual` and `facturing` are not words. `state`,
// `farm`, `tax`, `east` and `property` are — which is why `inter-state`, `non-farm`, `non-tax`,
// `Mid-east` and `Non-property` are left exactly where part B leaves them, as questions for the model.
//
// THREE conditions, not two, and the third is what keeps this pass off part B's ground: the closed
// spelling must not be on the page that carries the hyphen. Where it is, part B raises it, the page
// agent answers it holding the image, and `splitWordProblem` explicitly licenses the answer "the page
// really does print both spellings" — so joining it here would reverse an answer made with the page in
// view, from a pass that never saw it. That is not a theoretical collision. Without this condition, 7
// of the 36 joins on the corpus below are words part B also raised on a page that carries them.
//
// Run over those same files as assembly runs it — this function, on each submission's pages — it joins
// 29 cases (18 distinct words) across 8 of the 75 submissions, and leaves 44 cases (10 distinct)
// hyphenated while a closed spelling of them sits somewhere in the same submission. Those 44 are what
// the second and third conditions buy, and they include the two this file already records as printings
// where the JOINED spelling is the defect. One word lands on both sides, for the second reason below
// and only there.
//
// All three conditions are needed and each stops a different failure. Without corroboration,
// `ad-valorem` is a break whose `valorem` is no word and whose `advalorem` no document prints, and it
// would be joined into a spelling from nowhere. Without the tail condition, every legitimate compound
// whose document also prints the closed form gets closed. Without the page condition, the pass
// overrides the model on the one shape the model was already asked about.
//
// Five known imperfections, all accepted, because the alternative to naming them is finding them later.
// The first three are measured on the corpus; the last two are reasoned and have zero instances in it,
// which is a fact about the corpus and not about the rule:
//
//  * a spelling the MODEL wrote rather than the page. `Cross-hatch` beside `crosshatch` in a map
//    description is one voice being inconsistent with itself, not a transcription defect, and no image
//    settles it because neither spelling is printed. 3 of the 29 joins on those files are this, all in
//    map prose, and joining them changes a description's spelling and no claim about a page.
//  * a garbled page can put the tail in the dictionary and switch the condition off. On the rotated
//    arm, `vidual` appears as a standalone token, so `Indi-vidual` is left alone there while the same
//    word is joined on every straight arm. That is the conservative direction, and it is the
//    direction to fail in.
//  * skipping markup means a word can end up joined in prose and still hyphenated in an `alt`, because
//    the rewrite below only walks the text between tags. That is not hypothetical: on one measured arm
//    `Cross-hatch` occurs eight times, three in body text and five inside long `alt` descriptions, and
//    only the three move. The alternative is rewriting attribute values, which is how a repair reaches
//    an `href`, so the mismatch is the price. An attribute value is therefore READ by the tail guard and
//    never WRITTEN by the rewrite, which is the asymmetry the two indexes below exist for: a word in an
//    `alt` is enough to refuse a join and never enough to license one. Nothing downstream reads the
//    leftover as a new defect either — `textOf` drops attributes, so the contradiction check above cannot
//    see the `alt` copy in the first place. One attribute makes that mismatch a WCAG failure rather than
//    an inconsistency: a visible
//    label joined beside an `aria-label` or `title` that keeps its hyphen no longer has its visible text
//    contained in its accessible name (2.5.3), and no gate here catches it, because axe's
//    `label-content-name-mismatch` is experimental and outside `runOnly` (lint.ts). It is latent rather
//    than live: `agents/page.md` tells the model not to put printed text in an `aria-label` at all.
//  * the tail condition does not reach a PREFIX compound whose stem the document never uses alone.
//    `pre-empt` beside `preempt`, `co-ordination` beside `coordination`, `non-existent` beside
//    `nonexistent`: `empt`, `ordination` and `existent` are the stems, a printing may hyphenate all
//    three by house style, and the argument above — a compound joins words — is what stops holding,
//    because a prefix is not a word. Where both spellings are on one page the page condition catches it;
//    across pages, an inconsistently hyphenated document loses the hyphen. Zero instances in the 1,221
//    files: every word joined there is a broken word and every prefix compound in them (`inter-state`,
//    `non-farm`, `non-tax`, `Mid-east`, `Non-property`) has a stem the document does print alone. A
//    closed prefix list was the obvious remedy and is refused: `con-`, `dis-`, `trans-` and `cross-`
//    would be on it, and `con-struction`, `dis-tributed`, `trans-portation` and `cross-hatch` are real
//    breaks it would lose.
//  * a word the PROSE JOIN made whole across a page seam is judged against the page it landed on. Before
//    that join it was `Simi-` and `larly` in two pages and `WORD` matched neither as hyphenated, so part
//    B never saw it and cannot have answered it — yet if the landing page also prints the word whole,
//    the page condition declines anyway. Over-conservative for that one shape, and it leaves a hyphen
//    rather than removing a real one.
//
// Order-independent, which is what makes it belong at assembly rather than in the page loop:
// `runExtraction` documents pages as fully independent and forbids relying on completion order, so a
// dictionary built from the pages that happen to have finished would give a different document run to
// run. This one is built from the whole assembled body.
export function joinBrokenWords(pages: string[]): { pages: string[]; joined: JoinedWord[] } {
  const document = pages.join("\n\n");
  // Two indexes over the same document, at two widths, because the two questions they answer fail in
  // opposite directions. Evidence LICENSES a join, so it is the narrow one: only what the document shows.
  // The tail GUARD refuses one, so it is the wide one: anything that might be a word, wherever it sits.
  // A word missing from the first leaves a hyphen; a word missing from the second closes a compound the
  // printing owns, which is what the second condition exists to prevent, so the two cannot share a width.
  const whole = wholeWords(textOf(document.replace(NOT_SHOWN, " ")));
  // `decodeEntities` on the attribute text rather than `textOf`, so `alt="st&#97;te"` puts `state` in the
  // guard: the read side decodes on purpose, and a guard that did not would leave a numerically spelled
  // tail word as a hole in the blindness it was added to close. Not `textOf(document + attributeText(…))`,
  // which is the shorter spelling of the same fix and a worse one — a value containing a `<` would then be
  // read as a tag opening and take the words after it out of the guard, which is the direction that closes
  // a compound the printing owns.
  const guard = wholeWords(textOf(document) + decodeEntities(attributeText(document)));
  const joined: JoinedWord[] = [];
  const seen = new Set<string>();
  // A word spelled with an entity hyphen (`Govern&#45;ment`) is not a `WORD` match at all, so it is
  // read as evidence by nobody and rewritten by nobody. Under-detection, in the direction the rest of
  // this file already takes: the repair below only ever deletes a literal `-`.
  const rewriter =
    (own: Map<string, string>) =>
    (text: string): string =>
      text.replace(WORD, (word) => {
        if (word.split("-").length - 1 !== 1) return word;
        const tail = word.slice(word.indexOf("-") + 1);
        const closed = word.replace("-", "").toLowerCase();
        // The page settles it itself, so it is part B's and not this pass's. Declining here is the whole
        // of what keeps the two from colliding: `splitWordContradictions` raises exactly this shape, the
        // page agent answers it holding the image, and `splitWordProblem` gives it an explicit licence
        // to answer "the page really does print both spellings" and change nothing. Joining it here
        // would reverse that answer from a pass that never saw the page.
        //
        // `own` is a THIRD width and neither of the other two: script and style content IN, attribute
        // values OUT, which is `splitWordContradictions`' width exactly (`wholeWords(textOf(page))`, at the
        // call below). That is not incidental and must not drift, because the condition's whole claim is
        // that it declines precisely the population part B raises. A closed spelling living only in an
        // `alt` on this page therefore does NOT trip it — correctly, since part B cannot see that `alt`
        // either, so nothing has been asked about the word and nothing is being reversed. Widening `own`
        // to the guard's width would leave those words answered by no pass at all.
        if (own.has(closed)) return word;
        const evidence = whole.get(closed);
        if (evidence === undefined) return word;
        if (guard.has(tail.toLowerCase())) return word;
        const written = word.replace("-", "");
        // One entry per word, not per occurrence, on `splitWordAudit`'s reasoning: a document that broke
        // `Compos-ite` in four cells had one spelling settled, and all four are rewritten either way.
        // Per DOCUMENT rather than per page, so a word joined on one page and declined on another —
        // which the rule above makes possible — reports the join and says nothing about the decline.
        if (!seen.has(word.toLowerCase())) {
          seen.add(word.toLowerCase());
          joined.push({ split: word, written, evidence });
        }
        return written;
      });

  const walk = (html: string, rewrite: (text: string) => string): string => {
    // A text run up to the first `<` that began no tag. `MARKUP`'s attribute alternatives both need a
    // closing quote, so an unterminated one leaves its whole start tag unmatched and the run reaching
    // the NEXT tag would otherwise be rewritten as prose — putting the repair inside the attribute the
    // quote never closed. Stopping at the `<` costs a join in prose containing a bare `<`, which is the
    // direction to lose in and the only reading under which "in text and nowhere else" is true.
    const prose = (text: string): string => {
      const cut = text.indexOf("<");
      return cut === -1 ? rewrite(text) : rewrite(text.slice(0, cut)) + text.slice(cut);
    };
    let out = "";
    let at = 0;
    let opaque = 0;
    for (const m of html.matchAll(MARKUP)) {
      const before = html.slice(at, m.index);
      out += opaque > 0 ? before : prose(before);
      out += m[0];
      at = m.index + m[0].length;
      if (OPENS_OPAQUE.test(m[0])) opaque += 1;
      else if (CLOSES_OPAQUE.test(m[0]) && opaque > 0) opaque -= 1;
    }
    const tail = html.slice(at);
    return out + (opaque > 0 ? tail : prose(tail));
  };

  return { pages: pages.map((page) => walk(page, rewriter(wholeWords(textOf(page))))), joined };
}
