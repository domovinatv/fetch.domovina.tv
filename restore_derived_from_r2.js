#!/usr/bin/env node
/**
 * restore_derived_from_r2.js
 * ──────────────────────────
 * Vraća s R2 lokalno obrisane IZVEDENE slikovne artefakte:
 *
 *   images/{id}/screenshots/{ts}.png  →  {channel}/{base}_screenshots/{base}_{ts}.png
 *   images/{id}/og-t-{sec}.jpg        →  {channel}/{base}.og-sections/og-t-{sec}.jpg
 *
 * Kontekst: APFS migracija 2026-08-14 obrisala je klasu `DERIVED_ON_R2`
 * (screenshot PNG-ovi + og-sections JPEG-ovi, ~57 GiB) jer je sve verificirano
 * na R2. Manifesti (`_manifest.json`, `.og-sections/manifest.json`) su ostali,
 * pa lokalni layout zna TOČNO što je nedostajalo. Posljedica brisanja je bila da
 * `screenshot_youtube.js` (KORAK 10) gleda samo lokalno postojanje fajla i zato
 * bi ponovno snimao ~62.000 frameova s YouTubea — vidi `--skip-if-on-r2` ondje.
 * Ova skripta zatvara drugu polovicu: vraća lokalni katalog u kompletno stanje.
 *
 * Idempotentno: preskače ako lokalni fajl postoji i veličina se poklapa s R2.
 * Atomski upis (tmp + rename), pa prekid usred posla ne ostavlja krnje slike.
 *
 *   node restore_derived_from_r2.js --dry-run
 *   node restore_derived_from_r2.js
 *   node restore_derived_from_r2.js --channel domovina_tv
 *   node restore_derived_from_r2.js --kind screenshots --concurrency 16
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function getArg(name, def = null) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : def;
}
function hasFlag(name) { return args.includes(name); }

const OUTPUT_DIR   = getArg("--input-dir", path.join(__dirname, "storage", "output"));
const ONLY_CHANNEL = getArg("--channel");
const KIND         = getArg("--kind", "both");          // screenshots | og-sections | both
const CONCURRENCY  = parseInt(getArg("--concurrency", "8"), 10);
const DRY_RUN      = hasFlag("--dry-run");
const PLAN_FILE    = getArg("--plan-file");             // reuse LIST-a iz ranijeg runa

if (!["screenshots", "og-sections", "both"].includes(KIND)) {
    console.error(`❌ --kind mora biti screenshots | og-sections | both (dobio: ${KIND})`);
    process.exit(1);
}

// ─── .env (ručni parser, kao upload_to_r2.js / download_h264_from_r2.js) ──
(function loadEnv() {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
})();
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET     = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";

let _s3 = null, _S3 = null;
function s3() {
    if (_s3) return _s3;
    _S3 = require("@aws-sdk/client-s3");
    _s3 = new _S3.S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
    return _s3;
}

/**
 * LIST svih `images/` ključeva s veličinama. Jedan Class A poziv po 1000 objekata
 * (memory: r2_cost_list_once) — ~140 stranica naspram ~127.000 HEAD-ova.
 */
async function listImageKeys() {
    const out = new Map();   // key → size
    let token, pages = 0;
    do {
        const resp = await s3().send(new _S3.ListObjectsV2Command({
            Bucket: R2_BUCKET, Prefix: "images/", ContinuationToken: token, MaxKeys: 1000,
        }));
        for (const o of resp.Contents || []) out.set(o.Key, o.Size);
        token = resp.NextContinuationToken;
        if (++pages % 20 === 0) process.stdout.write(`\r   📋 LIST stranica ${pages} (${out.size} ključeva)   `);
    } while (token);
    process.stdout.write(`\r   📋 LIST gotov: ${pages} stranica, ${out.size} ključeva          \n`);
    return out;
}

async function r2Download(key, outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmp = `${outPath}.r2dl.tmp`;
    const resp = await s3().send(new _S3.GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        resp.Body.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", resolve);
        resp.Body.pipe(ws);
    });
    fs.renameSync(tmp, outPath);   // atomski — prekid ne ostavlja krnju sliku
    return fs.statSync(outPath).size;
}

// extractVideoId: naslovi epizoda znaju sadržavati "_yt_", pa uzmi ZADNJI match
// (memory: extract_video_id_last_match — ista zamka popravljena u 5 kopija).
function extractVideoId(base) {
    const i = base.lastIndexOf("_yt_");
    if (i === -1) return null;
    const id = base.slice(i + 4, i + 4 + 11);
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function listDirs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("._") && !e.name.startsWith("."))
        .map(e => e.name);
}

/**
 * Nađi lokalne izvedene direktorije. Oslanja se na to da manifesti NISU obrisani —
 * `{base}_screenshots/` i `{base}.og-sections/` i dalje postoje, samo su prazni.
 * Isti videoId može živjeti u više kanala (reuse `_unlisted` → kanal); svaki
 * lokalni dir dobiva svoju kopiju.
 */
function discover() {
    const targets = [];
    const channels = ONLY_CHANNEL ? [ONLY_CHANNEL] : listDirs(OUTPUT_DIR);

    for (const ch of channels) {
        const chDir = path.join(OUTPUT_DIR, ch);
        let entries;
        try { entries = fs.readdirSync(chDir, { withFileTypes: true }); } catch { continue; }

        for (const e of entries) {
            if (!(e.isDirectory() || e.isSymbolicLink())) continue;
            if (e.name.startsWith("._")) continue;

            let base = null, kind = null;
            if (e.name.endsWith("_screenshots")) {
                base = e.name.slice(0, -"_screenshots".length);
                kind = "screenshots";
            } else if (e.name.endsWith(".og-sections")) {
                base = e.name.slice(0, -".og-sections".length);
                kind = "og-sections";
            } else continue;

            if (KIND !== "both" && KIND !== kind) continue;

            const videoId = extractVideoId(base);
            if (!videoId) continue;

            targets.push({ channel: ch, base, videoId, kind, dir: path.join(chDir, e.name) });
        }
    }
    return targets;
}

/**
 * Za jedan lokalni dir izračunaj koje R2 ključeve treba povući.
 * Mapiranje je obrnuto od upload_to_r2.js:mapToAppKey.
 */
function planForTarget(t, r2) {
    const jobs = [];
    if (t.kind === "screenshots") {
        const prefix = `images/${t.videoId}/screenshots/`;
        for (const [key, size] of r2) {
            if (!key.startsWith(prefix)) continue;
            const filename = key.slice(prefix.length);
            if (filename.includes("/")) continue;
            if (!/\.png$/.test(filename)) continue;          // manifest.json je već lokalno
            jobs.push({ key, size, out: path.join(t.dir, `${t.base}_${filename}`) });
        }
    } else {
        const prefix = `images/${t.videoId}/`;
        for (const [key, size] of r2) {
            if (!key.startsWith(prefix)) continue;
            const filename = key.slice(prefix.length);
            if (filename.includes("/")) continue;
            if (!/^og-t-\d+\.jpg$/.test(filename)) continue;  // og-sections.json je već lokalno
            jobs.push({ key, size, out: path.join(t.dir, filename) });
        }
    }
    return jobs;
}

async function runConcurrent(tasks, concurrency) {
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (idx < tasks.length) {
            const i = idx++;
            await tasks[i]();
        }
    });
    await Promise.all(workers);
}

const fmtGiB = b => (b / 1024 ** 3).toFixed(2);

(async () => {
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   ♻️  RESTORE IZVEDENIH SLIKA S R2               ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   Input:  ${OUTPUT_DIR}`);
    console.log(`   Bucket: ${R2_BUCKET}`);
    console.log(`   Kind:   ${KIND}${ONLY_CHANNEL ? ` | kanal: ${ONLY_CHANNEL}` : ""}`);
    console.log("");

    if (!R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
        console.error("❌ Nedostaju R2 kredencijali u .env (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)");
        process.exit(1);
    }

    let r2;
    if (PLAN_FILE && fs.existsSync(PLAN_FILE)) {
        r2 = new Map(JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")));
        console.log(`   📋 Plan iz ${PLAN_FILE}: ${r2.size} ključeva`);
    } else {
        r2 = await listImageKeys();
        if (PLAN_FILE) fs.writeFileSync(PLAN_FILE, JSON.stringify([...r2]));
    }

    const targets = discover();
    console.log(`   📂 Lokalnih izvedenih direktorija: ${targets.length}`);

    // Plan
    const todo = [];
    const perChannel = {};
    let already = 0, alreadyBytes = 0, missingOnR2 = 0;

    for (const t of targets) {
        const jobs = planForTarget(t, r2);
        if (jobs.length === 0) { missingOnR2++; continue; }
        for (const j of jobs) {
            let st = null;
            try { st = fs.statSync(j.out); } catch { /* nema ga */ }
            if (st && st.size === j.size) { already++; alreadyBytes += st.size; continue; }
            todo.push({ ...j, channel: t.channel });
            perChannel[t.channel] = perChannel[t.channel] || { n: 0, bytes: 0 };
            perChannel[t.channel].n++;
            perChannel[t.channel].bytes += j.size;
        }
    }

    const totalBytes = todo.reduce((a, j) => a + j.size, 0);
    console.log(`   ✅ Već lokalno (veličina se poklapa): ${already} (${fmtGiB(alreadyBytes)} GiB)`);
    console.log(`   ⬇️  Za povlačenje:                    ${todo.length} (${fmtGiB(totalBytes)} GiB)`);
    if (missingOnR2) console.log(`   ⚠️  Direktorija bez ijednog ključa na R2: ${missingOnR2} (nikad uploadano ili snimanje palo)`);
    console.log("");

    if (todo.length === 0) { console.log("   ✨ Ništa za raditi."); return; }

    console.log("   Po kanalu:");
    for (const [ch, v] of Object.entries(perChannel).sort((a, b) => b[1].bytes - a[1].bytes)) {
        console.log(`     ${ch.padEnd(32)} ${String(v.n).padStart(7)}  ${fmtGiB(v.bytes).padStart(8)} GiB`);
    }
    console.log("");

    if (DRY_RUN) { console.log("   🧪 --dry-run — ništa nije skinuto."); return; }

    let done = 0, failed = 0, bytes = 0;
    const t0 = Date.now();
    let lastLog = 0;

    const tasks = todo.map(j => async () => {
        try {
            // NE piši `bytes += await …` — pod concurrency > 1 to je lost-update race
            // (lijeva strana se pročita PRIJE awaita, pa paralelni taskovi prepišu jedan
            // drugoga i brojač podbaci ~10×). Prvo await, pa tek onda inkrement.
            const size = await r2Download(j.key, j.out);
            bytes += size;
            done++;
        } catch (err) {
            failed++;
            if (failed <= 20) console.error(`\n   ❌ ${j.key}: ${err.message}`);
        }
        const now = Date.now();
        if (now - lastLog > 3000) {
            lastLog = now;
            const el = (now - t0) / 1000;
            const finished = done + failed;
            // ETA po BROJU fajlova, ne po bajtovima: posao je latencijski vezan (124k
            // sitnih objekata), a veličine su neravnomjerne po kanalima — byte-based
            // ETA zato divlja ovisno o tome koji je kanal trenutno na redu.
            const fps = finished / el;
            const eta = fps > 0 ? (todo.length - finished) / fps : 0;
            process.stdout.write(
                `\r   ⬇️  ${finished}/${todo.length} · ${fmtGiB(bytes)}/${fmtGiB(totalBytes)} GiB · ` +
                `${fps.toFixed(1)} fajl/s · ${(bytes / 1024 ** 2 / el).toFixed(1)} MiB/s · ` +
                `ETA ${Math.round(eta / 60)} min · greške ${failed}   `
            );
        }
    });

    await runConcurrent(tasks, CONCURRENCY);

    const el = (Date.now() - t0) / 1000;
    console.log("");
    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📊 RESTORE ZAVRŠEN                             ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Skinuto:  ${done} (${fmtGiB(bytes)} GiB)`);
    console.log(`   ❌ Grešaka:  ${failed}`);
    console.log(`   ⏱️  Trajanje: ${Math.round(el / 60)} min (${(bytes / 1024 ** 2 / el).toFixed(1)} MiB/s)`);
    if (failed > 0) console.log(`   ℹ️  Re-run je idempotentan — pokreni ponovno za preostale.`);
})();
