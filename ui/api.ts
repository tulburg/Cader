// Typed access to the Rust backend (S-1 Req 5). The webview reaches documents only through
// these commands. Outside Tauri (the browser preview) an in-memory library stands in.

export type DocKind = "speech" | "blog";

export interface DocMeta {
  id: string;
  title: string;
  kind: DocKind;
  status: "draft" | "saved";
  created: number;
  updated: number;
  sample: boolean;
  savedN: number; // the latest saved version, 0 when never saved (S-9 Req 6)
  savedAt: number;
}

export interface Doc {
  meta: DocMeta;
  text: string;
}

export type DictationEvent =
  | { state: "downloading"; progress: number }
  | { state: "ready" | "recording" | "transcribing" | "micDenied" }
  | { state: "error"; message: string };

export type ModelsEvent =
  | { state: "downloading"; progress: number }
  | { state: "ready" }
  | { state: "error"; message: string };

export interface Opt {
  text: string;
  note?: string;
}

// Saved versions (S-8).
export interface Change {
  kind: string;
  from: string;
  to: string;
}

export interface VersionInfo {
  n: number;
  time: number;
  changes: Change[];
}

export interface Version extends VersionInfo {
  text: string;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;

const tauri = (window as unknown as { __TAURI__?: { core: { invoke: Invoke }; event: { listen: Listen } } }).__TAURI__;

export const inTauri = Boolean(tauri);

export const api = {
  listDocs: () => call<DocMeta[]>("list_docs"),
  createDoc: (title: string, kind: DocKind) => call<DocMeta>("create_doc", { title, kind }),
  openDoc: (id: string) => call<Doc>("open_doc", { id }),
  saveText: (id: string, text: string) => call<DocMeta>("save_text", { id, text }),
  renameDoc: (id: string, title: string) => call<DocMeta>("rename_doc", { id, title }),
  deleteDoc: (id: string) => call<void>("delete_doc", { id }),
  // Dictation (S-3). startRecording is false when it began the model download instead.
  startRecording: (doc: string) => call<boolean>("start_recording", { doc }),
  stopRecording: () => call<string>("stop_recording"),
  openMicSettings: () => call<void>("open_mic_settings"),
  // Writing models (S-4). Calls reject with "models-missing" until modelsDownload finishes.
  modelsStatus: () => call<{ ready: boolean; downloading: boolean }>("models_status"),
  modelsDownload: () => call<void>("models_download"),
  correct: (text: string, key: string) => call<string>("correct", { text, key }),
  rephrase: (span: string, context: string, n: number, exclude: string[], key: string) => call<Opt[]>("rephrase", { span, context, n, exclude, key }),
  substitute: (span: string, context: string, n: number, exclude: string[], key: string) => call<Opt[]>("substitute", { span, context, n, exclude, key }),
  alternatives: (sentence: string, n: number, exclude: string[], key: string) => call<Opt[]>("alternatives", { sentence, n, exclude, key }),
  cancel: (key: string) => call<void>("cancel", { key }),
  saveVersion: (id: string, text: string, changes: Change[]) => call<{ version: VersionInfo; meta: DocMeta }>("save_version", { id, text, changes }),
  listVersions: (id: string) => call<VersionInfo[]>("list_versions", { id }),
  getVersion: (id: string, n: number) => call<Version>("get_version", { id, n }),
  restoreVersion: (id: string, n: number) => call<{ version: VersionInfo; meta: DocMeta }>("restore_version", { id, n }),
  // Export (S-9): a saved version to ~/Downloads (returns the path), or the print dialog for PDF.
  exportVersion: (id: string, n: number, ext: "md" | "txt") => call<string>("export_version", { id, n, ext }),
  printPage: () => call<void>("print_page"),
  on<T>(event: string, cb: (payload: T) => void): void {
    if (tauri) void tauri.event.listen<T>(event, (e) => cb(e.payload));
    else (local[event] ??= []).push(cb as (p: unknown) => void);
  },
};

// Events raised by the browser stand-in.
const local: Record<string, ((p: unknown) => void)[]> = {};
const emit = (event: string, payload: unknown) => local[event]?.forEach((cb) => cb(payload));

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauri ? tauri.core.invoke<T>(cmd, args) : (memory(cmd, args ?? {}) as Promise<T>);
}

// ---- Browser preview stand-in ----

const SAMPLE_TEXT = [
  "Good evening, and thank you all for coming. When this building first opened its doors in 1962, the town was smaller, the river was cleaner, and the idea of a public library was very important to the families who lived here.",
  "Tonight we are not just reopening a building. We are keeping a promise that was made to every child who ever sat cross-legged on that carpet and found a world inside a book.",
  "The people who has worked on this renovation gave more than their time. They gave their weekends, their patience, and in a few cases, their actual blood, sweat and tears when the old shelves came down.",
  "So let me begin with a simple thank you to the volunteers",
].join("\n\n");

const store = new Map<string, Doc>();
const versions = new Map<string, Version[]>();
{
  const t = Date.now();
  const meta: DocMeta = { id: "sample", title: "Remarks for the Riverside Library Opening", kind: "speech", status: "draft", created: t, updated: t, sample: true, savedN: 0, savedAt: 0 };
  store.set(meta.id, { meta, text: SAMPLE_TEXT });
}

async function memory(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  const get = (id: unknown) => {
    const d = store.get(String(id));
    if (!d) throw new Error(`No document ${id}`);
    return d;
  };
  const touch = (d: Doc) => ((d.meta.updated = Date.now()), { ...d.meta });
  switch (cmd) {
    case "list_docs":
      return [...store.values()].map((d) => ({ ...d.meta })).sort((x, y) => y.updated - x.updated);
    case "create_doc": {
      const t = Date.now();
      const meta: DocMeta = { id: `doc-${t}`, title: String(a.title).trim() || "Untitled", kind: a.kind as DocKind, status: "draft", created: t, updated: t, sample: false, savedN: 0, savedAt: 0 };
      store.set(meta.id, { meta, text: "" });
      return { ...meta };
    }
    case "open_doc": {
      const d = get(a.id);
      return { meta: { ...d.meta }, text: d.text };
    }
    case "save_text": {
      const d = get(a.id);
      d.text = String(a.text);
      d.meta.status = versions.get(d.meta.id)?.at(-1)?.text === d.text ? "saved" : "draft";
      return touch(d);
    }
    case "rename_doc": {
      const d = get(a.id);
      const title = String(a.title).trim();
      if (!title) throw new Error("A title cannot be empty");
      d.meta.title = title;
      return touch(d);
    }
    case "start_recording":
      return true;
    case "stop_recording":
      return "and to every reader who came back";
    case "open_mic_settings":
      return;
    case "save_version":
    case "restore_version": {
      const d = get(a.id);
      const list = versions.get(d.meta.id) ?? [];
      const old = cmd === "restore_version" ? list.find((v) => v.n === a.n) : undefined;
      if (cmd === "restore_version" && !old) throw new Error(`No version ${a.n}`);
      const v: Version = {
        n: list.length + 1,
        time: Date.now(),
        text: old ? old.text : String(a.text),
        changes: old ? [{ kind: "restore", from: "", to: `v${old.n}` }] : (a.changes as Change[]),
      };
      versions.set(d.meta.id, [...list, v]);
      d.text = v.text;
      d.meta.status = "saved";
      d.meta.savedN = v.n;
      d.meta.savedAt = v.time;
      const { text: _t, ...info } = v;
      return { version: info, meta: touch(d) };
    }
    case "list_versions":
      return (versions.get(String(a.id)) ?? []).map(({ text: _t, ...info }) => info).reverse();
    case "get_version": {
      const v = (versions.get(String(a.id)) ?? []).find((x) => x.n === a.n);
      if (!v) throw new Error(`No version ${a.n}`);
      return v;
    }
    case "export_version": {
      const v = (versions.get(String(a.id)) ?? []).find((x) => x.n === a.n);
      if (!v) throw new Error(`No version ${a.n}`);
      (window as unknown as { __lastExport?: string }).__lastExport = v.text;
      return `~/Downloads/${get(a.id).meta.title} v${v.n}.${a.ext}`;
    }
    case "print_page":
      window.print();
      return;
    case "models_status":
      return { ready: true, downloading: false };
    case "cancel":
      return;
    case "rephrase":
    case "substitute":
    case "alternatives": {
      // Canned options stand in for Qwen in the browser preview.
      await new Promise((r) => setTimeout(r, 120));
      const span = String(a.span ?? a.sentence);
      const pool =
        cmd === "substitute"
          ? ["enormous", "immense", "vast", "colossal", "massive", "towering", "sweeping", "monumental", "tremendous", "gigantic", "boundless", "mighty"].map((t) => ({ text: t, note: `a stand-in for "${span}"` }))
          : ["Put simply,", "In short,", "Truly,", "Above all,", "Plainly,", "Honestly,", "Once more,", "In the end,", "Even so,", "Still,", "Indeed,"].map((p) => ({ text: `${p} ${span.charAt(0).toLowerCase()}${span.slice(1)}` }));
      const exclude = (a.exclude as string[]) ?? [];
      const out = pool.filter((o) => !exclude.includes(o.text)).slice(0, Number(a.n));
      // Options stream in one at a time, as they do from the model.
      for (const option of out) {
        await new Promise((r) => setTimeout(r, 150));
        emit("option", { key: a.key, option });
      }
      return out;
    }
    case "correct":
      // A few fixed rules stand in for CoEdIT in the browser preview.
      await new Promise((r) => setTimeout(r, 60));
      return String(a.text)
        .replace(/\bhas worked\b/, "have worked")
        .replace(/\bmore then\b/, "more than")
        .replace(/\brenovaton\b/, "renovation")
        .replace(/\bi\b/g, "I");
    case "delete_doc":
      get(a.id);
      store.delete(String(a.id));
      return;
  }
  throw new Error(`Unknown command ${cmd}`);
}
