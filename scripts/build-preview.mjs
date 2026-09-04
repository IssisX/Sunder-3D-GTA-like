#!/usr/bin/env node
/**
 * Builds the game as one self-contained HTML file.
 *
 * Vite emits `dist-preview/index.html` plus a JS chunk and a stylesheet; this
 * folds both into the HTML so the result has no local dependencies at all and
 * can be opened from disk, served from anywhere, or published as an artifact.
 * Google Fonts stay as a remote stylesheet -- everything else is inline.
 *
 * Output: dist-preview/sunder.html
 */
import { build } from "vite";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist-preview");

await build({ configFile: join(root, "vite.preview.config.ts"), logLevel: "warn" });

let html = readFileSync(join(out, "index.html"), "utf8");
const js = join(out, "sunder.js");
const css = join(out, "sunder.css");

if (!existsSync(js)) {
  console.error(
    "build-preview: expected a single sunder.js chunk; the build produced something else",
  );
  process.exit(1);
}

// Inline the stylesheet, if the build produced one.
if (existsSync(css)) {
  const styles = readFileSync(css, "utf8");
  // A function replacer, not a string: minified bundles are full of `$&` and
  // `` $` `` sequences, and String.replace would expand them as substitution
  // patterns and splice the original tag back into the output.
  html = html.replace(/<link[^>]*sunder\.css[^>]*>/i, () => `<style>\n${styles}\n</style>`);
}

// Inline the module chunk. `</script>` inside a string literal would end the
// tag early, so it is split; the JSON-safe escape keeps the source identical.
const code = readFileSync(js, "utf8").replace(/<\/script>/gi, "<\\/script>");
html = html.replace(
  /<script[^>]*sunder\.js[^>]*><\/script>/i,
  () => `<script type="module">\n${code}\n</script>`,
);

if (html.includes("sunder.js") || html.includes("sunder.css")) {
  console.error("build-preview: failed to inline one of the emitted assets");
  process.exit(1);
}

// Emit the page CONTENT only. Browsers render a fragment like this correctly
// when opened directly, and it is also the shape an artifact host expects,
// which is what lets one build serve both.
html = html
  .replace(/^[\s\S]*?<head[^>]*>/i, "")
  .replace(/<\/head>\s*<body[^>]*>/i, "\n")
  .replace(/<\/body>\s*<\/html>\s*$/i, "")
  .trim();

const dest = join(out, "sunder.html");
writeFileSync(dest, html);
rmSync(js, { force: true });
rmSync(css, { force: true });
rmSync(join(out, "index.html"), { force: true });

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`dist-preview/sunder.html  ${kb} KB  (single file, no local dependencies)`);
