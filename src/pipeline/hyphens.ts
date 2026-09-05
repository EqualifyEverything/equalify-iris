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

// A run of letters with at most one internal hyphen, plus the hyphen itself, so both halves of the
// comparison come out of one pass. Letters only: `\p{L}` excludes digits, which keeps a printed
// range (`1962-63`) and a table's `12-4` out of it, and excludes `_`, which keeps an identifier that
// leaked out of a code span from being read as a broken word.
//
// AT MOST one hyphen is a stated limit, and #334 names the cost by name: `Con-struc-tion` and
// `Trans-porta-tion` carry two breaks each on `p032`, and its first detector missed them for exactly
// this reason. Kept anyway on two grounds. One, neither of those words is written whole anywhere on
// its own page, so on that census admitting them adds nothing HERE — which is a fact about one
// corpus, not about the pattern, and is why this is a limit rather than a proof. Two, one hyphen is
// the shape of the common case (a line break splits a word in one place) and it is what keeps a
// printed compound out: `state-by-state` is skipped rather than compared against a `statebystate`
// nothing writes.
const WORD = /\p{L}+(?:-\p{L}+)?/gu;

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
export function splitWordAudit(html: string): { words: number; split: SplitWord[] } {
  const text = textOf(html);
  // The unhyphenated spellings this page uses, first-written form kept, keyed case-folded so
  // `Composite` at the start of a sentence answers for `composite`.
  //
  // Only unhyphenated words are evidence, so a page writing `Commu-nications` and
  // `communications-related` and never the bare word finds nothing here. That is the under-reporting
  // direction, and it is the one to take: the alternative is to read the parts of hyphenated words
  // as whole words, which makes every compound its own corroboration and turns `non-property` —
  // printed with the hyphen on all three of #334's arms — into a contradiction with itself.
  const whole = new Map<string, string>();
  const splits: string[] = [];
  let words = 0;
  for (const [word] of text.matchAll(WORD)) {
    words += 1;
    if (word.includes("-")) {
      splits.push(word);
      continue;
    }
    const key = word.toLowerCase();
    if (!whole.has(key)) whole.set(key, word);
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
