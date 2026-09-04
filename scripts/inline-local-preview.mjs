import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve(process.cwd(), "local-preview-dist");
const indexPath = path.join(outDir, "index.html");
let html = await readFile(indexPath, "utf8");

const css = await readFile(path.join(outDir, "style.css"), "utf8");
const js = await readFile(path.join(outDir, "sunder.js"), "utf8");

html = html
  .replace(/<link\b[^>]*href=["']\.\/style\.css["'][^>]*>/i, `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`)
  .replace(/<script\b[^>]*src=["']\.\/sunder\.js["'][^>]*><\/script>/i, `<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`);

const outPath = path.join(outDir, "SUNDER.html");
await writeFile(outPath, html, "utf8");
console.log(`Wrote ${outPath}`);
