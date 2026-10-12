// Bundles widget/entry.ts into public/widget.js (one small, framework-free IIFE).
// Runs before `next build` and `next dev` (see package.json).
import { build } from "esbuild";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outfile = fileURLToPath(new URL("../public/widget.js", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("../widget/entry.ts", import.meta.url))],
  outfile,
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2019",
  legalComments: "none",
  banner: { js: "/* unquit cancel-flow widget | https://github.com/sauravsah/unquit */" },
  logLevel: "warning",
});

const kb = (statSync(outfile).size / 1024).toFixed(1);
console.log(`widget: public/widget.js ${kb} KB`);
