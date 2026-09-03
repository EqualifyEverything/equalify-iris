// Leniently extract a JSON object from an LLM response: the whole text if it is already JSON,
// otherwise the LAST `{…}` span in it that can be read — strictly, or after one repair pass
// over the commonest way a model writes an object that is not quite JSON (see `repairedSpan`).
// Returns null if nothing parses, so callers can degrade gracefully rather than crash.
//
// The last, not the first, and it cost a page to learn: a model that reasons before it
// answers puts its answer at the END of its output. The reply this was written for is a
// 62,017-character correction that opens "I'll carefully re-read the image for all the
// flagged values…" and contains SEVEN complete envelopes. The first, at offset 33,748, is a
// 62-character scratch template the model wrote while thinking —
//
//   { "html": "...", "log": "...", "suggested_agent": null }
//
// — which parses cleanly, so no fallback and no plausibility check anywhere downstream ever
// ran. `html` was the three-character string `...`; an 8,334-character page became 3
// characters, was logged `result: "kept"`, and page 17 vanished from the delivered document
// while the run reported 100 of 100 pages and `ready_for_review` (issue #170). The answer was
// in the reply the whole time: the seventh envelope, at offset 53,207, whose `log` reads
// "Page 17. Table 3 continues beyond this page" and whose `html` is 7,121 characters of table.
//
// Reading on past a candidate that does not parse also settles the six Feedback Agent verdicts
// #168 left unreadable, where the first `{` is a decoy the agent quoted in its own prose
// (`the contract is {html, log, suggested_agent}`).
//
// Measured over 1,596 agent replies in five bench rounds, nine read differently and every one
// of the nine is a rescue: six Feedback verdicts that were unreadable at all, the 62 kB
// correction above (3 characters of page → 7,121), one that had bound the first of FOUR fenced
// envelopes whose own logs call the first three abandoned drafts ("RESTART", "Intermediate
// attempt abandoned — column count in the Southeast row does not match": 2,253 → 13,182), and
// one page where the model noticed it had used a forbidden inline event handler, said so, and
// sent a corrected envelope afterwards, which is now the one delivered. The other 1,587 are
// unchanged.
//
// What the rule trades is a decoy AFTER the answer — a model that answers and then quotes the
// contract back. Nothing in the logs does that: every decoy in them is a draft or a quotation,
// and both come before the answer the model settles on. And note that last shape, where the
// corrected envelope is 85 characters SHORTER than the one it replaces: "the biggest
// candidate" would deliver the version the model had just rejected, so size cannot be the
// discriminator either.
//
// Two of the three paths have a floor under this judgement and one does not, which is worth
// stating precisely. A self-CORRECTION that comes back a fraction of the size of the page it was
// given is refused outright (`destroyedPage` in pipeline/correction.ts), and so is a review round
// that comes back with under half the prose of the document it was given — its own number, its own
// reading, read off its own rounds (`destroyedBody`, #174). What remains unguarded is the initial
// page render, which adopts `html` as it comes: there is no before-page to compare it against, so a
// floor there has to be an absolute plausibility check on what a page image that carried text may
// produce, which is #116's territory rather than this one's.
export function extractJson<T = unknown>(text: string): T | null {
  // A reply that is nothing but its JSON: much the commonest case, and no scan can improve
  // on it. Note this is the whole text and not a fenced block's content — the fenced case is
  // reached by the span walk below, which finds an object wherever it sits, and matching a
  // fence FIRST is what bound the scratch template above.
  const whole = text.trim();
  try {
    return JSON.parse(whole) as T;
  } catch {
    // On to the candidates.
  }
  let last: T | null = null;
  // Where the answer we settled on ended, for the whole-reply attempt at the bottom. An object
  // that closes on the reply's last character is the reply's own envelope, however it got there.
  let lastEnd = -1;
  for (let i = text.indexOf("{"); i !== -1; ) {
    const read = readObjectAt<T>(text, i);
    if (read !== null) {
      last = read.value;
      lastEnd = read.end;
      // Past the object, because everything inside it belongs to it: a nested
      // `{"name": "table-agent"}` is not a later answer, and counting it as one would make
      // "the last object" mean the innermost one.
      i = text.indexOf("{", read.end);
      continue;
    }
    // A candidate that could not be read tells us nothing about where it ended — least of all
    // a decoy, whose "object" is prose and whose closing brace belongs to something else. So
    // the search resumes at the next brace INSIDE it rather than after it. Resuming after it
    // returns null on fifteen replies in the bench logs (thirteen Reader verdicts, two
    // Feedback verdicts) that descending reads in full: a `{"html":"` quoted in the Reader's
    // own prose balances against a brace beyond the answer and hides the whole reply.
    //
    // The cost is that a truncated object's complete CHILDREN are candidates — a reply cut
    // off inside `"fragments": [{…}, {…}` can come back as one fragment rather than as null.
    // No reply in the logs does this, and where it happened the caller would read an envelope
    // missing the field it needs, which is the reported-failure path either way (#168).
    i = text.indexOf("{", i + 1);
  }
  // Last chance for a reply that is nothing BUT one object — opening at the first character and
  // closing at the last, which is what every one of these prompts asks for — whose escaping the
  // walk could not repair. Read under the narrower colon rule described above `repairedSpan`, and
  // taken only where the walk did not already close on the reply's last character
  // (`walkClosedOnTheLastCharacter`) and this reading's own strings are self-contained
  // (`stringsAreSelfContained`).
  //
  // Every part of that condition is load-bearing, and each is a version of this change that
  // shipped nothing. The narrow rule cannot go in the walk, because a candidate that newly parses
  // moves the cursor: on 14 of the 4,100 agent replies in the bench logs a Reader verdict quoting
  // `{"html":"…` in its prose gets a value-string that never closes, swallows the verdict behind
  // it, and comes back with one issue in place of five — and putting the narrow rule in as a
  // per-candidate FALLBACK loses the same 14 the same way. And the brace test is not decoration:
  // the narrow rule's own failure case is a string the tracker reads as a value where JSON meant a
  // key, which is what an ABANDONED unterminated string does to it —
  //
  //   {"html": "<p>Table 3 continues\n{"html": "<table>…</table>", "log": "ok", …}
  //
  // a draft the model gave up on mid-string and restarted inline. The walk reads the restart, which
  // is the answer; the narrow rule reads one object whose `html` is the abandoned prose with
  // `{"html": "` glued to the front of it, and that string is delivered to a reader as the page
  // (#168). Both gates refuse that reading, for different reasons — this restart is one the walk can
  // read whole, so the walk's answer closes where the REPLY closes, and the abandoned `{` does not
  // close inside the string — and a decoy the model QUOTED fails neither, so #339's verdict is read
  // as the rejection it is. (The first of those reasons is stated for this reply, not as a rule about
  // where restarts appear; see `walkClosedOnTheLastCharacter` below for the width it actually has.)
  //
  // TWO EARLIER VERSIONS OF THIS GATE WERE WRONG, and both looked like the same idea. The first
  // compared KEY SETS — the narrow reading preferred where it carried every field the walk found
  // plus one more — which is a race the decoy can win: it holds only while the quoted object names
  // fewer fields than the real envelope, so a four-field `notes` quote ties it, and it depends on
  // field ORDER, since a restart preceded by one complete field carries a strict superset and wins.
  // The second was the brace test alone, which is about the right thing and is not sufficient: one
  // `}` in the restarted page content rebalances the abandoned string and the envelope reaches the
  // page again. Neither field count nor a coincidence of braces has anything to do with which
  // reading is right. What does is whether the walk has already read an object that closes where the
  // reply closes — and, failing that, whether the model finished writing the object it quoted.
  const recovered = wholeReplyObject<T>(whole);
  if (recovered === null) return last;
  if (walkClosedOnTheLastCharacter(text, lastEnd)) return last;
  if (!stringsAreSelfContained(recovered)) return last;
  return recovered;
}

// Did the walk's answer end on the reply's final character?
//
// If it did, the walk read an object whose closing brace is the reply's own, and there is nothing
// left over for a second reading to recover — so the narrow rule is not tried at all. That is the
// gate the brace test below could not be, and the claim it rests on is deliberately the narrow one:
// a restart the walk can read WHOLE leaves nothing after it, and a restart the walk cannot read
// whole is the brace test's case. What it does NOT claim is that a restart is always the last thing
// in the reply — a model that restarts, closes the object and then adds a sentence has written a
// reply where it is not, and that reply is refused by `wholeReplyObject`'s `span.end` check instead,
// independently of where the walk stopped. Three revisions of this argument were retired for
// asserting an invariant one shape wider than the code relied on; this is the width it relies on.
//
// The brace test catches the abandoned-draft shape only while the abandoned prose leaves its `{`
// unbalanced, and one `}` anywhere in the restarted content — a code listing, template syntax, a
// math brace, all ordinary page content — rebalances it and hands #168 back:
//
//   {"html": "<p>draft continues\n{"html": "<p>use the } token</p>", "log": "ok", …}
//
// Whereas a decoy the model QUOTED sits inside a field of an envelope that closes after it, so the
// walk's reading of it stops short of the reply's end and this gate lets the narrow rule run.
//
// Both tests are kept because each is free in the same direction and neither implies the other: a
// restart whose own object does not parse leaves the walk on a fragment mid-reply, which only the
// brace test refuses. Rejecting a reading always answers with the walk's result, which is the
// result `main` gives, so a gate here can only ever return behaviour to the base.
function walkClosedOnTheLastCharacter(text: string, lastEnd: number): boolean {
  return lastEnd === text.trimEnd().length;
}

// One object spanning the whole reply, read with the colon rule confined to keys. Null unless the
// reply is exactly that: a `{` first, its match last, and JSON on the other side of the repair.
function wholeReplyObject<T>(whole: string): T | null {
  if (!whole.startsWith("{")) return null;
  const span = repairedSpan(whole, 0, false);
  if (span === null || span.end !== whole.length) return null;
  try {
    return JSON.parse(span.text) as T;
  } catch {
    return null;
  }
}

// Does every `{` inside this object's strings close inside the same string?
//
// The second of the two gates, and the one that catches a restart the walk could not read whole: a
// model QUOTING an object writes the whole thing — `"I read it as { "faithful": true, "problems": []
// } at first"` — so the braces inside that string balance. A model that ABANDONS an object
// mid-string and restarts has written a `{` whose `}` belongs to the restarted object, so the narrow
// reading swallows the opener and leaves it unbalanced. Nothing about field order, field count, or
// which reading is longer enters into it.
//
// What it is NOT is a complete discriminator, which is worth stating because a comment here once
// claimed it was: the invariant holds only while the abandoned string's own braces stay unbalanced,
// and a single `}` in the restarted content rebalances it. `walkClosedOnTheLastCharacter` is what
// closes that, and it is the gate to reach for first.
//
// False negatives cost exactly nothing, which is why this can afford to be strict: a page that
// legitimately prints a lone `{` makes the narrow reading unusable, and an unusable narrow reading
// means `extractJson` answers with the walk's result — the answer `main` gives. That is the safety
// property to keep in mind when editing this. Head and base can differ ONLY on a reply where the
// narrow reading is preferred, so every gate here can only ever return behaviour to the base.
function stringsAreSelfContained(value: unknown): boolean {
  if (typeof value === "string") {
    let depth = 0;
    for (const c of value) {
      if (c === "{") depth++;
      else if (c === "}" && --depth < 0) return false;
    }
    return depth === 0;
  }
  if (Array.isArray(value)) return value.every(stringsAreSelfContained);
  if (value !== null && typeof value === "object") {
    return Object.values(value).every(stringsAreSelfContained);
  }
  return true;
}

// The entries of an array field that DID arrive complete, out of a reply that stopped partway
// through it. Null when the reply carries no such field at all.
//
// `extractJson` above is the right reader for a reply that finished, and the only one: it returns
// the last envelope that parses, and a truncated envelope parses as nothing. That is deliberate —
// nothing can invent the rest of a cut-off object, and a caller handed half an envelope would
// deliver half a page. But an ARRAY of independent entries is the one shape where the prefix is
// not half an answer: `{"edits":[{…},{…},{…` cut in the third entry is two entries the model
// finished saying, each complete in itself, and reading them is the difference between a round
// that produced nothing and a round that produced most of what it was paid for (issue #295).
//
// Only the caller can know whether its entries really are independent, so this function reads and
// does not judge: `pipeline/review.ts` is where the Copy Editor's are, and where the rule about a
// pair of edits split across the cut lives.
//
// `closed` says the array's own `]` was reached, which means the cut fell somewhere AFTER it and
// the entries are the whole of what the model meant to send. A caller that can act on the
// difference should: a complete list is an answer, and a prefix is a fragment of one.
//
// The LAST occurrence of the field, for the reason `extractJson` takes the last envelope: a model
// that drafts before it answers writes the earlier one while thinking. A backslash in front of the
// key means it is quoted inside a string — a document that prints JSON — and is not this field.
export function readArrayPrefix<T>(text: string, field: string): { entries: T[]; closed: boolean } | null {
  const key = new RegExp(`"${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\[`, "g");
  let open: number | null = null;
  for (let m = key.exec(text); m !== null; m = key.exec(text)) {
    if (text[m.index - 1] === "\\") continue;
    open = m.index + m[0].length;
  }
  if (open === null) return null;
  const entries: T[] = [];
  for (let i = open; ; ) {
    while (i < text.length && (text[i] === "," || /\s/.test(text[i]!))) i++;
    // A `]` is the list the model finished; anything that is not an object where an entry belongs
    // is where this stops reading — the cut itself, or a shape this cannot use. Both leave the
    // entries already read intact, which is the whole point.
    if (i >= text.length || text[i] !== "{") return { entries, closed: text[i] === "]" };
    const read = readObjectAt<T>(text, i);
    if (read === null) return { entries, closed: false };
    entries.push(read.value);
    i = read.end;
  }
}

// One candidate: the balanced object starting at `start` and its end in the source, or null
// when nothing starting there parses.
function readObjectAt<T>(text: string, start: number): { value: T; end: number } | null {
  const strict = strictSpan(text, start);
  if (strict !== null) {
    try {
      return { value: JSON.parse(strict.text) as T, end: strict.end };
    } catch {
      // Balanced but not valid: the escaping is what is wrong with it.
    }
  }
  // The same walk under the reader's rule about quotes, which is the only thing that gets
  // past an object whose strings contain the page's own punctuation. It is tried even when
  // the strict walk found a span, because a stray quote makes the two disagree about where
  // the object ends.
  const repaired = repairedSpan(text, start, true);
  if (repaired !== null) {
    try {
      return { value: JSON.parse(repaired.text) as T, end: repaired.end };
    } catch {
      // Not an object, or not one anything here can read.
    }
  }
  return null;
}

interface Span {
  // The object's text — the source characters for `strictSpan`, the repaired ones for
  // `repairedSpan`, which is why the two are not interchangeable.
  text: string;
  // Index in the SOURCE after the closing brace, so a caller can resume past it.
  end: number;
}

// The balanced object at `start`, read strictly: a `"` opens or closes a string, full stop.
// Null when the braces never balance — an object cut off at the output ceiling, or a `{`
// in prose. Nothing below can invent the rest of a truncated reply, so that is where an
// envelope stops being readable at all.
function strictSpan(candidate: string, start: number): Span | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { text: candidate.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

// The same walk, repairing an object that is JSON in shape but not in escaping.
//
// The failure this exists for is not hypothetical and not rare: a page agent transcribing
// a document that quotes itself writes the page's own quotation marks straight into the
// JSON string —
//
//   { "html": "<blockquote><p>\"(1) bring together representatives …</p></blockquote>" }
//
// with the inner `"` unescaped. `JSON.parse` stops at that quote; and the strict walk above
// then mis-tracks every string after it, so on an odd number of stray quotes it reads the
// object's own closing `}` as text inside a string and reports no object at all. Either way
// `extractJson` returned null on a response that is complete, well-formed HTML and obviously
// readable to a person. What the callers then did with that null is what issue #168 was filed
// about — the whole reply, envelope and all, was delivered as the page's content.
//
// Measured over five bench rounds (1,596 agent replies in equalify-iris-bench run logs), this
// reads 60 of the 67 replies that a strict reading cannot read at all. Among the 60 is a 60 kB
// Copy Editor round, so whole correction passes were being lost to it too — not only pages. It
// also changes three replies that a strict reading DOES parse, and all three the same way: the
// object it can read is not the one the model meant, either a nested `{issue: …}` where the
// enclosing `{issues: […]}` is what the caller wants, or an earlier draft where the final
// answer needed repairing. Reading what the model meant is the point of both halves.
//
// The rule is the one a reader applies: a `"` inside a string is a terminator only if the
// text after it continues the OBJECT. So a quote followed by `,` `}` `]` or `:` closes the
// string, and any other quote is a character the model forgot to escape. Raw newlines and
// tabs inside a string — the same class of mistake, and JSON forbids them too — are escaped
// on the way past, as is a backslash that begins no escape sequence (`isEscape`). Because the
// walk and the repair share that rule, the depth it counts is the depth of the object the
// model MEANT, which is what lets it find the closing brace at all.
//
// Deliberately one pass with no backtracking, so it either yields JSON or does not: the
// caller's null is a page that could not be read, which is a reported outcome (see
// extraction.ts), and a cleverer repair that guessed wrong would put content nobody wrote
// into a delivered document. What the remaining unreadable replies are, and why each is left
// (7 of 1,596, once #170 taught the search which candidate to take):
//
//   * four page replies that are bare HTML with no envelope at all — not one brace between
//     them, so there is nothing here to read. These are not parser losses: `bareHtml` in
//     extraction.ts delivers them as the page they are. (One of them ends mid-sentence with
//     the model's own `end_turn` and 3,189 output tokens, so it is not the output ceiling
//     either — a page the agent left unfinished is #116's marker to ask for, not this
//     function's to notice.)
//   * three Feedback Agent verdicts with a `}` where a `]` belongs. Inferring which bracket the
//     model meant is inventing structure, on a path whose output is delivered to a reader as
//     the document. What comes back is whichever sub-object IS valid JSON, which does not carry
//     `issues` or `faithful`, so the verdict reads as "nothing to say" rather than as a guess.
//
// That rule has a SECOND reading, used in exactly one place — `extractJson`'s whole-reply attempt,
// not the candidate walk — and the reason is a verdict rather than a page. A `"` followed by `:`
// closes a KEY; that is the only place JSON puts a colon after a string, since after a VALUE comes
// `,`, `}` or `]`. So on prose that quotes a field name back the wider rule ends the value early.
// In
//
//   { "faithful": false, "problems": [{ … }],
//     "notes": "I first read the contract as { "faithful": true, "problems": [] }; it is not." }
//
// the quote after the inner `faithful` is followed by `:`, the value-string ended there, the walk
// read the rest of the sentence as object syntax, and the envelope did not parse. The decoy the
// model was quoting DID — `extractJson` resumed inside the failed candidate and returned
// `{ faithful: true, problems: [] }`. That is the one sub-object shape the null-is-safe argument
// below does NOT cover: it carries `faithful`, so a rejected page with a missing table row read as
// a confident pass, `ok: true` with no `unjudged` flag on it (issue #339, `verifyAgentOutput`).
//
// Which is NOT an argument for narrowing the rule generally, and the corpus said so before this
// shipped. Applied to every candidate it changes 14 of the 4,100 replies in the bench logs and
// worsens all 14: each is a Reader verdict whose prose quotes `{"html":"…`, `"log": "…"`,
// `"suggested_agent": null}` ahead of the answer, and under the narrow rule that value-string never
// closes, so the prose candidate swallows the real envelope behind it and the walk comes back with
// the LAST issue of the verdict in place of all of them — one issue instead of five. A runaway
// string is the failure the wider rule holds shut. Nor does trying it as a per-candidate FALLBACK
// help, which is the version that looked obviously safe and is not: at that prose brace both wider
// readings fail, so the fallback runs, succeeds on a span that ends past the real envelope, and
// `extractJson` resumes beyond the answer. Same 14 replies, same loss.
//
// What is safe is the narrow rule on the whole reply and nowhere else — one object, first character
// to last. Those 14 all open with prose, so the shape excludes them by construction, and over the
// same 4,100 replies it leaves 4,100 byte-identical while reading the verdict above correctly.
//
// The known limit within the rule is content whose unescaped quote is itself followed by a
// comma or a brace — `<p>She said "hello", he replied</p>` — which reads as a terminator and
// fails the parse. That is the failure this had before, not a new one. It also bounds what the
// whole-reply attempt fixes, and the bound is worth stating because a verdict is on the other side
// of it. Three kinds of residual still leave the decoy as the last readable object — and the last of
// them is a CLASS rather than a shape, so this list is not countable and said "four shapes" until the
// bullet below was widened. All of them are unchanged from before this repair rather than opened by it:
//
//   * the same `notes` inside a code fence, or after a sentence of preamble — the reply no longer
//     opens with `{`, so the whole-reply attempt does not apply to it at all;
//   * a quote of `"faithful",` rather than `"faithful":`, where the wide rule ends the value early
//     for a reason the narrow rule shares;
//   * a decoy containing ANY quoted string value at all — the `"` that opens it follows a `:` and the
//     `"` that closes it is followed by `,`, `}` or `]`, so the narrow rule ends the real `notes`
//     value at that point, the span stops before the end of the reply, and the whole-reply attempt
//     yields nothing. This is a CLASS, and it is the one the new `notes` field most invites. The
//     minimal instance is `{ …, "notes": "" }`; an earlier revision of this list named that instance
//     as if it were the trigger, which is the same error as the tail claim above but in the more
//     expensive direction — a residual understated is a residual someone closes by making the pin for
//     the special case pass. What this repair DOES fix is the decoy with no string values in it, which
//     is the shape issue #339 produced.
//
// A parser cannot close those in one pass — a `"` before `}` is a terminator on every reply that
// needed this repair in the first place — so they are closed twice elsewhere instead:
// `agents/feedback.md` asks the verifier for no quoted JSON in `notes` at all, and
// `verifyAgentOutput` refuses to read anything carrying fewer than both decision flags as a verdict.
// The last of these — the whole class of it, not just the empty-string instance — defeats BOTH of
// those, since the quoted contract it produces carries both flags as booleans, and a reply that quotes
// the whole contract back is indistinguishable in one pass from a reply that IS the contract. It reads as a pass on a page the verifier rejected, on
// `main` and here alike; what makes it acceptable to leave is that the prompt clause removes the
// only reason such a string would be written.

// Is the backslash at `i` the start of one of the six escapes JSON allows, or of a `\uXXXX`
// with its four hex digits? Anything else is a backslash the model wrote as itself.
function isEscape(candidate: string, i: number): boolean {
  const next = candidate[i + 1];
  if (next === undefined) return false;
  if (next === "u") return /^[0-9a-fA-F]{4}/.test(candidate.slice(i + 2, i + 6));
  return '"\\/bfnrt'.includes(next);
}

// `colonClosesValues` is the difference between the two readings `readObjectAt` tries. True is the
// original rule: a `"` followed by `:` ends the string wherever it appears. False confines that to
// a string in KEY position, which is the only place JSON puts a colon after one.
function repairedSpan(candidate: string, start: number, colonClosesValues: boolean): Span | null {
  let out = "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  // Which containers we are inside, innermost last, and whether a string opened here would be a
  // key. Both exist only to answer that question for the `":` case below; `depth` still decides
  // where the object ends, unchanged, so a reply with unbalanced `[` cannot change the span.
  const stack: ("obj" | "arr")[] = [];
  let expectKey = false;
  let keyString = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (!inStr) {
      out += c;
      if (c === '"') {
        inStr = true;
        keyString = stack[stack.length - 1] === "obj" && expectKey;
      } else if (c === ":") expectKey = false;
      else if (c === ",") expectKey = stack[stack.length - 1] === "obj";
      else if (c === "[") stack.push("arr");
      else if (c === "]") {
        stack.pop();
        expectKey = false;
      } else if (c === "{") {
        stack.push("obj");
        expectKey = true;
        depth++;
      } else if (c === "}") {
        stack.pop();
        expectKey = false;
        depth--;
        // `end` is an index in the SOURCE, not in `out`: the repair adds characters, so the
        // two lengths differ and a caller resuming at `start + out.length` would land past
        // the object — or, on a long page, past the answer that follows it.
        if (depth === 0) return { text: out, end: i + 1 };
      }
      continue;
    }
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      // A backslash the model meant as a character rather than as an escape. It is the same
      // mistake as the unescaped quote, and it comes from the same place: a page that PRINTS
      // a backslash. The real one is a title page describing its own decoration — "decorative
      // diagonal slash marks (visible as '\' before 'MEASURES')" — where `\'` is not a JSON
      // escape and stops the parse at that character.
      //
      // Where the two readings collide, the escape wins: a page printing `C:\new` gets a
      // newline, because the letter after the backslash is one JSON escapes use. Reading it
      // the other way would break every genuinely escaped `\n` in every reply that reaches
      // this pass, which is a far larger set than the paths that print one.
      if (!isEscape(candidate, i)) {
        out += "\\\\";
        continue;
      }
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      // Whatever follows this quote decides what it was — except a `:`, which decides it only
      // when this string is a key. In a value it is a colon the model wrote inside its prose,
      // and the string carries on (issue #339; see the note above `isEscape`).
      let j = i + 1;
      while (j < candidate.length && /\s/.test(candidate[j])) j++;
      const next = candidate[j];
      const closes =
        next === "," ||
        next === "}" ||
        next === "]" ||
        next === undefined ||
        (next === ":" && (colonClosesValues || keyString));
      if (closes) {
        out += c;
        inStr = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else out += c;
  }
  return null;
}
