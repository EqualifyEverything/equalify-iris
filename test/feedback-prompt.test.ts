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
    // Round 2 of #393: this shield was scoped to the legend, and #393 asks the page for a THIRD thing
    // the page prints nowhere — a list or table of places under the bands' printed wording, named as
    // the better home for the mapping. That list is neither "the term of the legend" nor "a count of
    // the key's entries", so nothing sanctioned it, and the paragraph below only ASKS for it, which is
    // precisely what failed before: prd.md §7.4 v1.10 records the verifier refusing a described <dd>
    // as invented text and the compliant correction DELETING it, making the only three serious
    // accessibility violations in that arm's output. That is why the shield was written as an explicit
    // "do not send it back AS INVENTED TEXT" rather than left to be inferred, and the new home needs
    // the same words. The wording matches the ask below verbatim so the two are found together.
    ["a list of places under the bands' printed wording is sanctioned by name, not by implication",
      /so is a LIST OR TABLE of the places under the bands' own printed wording, wherever the fragment carries one: no place-to-band mapping is printed anywhere on such a page — reading it off the ink is the whole job — so that list is the contract's answer and not text of the model's own/],
    // And the shield stays a shield rather than becoming a pass: transcription is what is protected,
    // correctness is not. Unbounded, "that list is the contract's answer" reads as licence to leave a
    // place in the wrong band, which is the defect the whole rule exists to catch.
    ["with all three sanctioned as transcription and none of them as correct",
      /Each of these three is sanctioned as the TRANSCRIPTION it is, and none of them is sanctioned as CORRECT: a shade named wrongly, a count that does not match the swatches, a place put in a band it is not in are all real problems below/],
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
    // #372's trap, and the reason the page.md half of this fix could not ship alone. This prompt is
    // the only thing that refuses a map page: the page agent's rules are not shown to the verifier,
    // so an obligation written only there is an obligation nothing enforces. Measured: acceptance of
    // map pages that classify nothing was 46.2% before the graphical-key rule existed and 0.0% after,
    // and none of that movement came from anyone asking for the mapping — on 6 of 8 plates the
    // refusal cites the key rule and on two it is the ONLY thing refusing them. So a key rule that
    // models finally satisfy would hand those pages a pass with the shading still missing, a
    // regression wearing a compliance fix's clothes. Verified off a delivered page rather than the
    // refusal strings: `runs-maps-95ca64c-r1`'s luna `acir-p077` ships an alt that names 49 places,
    // no key element at all, and ends "The map uses dark, medium, and light shading to distinguish
    // the three ratio categories."
    // Both qualifiers were absent from the first revision and both were wrong to omit, which review
    // round 1 of #393 filed as two separate notes. WIDER THAN ITS OBLIGATION: the page contract owes
    // a place-to-band mapping for a shaded MAP, while the rule this paragraph joins covers "the
    // fills of a cartogram, the hatchings of a chart" too — so a hatched chart described faithfully
    // and enumerating nothing matched the trigger with no page-side obligation behind it, and the
    // repair the clause asks for does not exist on that figure. AND IT REFUSED ITS OWN ANSWER: the
    // page contract now requires the indistinguishable-bands declaration "whether or not you place a
    // single item", so the correct answer on the hardest plates IS a key transcribed with nothing
    // placed. The escape was carried only by the hedge paragraph above and by "neither of them is
    // what you were sent" ten lines later, not by the sentence that names the kind — and this change
    // is what makes that answer common, so a false `content_missing` was the expensive direction.
    ["a key transcribed with nothing placed and no declaration is missing content",
      /a description of a shaded MAP that transcribes the key, places nothing, and does not say the bands cannot be told apart is missing the picture — the one failure on these pages you can settle without reading any ink at all/],
    ["with both qualifiers named as load-bearing, so neither reads as decoration",
      /Both halves of that sentence are load-bearing: it is a map, because a map has places for its bands to sort and a hatched bar chart or a fills key on a diagram has no such list to give, and it is silence, because a page that DECLARES its bands indistinguishable has answered this rule and placing nothing is exactly what answering it looks like/],
    ["and the non-answer is described by what it does, not by its wording",
      /says only that the map distinguishes its categories by shading has described the key and not the map: it states that a mapping was drawn without saying what it was/],
    ["and what a map's ink carries is stated, so the kind is not left to the trigger alone",
      /What a map's ink carries is which places fall in which band/],
    ["with the kind, the quote and the two answers the contract allows",
      /Report it as "content_missing", quote the sentence standing in for the mapping, and ask for either the places under the bands' own printed wording or the declaration that the bands cannot be told apart/],
    // #373 is the other half of this page and is deliberately not answered here: the checker
    // supplying the state-to-category assignment was wrong a third of the time it did it, and one
    // false assignment was obeyed into the delivered document. Asking for the mapping and supplying
    // the mapping are one sentence apart, so the prohibition travels with the ask.
    ["and the verifier names no place and no band of its own",
      /Name no place and no band yourself, for the reason any problem that supplies the reading is out of bounds: the assignment is the picture's, and a checker that supplies one hands the delivered page a band nobody read off the image/],
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
// 0 of 6 New England and 0 of 6 Mideast jurisdictions in its highest band — eleven of those twelve in
// the second-lowest and Massachusetts in the middle one — with the South passing as a control at 6 of
// 6 in the lightest. The paid verify pass
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
    // Both directions, because the page carried both: the "highest" claim was the one contradicted
    // and the "lowest" claim was the control that passed. Stated for one only, the inverted case is a
    // generalisation the model has to make on its own.
    ["a region called highest with no member in the highest band is the finding, with its kind",
      /a region the page calls highest with NOT ONE of its members in the highest band the HTML describes — or one it calls lowest with not one of them in the lowest band — contradicts the page's own words, and that is "content_wrong"/],
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

// #349. `agents/page.md` asks for the "log" field by name in 26 places, and for six kinds of
// obligation it asks for a log entry — a page ending mid-sentence, an orphan heading, an unkeyed
// symbol, a placeholder image source, a language change, an irregular table. The verifier judging the
// page against that contract was never shown the field, so it could only ignore those rules or hunt
// for their evidence in the HTML: across 311 verify replies in two bench rounds, 35 problems on 26
// replies demanded something of the log, and 26 of the 35 were about a log that existed and was not
// shown. `verifyAgentOutput` now quotes it (test/page-log-to-verifier.test.ts pins the carrying,
// including that a recheck is sent none).
//
// **Only TWO of the six are log-only, and the first draft of this clause said all six were.** The
// other four have an HTML half that is the load-bearing one — `[page not fully transcribed]` as the
// last content emitted (`page.md:49-51` calls the marker "the part that matters", because "log" is
// not delivered as the document), a placeholder `src` naming the page and the graphic (`:313`), `lang`
// on the element that changes language (`:602`), a reader-checkable note on an irregular sequence
// (`:513`). Telling the verifier the OBLIGATION is discharged by the log suppresses exactly those
// four in the HTML, on pages whose log admits them — so a truncated page whose log says where it
// stopped would ship without the marker `test/e2e.sh` §9i requires, and a Korean page whose log names
// its languages would ship declared English. The clause now discharges the RECORD and hands the log
// back as evidence FOR reading the HTML half, which is why the pins below are split in two.
//
// This pins what the prompt does with it, and the prohibition is the half that pays. Showing the
// field without a rule invites MORE log-directed demands, and every one of them is unsatisfiable by
// construction: `correctPage` is handed the problem strings and parsed for `html` alone, so "the log
// does not note X" spends the page's only licence on a field the repair cannot write.
test("the verify task reads a quoted log as evidence and never makes it the subject", () => {
  for (const [what, re] of [
    ["a quoted log is the transcriber's own account, to be checked rather than trusted",
      /that is the transcriber's account of its own work on this page, and it is evidence rather than a second source: check it against the image, the way you check the HTML/],
    ["a record the contract asks for in the log and nowhere else is made there",
      /A record the contract asks for in the\s+log AND NOWHERE ELSE is made there/],
    // The two that really are log-only, named — the general rule is the one the verifier applies to
    // the HTML, and these are the two cases where the evidence is nowhere else to be found.
    ["with the two log-only records named",
      /a heading the page gives nothing to place it\s+under, a symbol the page never keys/],
    ["and what it costs to report one of them as unrecorded",
      /where the log carries one of those, it is\s+carried, and reporting it as unrecorded is a false finding/],
    // And the four with an HTML half, each named with the half the DOCUMENT owes — the whole point of
    // the split. A verifier told the log discharges these stops checking the marker and the `lang`.
    ["the four with an HTML half say the document's half is still the verifier's",
      /the contract asks\s+something of the DOCUMENT as well, and that half is still yours to check/],
    ["with each document-side obligation named",
      /\[page not fully transcribed\] as the last thing it emits, a\s+placeholder src also names the page and the graphic, a change of language also\s+carries lang on the element that holds it, an irregular list or table also carries a\s+note a reader can check/],
    // The inversion that makes the change earn its cost rather than just not regress: an admission in
    // the log is EVIDENCE the HTML half is owed, so it turns a silent loss into a `content_missing`.
    ["and the log is evidence FOR that reading, not a discharge of it",
      /is not the discharge of those rules but your\s+evidence for reading them: where the log admits one and the HTML does not carry its\s+half, the reader loses it, and it is a problem like any other/],
    // Named because it is the one of the four with a downstream gate on it: `test/e2e.sh` §9i treats
    // the marker as the thing that must survive the review loop.
    ["with the marker singled out, in page.md's own words",
      /the marker most of\s+all, because a page that stops without one reads as complete to every reader/],
    // Review round 2, non-blocking. The four dual obligations do NOT share one `kind`: the taxonomy at
    // :157 puts a WCAG requirement unmet over faithful content in `a11y_only`, and :160's
    // earliest-in-list tiebreak cannot rescue a missing `lang` into `content_missing`, because nothing
    // is absent. `kind` gates nothing today (extraction.ts records the kind-gated fail as deliberately
    // unimplemented) — but it is the count #349's own §7.4 argument is measured in, and it becomes a
    // behaviour difference the day that gate is priced off these counts.
    ["the four are tagged by what the reader loses and not all as content_missing",
      /Tag it by what\s+the reader loses, the way you tag everything else/],
    ["with the content-side two named",
      /a missing marker and a missing\s+note about an irregular sequence are "content_missing"/],
    ["with the language case as a11y_only",
      /a language the log names that no lang\s+attribute marks is "a11y_only"/],
    // Review round 3, non-blocking, and the tag it corrects was mine rather than round 2's. `a11y_only`
    // is defined at :157 as a WCAG 2.2 AA requirement unmet, and an absent placeholder `src` is not
    // one: `page.md:313-314` puts the placeholder there "for whatever supplies the real asset", while
    // the reader is given the graphic by its alt text, which is present by hypothesis. So the fourth
    // obligation is `structure_wrong` — content all there, markup around it incomplete — which is also
    // where :160's earliest-in-list tiebreak would land it if both kinds were argued.
    ["and the placeholder src as structure_wrong rather than a11y_only",
      /a\s+graphic whose placeholder src the log records but the HTML does not carry is\s+"structure_wrong"/],
    // The other direction: a log that overstates what was done is not a licence to argue with the
    // log, it is evidence about the page — and the finding it supports is the ordinary one.
    ["a log the image refutes makes the missing content the problem, not the log",
      /the log is not the problem; the missing content is, and it is "content_missing" like any other/],
    ["the log is never the subject of a problem",
      /Never make the log itself the subject of a problem/],
    ["with the mechanism, so the rule is not read as a matter of taste",
      /The correction pass is handed your problem strings and the page and answers with HTML alone — it writes no log/],
    ["and what such a problem costs the page",
      /it spends the only licence you have over that page on a field the repair cannot touch/],
    // The absence case. 13.7% of pages reach the verifier from a reply that had no envelope and so
    // no log field at all, and "the agent recorded nothing" is a claim about the page that the
    // silence does not support.
    ["a message with no log quoted says nothing about the page",
      /where the user message quotes no log at all, the reply had none to quote: that is a fact about the reply and not about the page, so say nothing about it either way/],
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
//
// #373 directive 2: that unconditional half used to live INSIDE this paragraph, and being general in
// wording was not enough. It sat between two sentences conditioned on "where the user message tells
// you the page agent asked for a specialist it did not get", and on acir-p084 — where the checker
// supplied Colorado and Illinois into a below-average list, both measurably wrong, both shipped — NO
// arm requested a specialist. A reader taking the paragraph's opening condition as its scope reads
// the bound as scoped too. So the general rule is now its own paragraph keyed on the SHAPE of the
// problem, and this paragraph points at it rather than restating it: three restatements of one bound,
// each conditioned on something, is how a rule ends up binding on none of the pages that need it.
test("the verify task may hedge a reading it cannot support and may not replace it", () => {
  for (const [what, re] of [
    ["an unmet specialist request is read as the agent doubting its own work",
      /Where the user message tells you the page agent asked for a specialist it did not get, that is the agent saying it could not do this content reliably/],
    // The narrowed licence now POINTS at the general rule instead of carrying its own copy. Pinning
    // the pointer is the point: a restatement here is what the fix removed.
    ["with the narrowed licence pointing at the general bound rather than restating it",
      /your licence over what it produced for that content is narrower than usual: the bound on supplying the reading applies as it always does/],
    ["and the reason such a page is worth naming at all",
      /the model has already told you where its own reading is weakest, for nothing/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// #373 directive 2, the hoisted rule itself. Measured: 9 supplied category assignments in 40 map
// cells, 3 measurably wrong, 2 measurably RIGHT, 4 unmeasurable — and the 2 right ones are why the
// bound is keyed on the shape of the problem rather than on whether the checker turned out to be
// correct. On acir-p084 a first read named 4 below-average states and was right on all 4; the checker
// demanded Illinois and Colorado (median 178/sd 10.5 and 169/sd 7.9, both flat base map, both ~10x
// below the texture cut), the correction obeyed, and that six-state sentence is the delivered
// document. The clause it violated existed and was correct — it was reachable only through a
// condition that page did not meet.
test("the verify task bounds a supplied reading by the shape of the problem, not the page's history", () => {
  for (const [what, re] of [
    ["the bound is keyed on the shape of the problem",
      /A PROBLEM THAT SUPPLIES THE READING IS OUT OF BOUNDS, and what puts it out of bounds is the SHAPE of the problem rather than anything about the page it is written on/],
    // The shapes enumerated, because "supplies a reading" is the abstraction the p084 problem would
    // not have recognised itself in: it named states and a fill pattern, nothing about "readings".
    ["with the shapes that count as supplying one enumerated",
      /a problem that names that part and states the category, band or term it belongs in has supplied a reading of the picture/],
    // Scoped to what the ink leaves open, because the unscoped version reached content_wrong's own
    // definition — "a value in the wrong cell" IS a problem naming a cell and stating its value.
    ["scoped to what the printed characters do not settle",
      /Where what a part of the picture MEANS is not settled by characters the page prints — which category a place falls in, which band a region runs in, which term a swatch of ink stands for/],
    ["and what may be said instead",
      /Say the reading is unsupported and ask for it to be hedged, scoped, re-read or removed, and name no members of your own/],
    // Round 1 of #394: the bound as first written told a checker reading legible digits to stop
    // naming the cell it can plainly read, i.e. suppressed the strongest fidelity finding there is
    // on a scanned table. The carve-out is stated with an example, and states the tag.
    ["with transcription carved out by name, so a misread number is still named exactly",
      /THAT BOUND IS ON WHAT THE INK LEAVES OPEN AND NEVER ON WHAT THE PAGE PRINTS, so it does not silence a character you can read/],
    ["with the carve-out's worked case and its kind",
      /where the image shows 1,234 and the HTML says 1,334, name the cell and name the number, because that is the transcription being wrong rather than a reading being supplied — it is "content_wrong"/],
    ["and the other transcription shapes it reaches",
      /The same for a misread word, a value standing in the wrong cell, and a row's figures out of order/],
    ["with the mechanism, so it is not read as caution for its own sake",
      /a problem is an instruction the correction obeys literally, so asserting what part of a picture means when you cannot support it writes your guess into the delivered document as a fact/],
    // The 2-of-9 correct assignments are the case this sentence is for. Without it the rule reads as
    // "do not guess", which a checker confident of its reading does not think it is doing.
    ["and being right is not a defence, because nothing downstream can tell which was which",
      /a reading you supplied is not made safer by being right, because neither the correction nor any pass after it can tell which of your readings were which/],
    // The three pages the census actually turned on: p084 requested no specialist, its problems made
    // no regional claim, and it is a choropleth whose key the read did transcribe. Every existing
    // statement of the bound was reachable only by a door that page did not open.
    ["it binds on the pages none of the narrower statements reach",
      /It binds on a page that asked for no specialist, on a page whose caption makes no claim about any region, and on a page with no key to transcribe/],
    // Named by mechanism rather than by position: a prompt cross-reference that says "above" or
    // "below" is wrong as soon as anything moves, and this rule now has three dependents.
    ["with the three narrower statements named as instances of it, by what they are about",
      /the one about a key's swatches, the one about a region the caption calls highest or lowest, and the one about a page whose request for a specialist went unmet — are this same bound in the places it bites hardest, and none of them is its whole extent/],
    // And each of the two that remain in place carries the phrase, so a grep for the rule finds every
    // site that depends on it.
    ["and the key clause defers to it by name",
      /Name no place and no band yourself, for the reason any problem that supplies the reading is out of bounds/],
    ["and the region clause does too",
      /a problem naming the place and its band supplies the reading, and is out of bounds here for the reason it is out of bounds anywhere/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// #373 directive 1, and it changed shape between the issue being filed and this fix. The issue found
// feedback.md SILENT on the page-edge case (`git cat-file -p 883480a | grep -c 'not fully
// transcribed|cut off|page edge'` returned 0) while the checker invented a rule requiring the marker
// "when a page is cut off" — 3 of 3 markers added in that round went onto pages transcribed IN FULL,
// each of whose first reply had already written the log entry page.md asks for. Since then #349's fix
// landed: the log IS now quoted to the checker (`log: logNote` at the first verify call in
// src/pipeline/extraction.ts), and the clause written to use it says a log saying "the page was cut"
// is evidence the marker is owed. So the invented rule became an INSTRUCTED one, and this directive
// stopped being an omission and became a contradiction with page.md, which is unambiguous: the marker
// is "where you could not return all of it", while "If content is cut off at a page edge, note it in
// the log field" — log and nothing else. The word "edge" appears nowhere in feedback.md except inside
// "hedge", so there was no carve-out to lean on.
test("the verify task tells the model's own shortfall from the paper's edge before demanding a marker", () => {
  for (const [what, re] of [
    ["the marker's trigger is the model's shortfall and never the paper's edge",
      /THE MARKER IS FOR THE MODEL'S SHORTFALL AND NEVER FOR THE PAPER'S EDGE, and the log is what tells you which of the two you are looking at/],
    ["with page.md's own definition of what the marker means",
      /\[page not fully transcribed\] means the reply could not return everything the page holds/],
    // The 3-of-3 shape, stated as the case it is: a page that ends mid-sentence because the sheet
    // ends is COMPLETE, so there is no `content_missing` to file at all.
    ["and the page that ends where the paper does is a page transcribed in full",
      /A page whose last printed line runs out mid-sentence because the SHEET ends there is a page transcribed in full, and the contract puts that in the log AND NOWHERE ELSE — no marker is owed, and there is nothing absent from the document to report/],
    // The exact artefact all three exhibits produced: the first reply HAD written the prescribed log
    // entry, and the checker read that entry as the evidence a marker was missing.
    ["with the discharged-log case named, because that log entry is what the checker read as evidence",
      /a log noting that the page ends mid-sentence and carries on onto the next sheet is a rule already discharged, exactly like the log-only records above, and asking for the marker on top of it asks the page to say something that is not true/],
    ["and silence is the answer where the log does not say the shortfall was the model's",
      /where it describes the paper's edge, or describes neither, report none: nothing in the page's contract asks for a marker because a page ended where the paper did/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// #373 directive 6 asked whether to forbid the marker request OUTRIGHT, on the grounds that the
// checker "cannot tell the two cases apart without the log field, and #349 found the log is withheld
// from it on every page". That premise no longer holds — the log reaches the first verify call — so
// the narrower prohibition above is what shipped instead of a blanket ban, and this pins the
// asymmetry that makes it a prohibition rather than a caution. Verified in code, not taken from the
// issue: src/pipeline/review.ts says a surviving marker "is what the quality tally counts as a
// document that could not have finished the review loop clean (SIGNAL_UNFINISHED_PAGE): READER_SYSTEM
// reports every one of them every round and says settling it is nobody's job in this loop."
test("the verify task is given the asymmetry that makes a false marker unrecoverable", () => {
  for (const [what, re] of [
    ["the asymmetry is why the bound is a prohibition rather than a caution",
      /The asymmetry is why that is a prohibition rather than a caution/],
    ["with what a wrongly requested marker costs, in the loop's own terms",
      /A marker this pass wrongly asks for cannot be taken back out by anything downstream — the review loop raises one every round and settling it is nobody's job there/],
    ["and what it reaches a reader as",
      /it reaches a reader as the source being unreadable when no pass that saw the source said so/],
    ["against what the other direction costs",
      /A marker you wrongly leave alone costs a log line/],
    // Round 1 of #394: the silence is scoped, because a reply that stops short AND writes no log is
    // the one page the marker rule now says nothing about. What a reader loses there is the content,
    // and that has always been reportable on its own terms — say so, or the silence reads as blanket.
    ["with the silence scoped to the marker, so a truncated page's missing content is still reported",
      /That silence covers the MARKER and nothing else\. Content the image holds and the HTML does not is missing whether or not any log admits it/],
    ["and the page that recorded nothing is named as the case that needs saying",
      /a reply that stops short without recording anything is exactly where you have to say so yourself: report what is absent as "content_missing", quote where the HTML stops, and let the marker alone/],
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
