// Bundle the UI into dist/ for Tauri: main.ts via Bun's bundler, static files copied as is.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const result = await Bun.build({ entrypoints: [join(root, "ui", "main.ts")], outdir: out, target: "browser", minify: false });
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const f of ["index.html", "app.css", "logo.svg"]) cpSync(join(root, "ui", f), join(out, f));
console.log("UI built to dist/");
