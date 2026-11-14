#!/usr/bin/env node
/**
 * Trajna pohrana A/B članaka (agy flash vs hydrogen), da ostanu za buduće usporedbe.
 *
 *   node experiments/2026-11-15-agy-hydrogen-ab/archive.js            # disk: data/output/<kanal>/
 *   node experiments/2026-11-15-agy-hydrogen-ab/archive.js --upload   # + R2 cdn.domovina.ai/experiments/<exp>/...
 *
 * Disk raspored je onaj koji čita dataset.domovina.tv/sync_dataset.sh (korak 1c):
 *   data/output/<kanal>/<base>.exp-20261114.agy-<model>.{clanak,plan,meta}.json + _raw/*.raw.txt
 * Hrvatska imena artefakata namjerno: sufiks .article.json bi pipeline shvatio kao gotov korak.
 * `data` je symlink na /Volumes/DOMOVINA1TB/experiments/<exp> (gitignored).
 */
const fs = require("fs");
const path = require("path");

const E = __dirname;
const EXP = path.basename(E);
const STAMP = "exp-20261114";
const CHANNEL = { HYNJ0Ddwjyw: "radio_benkovac", L9JEBGkSokM: "psz_podcast", nToZnW8RHP4: "prgavi_podcast" };
const FULL = (m) => (m.startsWith("flash") ? `gemini-3.8-${m}` : `gemini-4-${m}`);

// run.log / run_high.log → trajanje, rc i Gemini 5h prije svakog članka
function runInfo() {
    const out = {};
    const seq = [];
    for (const f of ["run.log", "run_high.log"]) {
        const p = path.join(E, f);
        if (!fs.existsSync(p)) continue;
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
            let m = line.match(/^=== (\S+) (\S+) \(\S+\) start (\S+) gemini_5h=(\S+)/);
            if (m) { const k = `${m[1]}|${m[2]}`; out[k] = { start: m[3], gemini_5h_before: parseFloat(m[4]) }; seq.push(k); continue; }
            m = line.match(/^=== (\S+) (\S+) rc=(\d+) trajanje=(\d+) s/);
            if (m) Object.assign(out[`${m[1]}|${m[2]}`] || {}, { rc: +m[3], duration_s: +m[4] });
        }
    }
    // „poslije” = „prije” idućeg članka; Tier 2 queue troši isti prozor, pa je to gornja granica
    for (let i = 0; i + 1 < seq.length; i++) out[seq[i]].gemini_5h_after_upper = out[seq[i + 1]].gemini_5h_before;
    return out;
}

function main() {
    const upload = process.argv.includes("--upload");
    const info = runInfo();
    const dataDir = path.join(E, "data");
    if (!fs.existsSync(dataDir)) {
        const target = `/Volumes/DOMOVINA1TB/experiments/${EXP}`;
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, dataDir);
    }
    const files = [];
    const put = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); files.push(dst); };

    for (const m of fs.readdirSync(path.join(E, "out"))) {
        const dir = path.join(E, "out", m);
        for (const [id, ch] of Object.entries(CHANNEL)) {
            const art = fs.readdirSync(dir).find((f) => f.includes(`_yt_${id}`) && f.endsWith(".article.json"));
            if (!art) { console.log(`⏭️  ${m} ${id}: nema članka`); continue; }
            const base = art.split(".wav.canary.diarized")[0];
            const pre = path.join(dataDir, "output", ch, `${base}.${STAMP}.agy-${FULL(m)}`);
            put(path.join(dir, art), `${pre}.clanak.json`);
            const outline = art.replace(".article.json", ".outline.json");
            if (fs.existsSync(path.join(dir, outline))) put(path.join(dir, outline), `${pre}.plan.json`);
            const raw = path.join(dir, art.replace(".article.json", "_raw"));
            if (fs.existsSync(raw)) for (const r of fs.readdirSync(raw)) put(path.join(raw, r), `${pre}_raw/${r.endsWith(".txt") ? r : r + ".txt"}`);
            const log = path.join(dir, `${id}.log`);
            if (fs.existsSync(log)) put(log, `${pre}.log.txt`);
            const meta = {
                experiment: EXP, video_id: id, channel: ch, backend: "agy", model: FULL(m),
                input: "isti .wav.canary.diarized.srt + .canary.summary.json kao Opus 07.11. (FIDELITY_CLAUSE aktivan)",
                ...(info[`${id}|${m}`] || {}),
                doc: "docs/2026-11-15-agy-hydrogen-ab.md",
            };
            fs.writeFileSync(`${pre}.meta.json`, JSON.stringify(meta, null, 1));
            files.push(`${pre}.meta.json`);
        }
    }
    // Opus referenca istog dana (već je na CDN-u kao article.json, ovdje radi usporedbe na jednom mjestu)
    for (const [id, ch] of Object.entries(CHANNEL)) {
        const f = fs.readdirSync(path.join(E, "input")).find((x) => x.includes(`_yt_${id}`) && x.endsWith("opus.article.json"));
        if (f) put(path.join(E, "input", f), path.join(dataDir, "output", ch, `${f.split(".wav.canary.diarized")[0]}.${STAMP}.claude-opus-referenca.clanak.json`));
    }
    console.log(`💾 ${files.length} datoteka u ${path.join(dataDir, "output")}`);
    if (upload) return uploadR2(files, path.join(dataDir, "output"));
}

async function uploadR2(files, root) {
    const envPath = path.join(E, "..", "..", ".env");
    for (const l of fs.readFileSync(envPath, "utf8").split("\n")) {
        const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    const { S3Client, PutObjectCommand } = require(path.join(E, "..", "..", "node_modules", "@aws-sdk/client-s3"));
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
    const bucket = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";
    let n = 0;
    for (const f of files) {
        const key = `experiments/${EXP}/${path.relative(root, f)}`;
        await client.send(new PutObjectCommand({
            Bucket: bucket, Key: key, Body: fs.readFileSync(f),
            ContentType: f.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
            CacheControl: "public, max-age=3600",
        }));
        n++;
    }
    console.log(`⬆️  ${n} datoteka → https://cdn.domovina.ai/experiments/${EXP}/`);
}

main();
