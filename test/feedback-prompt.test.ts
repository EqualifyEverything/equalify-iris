// `agents/feedback.md`'s TASK: verify is the pass that compares one agent's HTML against
// the source image, and `verifyAgentOutput` hands it the agent's whole contract to judge
// against (src/pipeline/feedback.ts embeds `agent.content` in the prompt). This pins the
// clause that says what to do when the two disagree — when the contract requires output
// that does not look like the page.
//
// The page agent has three such rules, and #145's page-break marker made the third the
// sharpest: `<hr role="doc-pagebreak" aria-label="Page 5">` puts the page's printed number
// in an attribute, placed at the head of the page whether the page prints it at the head or
// the foot. A verifier comparing text to image sees a number on the paper and no number in
// the HTML, which is a transcription miss by every rule it knows. Reporting it costs a
// `correctPage` call whose only way to satisfy the report is to break the page rule — and
// the resulting lesson can be banked and applied to later runs (see src/pipeline/memory.ts),
// so one such verdict does not stay one.
//
// Pinned rather than left to the wording because the clause is invisible in normal
// operation: nothing fails when it is dropped, the pipeline simply starts spending rounds
// arguing with itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const feedbackMd = readFileSync(join(repoRoot, "agents", "feedback.md"), "utf8");
const prompt = feedbackMd.replace(/\s+/g, " ");

test("the verify task judges HTML against the agent's contract, not the image alone", () => {
  for (const [what, re] of [
    ["the contract is a standard the HTML is judged by, alongside the image",
      /Judge the HTML against that contract as well as against the image/],
    // The three shapes named are the page agent's three, in the order they cost a round:
    // the page-break marker's placement, its number-in-an-attribute, and #110's symbol.
    ["the shapes that will not look like the page are named",
      /a marker it places by rule rather than where the page prints it, a number or name it asks for in an attribute instead of in text, a symbol it asks to be left out/],
    ["following the contract is not an infidelity, and the cost of saying it is is named",
      /following the contract is not an infidelity, and reporting it as one spends a correction round on undoing the rule/],
    // The inversion is the operative half: "missing" is defined against the contract, so a
    // verifier has a test it can apply rather than a list of exceptions to remember.
    ["what counts as missing is defined against the contract",
      /What is missing is what the contract asked for and the HTML does not have/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// #347: the general clause above was not enough for one case, so that case is named. On the nine
// legend-bearing figure pages of a 100-page corpus the extraction read the shading key correctly
// and the verifier talked it out of it — "invented text not present as a legend label" against a
// `<dd>` describing the ink, twice, and the compliant correction deleted the description. The
// three serious accessibility violations in that arm's whole output were all created by the repair
// rather than found by it, and the verify-and-correct pair was 63.7% of what those pages cost.
//
// It is the same shape as the page-break marker above — output the contract demands, read as
// infidelity — but it needed naming rather than deriving, because the contract's own first clause
// ("never supply an expansion the page does not state") appears to forbid exactly what its `<dl>`
// clause requires here. A verifier applying the general rule reaches the prohibition first.
//
// The hedge half is the more expensive one. On `acir-p077` the extraction wrote "none visibly
// distinct from medium in this reproduction", which measurement off the source image confirms is
// the correct answer — the page's two light bands are 33 luminance units apart under a 113-unit
// lighting vignette — and the verifier called it "factually wrong", named thirteen states as the
// lightest shade of which seven carry the darkest fill, and bought the correction that installed
// it. Nothing downstream can see this: the corrected page is well-formed, specific and false, and
// every automated gate passes it.
test("the verify task will not score a described swatch as invented, or overturn a stated hedge", () => {
  for (const [what, re] of [
    ["the case is named rather than left to the general clause",
      /A graphical key is where that goes wrong most expensively, so it is named here/],
    ["a description of the ink is the transcription, because the page prints no words for it",
      /the page prints no words for that half, so a description of the ink standing as the term of the legend IS the transcription the contract asks for and is not invented text/],
    // Bounded to the invention framing it is aimed at. Unqualified, "do not send it back for naming
    // a shade the page does not name" also covers a shade named WRONGLY — which on this corpus is
    // the commonest defect of all, since the page names none of the tones in words — so the literal
    // reading told the verifier to leave a mis-read tone standing. The clause below is what it is
    // for; that one is what it is not for.
    ["the prohibited report is bounded to the invention framing",
      /do not send it back AS INVENTED TEXT for naming a shade the page does not name/],
    ["a count of the key's entries in the same description is covered on the same terms",
      /A count of the key's entries carried in the same description is the contract too, on the same terms/],
    // The root cause on p077: both agents assumed the legend's tones ran in the order of its
    // labels. Measured, they do not — 26, then 176, then 143 — so the assumption was written into
    // the markup as fact by the extraction and enforced as fact by the verifier. Pinned with its
    // kind, because this rule's job is to make one report clearly available while another is
    // withdrawn, and a verifier told only what NOT to file files nothing.
    ["what the contract does not sanction is named, so a mis-read tone stays reportable",
      /What the contract does not sanction is the tone being read off the order of the labels beside the swatch rather than off the swatch, which is frequently not the order the shades run in — a wrongly named shade is a real problem, and it is "content_wrong"/],
    ["a stated uncertainty is the contract being followed, and is checked before it is contradicted",
      /that hedge is the contract being followed — check it against the image before contradicting it/],
    ["and is never replaced by a confident assignment the verifier cannot see well enough to make",
      /never replace a stated uncertainty with a confident assignment you cannot see well enough to make/],
    // Symmetry, and it is the half a shield alone would cost. Protecting a hedge without also
    // licensing a verifier that CAN see through it makes an unclassified item nearly unfalsifiable,
    // so it becomes the cheapest answer the page agent has and the gap ships. `prd.md` §7.4 v1.10
    // takes the trade knowingly in the other direction — a gap the page admits beats a confident
    // assignment to the wrong band — which is a reason to bound the shield, not to omit it.
    ["a hedge is falsifiable, and a verifier that can tell the shades apart says which",
      /A hedge is not unfalsifiable, though: where you CAN tell the two apart, say so and say which is which, because an item left unclassified is a gap in the delivered page and a hedge nobody checks is the cheapest wrong answer available/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// #353: the verifier had both strings in front of it and did not compare them. On a map of state
// income categories the fragment's <figcaption> transcribed the page's own subtitle — "Eight of the
// Twelve States That Shift…" — and the alt attribute ten lines above it enumerated 40 states as
// above-average. The verifier quoted the legend's labels verbatim in its own first problem, ratified
// the list, and then LENGTHENED it: its third problem asserted a state into the category, the
// correction obeyed, and the delivered page names 41. Measuring the sheet's three fills put the true
// partition at 8 and 4 with the rest base map, matching the printed arithmetic exactly — so the
// verifier's claim was false, and the caption it had already been given was enough to know that.
//
// Two things are pinned. The comparison, and its direction: a verifier that may ask for a list to be
// SHORTENED but never lengthened cannot buy this defect, whatever it thinks it sees in the ink.
test("the verify task compares an enumeration against a count the page prints", () => {
  for (const [what, re] of [
    ["the free check is named, and named as free",
      /A count the page prints about its own picture settles more than the picture does, and reading it needs no ink at all/],
    ["with the shapes such a count comes in, and what it is compared against",
      /where the HTML transcribes a number for the size of a category — a subtitle's "eight of the twelve states", a total row, an "of which" — and an alt attribute or a list in the same fragment enumerates that category's members, count them and compare the two/],
    // Which string wins, and why: one of them is transcription and the other is a reading. Without
    // this the verifier can as easily send back the caption.
    ["the page's own number is what the list is wrong against, and the kind is named",
      /Both strings are in front of you and one of them is the page's own, so a list whose length contradicts it is wrong, and it is "content_wrong"/],
    // The ordering matters because the ink is where this verifier is least reliable — four figure
    // pages graded, four wrong readings — and this check is decidable where the ink is not.
    ["the free check is ordered ahead of the ones that need the picture",
      /Make that comparison BEFORE you grade anything that turns on the ink, because it is free and it is decidable where the ink may not be/],
    // The asymmetry is the operative half: what shipped on p084 was not a missed check, it was a
    // problem string that added a member. A verifier that cannot take a list past the page's own
    // number cannot write this defect however wrong its reading of the picture is.
    //
    // Bounded at the count rather than at lengthening, and that bound is the whole of the rule.
    // "Never ask for it to be lengthened" also bars the one lengthening that is right — a list
    // that names nine where the page prints twelve is three members missing, which is a real
    // `content_missing` finding, and an unconditional ban leaves it with no repair path at all.
    ["the refusal is bounded at the printed count, not at lengthening",
      /never ask for such a list to be taken PAST the printed count: adding a member to a category the page itself caps is the one repair that cannot be right/],
    ["so a list short of the count stays reportable, with its kind and its bound",
      /A list that falls SHORT of the count is a different finding and a real one .* so report it, as "content_missing", and quote the printed number in the problem so the repair has the bound the page gives it/],
    // Without this the short-list licence reintroduces the defect by the other route: a verifier
    // that may ask for three more members and cannot read them names three anyway.
    ["and naming unreadable members to reach the number is refused as the same repair",
      /Where you cannot say which members are missing, say that the list is short of the count and leave it there; naming members to reach the number is the same wrong repair arriving by the other direction/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// #355, the same free check on the other axis. The count check above compares an enumeration's
// LENGTH against a size the page prints; this compares its MEMBERSHIP against a region the page
// names. On the same map, in the same fragment, the <figcaption> read "The South, in General, Has the
// Lowest Effective Rates; the New England and Mideastern States, the Highest" while the alt filed
// 0 of 6 New England and 0 of 6 Mideast jurisdictions in its highest band — all twelve of them in the
// second-lowest — with the South passing as a control at 6 of 6 in the lightest. The paid verify pass
// on that page cost $0.04529 (67.4% of the page) and made one edit, which the ink says was wrong;
// this comparison was available to it for nothing and it never made it.
test("the verify task compares a region the page names against the bands the HTML sorts into", () => {
  for (const [what, re] of [
    ["the free check is named, and named as free",
      /A claim the page makes in words about a whole REGION is checkable the same way and for the same nothing/],
    ["with the shape such a claim comes in, and what it is compared against",
      /where a <figcaption> or a sentence in the fragment says that a named group of places runs highest or lowest, and an alt attribute or a list sorts individual places into bands, compare the two/],
    // Pinned as a SET predicate, because the caption's own words are hedged — "in General" licenses
    // exceptions. A rule that fired on one member out of its region's band would fire on most
    // correct maps, and the finding here is not one member: it is nought of six, twice.
    ["what the sentence contradicts is the whole set, and one member is not a problem at all",
      /What such a sentence can contradict is the SET and not one member — it is a generalisation and leaves room for exceptions — so a single place out of step with its region is not a problem at all/],
    ["a region called highest with no member in the highest band is the finding, with its kind",
      /a region the page calls highest with NOT ONE of its members in the highest band the HTML describes contradicts the page's own words, and that is "content_wrong"/],
    // Ordered with the count check for the same reason the count check is ordered: this verifier's
    // ink readings are graded 5 wrong of 6 on the pages whose verdict turns on one, and both of
    // these checks are decidable without the picture at all.
    ["the free check is ordered ahead of the ones that need the picture",
      /Make this comparison with the count comparison above, before you grade anything that turns on the ink, because both are decidable where the ink may not be/],
    // The licence bound, which is the operative half. A regional generalisation says which region
    // runs high and never which place sits in which band, so the verifier has evidence that a
    // reading is wrong and no evidence of what is right — and a problem string is an instruction the
    // correction obeys literally. On this page the one thing the paid pass did buy was a state moved
    // between two mutually exclusive bands, into the only one the ink rules out.
    ["the problem quotes both strings and supplies no assignment of its own",
      /Quote both strings in the problem and stop there: the sentence says which region runs high and never which place sits in which band, so you may say the sorting is unsupported and ask for it to be hedged, scoped or re-read, and you may not supply the assignment yourself/],
    // And the bound that keeps the check from inventing work: which places a region covers is world
    // knowledge, not text in the fragment. Supplying that membership to make the comparison possible
    // manufactures the disagreement, and this verifier's guesses are what the whole rule distrusts.
    ["the check is refused where the region's membership is not on the page",
      /make no such report where you cannot say which places the named region covers — that membership is not on the page, and supplying it from your own knowledge to manufacture the comparison is how this check invents a problem instead of finding one/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// Also #353. The page agent can ask for a specialist (`suggested_agent`); `dispatchSpecialist` routes
// it and logs the outcome, and nothing else read it. In a 100-page round there were 7 such requests
// on 5 pages under 6 names, every one a map specialist, none resolved — and those 5 were every page
// in the round whose verdict turned on reading ink. On p084 the page agent asked for help producing
// "a structured data table of each state's classification", got the classification wrong, and the
// verify step then added a state to a category the page does not put it in.
//
// `specialistCaution` in src/pipeline/extraction.ts now carries the unmet request into the verify
// message (test/verify-specialist-caution.test.ts pins the carrying). This pins what the prompt does
// with it — and deliberately pins the UNCONDITIONAL half too, because the flag is not a detector: it
// is page-level rather than per-arm, it missed two of that round's hard pages, and a rule that only
// bites on a flagged page would leave the same defect free to ship on the pages it missed.
test("the verify task may hedge a reading it cannot support and may not replace it", () => {
  for (const [what, re] of [
    ["an unmet specialist request is read as the agent doubting its own work",
      /Where the user message tells you the page agent asked for a specialist it did not get, that is the agent saying it could not do this content reliably/],
    ["with both halves of the narrowed licence, the permitted one and the refused one",
      /you may say a reading is unsupported and ask for it to be hedged, scoped or removed, and you may not supply a replacement reading of your own/],
    // The generalisation, pinned separately: without it the clause reads as being about flagged
    // pages, and p092 and p095 turned on ink and drew no request at all.
    ["the bound holds on every page, not only the flagged ones",
      /That bound is not special to those pages/],
    ["and the mechanism, so it is not read as caution for its own sake",
      /a problem is an instruction the correction obeys literally, so asserting what a region of a picture means when you cannot support it writes your guess into the delivered document as a fact/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// Also #347, and the generalizable half of it. `correctPage` is told to resolve every problem and
// change nothing else, so each problem string is a licence — and the licence is shaped by the
// REASON, not only by the target. p093's third problem said a phrase in the markup was "invented
// text not present as a legend label". The phrase is the legend's own printed heading, set in two
// lines inside the legend box, and the correction deleted it. "This is a heading glued to the
// first label" would have licensed moving those words; "this text is not on the page" licenses
// only removing them. Same page, same words, opposite repairs, and the difference is entirely in
// the sentence the verifier chose.
test("the verify task states that a problem's reason is part of the licence it grants", () => {
  for (const [what, re] of [
    ["the reason is named as part of the licence rather than as commentary",
      /The REASON you give is part of that licence and not commentary on it/],
    ["with the two repairs a right finding can buy, contrasted",
      /"this heading sits at the wrong level" licenses moving it, while "this text is not on the page" licenses only deleting it/],
    ["and the consequence, so the rule is not read as a style note",
      /a right finding with a wrong reason buys the wrong repair. Say what you saw and where, not what you infer it means/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});
