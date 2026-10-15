#!/usr/bin/env node
// Priprema TRAJNI izlaz eksperimenta: data/output/<kanal>/<base>.*
// Raspored je isti kao kanalski dir u storage/output, pa ga dataset.domovina.tv
// sync_dataset.sh (korak 1c) pokupi u data/<kanal>/<base>/. NIKAD u storage/output:
// pipeline bi izvedene datoteke shvatio kao gotov korak (idempotencija) i objavio ih.
//
// Za 2 epizode koje pipeline već ima → postojeći base i kanalski dir (isti dataset folder).
// Za nove → yt-dlp .info.json + .description, base = {upload_date}_{sanitize(title)}_yt_{id}
// (ista formula kao fetch.js). Piše bases.tsv: id, kanal, base.
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const REPO = path.resolve(__dirname, "../..");
const OUT = path.join(__dirname, "data/output");

function sanitizeDescription(str) {
  if (!str) return "nepoznat_naslov";
  str = str.toLowerCase();
  const map = { 'č': 'c', 'ć': 'c', 'ž': 'z', 'š': 's', 'đ': 'd', 'Č': 'c', 'Ć': 'c', 'Ž': 'z', 'Š': 's', 'Đ': 'd' };
  str = str.replace(/[čćžšđČĆŽŠĐ]/g, (c) => map[c] || c);
  str = str.replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return str || "nepoznat_naslov";
}

function findInPipeline(id) {
  const root = path.join(REPO, "storage/output");
  for (const ch of fs.readdirSync(root)) {
    if (ch.startsWith("_") || ch.startsWith(".")) continue;
    let files; try { files = fs.readdirSync(path.join(root, ch)); } catch { continue; }
    const f = files.find((x) => x.endsWith(`_yt_${id}.info.json`) && !x.startsWith("._"));
    if (f) return { kanal: ch, base: f.slice(0, -".info.json".length) };
  }
  return null;
}

const rows = fs.readFileSync(path.join(__dirname, "testset.tsv"), "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
const out = ["id\tkanal\tbase"];
for (const [id, slug] of rows) {
  const hit = findInPipeline(id);
  if (hit) { out.push(`${id}\t${hit.kanal}\t${hit.base}`); console.log("pipeline", id, hit.kanal); continue; }
  const kanal = slug.replace(/-/g, "_");
  const dir = path.join(OUT, kanal);
  fs.mkdirSync(dir, { recursive: true });
  let base = fs.readdirSync(dir).find((x) => x.endsWith(`_yt_${id}.info.json`));
  if (!base) {
    const info = JSON.parse(execFileSync("yt-dlp", ["-J", "--no-warnings", "--cookies-from-browser", "brave", "--", `https://www.youtube.com/watch?v=${id}`], { maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] }));
    base = `${info.upload_date}_${sanitizeDescription(info.title)}_yt_${id}`;
    fs.writeFileSync(path.join(dir, `${base}.info.json`), JSON.stringify(info));
    fs.writeFileSync(path.join(dir, `${base}.description`), info.description || "");
  } else base = base.slice(0, -".info.json".length);
  out.push(`${id}\t${kanal}\t${base}`);
  console.log("novo   ", id, kanal, base.slice(0, 60));
}
fs.writeFileSync(path.join(__dirname, "bases.tsv"), out.join("\n") + "\n");
