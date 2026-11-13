// Proofreading (S-5): split paragraphs into sentences, compare each sentence with the model's
// corrected version word by word, and describe every difference as an issue with a reason.
// Pure functions only; main.ts owns the state and the rendering.

export type IssueKind = "grammar" | "dictation";

export interface Sentence {
  text: string;
  start: number; // offset in the paragraph
}

export interface Edit {
  at: number; // offset in the sentence
  from: string; // text replaced (may be empty for a pure insertion)
  to: string;
  kind: IssueKind;
  reason: string;
  auto: boolean; // obvious misspelling: applied without asking (Req 6)
}

export function sentences(paragraph: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g;
  for (let m; (m = re.exec(paragraph)); ) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    const lead = m[0].length - m[0].trimStart().length;
    const text = m[0].trim();
    if (text) out.push({ text, start: m.index + lead });
  }
  return out;
}

const FILLERS = new Set(["um", "uh", "erm", "er", "ah", "uhm", "hmm", "mm"]);
const CONFUSED = [
  ["then", "than"], ["there", "their", "they're"], ["your", "you're"], ["its", "it's"], ["to", "too", "two"],
  ["affect", "effect"], ["loose", "lose"], ["were", "where", "we're"], ["whose", "who's"], ["accept", "except"],
];

const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

// Dictation clean-up the model may skip: fillers, doubled words, and a missing full stop.
export function dictationFixes(sentence: string, lastInParagraph: boolean): string {
  let s = sentence.replace(/(^|\s)(um|uh|erm|er|uhm|hmm)\b,?\s*/gi, "$1");
  s = s.replace(/\b(\w+)(\s+)\1\b/gi, "$1");
  s = s.replace(/^\s*([a-z])/, (c) => c.toUpperCase()).trim();
  if (lastInParagraph && s && !/[.!?]["'”’)\]]*$/.test(s)) s += ".";
  return s;
}

interface Tok {
  t: string;
  start: number;
  end: number;
}

function tokens(s: string): Tok[] {
  return [...s.matchAll(/\S+/g)].map((m) => ({ t: m[0], start: m.index!, end: m.index! + m[0].length }));
}

// Word-level differences between a sentence and its corrected form.
export function diff(original: string, corrected: string): Edit[] {
  const a = tokens(original);
  const b = tokens(corrected);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  // Align on the bare word, so a word that only gained punctuation stays its own edit.
  // A likely misspelling also aligns with its correction, so it is not merged with its neighbours.
  const same = (x: number, y: number) => {
    const p = bare(a[x].t);
    const q = bare(b[y].t);
    return p === q || (p.length >= 4 && p[0] === q[0] && levenshtein(p, q) <= 2);
  };
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = same(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(i, j)) {
      if (a[i].t !== b[j].t) edits.push(hunk(original, a, b, i, i + 1, j, j + 1));
      i++;
      j++;
      continue;
    }
    const i0 = i;
    const j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && same(i, j))) {
      if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) j++;
      else i++;
    }
    edits.push(hunk(original, a, b, i0, i, j0, j));
  }
  return edits;
}

function hunk(original: string, a: Tok[], b: Tok[], i0: number, i1: number, j0: number, j1: number): Edit {
  const words = (t: Tok[], x: number, y: number) => t.slice(x, y).map((k) => k.t).join(" ");
  let from = words(a, i0, i1);
  let to = words(b, j0, j1);
  let at = i0 < a.length ? a[i0].start : original.length;
  const removed = to === "" ? from : "";
  // A pure insertion is anchored on the word before it (or after it, at the start).
  if (i0 === i1) {
    if (i0 > 0) {
      at = a[i0 - 1].start;
      from = a[i0 - 1].t;
      to = `${from} ${to}`;
    } else if (a.length) {
      at = a[0].start;
      from = a[0].t;
      to = `${to} ${from}`;
    }
  }
  const prev = i0 > 0 ? bare(a[i0 - 1].t) : "";
  const next = i1 < a.length ? bare(a[i1].t) : "";
  const { kind, reason, auto } = classify(from, to, removed, prev, next, i1 === a.length);
  return { at, from, to, kind, reason, auto };
}

function classify(from: string, to: string, removed: string, prev: string, next: string, atEnd: boolean): Pick<Edit, "kind" | "reason" | "auto"> {
  const no = { auto: false };
  if (removed) {
    const ws = removed.split(/\s+/).map(bare);
    if (ws.every((w) => FILLERS.has(w))) return { kind: "dictation", reason: "Filler word", ...no };
    if (ws.length === 1 && (ws[0] === prev || ws[0] === next)) return { kind: "dictation", reason: "Repeated word", ...no };
    return { kind: "grammar", reason: "Unneeded word", ...no };
  }
  const strip = (s: string) => s.replace(/[^\p{L}\p{N}'\s]/gu, "").replace(/\s+/g, " ").trim();
  if (strip(from) === strip(to)) {
    if (atEnd && /[.!?]$/.test(to) && !/[.!?]$/.test(from)) return { kind: "dictation", reason: "Missing end punctuation", ...no };
    return { kind: "grammar", reason: "Punctuation", ...no };
  }
  if (strip(from).toLowerCase() === strip(to).toLowerCase()) return { kind: "grammar", reason: "Capitalization", ...no };
  const f = bare(from);
  const t = bare(to);
  if (!/\s/.test(from) && !/\s/.test(to)) {
    if (CONFUSED.some((set) => set.includes(f) && set.includes(t))) return { kind: "grammar", reason: "Commonly confused word", ...no };
    // An obvious misspelling: one word, a small edit, same start, and the rest of the token unchanged.
    if (f.length >= 4 && f[0] === t[0] && levenshtein(f, t) <= 2 && from.replace(/[\p{L}']/gu, "") === to.replace(/[\p{L}']/gu, "") && !inflection(f, t))
      return { kind: "grammar", reason: "Spelling", auto: true };
  }
  return { kind: "grammar", reason: "Grammar", ...no };
}

// Changes that are grammar, not typos: come/came, sing/sang (a vowel swap in a short word), and
// work/works/worked/working (an ending added or dropped).
function inflection(a: string, b: string): boolean {
  const vowels = /[aeiouy]/;
  if (a.length === b.length && a.length <= 6 && [...a].every((c, i) => c === b[i] || (vowels.test(c) && vowels.test(b[i])))) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  const stem = short.replace(/e$/, "");
  return long.startsWith(stem) && /^e?(s|es|d|ed|ing|r|er|ly)$/.test(long.slice(stem.length));
}

function levenshtein(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// Apply one edit to a sentence and tidy the spacing it leaves behind.
export function applyEdit(sentence: string, e: Pick<Edit, "at" | "from" | "to">): string {
  const s = sentence.slice(0, e.at) + e.to + sentence.slice(e.at + e.from.length);
  return s.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

// The words of `alt`, each marked if it is not in `original` (for showing what an alternative changes).
export function changedWords(original: string, alt: string): { text: string; changed: boolean }[] {
  const a = tokens(original).map((t) => bare(t.t));
  const b = tokens(alt);
  const m = b.length;
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === bare(b[j].t) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { text: string; changed: boolean }[] = [];
  let i = 0;
  for (let j = 0; j < m; j++) {
    while (i < a.length && a[i] !== bare(b[j].t) && lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    const same = i < a.length && a[i] === bare(b[j].t);
    if (same) i++;
    out.push({ text: b[j].t, changed: !same });
  }
  return out;
}

// Word diff of two texts for the version view (S-8 Req 3): runs of kept, removed and added words.
export function wordDiff(before: string, after: string): { op: "same" | "del" | "ins"; text: string }[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { op: "same" | "del" | "ins"; text: string }[] = [];
  const push = (op: "same" | "del" | "ins", w: string) => {
    const last = out[out.length - 1];
    if (last?.op === op) last.text += ` ${w}`;
    else out.push({ op, text: w });
  };
  let i = 0;
  let j = 0;
  // Removals before additions within a changed run, so the run reads "old new".
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push("same", a[i++]);
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) push("del", a[i++]);
    else push("ins", b[j++]);
  }
  // Within a changed run, put every removal before every addition.
  for (let k = 0; k + 1 < out.length; k++)
    if (out[k].op === "ins" && out[k + 1].op === "del") [out[k], out[k + 1]] = [out[k + 1], out[k]];
  for (let k = 0; k + 1 < out.length; k++)
    if (out[k].op === out[k + 1].op) {
      out[k].text += ` ${out[k + 1].text}`;
      out.splice(k-- + 1, 1);
    }
  return out;
}
