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
// discriminator either. On the page path a correction that comes back a fraction of the size
// it replaces is refused anyway (extraction.ts).
export function extractJson<T = unknown>(text: string): T | null {
  // A reply that is nothing but its JSON: much the commonest case, and no scan can improve
  // on it. Note this is the whole text and not a fenced block's content — the fenced case is
  // reached by the span walk below, which finds an object wherever it sits, and matching a
  // fence FIRST is what bound the scratch template above.
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    // On to the candidates.
  }
  let last: T | null = null;
  for (let i = text.indexOf("{"); i !== -1; ) {
    const read = readObjectAt<T>(text, i);
    if (read !== null) {
      last = read.value;
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
  return last;
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
  const repaired = repairedSpan(text, start);
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
// The known limit within the rule is content whose unescaped quote is itself followed by a
// comma or a brace — `<p>She said "hello", he replied</p>` — which reads as a terminator and
// fails the parse. That is the failure this had before, not a new one.

// Is the backslash at `i` the start of one of the six escapes JSON allows, or of a `\uXXXX`
// with its four hex digits? Anything else is a backslash the model wrote as itself.
function isEscape(candidate: string, i: number): boolean {
  const next = candidate[i + 1];
  if (next === undefined) return false;
  if (next === "u") return /^[0-9a-fA-F]{4}/.test(candidate.slice(i + 2, i + 6));
  return '"\\/bfnrt'.includes(next);
}

function repairedSpan(candidate: string, start: number): Span | null {
  let out = "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
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
      // Whatever follows this quote decides what it was.
      let j = i + 1;
      while (j < candidate.length && /\s/.test(candidate[j])) j++;
      const next = candidate[j];
      if (next === "," || next === "}" || next === "]" || next === ":" || next === undefined) {
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
