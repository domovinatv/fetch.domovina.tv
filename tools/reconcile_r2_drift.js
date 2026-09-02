#!/usr/bin/env node

/**
 * reconcile_r2_drift.js — poravnaj DISK i R2 tamo gdje `audit_pipeline.js` javi DRIFT.
 *
 * Zašto postoji: audit uz svaki drift ispiše `force_upload.js`, ali ta preporuka je
 * SMJERNO SLIJEPA — DRIFT znači samo „disk ≠ R2", ne „disk je noviji". Mjereno
 * 2026-09-02 na 15 driftanih epizoda: kod 12 je R2 verzija bila BOGATIJA (CDN nosi
 * `claude-code:opus` članak, na disku je ostao stariji `gemini-*` artefakt), pa bi
 * slijepi force_upload prepisao dobru verziju lošijom. Ovaj alat prvo izmjeri
 * SADRŽAJ obje strane, pa tek onda odluči smjer:
 *
 *     CDN bogatiji  → povuci na disk (uz backup lokalne verzije)
 *     disk bogatiji → force_upload.js (+ CF purge, radi ga sam force_upload)
 *
 * Datoteka koja se povlači s CDN-a dobiva ime po `metadata` iz samog JSON-a
 * (`source_file` + `model` + `generated_at`), pa dedup po leksikografski najvećem
 * `_{date}_{model}` i dalje bira nju (vidi MEMORY article_json_dedup_latest_per_video).
 *
 * Usage:
 *   node tools/reconcile_r2_drift.js                      # dry-run (default), sam pokreće audit
 *   node tools/reconcile_r2_drift.js --audit rep.json     # koristi postojeći izvještaj
 *   node tools/reconcile_r2_drift.js --commit             # stvarno piše
 *   node tools/reconcile_r2_drift.js --commit --only OoSYX4S6NNI
 *
 * Exit: 0 = sve poravnato / nema drifta, 1 = ostalo je nešto neriješeno.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const args = process.argv.slice(2);
function getArg(name) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
const COMMIT = args.includes("--commit");
const ONLY = getArg("--only");
const OUTPUT_DIR = getArg("--input-dir") || path.join(REPO, "storage", "output");
const CDN = process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai";
const BACKUP_DIR = path.join(REPO, "storage", ".drift_backup", new Date().toISOString().slice(0, 10));

// R2 basename → { lokalni suffix, kako se mjeri bogatstvo, force_upload target }.
// Isti skup koji `audit_pipeline.js` uspoređuje u fazi "Isporuka na R2/CDN".
const ARTIFACTS = {
    "article.json":             { suffix: ".article.json", shape: "sections", target: "article", modelled: true },
    "outline.json":            { suffix: ".outline.json", shape: "sections", target: null, modelled: true },
    "article.magisterium.json": { suffix: ".article.magisterium.json", shape: "sections", target: "magisterium", modelled: true },
    "summary.json":            { suffix: ".wav.canary.summary.json", shape: "summary", target: "summary", modelled: false },
    "book.epub":               { suffix: ".epub", shape: "bytes", target: null, modelled: false },
    "diarized.srt":            { suffix: ".wav.canary.diarized.srt", shape: "bytes", target: null, modelled: false },
};

// ─── Pomoćne ───────────────────────────────────────────────────────────────

function extractVideoId(name) {
    const m = [...name.matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
    return m.length ? m[m.length - 1][1] : null;
}

// Lokalna datoteka koju bi audit/uploader smatrali mjerodavnom: leksikografski
// najveća s tim suffixom. `.article.json` i `.article.magisterium.json` se
// razlikuju jednoznačno jer prvi NE završava na drugi (i obrnuto).
function localFileFor(dir, videoId, r2name) {
    const { suffix } = ARTIFACTS[r2name];
    let files;
    try { files = fs.readdirSync(dir); } catch { return null; }
    const hits = files.filter(f => {
        if (f.startsWith("._") || extractVideoId(f) !== videoId) return false;
        if (f.includes(".loudnorm.") || f.includes(".sortformer.")) return false;
        if (!f.endsWith(suffix)) return false;
        if (suffix === ".article.json" && f.endsWith(".article.magisterium.json")) return false;
        if (f.endsWith(".en.json")) return false;
        return true;
    });
    return hits.sort().pop() || null;
}

function shapeOf(kind, buf) {
    if (kind === "bytes") return { score: buf.length, label: `${buf.length} B` };
    let j;
    try { j = JSON.parse(buf.toString("utf-8")); } catch { return { score: -1, label: "neispravan JSON" }; }
    if (kind === "summary") {
        const s = j.summary || {};
        const chars = Object.values(s).map(v => (typeof v === "string" ? v.length : JSON.stringify(v || "").length))
            .reduce((a, b) => a + b, 0);
        return { score: chars, label: `${chars} znakova sažetka` };
    }
    const its = Array.isArray(j.iterations) ? j.iterations : [];
    const sec = its.reduce((s, i) => s + ((i.sections || []).length), 0);
    // Sekcije su nosilac sadržaja; iteracije razrješavaju izjednačenje.
    return { score: sec * 1000 + its.length, label: `${its.length} it / ${sec} sek`, meta: j.metadata };
}

// `{base}.wav.canary.diarized.srt` + model + datum → ime po konvenciji repoa.
function targetNameFromMetadata(meta, r2name) {
    if (!meta || !meta.source_file || !meta.model || !meta.generated_at) return null;
    const base = meta.source_file.replace(/\.srt$/, "");
    // Provenance u JSON-u je puna (`claude-code:opus`), u imenu ide goli alias —
    // inače `'c' < 'g'` znači da Opus članak nikad ne pobijedi gemini (CLAUDE.md).
    const slug = String(meta.model).split(":").pop();
    const d = new Date(meta.generated_at);
    if (isNaN(d)) return null;
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const ext = r2name === "article.json" ? ".article.json"
        : r2name === "outline.json" ? ".outline.json"
            : ".article.magisterium.json";
    return `${base}_${date}_${slug}${ext}`;
}

function backup(dir, filename) {
    const src = path.join(dir, filename);
    if (!fs.existsSync(src)) return null;
    const dest = path.join(BACKUP_DIR, path.basename(dir), filename);
    if (COMMIT) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
    return dest;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

(async () => {
    let auditPath = getArg("--audit");
    if (!auditPath) {
        auditPath = path.join(REPO, "storage", ".drift_audit.json");
        console.log("🔎 Nema --audit — pokrećem audit_pipeline.js --deep (traje ~2 min)…");
        try {
            execFileSync("node", [path.join(REPO, "audit_pipeline.js"), "--deep", "--json", auditPath, "--limit", "0"],
                { cwd: REPO, stdio: "ignore" });
        } catch (_) { /* exit 1 = ima rupa, to je očekivano */ }
    }
    const report = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
    console.log(`📄 Izvještaj: ${auditPath} (${report.with_gaps} epizoda s rupom od ${report.total})`);
    console.log(`   način: ${COMMIT ? "COMMIT (piše)" : "DRY-RUN (ništa se ne mijenja)"}\n`);

    let pulled = 0, pushed = 0, manual = 0, same = 0;

    for (const ep of report.episodes) {
        if (ONLY && ep.id !== ONLY) continue;
        const drifts = (ep.problems || []).filter(p => p.stage === "r2" && p.kind === "DRIFT");
        if (!drifts.length) continue;
        const dir = path.join(OUTPUT_DIR, ep.channel);
        console.log(`━━━ ${ep.id}  [${ep.channel}]`);

        // article.json PRVI: iz njegove `metadata` se izvodi `{base}_{date}_{model}`
        // prefiks kojim se imenuje i outline (outline.json na CDN-u NEMA metadata,
        // pa bi inače pao na prepisivanje datoteke s tuđim model-slugom u imenu).
        drifts.sort((a, b) => (a.detail.startsWith("article.json:") ? -1 : 0) - (b.detail.startsWith("article.json:") ? -1 : 0));
        let derivedPrefix = null;

        for (const p of drifts) {
            const r2name = Object.keys(ARTIFACTS).find(n => p.detail.startsWith(`${n}:`));
            if (!r2name) { console.log(`   ⚠️  ne znam mapirati: ${p.detail}`); manual++; continue; }
            const spec = ARTIFACTS[r2name];
            const localFile = localFileFor(dir, ep.id, r2name);
            if (!localFile) { console.log(`   ⚠️  ${r2name}: nema lokalne datoteke`); manual++; continue; }

            let remoteBuf;
            try {
                const resp = await fetch(`${CDN}/data/${ep.id}/${r2name}`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                remoteBuf = Buffer.from(await resp.arrayBuffer());
            } catch (err) {
                console.log(`   ⚠️  ${r2name}: CDN nedostupan (${err.message}) — preskačem`);
                manual++; continue;
            }
            const localBuf = fs.readFileSync(path.join(dir, localFile));
            if (localBuf.length === remoteBuf.length) { console.log(`   ✅ ${r2name}: već poravnato`); same++; continue; }

            const L = shapeOf(spec.shape, localBuf);
            const R = shapeOf(spec.shape, remoteBuf);
            const dir_ = R.score > L.score ? "PULL" : R.score < L.score ? "PUSH" : "PULL";
            console.log(`   ${r2name}: disk ${L.label} (${localBuf.length} B) vs CDN ${R.label} (${remoteBuf.length} B) → ${dir_}`);

            if (dir_ === "PULL") {
                let name = spec.modelled ? targetNameFromMetadata(R.meta, r2name) : null;
                if (name && r2name === "article.json") derivedPrefix = name.slice(0, -".article.json".length);
                if (!name && r2name === "outline.json" && derivedPrefix) name = `${derivedPrefix}.outline.json`;
                if (!name) name = localFile;                       // fallback: prepiši postojeću
                const dest = path.join(dir, name);
                const overwrite = fs.existsSync(dest);
                if (overwrite) backup(dir, name);
                if (COMMIT) fs.writeFileSync(dest, remoteBuf);
                console.log(`      ⬇️  ${COMMIT ? "zapisano" : "zapisalo bi se"}: ${name}${overwrite ? " (backup napravljen)" : " (nova datoteka)"}`);
                pulled++;
            } else {
                if (!spec.target) { console.log("      ⚠️  force_upload nema target za taj artefakt — ručno"); manual++; continue; }
                if (COMMIT) {
                    const out = execFileSync("node", [path.join(REPO, "force_upload.js"),
                        "--video-id", ep.id, "--channel", ep.channel, "--targets", spec.target],
                    { cwd: REPO, encoding: "utf-8" });
                    console.log(out.trim().split("\n").map(l => `      ${l}`).join("\n"));
                } else {
                    console.log(`      ⬆️  pokrenulo bi: node force_upload.js --video-id ${ep.id} --channel ${ep.channel} --targets ${spec.target}`);
                }
                pushed++;
            }
        }
    }

    console.log(`\n📊 PULL (CDN→disk): ${pulled} · PUSH (disk→CDN): ${pushed} · već isto: ${same} · ručno: ${manual}`);
    if (!COMMIT) console.log("   (dry-run — pokreni s --commit da se stvarno izvrši)");
    else if (pulled) console.log(`   backup lokalnih verzija: ${BACKUP_DIR}`);
    process.exit(manual > 0 ? 1 : 0);
})().catch(err => {
    console.error(`❌ ${err.stack || err.message}`);
    process.exit(2);
});
