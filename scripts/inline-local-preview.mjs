import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve(process.cwd(), "local-preview-dist");
const indexPath = path.join(outDir, "index.html");
let html = await readFile(indexPath, "utf8");

const cssMatch = html.match(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*>/i);
if (cssMatch) {
  const cssPath = path.resolve(outDir, cssMatch[1].replace(/^\.\//, ""));
  const css = await readFile(cssPath, "utf8");
  html = html.replace(cssMatch[0], `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`);
}

const scriptMatch = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["'][^>]*><\/script>/i);
if (!scriptMatch) throw new Error("Local preview build did not emit a module entry script");

const jsPath = path.resolve(outDir, scriptMatch[1].replace(/^\.\//, ""));
const js = await readFile(jsPath, "utf8");
html = html.replace(
  scriptMatch[0],
  `<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`,
);

if (/\b(?:src|href)=["']\.\//i.test(html)) {
  throw new Error("Local preview still contains external relative assets");
}

const outPath = path.join(outDir, "SUNDER.html");
await writeFile(outPath, html, "utf8");
console.log(`Wrote ${outPath}`);
