#!/usr/bin/env node

/**
 * translate_to_english.js
 *
 * Generira engleske paralelne artefakte (summary.en.json, article.en.json,
 * article.magisterium.en.json) iz hrvatskih originala uz strogi "no hallucinations"
 * režim — Vertex AI Gemini 2.5 Flash sa temperature=0 i eksplicitnim pravilima.
 *
 * Princip:
 *   1. Per-field translacija (NE cijeli JSON odjednom) — manji chunk = bolja vjernost
 *   2. temperature=0, responseMimeType=application/json
 *   3. System prompt zabranjuje paraphrazu, embelishment, izostavljanje
 *   4. Croatian proper names (Brčina, Antunovski hod) ostaju isti
 *   5. Katolička terminologija mapirana na standardni engleski (euharistija→Eucharist, klanjanje→adoration)
 *   6. Markdown i citati preservirani
 *   7. Citations iz article.magisterium.json se ne prevode (već su engleski)
 *
 * Naming:
 *   {basename}.wav.canary.summary.json
 *     → {basename}.wav.canary.summary.en.json
 *   {basename}.wav.canary.diarized_{date}_{model}.article.json
 *     → {basename}.wav.canary.diarized_{date}_{model}.article.en.json
 *   {basename}.wav.canary.diarized_{date}_{model}.article.magisterium.json
 *     → {basename}.wav.canary.diarized_{date}_{model}.article.magisterium.en.json
 *
 * Auth: gcloud OAuth (memory: gemini-auth-oauth-only). Multi-region rotacija.
 *
 * Usage:
 *   node translate_to_english.js --input-dir storage/output --video-id 6ueR_Leq6uE
 *   node translate_to_english.js --input-dir storage/output --channel mladi_za_domovinu --limit 5
 *   node translate_to_english.js --input-dir storage/output --video-id ... --dry-run
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── KONFIGURACIJA ────────────────────────────────────────────────

const GEMINI_CONF = (() => {
    try {
        const text = fs.readFileSync(path.join(__dirname, "gemini.conf"), "utf-8");
        const conf = {};
        for (const line of text.split("\n")) {
            const t = line.trim();
            if (!t || t.startsWith("#")) continue;
            const eq = t.indexOf("=");
            if (eq > 0) conf[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
        }
        return conf;
    } catch { return {}; }
})();

const VERTEX_PROJECT = process.env.VERTEX_PROJECT || GEMINI_CONF.VERTEX_PROJECT;
const GEMINI_MODEL = process.env.GEMINI_MODEL || GEMINI_CONF.GEMINI_MODEL || "gemini-2.5-flash";
const VERTEX_REGIONS = (process.env.VERTEX_REGIONS || GEMINI_CONF.VERTEX_REGIONS || "global,us-central1,us-east1,europe-west1,europe-west4")
    .split(",").map(r => r.trim()).filter(Boolean);

if (!VERTEX_PROJECT) {
    console.error("❌ VERTEX_PROJECT nije postavljen (gemini.conf ili env).");
    process.exit(1);
}

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 3000;
const REQUEST_DELAY_MS = 200;

// ─── OAuth TOKEN ──────────────────────────────────────────────────

let cachedAccessToken = null;
let tokenExpiry = 0;

function getOrRefreshAccessToken() {
    if (cachedAccessToken && Date.now() < tokenExpiry) return cachedAccessToken;
    try {
        cachedAccessToken = execSync("gcloud auth print-access-token", { encoding: "utf-8" }).trim();
        tokenExpiry = Date.now() + 50 * 60 * 1000; // 50 min cache
        return cachedAccessToken;
    } catch (err) {
        console.error("❌ Ne mogu dohvatiti gcloud token. Pokreni: gcloud auth login");
        process.exit(1);
    }
}

// ─── REGION ROTACIJA ──────────────────────────────────────────────

let regionIndex = 0;
function getNextRegion() {
    const region = VERTEX_REGIONS[regionIndex % VERTEX_REGIONS.length];
    regionIndex++;
    return region;
}

function buildEndpointUrl(region) {
    if (region === "global") {
        return `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${GEMINI_MODEL}:generateContent`;
    }
    return `https://${region}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${region}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
}

// ─── STROGI TRANSLATOR PROMPT ─────────────────────────────────────

const TRANSLATOR_PROMPT = `You are a strictly literal Croatian-to-English translator for a Catholic podcast platform.

ABSOLUTE RULES — VIOLATIONS ARE FAILURES:
1. Translate EVERY sentence faithfully. Do NOT skip, summarize, or omit any information.
2. Do NOT add information, explanations, context, or stylistic embellishments not present in the Croatian source.
3. Do NOT paraphrase. Stay as close to the source structure as English grammar allows.
4. Preserve Croatian proper names exactly (do NOT anglicize):
   - Person names: fra Stjepan Brčina, Marko Petrović, Marino Kožul (keep "fra" prefix for Franciscan friars)
   - Organizations: Mladi za domovinu, Evangelizacijska zajednica Sveti Duh, Antunovski hod, Tečaj Filip, Duhovno-duhovite večeri (DDV)
   - Places: Sveti Duh, Bazilika svetog Antuna Padovanskog, Dubrava, Knin, Cres, Padova, Hercegovina, Slavonija
5. Use standard English Catholic terminology where Croatian uses Croatian:
   - Bog → God; Krist / Isus → Christ / Jesus; Marija (BDM) → Mary (BVM)
   - Duh Sveti → Holy Spirit; Otac (Bog) → Father (God)
   - euharistija → Eucharist; klanjanje → Eucharistic adoration; sakrament → sacrament
   - misa → Mass; ispovijed → confession (sacrament of reconciliation); krizma → confirmation; vjenčanje → marriage
   - krunica → Rosary; hod → walk; hodočašće → pilgrimage; svećenik → priest; biskup → bishop
   - apostoli → apostles; evangelizacija → evangelization; obnova → renewal; nauk → teaching
   - Sotona / đavao / vrag → Satan / devil; napast / kušnja → temptation
   - sveti Antun Padovanski → Saint Anthony of Padua; Majka Terezija → Mother Teresa; Karlo Acutis → Carlo Acutis
   - Posljednja večera → Last Supper; Knjiga mudrosti → Book of Wisdom
6. Preserve ALL Markdown formatting (**bold**, *italic*, lists, blockquotes >, headings).
7. Preserve direct quotes inside the text — keep their double or single quotes as in the source.
8. Preserve any > "Magisterium uskladenost:" → > "Magisterium alignment:" notes intact as blockquotes.
9. If a Croatian sentence contains a quoted phrase, translate the phrase literally inside the quotation marks.
10. Output ONLY valid JSON of this exact shape: {"en": "<English translation>"}. No commentary, no markdown fences.

If the source is empty or whitespace only, return {"en": ""}.`;

// ─── GEMINI POZIV ─────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function translateOne(croatianText, dryRun) {
    if (!croatianText || typeof croatianText !== "string" || croatianText.trim() === "") {
        return croatianText || "";
    }
    if (dryRun) {
        return `[dry-run en] ${croatianText.substring(0, 40)}…`;
    }

    const payload = {
        contents: [{ role: "user", parts: [{ text: croatianText }] }],
        systemInstruction: { role: "system", parts: [{ text: TRANSLATOR_PROMPT }] },
        generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: 8192
        }
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const region = getNextRegion();
        const url = buildEndpointUrl(region);
        const token = getOrRefreshAccessToken();

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errText = await response.text();
                if (response.status === 401) {
                    cachedAccessToken = null; tokenExpiry = 0; continue;
                }
                if (response.status === 429) {
                    const waitMs = Math.min(RETRY_BASE_DELAY_MS * attempt, 30000);
                    process.stderr.write(`\n      ⏳ 429 ${region}, čekam ${waitMs/1000}s (${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs); continue;
                }
                if (response.status >= 500) {
                    await sleep(RETRY_BASE_DELAY_MS * attempt); continue;
                }
                throw new Error(`Vertex AI ${response.status} ${region}: ${errText.substring(0, 200)}`);
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("Prazan response.candidates[0].content");

            let cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
            const parsed = JSON.parse(cleaned);
            if (typeof parsed.en !== "string") throw new Error(`Missing "en" field in response: ${cleaned.substring(0, 200)}`);
            return parsed.en;
        } catch (err) {
            if (attempt === MAX_RETRIES) throw err;
            await sleep(RETRY_BASE_DELAY_MS * attempt);
        }
    }
    throw new Error("MAX_RETRIES exceeded");
}

// ─── TRANSLATE WORKFLOWS PO SCHEMI ────────────────────────────────

// Vraća true ako je entitet vlastito ime/lokacija/institucija koju NE treba prevoditi
function isProperNoun(s) {
    if (!s) return false;
    // Heuristika: prva slova velika, sadrži hrvatske dijakritičke znakove ili specifične patterne
    return /^[A-ZČĆĐŠŽ]/.test(s) || /[čćđšž]/.test(s);
}

async function translateSummary(croatian, dryRun) {
    const out = JSON.parse(JSON.stringify(croatian)); // deep clone
    const s = croatian.summary || {};
    const eS = out.summary;

    // Direktna polja
    if (s.title_hr) eS.title_en = await translateOne(s.title_hr, dryRun);
    if (s.abstract_hr) eS.abstract_en = await translateOne(s.abstract_hr, dryRun);

    // Arrays of short strings — pojedinačno
    if (Array.isArray(s.key_topics)) {
        eS.key_topics_en = [];
        for (const t of s.key_topics) eS.key_topics_en.push(await translateOne(t, dryRun));
    }
    if (Array.isArray(s.key_points)) {
        eS.key_points_en = [];
        for (const p of s.key_points) eS.key_points_en.push(await translateOne(p, dryRun));
    }

    // Speakers — role je generic ("voditelj"/"gost") — ostaje role + dodaj role_en
    if (Array.isArray(s.speakers)) {
        for (let i = 0; i < s.speakers.length; i++) {
            const sp = s.speakers[i];
            const eSp = eS.speakers[i];
            if (sp.role) eSp.role_en = await translateOne(sp.role, dryRun);
        }
    }

    // Mentioned people/places/organizations — vlastita imena ostaju, ali kalkovi se prevode
    // Praksa: ako ime sadrži CamelCase i nema čisto hrvatskih riječi, ostaje;
    // za miješane termine (npr. "Bazilika svetog Antuna Padovanskog" → "Basilica of Saint Anthony of Padua")
    // preglednije je samo prevesti cijeli niz odjednom
    for (const field of ["mentioned_people", "mentioned_places", "mentioned_organizations"]) {
        if (Array.isArray(s[field])) {
            eS[`${field}_en`] = [];
            for (const item of s[field]) eS[`${field}_en`].push(await translateOne(item, dryRun));
        }
    }

    eS.language = "hr"; // izvorni
    eS.translation = {
        target_language: "en",
        model: GEMINI_MODEL,
        method: "literal-no-hallucinations",
        temperature: 0
    };

    return out;
}

async function translateArticle(croatian, dryRun) {
    const out = JSON.parse(JSON.stringify(croatian));
    for (const it of out.iterations) {
        if (it.theme) it.theme_en = await translateOne(it.theme, dryRun);
        if (it.reason_for_cut) it.reason_for_cut_en = await translateOne(it.reason_for_cut, dryRun);
        for (const sec of (it.sections || [])) {
            if (sec.subtitle) sec.subtitle_en = await translateOne(sec.subtitle, dryRun);
            if (sec.screenshot_description) sec.screenshot_description_en = await translateOne(sec.screenshot_description, dryRun);
            if (sec.content) sec.content_en = await translateOne(sec.content, dryRun);
            if (Array.isArray(sec.keywords)) {
                sec.keywords_en = [];
                for (const k of sec.keywords) sec.keywords_en.push(await translateOne(k, dryRun));
            }
            if (Array.isArray(sec.entities)) {
                sec.entities_en = [];
                for (const e of sec.entities) sec.entities_en.push(await translateOne(e, dryRun));
            }
        }
    }
    out.translation = {
        target_language: "en",
        model: GEMINI_MODEL,
        method: "literal-no-hallucinations",
        temperature: 0,
        generated_at: new Date().toISOString()
    };
    return out;
}

async function translateMagisterium(croatian, dryRun) {
    const out = JSON.parse(JSON.stringify(croatian));
    if (out.score_interpretation) out.score_interpretation_en = await translateOne(out.score_interpretation, dryRun);
    for (let i = 0; i < (out.score_breakdown || []).length; i++) {
        const sb = out.score_breakdown[i];
        if (sb.theme) sb.theme_en = await translateOne(sb.theme, dryRun);
    }
    for (const it of out.iterations) {
        if (it.theme) it.theme_en = await translateOne(it.theme, dryRun);
        for (const sec of (it.sections || [])) {
            if (sec.subtitle) sec.subtitle_en = await translateOne(sec.subtitle, dryRun);
            if (sec.screenshot_description) sec.screenshot_description_en = await translateOne(sec.screenshot_description, dryRun);
            if (sec.content) sec.content_en = await translateOne(sec.content, dryRun);
            if (Array.isArray(sec.keywords)) {
                sec.keywords_en = [];
                for (const k of sec.keywords) sec.keywords_en.push(await translateOne(k, dryRun));
            }
            if (Array.isArray(sec.entities)) {
                sec.entities_en = [];
                for (const e of sec.entities) sec.entities_en.push(await translateOne(e, dryRun));
            }
            const m = sec.magisterium;
            if (m) {
                if (m.assessment) m.assessment_en = await translateOne(m.assessment, dryRun);
                if (m.enrichment) m.enrichment_en = await translateOne(m.enrichment, dryRun);
                if (Array.isArray(m.concerns)) {
                    m.concerns_en = [];
                    for (const c of m.concerns) m.concerns_en.push(await translateOne(c, dryRun));
                }
                // citations.document_title i document_author su već engleski → ostavi
            }
        }
    }
    out.translation = {
        target_language: "en",
        model: GEMINI_MODEL,
        method: "literal-no-hallucinations",
        temperature: 0,
        generated_at: new Date().toISOString()
    };
    return out;
}

// ─── DISCOVERY ────────────────────────────────────────────────────

function discoverArtifacts(inputDir, channelFilter, videoIdFilter) {
    const results = [];
    const channels = fs.readdirSync(inputDir, { withFileTypes: true });
    for (const ch of channels) {
        if (!(ch.isDirectory() || ch.isSymbolicLink()) || ch.name.startsWith(".")) continue;
        if (channelFilter && ch.name !== channelFilter) continue;

        const channelDir = path.join(inputDir, ch.name);
        const files = fs.readdirSync(channelDir);

        // Grupiraj po basenameu (extract video ID)
        const byBase = new Map();
        for (const f of files) {
            if (f.startsWith("._")) continue;
            const m = f.match(/_yt_([a-zA-Z0-9_-]{11})\b/);
            if (!m) continue;
            const vid = m[1];
            if (videoIdFilter && vid !== videoIdFilter) continue;
            if (!byBase.has(vid)) byBase.set(vid, { channel: ch.name, channelDir, videoId: vid, files: [] });
            byBase.get(vid).files.push(f);
        }

        for (const entry of byBase.values()) {
            // summary
            const summaryFile = entry.files.find(f => f.endsWith(".canary.summary.json") && !f.includes(".en."));
            // article (najnoviji po datumu/modelu)
            const articleFiles = entry.files
                .filter(f => f.endsWith(".article.json") && !f.endsWith(".magisterium.json") && !f.includes(".en."))
                .sort().reverse();
            const articleFile = articleFiles[0];
            // magisterium
            const magFiles = entry.files
                .filter(f => f.endsWith(".article.magisterium.json") && !f.includes(".en."))
                .sort().reverse();
            const magFile = magFiles[0];

            if (!summaryFile && !articleFile && !magFile) continue;
            results.push({ ...entry, summaryFile, articleFile, magFile });
        }
    }
    return results;
}

// ─── MAIN ─────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const getArg = (n) => {
        const i = args.indexOf(n);
        return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
    };
    return {
        inputDir: getArg("--input-dir") || "storage/output",
        channel: getArg("--channel"),
        videoId: getArg("--video-id"),
        limit: getArg("--limit") ? parseInt(getArg("--limit"), 10) : null,
        dryRun: args.includes("--dry-run"),
        force: args.includes("--force")
    };
}

async function main() {
    const opts = parseArgs();

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║  🇬🇧  CROATIAN → ENGLISH (no hallucinations)     ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Input:   ${opts.inputDir}`);
    console.log(`   🌐 Project: ${VERTEX_PROJECT} | Model: ${GEMINI_MODEL}`);
    console.log(`   🔄 Regije (${VERTEX_REGIONS.length}): ${VERTEX_REGIONS.join(", ")}`);
    if (opts.videoId) console.log(`   🎬 Video ID: ${opts.videoId}`);
    if (opts.channel) console.log(`   📁 Channel: ${opts.channel}`);
    if (opts.dryRun) console.log("   ⚠️  DRY-RUN — no API calls");

    const items = discoverArtifacts(opts.inputDir, opts.channel, opts.videoId);
    console.log(`\n   📊 Videa za prijevod: ${items.length}\n`);

    let totalOk = 0, totalSkip = 0, totalErr = 0;
    const startedAll = Date.now();

    for (let i = 0; i < items.length; i++) {
        if (opts.limit && i >= opts.limit) break;
        const it = items[i];
        console.log(`   ━━━ [${i+1}/${items.length}] [${it.channel}] ${it.videoId} ━━━`);

        const triples = [
            { src: it.summaryFile, kind: "summary", translate: translateSummary, replaceSuffix: ".canary.summary.json", enSuffix: ".canary.summary.en.json" },
            { src: it.articleFile, kind: "article", translate: translateArticle, replaceSuffix: ".article.json", enSuffix: ".article.en.json" },
            { src: it.magFile, kind: "magisterium", translate: translateMagisterium, replaceSuffix: ".article.magisterium.json", enSuffix: ".article.magisterium.en.json" }
        ];

        for (const t of triples) {
            if (!t.src) { console.log(`      ⏭️  ${t.kind}: nema izvora`); continue; }
            const outFile = t.src.replace(new RegExp(`\\${t.replaceSuffix}$`), t.enSuffix);
            const outPath = path.join(it.channelDir, outFile);
            const srcPath = path.join(it.channelDir, t.src);

            if (!opts.force && fs.existsSync(outPath)) {
                console.log(`      ⏭️  ${t.kind}: već postoji — ${outFile}`);
                totalSkip++;
                continue;
            }

            const start = Date.now();
            process.stdout.write(`      🔄 ${t.kind}: prevod… `);

            try {
                const croatian = JSON.parse(fs.readFileSync(srcPath, "utf-8"));
                const translated = await t.translate(croatian, opts.dryRun);
                fs.writeFileSync(outPath, JSON.stringify(translated, null, 2), "utf-8");
                const sec = ((Date.now() - start) / 1000).toFixed(1);
                console.log(`✅ (${sec}s, ${(fs.statSync(outPath).size/1024).toFixed(1)}KB) → ${outFile}`);
                totalOk++;
                if (!opts.dryRun) await sleep(REQUEST_DELAY_MS);
            } catch (err) {
                console.log(`❌ ${err.message}`);
                totalErr++;
            }
        }
    }

    const total = ((Date.now() - startedAll) / 1000).toFixed(1);
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK TRANSLATIONA                       ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Uspjelih:        ${totalOk}`);
    console.log(`   ⏭️  Preskočenih:    ${totalSkip}`);
    console.log(`   ❌ Grešaka:         ${totalErr}`);
    console.log(`   ⏱  Ukupno:         ${total}s`);
}

main().catch((err) => {
    console.error("\n❌ Fatal:", err.message);
    process.exit(1);
});
