// Cader UI: the library (S-1) and the writing surface (S-2). Documents come from the Rust
// backend through api.ts. Proofreading (S-5) comes from the local correction model; the
// wording and sentence cards are still sample data on the seeded example until S-6 and S-7.

import { api, type DictationEvent, type DocMeta, type ModelsEvent, type Opt, type VersionInfo } from "./api";
import { showLibrary } from "./library";
import { applyEdit, changedWords, dictationFixes, diff, sentences, wordDiff } from "./proofread";

type Kind = "grammar" | "dictation" | "tighter" | "wording" | "sentence";
type Tab = "rephrase" | "substitute" | "sentence";

interface Suggestion {
  id: string;
  kind: Kind;
  para: number; // paragraph index
  at: number; // offset of the span in that paragraph
  text: string; // exact span in that paragraph
  label: string; // one line for the pending list
  fix?: string; // margin-note kinds (grammar, tighter): the replacement
  tab?: Tab; // card kinds (wording, sentence): which tab opens first
  options?: Partial<Record<Tab, Option[]>>;
  // Proofread issues (S-5) are derived from the corrections, not stored.
  reason?: string;
  proof?: { sentence: string; start: number; at: number; corr: string; key: string };
}

interface Option {
  text: string;
  note?: string;
  batch?: number; // which More batch it came from (S-7 shows the latest batch plus pinned ones)
  pinned?: boolean;
}

// The open document. `versions` counts the saved versions plus the working draft, if it differs.
const doc = {
  id: "",
  title: "",
  version: 1,
  versions: 1,
  autoFixed: 0,
  paragraphs: [] as string[],
  live: -1, // the paragraph still being dictated
  // Changes applied in the current review (S-7 Req 5); version history (S-8) builds on this.
  changes: [] as { kind: Kind | "dictated"; from: string; to: string; time: number }[],
  saved: false, // the text matches the latest saved version
  savedAt: 0, // when the latest version was saved
  typed: false, // the text was edited by hand in this review
};

let suggestions: Suggestion[] = [];

const SAMPLE_SUGGESTIONS: Omit<Suggestion, "at">[] = [
  {
    id: "s1", kind: "wording", para: 0, text: "very important", label: "“very important”: stronger word", tab: "substitute",
    options: {
      substitute: [
        { text: "vital", note: "necessary for life to go on" },
        { text: "indispensable", note: "could not do without it" },
        { text: "paramount", note: "above everything else" },
        { text: "cherished", note: "warmer, about feeling" },
        { text: "essential", note: "basic and necessary" },
      ],
      rephrase: [{ text: "something the families here could not do without" }, { text: "close to the heart of every family here" }, { text: "a matter of real pride" }],
    },
  },
  { id: "s2", kind: "tighter", para: 1, text: "keeping a promise that was made", fix: "keeping a promise made", label: "keeping a promise that was made → keeping a promise made" },
  {
    id: "s4", kind: "wording", para: 2, text: "their actual blood, sweat and tears", label: "“actual blood, sweat and tears”: rephrase", tab: "rephrase",
    options: {
      rephrase: [{ text: "real blood, sweat and tears" }, { text: "their sweat, and now and then their blood" }, { text: "everything they had" }],
      substitute: [{ text: "toil", note: "hard, tiring work" }, { text: "grit", note: "courage and resolve" }, { text: "devotion", note: "love shown through effort" }],
    },
  },
  {
    id: "s5", kind: "sentence", para: 3, text: "So let me begin with a simple thank you to the volunteers", label: "Other ways to say the closing line", tab: "sentence",
    options: {
      sentence: [
        { text: "Let me begin, simply, by thanking the volunteers" },
        { text: "First, a simple thank you to our volunteers" },
        { text: "I want to start with the volunteers, and a simple thank you" },
      ],
    },
  },
];

const COLORS: Record<Kind, string> = { grammar: "#d0453a", dictation: "#b88a00", tighter: "#b88a00", sentence: "#b88a00", wording: "#3f6bf2" };
const NOTE_LABEL: Record<Kind, string> = { grammar: "Grammar", dictation: "Dictation", tighter: "Tighter", wording: "Wording", sentence: "Sentence" };

// ---- Proofreading state (S-5) ----

const corrections = new Map<string, string>(); // sentence -> the model's corrected sentence
const ignored = new Set<string>(); // issues ignored for this version
let autoFixes: { corr: string; from: string; to: string }[] = [];
let proofed = false; // after the first Proofread, edited sentences are re-checked on their own
let modelCalls = 0; // shown as data-model-calls on <html>, for checks

function issues(): Suggestion[] {
  const out: Suggestion[] = [];
  doc.paragraphs.forEach((p, para) => {
    if (para === doc.live) return;
    for (const sen of sentences(p)) {
      const corr = corrections.get(sen.text);
      if (corr === undefined) continue;
      for (const e of diff(sen.text, corr)) {
        const key = `${corr}|${e.from}|${e.to}`;
        if (!e.from || ignored.has(key)) continue;
        out.push({
          id: `p${para}-${sen.start + e.at}`, kind: e.kind, para, at: sen.start + e.at, text: e.from, fix: e.to, reason: e.reason,
          label: `${e.from} → ${e.to || "(remove)"}`,
          proof: { sentence: sen.text, start: sen.start, at: e.at, corr, key },
        });
      }
    }
  });
  return out;
}

function all(): Suggestion[] {
  return [...suggestions, ...issues()];
}

// Card suggestions keep their span as the text changes: move to the nearest match, or drop.
function relocate(): void {
  suggestions = suggestions.filter((s) => {
    const p = doc.paragraphs[s.para] ?? "";
    let best = -1;
    for (let i = p.indexOf(s.text); i >= 0; i = p.indexOf(s.text, i + 1)) if (best < 0 || Math.abs(i - s.at) < Math.abs(best - s.at)) best = i;
    s.at = best;
    return best >= 0;
  });
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bodyEl = $("doc-body");
const notesEl = $("notes");
const card = $("card");
const optionsEl = $("options");
const pendingBtn = $<HTMLButtonElement>("pending");
const pendingList = $("pending-list");

// ---- Document rendering ----

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// Whole-word match so "has" does not hit "chase".
function wordRe(span: string): RegExp {
  return new RegExp(`(^|[^\\w])(${span.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w])`);
}

function renderDoc(): void {
  $("doc-title").textContent = doc.title;
  $("doc-heading").textContent = doc.title;
  document.title = `${doc.title} - Cader`;
  if (!doc.paragraphs.length) {
    bodyEl.innerHTML = "<p><br></p>";
    renderNotes();
    renderPending();
    return;
  }
  relocate();
  const marks = all().sort((a, b) => a.at - b.at);
  bodyEl.innerHTML = doc.paragraphs
    .map((text, i) => {
      let html = "";
      let pos = 0;
      for (const s of marks.filter((x) => x.para === i)) {
        if (s.at < pos || text.slice(s.at, s.at + s.text.length) !== s.text) continue; // overlaps an earlier mark
        html += `${escapeHtml(text.slice(pos, s.at))}<span class="mark ${s.kind}" data-id="${s.id}">${escapeHtml(s.text)}</span>`;
        pos = s.at + s.text.length;
      }
      html += escapeHtml(text.slice(pos));
      return `<p${i === doc.live ? ' class="live"' : ""}>${html}</p>`;
    })
    .join("");
  renderNotes();
  renderPending();
}

// Margin notes sit beside the line of the span they fix.
function renderNotes(): void {
  notesEl.innerHTML = "";
  const top = notesEl.getBoundingClientRect().top;
  let below = -Infinity; // notes on the same line stack instead of overlapping
  for (const s of all().filter((x) => x.fix !== undefined)) {
    const mark = markFor(s.id);
    if (!mark) continue;
    const note = document.createElement("div");
    note.className = `note ${s.kind}`;
    note.dataset.id = s.id;
    const change = s.kind === "tighter" ? escapeHtml(s.fix!) : `<s>${escapeHtml(s.text)}</s> &#8594; <b>${s.fix ? escapeHtml(s.fix) : "remove"}</b>`;
    note.innerHTML = `<div class="label">${escapeHtml(s.reason ?? NOTE_LABEL[s.kind])}</div>${change}<div class="acts"><button class="apply">Apply</button><button class="ignore">Ignore</button></div>`;
    const y = Math.max(mark.getBoundingClientRect().top - top - 22, below + 12);
    note.style.top = `${y}px`;
    note.querySelector(".apply")!.addEventListener("click", () => apply(s, s.fix!));
    note.querySelector(".ignore")!.addEventListener("click", () => ignore(s));
    notesEl.appendChild(note);
    below = y + note.offsetHeight;
  }
}

function markFor(id: string): HTMLElement | null {
  return bodyEl.querySelector<HTMLElement>(`.mark[data-id="${id}"]`);
}

// ---- Pending badge, dropdown and Save ----

function renderPending(): void {
  const list = all();
  const n = list.length;
  pendingBtn.textContent = String(n);
  pendingBtn.hidden = n === 0;
  // Saved (S-9): the text reads clean, Save gives way to Export, and a new review can be requested.
  document.body.classList.toggle("is-saved", doc.saved);
  $("request-review").hidden = !doc.saved;
  $("export-wrap").hidden = !doc.saved;
  if (!doc.saved) toggleExport(false);
  $("save").hidden = n > 0 || doc.saved;
  const auto = $<HTMLButtonElement>("autofixed");
  auto.textContent = `${doc.autoFixed} auto-fixed`;
  auto.disabled = doc.autoFixed === 0;
  autoList.innerHTML =
    `<div class="dropdown-head"><span>${autoFixes.length} auto-fixed</span></div>` +
    autoFixes
      .map((f, i) => `<div class="issue fixed"><span class="what"><s>${escapeHtml(f.from)}</s> &#8594; ${escapeHtml(f.to)}</span><button class="undo" data-i="${i}">Undo</button></div>`)
      .join("");
  if (!autoFixes.length) toggleAuto(false);
  renderStepper();
  pendingList.innerHTML =
    `<div class="dropdown-head"><span>${n} pending</span><span class="head-acts"><button id="accept-all">Accept all</button><button id="ignore-all">Ignore all</button></span></div>` +
    (n === 0
      ? `<div class="empty">Nothing pending.</div>`
      : list
          .map(
            (s) =>
              `<button class="issue" data-id="${s.id}"><span class="dot" style="background:${COLORS[s.kind]}"></span><span><div class="what">${escapeHtml(s.label)}</div><div class="where">${escapeHtml(s.reason ?? NOTE_LABEL[s.kind])} &#183; para ${s.para + 1}</div></span></button>`,
          )
          .join(""));
  if (n === 0) togglePending(false);
}

function togglePending(open: boolean): void {
  pendingList.hidden = !open;
  pendingBtn.setAttribute("aria-expanded", String(open));
}

pendingBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePending(pendingList.hidden);
});

pendingList.addEventListener("click", (e) => {
  e.stopPropagation();
  const target = e.target as HTMLElement;
  if (target.id === "ignore-all") {
    closeCard();
    for (const s of issues()) ignored.add(s.proof!.key);
    suggestions = [];
    renderDoc();
    return;
  }
  if (target.id === "accept-all") {
    closeCard();
    acceptAll();
    return;
  }
  const item = target.closest<HTMLElement>(".issue");
  if (!item) return;
  togglePending(false);
  jumpTo(item.dataset.id!);
});

// Scroll to an issue, highlight it, and have its suggestion ready.
function jumpTo(id: string): void {
  const s = all().find((x) => x.id === id);
  const mark = markFor(id);
  if (!s || !mark) return;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  if (s.fix !== undefined) {
    closeCard();
    mark.classList.add("reviewing");
    const note = notesEl.querySelector<HTMLElement>(`.note[data-id="${id}"]`);
    note?.classList.add("focus");
    setTimeout(() => {
      mark.classList.remove("reviewing");
      note?.classList.remove("focus");
    }, 2400);
  } else {
    openCard(s, mark);
  }
}

// Save closes the review: the text and its change list become the next version (S-8 Req 1, 2; D-7).
$("save").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("save");
  if (!doc.id || btn.disabled) return;
  btn.disabled = true;
  const n = await saveReview();
  btn.disabled = false;
  if (n) flash(`Saved v${n}. Review complete.`);
});

async function saveReview(): Promise<number | null> {
  const text = doc.paragraphs.join(PREFIX) + "\n";
  const changes = [
    ...autoFixes.map((f) => ({ kind: "spelling", from: f.from, to: f.to })),
    ...doc.changes.map(({ kind, from, to }) => ({ kind: String(kind), from, to })),
    ...(doc.typed ? [{ kind: "manual", from: "", to: "Edited by hand" }] : []),
  ];
  try {
    clearTimeout(saveTimer); // the version write also stores the working text
    dirty = false;
    const { version } = await api.saveVersion(doc.id, text, changes);
    doc.version = doc.versions = version.n;
    doc.saved = true;
    doc.savedAt = version.time;
    // Every review in the pass is complete: suggestions and notes collapse (S-9 Req 2, 3).
    suggestions = [];
    corrections.clear();
    proofed = false;
    proofPass++;
    clearTimeout(checkTimer);
    checkAgain = false;
    doc.live = -1;
    doc.changes = [];
    doc.typed = false;
    autoFixes = [];
    doc.autoFixed = 0;
    ignored.clear();
    renderDoc();
    if (!versionsEl.hidden) void openVersions();
    return version.n;
  } catch (e) {
    flash(`Could not save: ${e}`);
    return null;
  }
}

function idleStatus(): string {
  return doc.saved ? `Saved v${doc.versions} \u00b7 ${when(doc.savedAt)} \u00b7 reviews completed` : `Review ${doc.version} \u00b7 autosaved`;
}

// A new pass on the saved text: the model runs again (S-9 Req 4). Saved versions stay as they are.
$("request-review").addEventListener("click", () => {
  if (!doc.saved) return;
  doc.saved = false;
  doc.version = doc.versions += 1;
  if (viewing !== null || !versionsEl.hidden) closeVersions();
  renderPending();
  proofed = true;
  void check(true);
});

// ---- Export (S-9 Req 5): always the latest saved version ----

const exportMenu = $("export-menu");

function toggleExport(open = exportMenu.hidden): void {
  exportMenu.hidden = !open;
  $("export").setAttribute("aria-expanded", String(open));
  if (open) $("export-note").textContent = `Exports v${doc.versions}, the latest saved version`;
}

$("export").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleExport();
});
document.addEventListener("click", (e) => {
  if (!exportMenu.hidden && !(e.target as HTMLElement).closest("#export-wrap")) toggleExport(false);
});
exportMenu.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-x]");
  if (!b) return;
  toggleExport(false);
  void exportAs(b.dataset.x!);
});

async function exportAs(how: string): Promise<void> {
  if (!doc.saved || !doc.id) return;
  const n = doc.versions;
  try {
    const v = await api.getVersion(doc.id, n);
    if (how === "copy") {
      await navigator.clipboard.writeText(v.text);
      flash(`Copied v${n}.`);
    } else if (how === "md" || how === "txt") {
      flash(`Exported v${n} to ${await api.exportVersion(doc.id, n, how)}`);
    } else if (how === "read") {
      openReader(v.text, n);
    } else if (how === "pdf") {
      $("print-out").innerHTML =
        `<h1>${escapeHtml(doc.title)}</h1>` + paras(v.text).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
      await api.printPage();
    }
  } catch (e) {
    flash(`Could not export: ${e}`);
  }
}

const paras = (t: string) => t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

// Reading view for delivering a speech: one paragraph at a time, the next one dimmed.
const reader = { paras: [] as string[], i: 0, size: 44 };

function openReader(text: string, n: number): void {
  reader.paras = paras(text);
  reader.i = 0;
  $("reader-title").textContent = `${doc.title} \u00b7 v${n}`;
  $("reader").hidden = false;
  renderReader();
}

function renderReader(): void {
  const { paras: ps, i, size } = reader;
  const el = $("reader-text");
  el.style.fontSize = `${size}px`;
  el.style.lineHeight = "1.5";
  el.innerHTML = ps
    .slice(i, i + 2)
    .map((p, k) => `<p${k ? ' class="next"' : ""}>${escapeHtml(p)}</p>`)
    .join("");
  $("reader-foot").textContent = ps.length
    ? `${i + 1} of ${ps.length} \u00b7 ${i + 1 < ps.length ? "Space or \u2193 for the next paragraph" : "End"}`
    : "Nothing saved yet";
}

function readerKey(e: KeyboardEvent): void {
  const last = reader.paras.length - 1;
  if (e.key === "Escape") $("reader").hidden = true;
  else if ((e.key === " " && !e.shiftKey) || e.key === "ArrowDown" || e.key === "PageDown") reader.i = Math.max(0, Math.min(last, reader.i + 1));
  else if (e.key === " " || e.key === "ArrowUp" || e.key === "PageUp") reader.i = Math.max(0, reader.i - 1);
  else return;
  e.preventDefault();
  renderReader();
}

const resize = (d: number) => {
  reader.size = Math.max(24, Math.min(80, reader.size + d));
  renderReader();
};
$("reader-smaller").addEventListener("click", () => resize(-4));
$("reader-larger").addEventListener("click", () => resize(4));
$("reader-close").addEventListener("click", () => ($("reader").hidden = true));

// ---- Versions panel (S-8 Req 3, 4) ----

const versionsEl = $("versions");
const verBody = $("ver-body");
let vlist: VersionInfo[] = []; // newest first
let viewing: number | null = null; // the saved version on show; null is the working draft

const savedCount = () => (doc.saved ? doc.versions : doc.versions - 1);

function renderStepper(): void {
  const n = viewing ?? doc.version;
  $("v-label").textContent = `v${n} of ${doc.versions}`;
  $<HTMLButtonElement>("v-prev").disabled = (viewing === null ? (doc.saved ? savedCount() - 1 : savedCount()) : viewing - 1) < 1;
  $<HTMLButtonElement>("v-next").disabled = viewing === null;
}

async function openVersions(): Promise<void> {
  if (!doc.id) return;
  closeCard();
  vlist = await api.listVersions(doc.id).catch(() => []);
  versionsEl.hidden = false;
  $("v-label").setAttribute("aria-expanded", "true");
  document.querySelector(".stepper")!.classList.add("open");
  renderVersions();
}

function closeVersions(): void {
  versionsEl.hidden = true;
  $("v-label").setAttribute("aria-expanded", "false");
  document.querySelector(".stepper")!.classList.remove("open");
  showDraft();
}

// Back to the editable working text.
function showDraft(): void {
  viewing = null;
  verBody.hidden = true;
  $("vbar").hidden = true;
  bodyEl.hidden = false;
  notesEl.style.visibility = "";
  $("doc-heading").contentEditable = "true";
  renderStepper();
  if (!versionsEl.hidden) renderVersions();
}

// A saved version, read only, with a word diff against another one (0 for none).
async function showVersion(n: number, against = n - 1): Promise<void> {
  closeCard();
  try {
    // The list may be from before the latest Save; the compare menu needs every version.
    vlist = await api.listVersions(doc.id);
    const v = await api.getVersion(doc.id, n);
    const base = against > 0 ? (await api.getVersion(doc.id, against)).text : null;
    viewing = n;
    verBody.innerHTML = diffHtml(base, v.text);
    verBody.hidden = false;
    bodyEl.hidden = true;
    notesEl.style.visibility = "hidden";
    $("doc-heading").contentEditable = "false";
    $("vbar-what").textContent = `Viewing v${n} \u00b7 Saved ${when(v.time)}`;
    const others = vlist.filter((x) => x.n !== n).map((x) => x.n);
    $("vbar-against").innerHTML =
      `<option value="0"${against === 0 ? " selected" : ""}>nothing</option>` +
      others.map((o) => `<option value="${o}"${o === against ? " selected" : ""}>v${o}${o === n - 1 ? " (previous)" : ""}</option>`).join("");
    $("vbar").hidden = false;
    renderStepper();
    if (!versionsEl.hidden) renderVersions();
  } catch (e) {
    flash(`Could not open v${n}: ${e}`);
  }
}

function diffHtml(before: string | null, after: string): string {
  // Paragraph breaks travel through the diff as a marker word.
  const flat = (t: string) => t.trim().split(/\n\s*\n/).map((p) => p.trim()).join(" \u00b6 ");
  const segs = before === null ? [{ op: "same" as const, text: flat(after) }] : wordDiff(flat(before), flat(after));
  let html = "<p>";
  for (const seg of segs) {
    seg.text.split(/\s*\u00b6\s*/).forEach((part, k) => {
      if (k && seg.op !== "del") html += "</p><p>"; // a removed break joins paragraphs, as in the newer text
      if (!part) return;
      const t = escapeHtml(part);
      html += (seg.op === "same" ? t : seg.op === "del" ? `<s>${t}</s>` : `<ins>${t}</ins>`) + " ";
    });
  }
  return html.replace(/<p>\s*<\/p>/g, "") + "</p>";
}

function when(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return d.toDateString() === new Date().toDateString() ? `Today, ${time}` : `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}, ${time}`;
}

const KIND_LABEL: Record<string, string> = {
  grammar: "Grammar", spelling: "Spelling", dictation: "Dictation", tighter: "Tighter", wording: "Wording", sentence: "Alternative", dictated: "Dictated",
};

function changeLine(c: { kind: string; from: string; to: string }): string {
  const cut = (t: string) => escapeHtml(t.length > 40 ? `${t.slice(0, 38)}\u2026` : t);
  const what =
    c.kind === "manual"
      ? "Edited by hand"
      : c.kind === "restore"
        ? `Restored from ${escapeHtml(c.to)}`
        : `${KIND_LABEL[c.kind] ?? escapeHtml(c.kind)}: ${c.from ? `${cut(c.from)} &#8594; ` : ""}${cut(c.to)}`;
  return `<div><span class="dot ${escapeHtml(c.kind)}"></span>${what}</div>`;
}

function summary(v: VersionInfo): string {
  if (!v.changes.length) return v.n === 1 ? "First version" : "No changes listed";
  if (v.changes.length === 1 && v.changes[0].kind === "restore") return `Restored from ${escapeHtml(v.changes[0].to)}`;
  return `${v.changes.length} change${v.changes.length === 1 ? "" : "s"}`;
}

function renderVersions(): void {
  const saved = savedCount();
  const edits = doc.changes.length + autoFixes.length;
  const draft = doc.saved
    ? ""
    : `<button class="vrow${viewing === null ? " sel" : ""}" data-n="0"><div class="top"><b>Working draft</b><span>autosaved</span></div><div class="sum">${
        saved ? `${edits ? `${edits} edit${edits === 1 ? "" : "s"}` : doc.typed ? "Edited by hand" : "No edits"} since v${saved}` : "Not saved yet"
      }</div></button>`;
  // Restoring saves the working draft first, so nothing is lost.
  const next = saved + (draftHasWork() ? 2 : 1);
  $("vlist").innerHTML =
    draft +
    vlist
      .map((v) =>
        v.n === viewing
          ? `<div class="vrow sel"><div class="top"><b>v${v.n}</b><span>${when(v.time)}</span></div>${
              v.changes.length ? `<div class="vchanges">${v.changes.map(changeLine).join("")}</div>` : `<div class="sum">${summary(v)}</div>`
            }<div class="vacts"><button class="primary" data-restore="${v.n}">Restore as v${next}</button><button data-n="0">Back to draft</button></div></div>`
          : `<button class="vrow" data-n="${v.n}"><div class="top"><b>v${v.n}</b><span>${when(v.time)}</span></div><div class="sum">${summary(v)}</div></button>`,
      )
      .join("") +
    (vlist.length ? "" : `<div class="sum">No saved versions yet. Save adds one.</div>`);
}

// Unsaved work since the last Save (a Request review alone changes nothing).
function draftHasWork(): boolean {
  return !doc.saved && (doc.typed || doc.changes.length > 0 || autoFixes.length > 0 || savedCount() === 0);
}

async function restore(n: number): Promise<void> {
  // The draft is saved first so nothing is lost, which needs every suggestion settled (S-9 Req 1).
  if (draftHasWork()) {
    const pending = all().length;
    if (pending) {
      flash(`Accept or ignore the ${pending} pending suggestion${pending === 1 ? "" : "s"} first, so the draft can be saved before restoring.`);
      return;
    }
    if (!(await saveReview())) return;
  }
  try {
    const { version } = await api.restoreVersion(doc.id, n);
    await openEditor(doc.id);
    flash(`Restored v${n} as v${version.n}.`);
  } catch (e) {
    flash(`Could not restore: ${e}`);
  }
}

versionsEl.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-n], [data-restore]");
  if (!t) return;
  if (t.dataset.restore) void restore(Number(t.dataset.restore));
  else if (t.dataset.n === "0") showDraft();
  else void showVersion(Number(t.dataset.n));
});
$("vbar-against").addEventListener("change", (e) => viewing && void showVersion(viewing, Number((e.target as HTMLSelectElement).value)));
$("v-label").addEventListener("click", () => (versionsEl.hidden ? void openVersions() : closeVersions()));
$("v-prev").addEventListener("click", () => {
  const to = viewing === null ? (doc.saved ? savedCount() - 1 : savedCount()) : viewing - 1;
  if (to >= 1) void showVersion(to);
});
$("v-next").addEventListener("click", () => {
  if (viewing === null) return;
  if (viewing < savedCount() && !(doc.saved && viewing + 1 === savedCount())) void showVersion(viewing + 1);
  else showDraft();
});


// ---- Suggestion card ----

let current: { s: Suggestion; mark: HTMLElement; tab: Tab; original: string; loading: Tab | null; req: number; key: string; batch: number; previewed: boolean } | null = null;

function openCard(s: Suggestion, mark: HTMLElement): void {
  closeCard();
  current = { s, mark, tab: s.tab ?? "rephrase", original: mark.textContent ?? "", loading: null, req: 0, key: "", batch: 0, previewed: false };
  mark.classList.add("reviewing");
  card.hidden = false;
  const sideTop = card.parentElement!.getBoundingClientRect().top;
  card.style.top = `${Math.max(0, mark.getBoundingClientRect().top - sideTop - 20)}px`;
  showTab(current.tab);
}

// Switch tab, asking the model the first time a tab is shown for this span.
function showTab(tab: Tab): void {
  if (!current) return;
  // Alternatives are for a whole sentence: from a smaller span, move to its sentence.
  if (tab === "sentence" && current.s.kind !== "sentence") {
    const { para, at } = current.s;
    closeCard();
    const sen = sentences(doc.paragraphs[para] ?? "").find((x) => at >= x.start && at < x.start + x.text.length);
    if (sen) openSentenceCard(para, sen);
    return;
  }
  preview(null);
  current.tab = tab;
  renderCard();
  if (!current.s.options?.[tab]?.length) void fetchOptions();
}

// The sentence around a span, which the model needs to keep a rewrite fitting (S-6 Req 2).
function sentenceAround(para: number, at: number): string {
  const p = doc.paragraphs[para] ?? "";
  return sentences(p).find((x) => at >= x.start && at < x.start + x.text.length)?.text ?? p;
}

const BATCH: Record<Tab, number> = { rephrase: 3, substitute: 5, sentence: 3 };

// Ask for a batch of options; earlier ones are excluded so More never repeats (Req 5).
async function fetchOptions(): Promise<void> {
  if (!current || current.loading === current.tab) return;
  const c = current;
  const { s, tab } = c;
  const have = s.options?.[tab] ?? [];
  const exclude = have.map((o) => o.text);
  const span = c.original;
  // Each request has its own key, so options streamed by an older one are never taken for this one.
  if (c.loading) void api.cancel(c.key).catch(() => {});
  const req = ++c.req;
  const key = `card-${s.id}-${req}`;
  c.key = key;
  const batch = 1 + Math.max(0, ...have.map((o) => o.batch ?? 0));
  c.batch = batch;
  c.loading = tab;
  renderCard();
  try {
    const context = sentenceAround(s.para, s.at);
    const fresh =
      tab === "substitute"
        ? await api.substitute(span, context, BATCH[tab], exclude, key)
        : tab === "rephrase"
          ? await api.rephrase(span, context, BATCH[tab], exclude, key)
          : await api.alternatives(span, BATCH[tab], exclude, key);
    // Streamed options are already in; add any the stream missed.
    for (const o of fresh) addOption(s, tab, o, batch, exclude);
    if (!fresh.length) flash("No new options this time. Try More again.");
  } catch (e) {
    if (String(e).includes("models-missing")) offerDownload();
    else if (!String(e).includes("cancelled")) flash(`Could not get options: ${e}`);
  } finally {
    if (c.req === req) c.loading = null;
    if (current === c) renderCard();
  }
}

function addOption(s: Suggestion, tab: Tab, o: Opt, batch: number, exclude: string[]): boolean {
  const list = s.options?.[tab] ?? [];
  if (exclude.includes(o.text) || list.some((x) => x.text === o.text)) return false;
  s.options = { ...s.options, [tab]: [...list, { ...o, batch }] };
  return true;
}

// Options arrive one by one while the model writes them (S-4 Req 4), so the first shows in seconds.
api.on<{ key: string; option: Opt }>("option", ({ key, option }) => {
  const c = current;
  if (!c || !c.loading || key !== c.key) return;
  const prior = (c.s.options?.[c.loading] ?? []).filter((o) => (o.batch ?? 0) < c.batch).map((o) => o.text);
  if (addOption(c.s, c.loading, option, c.batch, prior) && c.tab === c.loading) renderCard();
});

function renderCard(): void {
  if (!current) return;
  const { s, tab } = current;
  card.querySelectorAll<HTMLButtonElement>("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  const opts = visible();
  optionsEl.className = `options${tab === "substitute" ? "" : " list"}`;
  optionsEl.innerHTML =
    opts
      .map(({ o, i }) =>
        tab === "sentence"
          ? // Alternatives show what they change, and can be pinned while trying more (S-7 Req 3, 4).
            `<div class="opt-row"><button class="opt" data-i="${i}">${changedWords(current!.original, o.text)
              .map((w) => (w.changed ? `<b class="chg">${escapeHtml(w.text)}</b>` : escapeHtml(w.text)))
              .join(" ")}</button><button class="pin" data-i="${i}" aria-pressed="${Boolean(o.pinned)}" title="Keep this one while trying more">${o.pinned ? "Pinned" : "Pin"}</button></div>`
          : `<button class="opt" data-i="${i}">${escapeHtml(o.text)}</button>`,
      )
      .join("") +
    (current.loading === tab ? `<div class="hint">Thinking\u2026</div>` : opts.length ? "" : `<div class="hint">No ${tab} options yet. Press More.</div>`);
  $<HTMLButtonElement>("more").disabled = current.loading === tab;
  setHint(opts[0]?.o);
}

// The options on show: all of them, or for alternatives the latest batch plus pinned ones.
function visible(): { o: Option; i: number }[] {
  if (!current) return [];
  const all = (current.s.options?.[current.tab] ?? []).map((o, i) => ({ o, i }));
  if (current.tab !== "sentence") return all;
  const last = Math.max(0, ...all.map(({ o }) => o.batch ?? 0));
  return all.filter(({ o }) => o.pinned || (o.batch ?? 0) === last);
}

function setHint(o: Option | undefined): void {
  const n = Math.min(visible().length, 5);
  const keys = n ? `Hover to preview, 1-${n} to pick.` : "";
  $("hint").textContent = o?.note ? `${o.text}: ${o.note}. ${keys}` : keys;
}

function preview(text: string | null): void {
  if (!current) return;
  current.mark.textContent = text ?? current.original;
  current.mark.classList.toggle("preview", text !== null);
  if (text !== null) current.previewed = true;
}

function closeCard(restore = true): void {
  if (current) {
    if (current.loading) void api.cancel(current.key).catch(() => {});
    if (restore) preview(null);
    current.mark.classList.remove("reviewing");
  }
  const was = current;
  current = null;
  card.hidden = true;
  if (was) document.dispatchEvent(new Event("cader:closed"));
  // A preview flattens any issue marks inside the span; draw them again.
  if (was?.previewed && restore) renderKeepingCaret();
}

card.querySelectorAll<HTMLButtonElement>("[role=tab]").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab as Tab)),
);

optionsEl.addEventListener("mouseover", (e) => {
  const o = (e.target as HTMLElement).closest<HTMLElement>(".opt");
  if (!o || !current) return;
  const opt = current.s.options![current.tab]![Number(o.dataset.i)];
  preview(opt.text);
  setHint(opt);
});
optionsEl.addEventListener("mouseleave", () => preview(null));
optionsEl.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const pin = t.closest<HTMLElement>(".pin");
  if (pin && current) {
    e.stopPropagation(); // the re-render detaches the button, which would read as an outside click
    const o = current.s.options![current.tab]![Number(pin.dataset.i)];
    o.pinned = !o.pinned;
    renderCard();
    return;
  }
  const o = t.closest<HTMLElement>(".opt");
  if (o && current) pick(Number(o.dataset.i));
});

function pick(i: number): void {
  if (!current) return;
  const opt = current.s.options?.[current.tab]?.[i];
  if (opt) apply(current.s, opt.text);
}

// Number keys pick among the options on show.
function pickShown(k: number): void {
  const shown = visible()[k];
  if (shown) pick(shown.i);
}

$("more").addEventListener("click", () => void fetchOptions());

$("ignore").addEventListener("click", () => current && resolve(current.s));

// ---- Applying and resolving ----

function apply(s: Suggestion, text: string): void {
  const p = doc.paragraphs[s.para];
  doc.changes.push({ kind: s.kind, from: s.text, to: text, time: Date.now() });
  if (s.proof) {
    // Replace inside the sentence, which keeps its correction as the target for what is left.
    const { sentence, start, at, corr } = s.proof;
    const next = applyEdit(sentence, { at, from: s.text, to: text });
    corrections.set(next, corr);
    doc.paragraphs[s.para] = p.slice(0, start) + next + p.slice(start + sentence.length);
  } else {
    doc.paragraphs[s.para] = p.slice(0, s.at) + text + p.slice(s.at + s.text.length);
  }
  resolve(s);
  persist();
}

function resolve(s: Suggestion): void {
  closeCard(false);
  suggestions = suggestions.filter((x) => x.id !== s.id);
  renderDoc();
}

function ignore(s: Suggestion): void {
  if (s.proof) ignored.add(s.proof.key);
  resolve(s);
}

// Apply every remaining fix: card fixes first, then each sentence's corrections, last first.
function acceptAll(): void {
  for (const s of suggestions.filter((x) => x.fix !== undefined).sort((a, b) => b.at - a.at)) {
    const p = doc.paragraphs[s.para];
    doc.paragraphs[s.para] = p.slice(0, s.at) + s.fix + p.slice(s.at + s.text.length);
  }
  suggestions = suggestions.filter((x) => x.fix === undefined);
  doc.paragraphs = doc.paragraphs.map((p, para) => {
    if (para === doc.live) return p;
    for (const sen of sentences(p).reverse()) {
      const corr = corrections.get(sen.text);
      if (corr === undefined) continue;
      const edits = diff(sen.text, corr).filter((e) => e.from && !ignored.has(`${corr}|${e.from}|${e.to}`));
      const next = edits.reverse().reduce((acc, e) => applyEdit(acc, e), sen.text);
      corrections.set(next, corr);
      p = p.slice(0, sen.start) + next + p.slice(sen.start + sen.text.length);
    }
    return p;
  });
  renderDoc();
  persist();
}

// ---- Auto-fixed list: review and undo (S-5 Req 6) ----

const autoList = $("autofixed-list");

function toggleAuto(open: boolean): void {
  autoList.hidden = !open;
  $("autofixed").setAttribute("aria-expanded", String(open));
}

$("autofixed").addEventListener("click", (e) => {
  e.stopPropagation();
  togglePending(false);
  toggleAuto(autoList.hidden);
});

autoList.addEventListener("click", (e) => {
  e.stopPropagation();
  const b = (e.target as HTMLElement).closest<HTMLElement>(".undo");
  if (!b) return;
  const f = autoFixes[Number(b.dataset.i)];
  autoFixes = autoFixes.filter((x) => x !== f);
  doc.autoFixed = autoFixes.length;
  ignored.add(`${f.corr}|${f.from}|${f.to}`);
  doc.paragraphs = doc.paragraphs.map((p) => {
    for (const sen of sentences(p)) {
      if (corrections.get(sen.text) !== f.corr) continue;
      const m = wordRe(f.to).exec(sen.text);
      if (!m) continue;
      const next = applyEdit(sen.text, { at: m.index + m[1].length, from: f.to, to: f.from });
      corrections.set(next, f.corr);
      return p.slice(0, sen.start) + next + p.slice(sen.start + sen.text.length);
    }
    return p;
  });
  renderDoc();
  persist();
});

bodyEl.addEventListener("click", (e) => {
  const mark = (e.target as HTMLElement).closest<HTMLElement>(".mark");
  if (!mark) return;
  const s = all().find((x) => x.id === mark.dataset.id);
  if (!s) return;
  if (s.fix !== undefined) jumpTo(s.id);
  else openCard(s, mark);
});

// Selecting any other text opens the card for that selection (options arrive with S-6).
bodyEl.addEventListener("mouseup", () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !bodyEl.contains(sel.anchorNode)) return;
  const text = sel.toString().trim();
  if (!text || text.length > 200) return;
  const range = sel.getRangeAt(0);
  if ((range.commonAncestorContainer as HTMLElement).closest?.(".mark")) return;
  const mark = document.createElement("span");
  mark.className = "mark";
  try {
    range.surroundContents(mark);
  } catch {
    return; // selection crosses paragraphs
  }
  sel.removeAllRanges();
  const pEl = mark.closest("p")!;
  const para = [...bodyEl.children].indexOf(pEl);
  const before = document.createRange();
  before.setStart(pEl, 0);
  before.setEndBefore(mark);
  const s: Suggestion = { id: `sel-${Date.now()}`, kind: "wording", para, at: before.toString().length, text, label: `“${text}”`, tab: "rephrase", options: {} };
  openTransient(s, mark);
});

// A selection or sentence card is not a pending suggestion; its mark goes when the card closes.
function openTransient(s: Suggestion, mark: HTMLElement): void {
  mark.dataset.id = s.id;
  openCard(s, mark);
  const unwrap = () => {
    if (!current || current.s !== s) {
      if (mark.isConnected) {
        mark.replaceWith(...mark.childNodes);
        bodyEl.normalize();
      }
      document.removeEventListener("cader:closed", unwrap);
    }
  };
  document.addEventListener("cader:closed", unwrap);
}

// ---- Sentence alternatives (S-7) ----

// A DOM range over [start, end) of a paragraph's text.
function rangeAt(pEl: Element, start: number, end: number): Range | null {
  const walk = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0;
  let begun = false;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = n.textContent!.length;
    if (!begun && start <= pos + len) {
      r.setStart(n, start - pos);
      begun = true;
    }
    if (begun && end <= pos + len) {
      r.setEnd(n, end - pos);
      return r;
    }
    pos += len;
  }
  return null;
}

function openSentenceCard(para: number, sen: { text: string; start: number }): void {
  const pEl = bodyEl.children[para];
  const r = pEl && rangeAt(pEl, sen.start, sen.start + sen.text.length);
  if (!r || r.toString() !== sen.text) return;
  const mark = document.createElement("span");
  mark.className = "mark sentence";
  try {
    r.surroundContents(mark);
  } catch {
    return; // an issue mark straddles the sentence edge
  }
  const s: Suggestion = { id: `sen-${Date.now()}`, kind: "sentence", para, at: sen.start, text: sen.text, label: "Other ways to say this", tab: "sentence", options: {} };
  openTransient(s, mark);
}

// Resting the caret in a finished sentence lists alternatives for it (Req 1). Not while typing
// or dictating, and not on an issue mark, which has its own card.
let dwellTimer = 0;
let lastInput = 0;
document.addEventListener("selectionchange", () => {
  clearTimeout(dwellTimer);
  dwellTimer = window.setTimeout(() => {
    const sel = window.getSelection();
    if (!sel?.isCollapsed || !bodyEl.contains(sel.focusNode) || current || recState !== "idle") return;
    if (Date.now() - lastInput < 2500 || !pendingList.hidden || !autoList.hidden) return;
    if ((sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode?.parentElement)?.closest(".mark")) return;
    const c = caretAt();
    if (!c || c.para === doc.live) return;
    const sen = sentences(doc.paragraphs[c.para] ?? "").find((x) => c.off > x.start && c.off < x.start + x.text.length);
    if (!sen || !/[.!?]["'\u201d\u2019)\]]*$/.test(sen.text) || sen.text.split(/\s+/).length < 4) return;
    openSentenceCard(c.para, sen);
  }, 900);
});

// ---- Keyboard ----

document.addEventListener("keydown", (e) => {
  if (!$("reader").hidden) return readerKey(e);
  const k = e.key.toLowerCase();
  if (e.metaKey && e.shiftKey && doc.saved && !$("editor").hidden && (k === "c" || k === "r")) {
    e.preventDefault();
    void exportAs(k === "c" ? "copy" : "read");
    return;
  }
  if (e.key === "Escape") {
    if (!exportMenu.hidden) toggleExport(false);
    else if (!versionsEl.hidden) closeVersions();
    else if (viewing !== null) showDraft();
    else if (!pendingList.hidden) togglePending(false);
    else if (!autoList.hidden) toggleAuto(false);
    else if (current) closeCard();
    return;
  }
  if (!current) return;
  if (/^[1-5]$/.test(e.key)) {
    e.preventDefault();
    pickShown(Number(e.key) - 1);
  } else if (e.metaKey && (e.key === "r" || e.key === "e")) {
    e.preventDefault();
    showTab(e.key === "r" ? "rephrase" : "substitute");
  }
});

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!pendingList.hidden && !t.closest(".pending-wrap")) togglePending(false);
  if (!autoList.hidden && !t.closest(".pending-wrap")) toggleAuto(false);
  if (current && !t.closest(".card") && !t.closest(".mark")) closeCard();
});

// ---- Dictation (S-3): record button, hotkey, and inserting the transcript ----

const rec = $<HTMLButtonElement>("rec");
const recTime = $("rec-time");
let recStart = 0;
let recTimer = 0;
let recState: "idle" | "recording" | "transcribing" = "idle";

// Where the transcript goes: the last caret position inside the document, if any (Req 4).
let caret: Range | null = null;
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && bodyEl.contains(sel.anchorNode)) caret = sel.getRangeAt(0).cloneRange();
});

function setRecState(next: typeof recState, label = ""): void {
  recState = next;
  rec.classList.toggle("on", next === "recording");
  rec.classList.toggle("busy", next === "transcribing");
  rec.setAttribute("aria-label", next === "recording" ? "Stop recording" : "Start recording");
  clearInterval(recTimer);
  if (next === "recording") {
    recStart = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    recTimer = window.setInterval(tick, 250);
  } else {
    recTime.textContent = label;
  }
}

async function toggleRecording(): Promise<void> {
  if (viewing !== null) closeVersions(); // dictation goes into the working draft
  if (!doc.id || recState === "transcribing") return;
  if (recState === "idle") {
    closeCard();
    try {
      const started = await api.startRecording(doc.id);
      if (started) setRecState("recording");
    } catch (e) {
      setRecState("idle", String(e));
    }
    return;
  }
  setRecState("transcribing", "Transcribing\u2026");
  try {
    const text = await api.stopRecording();
    setRecState("idle");
    if (text) insertTranscript(text);
  } catch (e) {
    setRecState("idle", String(e));
  }
}

function insertTranscript(text: string): void {
  const inBody = caret && bodyEl.contains(caret.startContainer);
  if (inBody) {
    const r = caret!;
    r.deleteContents();
    const before = r.startContainer.textContent?.slice(0, r.startOffset) ?? "";
    const node = document.createTextNode((before && !/\s$/.test(before) ? " " : "") + text);
    r.insertNode(node);
    r.setStartAfter(node);
    r.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  } else {
    // Nothing focused: append at the end of the document.
    const last = bodyEl.querySelector("p:last-of-type");
    if (last && (last.textContent ?? "").trim()) {
      const p = document.createElement("p");
      p.textContent = text;
      bodyEl.appendChild(p);
    } else if (last) {
      last.textContent = text;
    }
  }
  doc.paragraphs = readParagraphs();
  doc.changes.push({ kind: "dictated", from: "", to: text, time: Date.now() });
  persist();
}

rec.addEventListener("click", () => void toggleRecording());
// Keep focus (and the caret) in the document when the button is pressed.
rec.addEventListener("mousedown", (e) => e.preventDefault());
api.on("dictation-toggle", () => void toggleRecording());

api.on<DictationEvent>("dictation", (e) => {
  if (e.state === "downloading") setRecState("idle", `Downloading speech model ${Math.round(e.progress * 100)}%`);
  else if (e.state === "ready" && recState === "idle" && recTime.textContent?.startsWith("Downloading")) setRecState("idle", "Speech model ready. Press to dictate.");
  else if (e.state === "micDenied") {
    recTime.innerHTML = `Cader can't hear the microphone. <button class="link" id="mic-settings">Open Settings</button>`;
    $("mic-settings").addEventListener("click", () => api.openMicSettings());
  } else if (e.state === "error") setRecState("idle", e.message);
});

// ---- Proofreading (S-5) ----

const proofBtn = $<HTMLButtonElement>("proofread");
let checking = false;
let checkAgain = false;
let checkTimer = 0;
let proofPass = 0; // Save ends the pass; a check still running for an older pass stops

// The caret's paragraph and text offset, so a re-render does not lose the user's place.
function caretAt(): { para: number; off: number } | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !bodyEl.contains(sel.focusNode)) return null;
  const pEl = (sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode!.parentElement)?.closest("p");
  if (!pEl) return null;
  const r = document.createRange();
  r.setStart(pEl, 0);
  r.setEnd(sel.focusNode!, sel.focusOffset);
  return { para: [...bodyEl.children].indexOf(pEl), off: r.toString().length };
}

function restoreCaret(c: { para: number; off: number } | null): void {
  const pEl = c && bodyEl.children[c.para];
  if (!pEl) return;
  lastInput = Date.now(); // not the user placing the caret, so no sentence card (S-7)
  const walk = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT);
  let left = c.off;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = n.textContent!.length;
    if (left <= len) {
      const sel = window.getSelection()!;
      sel.collapse(n, left);
      return;
    }
    left -= len;
  }
}

function renderKeepingCaret(): void {
  const c = document.activeElement === bodyEl ? caretAt() : null;
  renderDoc();
  restoreCaret(c);
}

// Sentences without a correction yet. While typing, the sentence under the caret waits.
function unchecked(full: boolean): { para: number; text: string; last: boolean }[] {
  const c = full || document.activeElement !== bodyEl ? null : caretAt();
  const out: { para: number; text: string; last: boolean }[] = [];
  doc.paragraphs.forEach((p, para) => {
    if (para === doc.live) return;
    const list = sentences(p);
    list.forEach((sen, k) => {
      if (corrections.has(sen.text)) return;
      if (c && c.para === para && c.off >= sen.start && c.off <= sen.start + sen.text.length) return;
      out.push({ para, text: sen.text, last: k === list.length - 1 });
    });
  });
  return out;
}

async function check(full: boolean): Promise<void> {
  if (!proofed) return;
  if (checking) {
    checkAgain = true;
    return;
  }
  checking = true;
  const pass = proofPass;
  try {
    const todo = unchecked(full);
    if (full) proofBtn.disabled = true;
    for (let k = 0; k < todo.length; k++) {
      if (!doc.id || pass !== proofPass) return;
      if (full) setStatus(`Proofreading ${k + 1} of ${todo.length}\u2026`);
      const t = todo[k];
      let corr: string;
      try {
        document.documentElement.dataset.modelCalls = String(++modelCalls);
        corr = await api.correct(t.text, `proof-${t.para}-${k}`);
        if (pass !== proofPass) return;
      } catch (e) {
        if (String(e).includes("models-missing")) offerDownload();
        else if (!String(e).includes("cancelled")) flash(`Proofread failed: ${e}`);
        return;
      }
      // A rewrite far from the original is not a correction; keep the dictation clean-up only.
      const ratio = corr.length / Math.max(1, t.text.length);
      corr = dictationFixes(ratio < 0.5 || ratio > 1.6 ? t.text : corr, t.last);
      corrections.set(t.text, corr);
      autoApply(t.para, t.text, corr);
      renderKeepingCaret();
    }
    if (full) flash(issues().length ? `Proofread done: ${issues().length} to review.` : "Proofread done. No issues found.");
  } finally {
    checking = false;
    proofBtn.disabled = false;
    if (checkAgain) {
      checkAgain = false;
      // A check asked for in a newer pass (Request review) runs in full; check() skips it if no pass is open.
      void check(pass !== proofPass);
    }
  }
}

// Obvious misspellings are fixed without asking and listed under "auto-fixed" (Req 6).
function autoApply(para: number, sentence: string, corr: string): void {
  const p = doc.paragraphs[para];
  const sen = p !== undefined && sentences(p).find((x) => x.text === sentence);
  if (!sen) return;
  const autos = diff(sentence, corr).filter((e) => e.auto && !ignored.has(`${corr}|${e.from}|${e.to}`));
  if (!autos.length) return;
  const next = [...autos].reverse().reduce((acc, e) => applyEdit(acc, e), sentence);
  corrections.set(next, corr);
  doc.paragraphs[para] = p.slice(0, sen.start) + next + p.slice(sen.start + sentence.length);
  autoFixes.push(...autos.map((e) => ({ corr, from: e.from, to: e.to })));
  doc.autoFixed = autoFixes.length;
  persist();
}

function scheduleCheck(): void {
  if (!proofed) return;
  clearTimeout(checkTimer);
  checkTimer = window.setTimeout(() => void check(false), 900);
}

proofBtn.addEventListener("click", () => {
  proofed = true;
  void check(true);
});

// The writing models are a one-time 9.8 GB download (S-4).
function offerDownload(): void {
  setStatus(`The writing models are not downloaded yet (9.8 GB). <button class="link" id="get-models">Download</button>`, true);
  $("get-models").addEventListener("click", () => void api.modelsDownload());
}

api.on<ModelsEvent>("models", (e) => {
  if (e.state === "downloading") setStatus(`Downloading writing models ${Math.round(e.progress * 100)}%`);
  else if (e.state === "error") setStatus(e.message);
  else if (e.state === "ready") {
    flash("Writing models ready.");
    if (proofed) void check(true);
  }
});

// ---- Status line ----

let flashTimer = 0;
// A status that stays until replaced (progress, prompts).
function setStatus(msg: string, html = false): void {
  clearTimeout(flashTimer);
  const el = $("status");
  if (html) el.innerHTML = msg;
  else el.textContent = msg;
}

function flash(msg: string): void {
  const el = $("status");
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (el.textContent = idleStatus()), 2600);
}

// ---- Opening, editing and saving documents ----

const PREFIX = "\n\n";

export async function openEditor(id: string): Promise<void> {
  closeCard();
  if (!versionsEl.hidden || viewing !== null) closeVersions();
  togglePending(false);
  const { meta, text } = await api.openDoc(id);
  doc.id = meta.id;
  doc.title = meta.title;
  doc.paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const saved = await api.listVersions(id).catch(() => []);
  doc.saved = meta.status === "saved" && saved.length > 0;
  doc.savedAt = saved[0]?.time ?? 0;
  doc.version = doc.versions = saved.length + (doc.saved ? 0 : 1);
  doc.typed = false;
  // Sample suggestions belong to the example text only; drop any whose span is gone.
  suggestions = [];
  if (meta.sample)
    for (const s of SAMPLE_SUGGESTIONS) {
      const m = doc.paragraphs[s.para] !== undefined && wordRe(s.text).exec(doc.paragraphs[s.para]);
      if (m) suggestions.push({ ...s, options: structuredClone(s.options), at: m.index + m[1].length });
    }
  doc.live = meta.sample && suggestions.some((s) => s.id === "s5") ? 3 : -1;
  proofed = false;
  doc.changes = [];
  ignored.clear();
  autoFixes = [];
  doc.autoFixed = 0;
  $("library").hidden = true;
  $("editor").hidden = false;
  document.body.classList.remove("in-library");
  renderDoc();
  flash("");
  if (!doc.paragraphs.length) bodyEl.focus();
}

function readParagraphs(): string[] {
  return [...bodyEl.querySelectorAll("p")].map((p) => (p.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
}

let saveTimer = 0;
let dirty = false;
function persist(): void {
  if (!doc.id) return;
  dirty = true;
  // The first change after a Save starts the next review.
  if (doc.saved) {
    doc.saved = false;
    doc.version = doc.versions += 1;
    renderPending();
  }
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      await api.saveText(doc.id, doc.paragraphs.join(PREFIX) + "\n");
      dirty = false;
      flash("");
    } catch (e) {
      flash(`Could not save: ${e}`);
    }
  }, 400);
}

// Typing changes the text; marks stay in place until the next render.
bodyEl.addEventListener("input", () => {
  lastInput = Date.now();
  // Typing into a sentence under review ends that review.
  if (current?.s.id.startsWith("sen-")) closeCard();
  doc.paragraphs = readParagraphs();
  doc.typed = true;
  persist();
  scheduleCheck();
});
// Leaving a sentence lets it be checked (the one under the caret waits while typing).
bodyEl.addEventListener("blur", scheduleCheck);
document.addEventListener("keyup", (e) => {
  if (e.key.startsWith("Arrow") && document.activeElement === bodyEl) scheduleCheck();
});
bodyEl.addEventListener("mouseup", scheduleCheck);

// Paste as plain text so no outside markup lands in the document.
bodyEl.addEventListener("paste", (e) => {
  e.preventDefault();
  document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
});

// The heading is the title: editing it renames the document.
const heading = $("doc-heading");
heading.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    heading.blur();
  }
});
heading.addEventListener("blur", async () => {
  const title = (heading.textContent ?? "").trim();
  if (!doc.id || title === doc.title) return;
  if (!title) {
    heading.textContent = doc.title;
    return;
  }
  try {
    const meta: DocMeta = await api.renameDoc(doc.id, title);
    doc.title = meta.title;
    $("doc-title").textContent = doc.title;
    document.title = `${doc.title} - Cader`;
  } catch (e) {
    heading.textContent = doc.title;
    flash(`Could not rename: ${e}`);
  }
});

$("to-library").addEventListener("click", async () => {
  clearTimeout(saveTimer);
  if (doc.id && dirty) await api.saveText(doc.id, readParagraphs().join(PREFIX) + "\n").catch(() => {});
  dirty = false;
  closeCard();
  togglePending(false);
  toggleAuto(false);
  clearTimeout(checkTimer);
  doc.id = "";
  await showLibrary();
});

window.addEventListener("resize", renderNotes);
showLibrary();
