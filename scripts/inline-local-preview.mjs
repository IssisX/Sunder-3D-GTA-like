import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve(process.cwd(), "local-preview-dist");
const indexPath = path.join(outDir, "index.html");
let html = await readFile(indexPath, "utf8");

const css = await readFile(path.join(outDir, "style.css"), "utf8");
const js = await readFile(path.join(outDir, "sunder.js"), "utf8");

const inlineCss = `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`;
const inlineJs = `<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`;

// IMPORTANT: use function replacers. A bundled JS string can legitimately
// contain "$&"; passing the bundle as a replacement string would expand "$&"
// into the matched external <script> tag and corrupt the inline executable.
html = html
  .replace(
    /<link\b[^>]*href=["']\.\/style\.css["'][^>]*>/i,
    () => inlineCss,
  )
  .replace(
    /<script\b[^>]*src=["']\.\/sunder\.js["'][^>]*><\/script>/i,
    () => inlineJs,
  );

const outPath = path.join(outDir, "SUNDER.html");
await writeFile(outPath, html, "utf8");
console.log(`Wrote ${outPath}`);
