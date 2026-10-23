// Builds the deployable frontend into dist/.
//   node scripts/build-frontend.mjs <apiBase> <environmentLabel> <apiOrigin> [pulseOrigin]
// - frontend/index.html is kept as a page fragment (it doubles as the Claude prototype
//   artifact, which supplies its own document skeleton), so wrap it in a full document here.
// - Fill in the backend address. With no address the page runs as the sample-data prototype.
// - pulseOrigin (e.g. https://<pulse>.azurestaticapps.net): lets HD IT Pulse frame this app and sign it in.
//   Without it the app can't be framed at all (frame-ancestors 'none').
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";

const [apiBase = "", envLabel = "Test", apiOrigin = ""] = process.argv.slice(2);
if (!/^https:\/\//.test(apiBase)) { console.error("apiBase must be an https URL"); process.exit(1); }
const pulseOrigin = (process.argv[5] || "").replace(/\/+$/, "");
if (pulseOrigin && !/^https:\/\/[^/]+$/.test(pulseOrigin)) { console.error("pulseOrigin must look like https://host"); process.exit(1); }

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

let index = readFileSync("frontend/index.html", "utf8")
  .replaceAll("__API_BASE__", apiBase)
  .replaceAll("__ENVIRONMENT__", envLabel)
  .replaceAll("__PULSE_ORIGIN__", pulseOrigin);
if (!/^\s*<!doctype/i.test(index)) {
  // The fragment opens with <title>, <meta>, <link> and <style>; those belong in <head>.
  const cut = index.search(/<(header|main|nav|div|section)\b/i);
  const head = cut > 0 ? index.slice(0, cut) : "", body = cut > 0 ? index.slice(cut) : index;
  index = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>html,body{margin:0}[hidden]{display:none!important}</style>
${head.trim()}
</head>
<body>
${body}
</body>
</html>
`;
}
if (index.includes("__API_BASE__") || index.includes("__ENVIRONMENT__")) { console.error("placeholders left in index.html"); process.exit(1); }
writeFileSync("dist/index.html", index);

for (const f of ["user-guide.html", "changelog.html"]) copyFileSync(`frontend/${f}`, `dist/${f}`);
const swa = JSON.parse(readFileSync("frontend/staticwebapp.config.json", "utf8").replaceAll("__API_ORIGIN__", apiOrigin || new URL(apiBase).origin));
if (pulseOrigin) {
  // Only HD IT Pulse may frame this app. CSP frame-ancestors replaces X-Frame-Options, which can't allow one origin.
  const h = swa.globalHeaders;
  h["Content-Security-Policy"] = h["Content-Security-Policy"].replace("frame-ancestors 'none'", `frame-ancestors ${pulseOrigin}`);
  delete h["X-Frame-Options"];
  if (!h["Content-Security-Policy"].includes(`frame-ancestors ${pulseOrigin}`)) { console.error("couldn't set frame-ancestors"); process.exit(1); }
}
writeFileSync("dist/staticwebapp.config.json", JSON.stringify(swa, null, 2) + "\n");
console.log(`Built dist/ for ${envLabel} against ${apiBase}${pulseOrigin ? ", framed by " + pulseOrigin : ""}`);
