// Leniently extract a JSON object from an LLM response: prefer a fenced ```json block,
// fall back to the first balanced {...} span, and — only when both of those have failed —
// to one repair pass over the commonest way a model writes an object that is not quite
// JSON (see `repairedSpan`). Returns null if nothing parses, so callers can degrade
// gracefully rather than crash.
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  // Try the whole candidate first.
  try {
    return JSON.parse(candidate.trim()) as T;
  } catch {
    // Fall back to the first balanced object.
  }
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  const strict = strictSpan(candidate, start);
  if (strict !== null) {
    try {
      return JSON.parse(strict) as T;
    } catch {
      // The span is balanced but not valid: the escaping is what is wrong with it.
    }
  }
  // Last: the same walk under the reader's rule about quotes, which is the only thing
  // that gets past an object whose strings contain the page's own punctuation.
  const repaired = repairedSpan(candidate, start);
  if (repaired === null) return null;
  try {
    return JSON.parse(repaired) as T;
  } catch {
    return null;
  }
}

// The first balanced object, read strictly: a `"` opens or closes a string, full stop.
// Null when the braces never balance — an object cut off at the output ceiling, or a `{`
// in prose. Nothing below can invent the rest of a truncated reply, so that is where an
// envelope stops being readable at all.
function strictSpan(candidate: string, start: number): string | null {
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
      if (depth === 0) return candidate.slice(start, i + 1);
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
// Measured over five bench rounds (1,445 agent replies in equalify-iris-bench run logs), this
// reads 52 of the 65 replies that were unreadable and changes not one of the 1,380 that
// already parsed. Among the 52 is a 60 kB Copy Editor round, so whole correction passes were
// being lost to it too — not only pages.
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
// into a delivered document. What the 13 remaining replies are, and why each is left:
//
//   * four page replies cut off mid-string at the output ceiling. The rest of the page is not
//     in the reply, so nothing here can supply it (issues #135, #143, #165 are the containment
//     for that case).
//   * two with a `}` where a `]` belongs. Inferring which bracket the model meant is inventing
//     structure, on a path whose output is delivered to a reader as the document.
//   * seven Feedback Agent verdicts whose PROSE quotes a brace before the real object begins
//     — `the contract is {html, log, suggested_agent}` — so the first `{` in the text is a
//     decoy. Which candidate to bind is issue #170's subject, and it is a real defect with a
//     real cost: a reasoning model's scratch template `{"html": "...", "log": "..."}` parses
//     cleanly and replaced an 8,334-character page with three characters. Choosing among
//     candidates is therefore its own change, with its own decision about which one wins —
//     not something to slip into a repair pass whose rule is "read what is there".
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

function repairedSpan(candidate: string, start: number): string | null {
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
        if (depth === 0) return out;
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
