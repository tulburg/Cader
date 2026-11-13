// The library view (S-1 Req 4): list documents, and create, open, rename and delete them.

import { api, type DocKind, type DocMeta } from "./api";
import { openEditor } from "./main";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $("docs");

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function edited(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// The latest saved version and when (S-9 Req 6); a draft says what it builds on.
function saved(d: DocMeta): string {
  // Documents saved before the version number was kept in their metadata have no savedN.
  if (!d.savedN) return d.status === "saved" ? "Saved" : "Draft";
  return d.status === "saved" ? `Saved v${d.savedN} \u00b7 ${edited(d.savedAt)}` : `Draft \u00b7 v${d.savedN} saved ${edited(d.savedAt)}`;
}

export async function showLibrary(): Promise<void> {
  $("editor").hidden = true;
  $("library").hidden = false;
  document.body.classList.add("in-library");
  document.title = "Cader";
  let docs: DocMeta[];
  try {
    docs = await api.listDocs();
  } catch (e) {
    list.innerHTML = `<li class="lib-empty">Could not read the library: ${escapeHtml(String(e))}</li>`;
    return;
  }
  list.innerHTML = docs.length
    ? docs
        .map(
          (d) => `<li class="row" data-id="${escapeHtml(d.id)}">
  <button class="t" data-act="open" title="Open">${escapeHtml(d.title)}</button>
  <span class="k">${d.kind === "speech" ? "Speech" : "Blog"}</span>
  <span>${edited(d.updated)}</span>
  <span class="st ${d.status}">${saved(d)}</span>
  <span class="ops"><button data-act="rename">Rename</button><button data-act="delete">Delete</button></span>
</li>`,
        )
        .join("")
    : `<li class="lib-empty">No documents yet. Start a speech or a blog post.</li>`;
}

document.querySelectorAll<HTMLButtonElement>(".new").forEach((b) =>
  b.addEventListener("click", async () => {
    const kind = b.dataset.kind as DocKind;
    const meta = await api.createDoc(kind === "speech" ? "Untitled speech" : "Untitled post", kind);
    await openEditor(meta.id);
    // Select the placeholder title so typing replaces it.
    const h = $("doc-heading");
    const range = document.createRange();
    range.selectNodeContents(h);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    h.focus();
  }),
);

list.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  const row = btn?.closest<HTMLElement>(".row");
  if (!btn || !row) return;
  const id = row.dataset.id!;
  const act = btn.dataset.act;
  if (act === "open") return openEditor(id);
  if (act === "rename") return startRename(row, id);
  if (act === "delete") return confirmDelete(row, id);
  if (act === "confirm-delete") {
    await api.deleteDoc(id);
    return showLibrary();
  }
  if (act === "cancel") return showLibrary();
});

function startRename(row: HTMLElement, id: string): void {
  const title = row.querySelector<HTMLElement>(".t")!;
  const input = document.createElement("input");
  input.value = title.textContent ?? "";
  input.setAttribute("aria-label", "Title");
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (save && next && next !== title.textContent) await api.renameDoc(id, next).catch(() => {});
    await showLibrary();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// Deleting asks once in the row; the folder goes to the library's .trash, not away for good.
function confirmDelete(row: HTMLElement, id: string): void {
  row.classList.add("confirming");
  row.querySelector(".ops")!.innerHTML = `<button data-act="confirm-delete" class="danger">Move to trash</button><button data-act="cancel">Cancel</button>`;
  row.querySelector<HTMLButtonElement>("[data-act=cancel]")!.focus();
  void id;
}
