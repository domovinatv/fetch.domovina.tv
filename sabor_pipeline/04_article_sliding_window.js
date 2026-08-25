#!/usr/bin/env node
/**
 * FAZA 04 (prolaz A) — dugi članak o cijeloj saborskoj sjednici, map-reduce
 * kliznim prozorom preko dijariziranog i imenovanog transkripta.
 *
 * Zašto klizni prozor, a ne jedan poziv: sjednica ima **819 000 znakova
 * (≈ 264 000 tokena)**. Gemini 3.x to primi u kontekst, ali „primi" i „obradi
 * ravnomjerno" nisu isto — u jednom prolazu sredina snimke dobiva bitno manje
 * pažnje od početka i kraja, a ovdje je sredina 12 sati rasprave.
 *
 * Tok:
 *   MAP     svaki prozor (~45 000 znakova, preklapanje 1 blok) → strukturirane
 *           bilješke u JSON-u; prozor se NIKAD ne lomi usred bloka jer je blok
 *           jedan neprekinuti istup jednog govornika
 *   OUTLINE sve bilješke (male) → tematski plan članka
 *   WRITE   svako poglavlje zasebno, s bilješkama SVOJIH prozora + citatima
 *
 * Svaki korak je idempotentan i piše međurezultat na disk — prekinut run se
 * nastavlja, ne ponavlja (ista konvencija kao `generate_article_gemini.js`).
 *
 * Backend (isti izbor kao koraci 7+8 u glavnom pipelineu):
 *   --backend agy     → `agy -p --model <AGY_MODEL>`   (default gemini-3.7-flash-high)
 *   --backend claude  → `claude -p --model opus` pod PRETPLATOM
 *
 * ⛔ Za `claude` backend vrijede tvrda pravila iz CLAUDE.md: `--tools ''` je
 *    obavezan, `--bare` se NIKAD ne koristi (tiho prebacuje na per-token naplatu).
 *
 * Uporaba:
 *   node sabor_pipeline/04_article_sliding_window.js --session <id> --backend agy
 *   node sabor_pipeline/04_article_sliding_window.js --session <id> --only-map --limit 2
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "storage", "output", "sabor");

const args = process.argv.slice(2);
function getArg(n, d = null) { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; }
const has = (n) => args.includes(n);

const SESSION = getArg("--session");
const BACKEND = getArg("--backend", "agy");
const AGY_MODEL = getArg("--model", process.env.AGY_MODEL || "gemini-3.7-flash-high");
const CLAUDE_MODEL = getArg("--model", process.env.CLAUDE_MODEL || "opus");
const WINDOW_CHARS = Number(getArg("--window-chars", 45000));
const LIMIT = Number(getArg("--limit", 0));
const ONLY_MAP = has("--only-map");
const ONLY_WRITE = has("--only-write");
const FORCE = has("--force");
const TIMEOUT_MS = Number(getArg("--timeout", 900)) * 1000;

if (!SESSION) { console.error("Uporaba: --session <session_id> [--backend agy|claude]"); process.exit(2); }

const sessionDir = path.join(getArg("--output-dir", DEFAULT_OUTPUT_DIR), SESSION);
const workDir = path.join(sessionDir, `article_${BACKEND}_${slug(BACKEND === "agy" ? AGY_MODEL : CLAUDE_MODEL)}`);
const windowsDir = path.join(workDir, "windows");

// ───────────────────────── LLM backend ─────────────────────────

/** `agy -p` headless, JSON envelope (isti poziv kao generate_article_gemini.js). */
function callAgy(system, user) {
    // ⚠️ agy NE čita prompt sa stdina — `-p` traži inline vrijednost
    // (`-p=<tekst>`). Poziv iz `generate_article_gemini.js` koji šalje prompt
    // kroz stdin s trenutnom verzijom puca s „-p took --model as its prompt".
    return run("agy", ["--model", AGY_MODEL, "--output-format", "json",
                       "--dangerously-skip-permissions",
                       `-p=${system}\n\n---\n\n${user}`], null)
        .then((out) => {
            let env;
            try { env = JSON.parse(out); }
            catch (_) { throw new Error(`agy nije vratio JSON envelope: ${out.slice(0, 300)}`); }
            if (env.status !== "SUCCESS") {
                throw new Error(`agy status=${env.status}: ${String(env.error || env.response).slice(0, 300)}`);
            }
            return String(env.response || "");
        });
}

/**
 * `claude -p` pod pretplatom.
 * `--tools ''` je OBAVEZAN (bez njega tool definicije uđu u svaki poziv,
 * 21 000 → 233 tokena overhead), a `cwd` mora biti neutralan direktorij inače
 * `claude` učita projektni CLAUDE.md u svaki poziv. NIKAD `--bare`.
 */
function callClaude(system, user) {
    const neutral = fs.mkdtempSync(path.join(os.tmpdir(), "sabor-llm-"));
    return run("claude", ["-p", "--model", CLAUDE_MODEL, "--tools", "",
                          "--append-system-prompt", system],
        user, { cwd: neutral })
        .finally(() => { try { fs.rmSync(neutral, { recursive: true, force: true }); } catch (_) {} });
}

function run(cmd, argv, stdin, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"], ...opts });
        let out = "", err = "";
        const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd}: timeout ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS);
        p.stdout.on("data", (d) => { out += d; });
        p.stderr.on("data", (d) => { err += d; });
        p.on("error", (e) => { clearTimeout(timer); reject(new Error(`${cmd} spawn: ${e.message}`)); });
        p.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(`${cmd} exit ${code}: ${(err || out).slice(0, 400)}`));
            resolve(out);
        });
        p.stdin.on("error", () => {});
        p.stdin.end(stdin == null ? "" : stdin);
    });
}

const callLlm = BACKEND === "claude" ? callClaude : callAgy;

/** Izvuci JSON iz odgovora — modeli ga rado zamotaju u ```json ogradu. */
function extractJson(text) {
    const t = String(text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fence ? fence[1] : t;
    const s = body.indexOf("{"), e = body.lastIndexOf("}");
    if (s === -1 || e === -1) throw new Error(`nema JSON objekta u odgovoru: ${t.slice(0, 200)}`);
    return JSON.parse(body.slice(s, e + 1));
}

// ───────────────────────── prozori ─────────────────────────

/** Ime govornika za prikaz — bez izmišljanja kad identitet nije razriješen. */
function speakerLabel(b) {
    if (b.speaker_name) return `${b.speaker_name}${b.party ? ` (${b.party})` : ""}`;
    if (b.role === "predsjedatelj") return `Predsjedavajući [${b.speaker_id}]`;
    if (b.role === "clan_vlade") return `Član Vlade [${b.speaker_id}]`;
    return `Neimenovani govornik [${b.speaker_id}]`;
}

function renderBlock(b) {
    return `[${b.start_hms} | ${b.speaker_id}] ${speakerLabel(b)}: ${b.text}`;
}

/**
 * Podjela na prozore. Blok se NIKAD ne lomi — jedan blok je jedan neprekinuti
 * istup, a presječen istup daje polovicu argumenta bez zaključka.
 * Preklapanje je jedan blok, da poglavlje koje počinje na granici ima uvod.
 */
function buildWindows(blocks, targetChars) {
    const windows = [];
    let cur = [], size = 0;
    for (const b of blocks) {
        const r = renderBlock(b);
        if (size + r.length > targetChars && cur.length) {
            windows.push(cur);
            cur = [cur[cur.length - 1]];               // preklapanje: zadnji blok
            size = renderBlock(cur[0]).length;
        }
        cur.push(b);
        size += r.length + 2;
    }
    if (cur.length > 1 || windows.length === 0) windows.push(cur);
    return windows;
}

// ───────────────────────── promptovi ─────────────────────────

const MAP_SYSTEM = `Ti si parlamentarni izvjestitelj koji čita doslovni transkript sjednice Hrvatskoga sabora.
Transkript je strojni (NVIDIA Canary ASR) pa sadrži pogreške u imenima, brojevima i padežima.

TVRDA PRAVILA:
1. Piši ISKLJUČIVO na hrvatskom.
2. NE izmišljaj imena. Ako u transkriptu piše "Neimenovani govornik [SPEAKER_042]", tako ga i navedi.
3. NE izmišljaj brojke ni datume kojih nema u tekstu. Ako je broj izgovoren riječima ("dvadeset devet milijuna eura"), prepiši ga brojkom samo ako je nedvosmislen.
4. Svaka tvrdnja MORA imati timestamp iz uglatih zagrada u kojem je izrečena.
5. Vraćaš ISKLJUČIVO valjan JSON, bez ikakvog teksta izvan njega.`;

function mapUser(win, idx, total, blocks) {
    return `Ovo je prozor ${idx + 1} od ${total} transkripta 11. izvanredne sjednice Hrvatskoga sabora
(20.–21. kolovoza 2026., tema: odlaganje opasnog otpada na području Gospića; sjednicu je zatražio Predsjednik Republike).

Vremenski raspon prozora: ${blocks[0].start_hms} – ${blocks[blocks.length - 1].start_hms}.

Pročitaj i vrati JSON s ovom shemom:
{
  "raspon": {"od": "HH:MM:SS", "do": "HH:MM:SS"},
  "teme": ["kratki nazivi tema o kojima se u OVOM prozoru raspravljalo"],
  "faza_sjednice": "npr. uvodna izlaganja | klupska stajališta | pojedinačne rasprave | replike | glasovanje",
  "govornici": [{"ime": "...", "uloga": "zastupnik|predsjedavajući|član Vlade|neimenovan", "sazetak_istupa": "2-3 rečenice"}],
  "kljucne_tvrdnje": [{"tko": "...", "timestamp": "HH:MM:SS", "tvrdnja": "jedna rečenica", "vrsta": "optuzba|obrana|podatak|prijedlog|pitanje"}],
  "sukobi": [{"izmedu": ["A", "B"], "o_cemu": "...", "timestamp": "HH:MM:SS"}],
  "brojke_i_datumi": [{"vrijednost": "...", "kontekst": "...", "timestamp": "HH:MM:SS"}],
  "citati": [{"tko": "...", "timestamp": "HH:MM:SS", "citat": "doslovan navod, najviše 30 riječi"}],
  "proceduralno": ["stanke, povrede Poslovnika, opomene — samo ako su značajne"]
}

Budi iscrpan u "kljucne_tvrdnje" (10-25 stavki) — to je jedini trag koji ostaje nakon ovog prozora.

TRANSKRIPT:
${win}`;
}

const OUTLINE_SYSTEM = `Ti si urednik koji od bilježaka sastavlja plan dugog novinarskog članka o cjelodnevnoj saborskoj sjednici.
Piši na hrvatskom. Vraćaš ISKLJUČIVO valjan JSON.`;

function outlineUser(notes) {
    return `Ovo su strukturirane bilješke iz ${notes.length} uzastopnih prozora transkripta 11. izvanredne sjednice
Hrvatskoga sabora (20 h 01 min, 20.–21. 8. 2026., tema: opasni otpad u Gospiću).

Sastavi plan članka od 8 do 12 poglavlja. Poglavlja moraju pokriti CIJELU sjednicu, ne samo početak.
Neka barem dva poglavlja budu tematska (ne kronološka) — npr. "Tko je što znao i kada" ili "Sukob oko odgovornosti Fonda".

Vrati JSON:
{
  "naslov": "novinarski naslov cijelog članka",
  "podnaslov": "jedna rečenica",
  "sazetak": "3-5 rečenica koje sažimaju cijelu sjednicu",
  "poglavlja": [
    {"broj": 1, "naslov": "...", "teziste": "što ovo poglavlje mora obraditi, 2-3 rečenice",
     "prozori": [0, 1, 2], "kljucni_govornici": ["..."]}
  ]
}
"prozori" je popis rednih brojeva prozora (0-indeksirano) iz kojih se poglavlje piše.

BILJEŠKE:
${JSON.stringify(notes, null, 1)}`;
}

const WRITE_SYSTEM = `Ti si iskusni parlamentarni novinar. Pišeš poglavlje dugog analitičkog članka na hrvatskom.

TVRDA PRAVILA:
1. NE izmišljaj imena, brojke, datume ni citate. Sve mora doći iz priloženih bilježaka i citata.
2. Govornika kojemu identitet nije utvrđen zovi opisno ("neimenovani zastupnik", "predstavnica Vlade"), NIKAD ne pogađaj ime.
3. Za svaku važnu tvrdnju navedi vrijeme u obliku [HH:MM:SS] — čitatelj po njemu skače na snimku.
4. Piši tekućim novinarskim jezikom, bez natuknica. Ne ponavljaj naslov poglavlja u prvoj rečenici.
5. Vraćaš ISKLJUČIVO Markdown tekst poglavlja, bez ikakvog uvoda o tome što radiš.`;

function writeUser(ch, notes, citati) {
    return `Napiši poglavlje ${ch.broj}: „${ch.naslov}" dugog članka o 11. izvanrednoj sjednici Hrvatskoga sabora
(20 h 01 min, 20.–21. 8. 2026., opasni otpad u Gospiću, sjednicu zatražio Predsjednik Republike).

Težište poglavlja: ${ch.teziste}
Ključni govornici: ${(ch.kljucni_govornici || []).join(", ") || "(nije određeno)"}

Duljina: 600–1100 riječi. Počni Markdown naslovom razine 2 (## ${ch.naslov}).

BILJEŠKE IZ PRIPADAJUĆIH PROZORA:
${JSON.stringify(notes, null, 1)}

DOSLOVNI CITATI KOJE SMIJEŠ KORISTITI (i samo njih):
${JSON.stringify(citati, null, 1)}`;
}

// ───────────────────────── koraci ─────────────────────────

async function main() {
    const alignedPath = path.join(sessionDir, "aligned_transcript.json");
    if (!fs.existsSync(alignedPath)) { console.error(`GREŠKA: nedostaje ${alignedPath} (pokreni fazu 03)`); process.exit(1); }
    const aligned = JSON.parse(fs.readFileSync(alignedPath, "utf8"));
    fs.mkdirSync(windowsDir, { recursive: true });

    const windows = buildWindows(aligned.blocks, WINDOW_CHARS);
    const totalChars = aligned.blocks.reduce((s, b) => s + renderBlock(b).length, 0);
    log(`Sjednica ${SESSION}: ${aligned.blocks.length} blokova, ${totalChars.toLocaleString("hr")} znakova`);
    log(`Backend: ${BACKEND} (${BACKEND === "agy" ? AGY_MODEL : CLAUDE_MODEL}) → ${path.relative(REPO_ROOT, workDir)}`);
    log(`Prozora: ${windows.length} × ~${WINDOW_CHARS.toLocaleString("hr")} znakova (preklapanje 1 blok)`);

    // ── MAP ──
    const t0 = Date.now();
    const todo = LIMIT > 0 ? windows.slice(0, LIMIT) : windows;
    for (let i = 0; i < todo.length; i++) {
        if (ONLY_WRITE) break;
        const out = path.join(windowsDir, `w${String(i).padStart(2, "0")}.json`);
        if (fs.existsSync(out) && !FORCE) { log(`  [${i + 1}/${todo.length}] preskačem (postoji)`); continue; }
        const blocks = todo[i];
        const text = blocks.map(renderBlock).join("\n\n");
        const started = Date.now();
        try {
            const raw = await callLlm(MAP_SYSTEM, mapUser(text, i, windows.length, blocks));
            const json = extractJson(raw);
            json._window = i;
            json._blocks = blocks.length;
            json._chars = text.length;
            fs.writeFileSync(out, JSON.stringify(json, null, 1) + "\n", "utf8");
            log(`  [${i + 1}/${todo.length}] ${blocks[0].start_hms}–${blocks[blocks.length - 1].start_hms} ` +
                `${(text.length / 1000).toFixed(0)}k zn → ${(json.kljucne_tvrdnje || []).length} tvrdnji, ` +
                `${(json.citati || []).length} citata (${((Date.now() - started) / 1000).toFixed(0)}s)`);
        } catch (e) {
            log(`  [${i + 1}/${todo.length}] ✖ ${e.message.slice(0, 200)}`);
            fs.writeFileSync(out.replace(/\.json$/, ".error.txt"), e.message, "utf8");
        }
    }
    log(`MAP gotov u ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    if (ONLY_MAP) return;

    // ── OUTLINE ──
    const notes = [];
    for (let i = 0; i < windows.length; i++) {
        const f = path.join(windowsDir, `w${String(i).padStart(2, "0")}.json`);
        if (fs.existsSync(f)) notes.push(JSON.parse(fs.readFileSync(f, "utf8")));
    }
    if (!notes.length) { console.error("GREŠKA: nema nijedne bilješke — MAP nije prošao."); process.exit(1); }
    log(`Bilježaka: ${notes.length}/${windows.length}`);

    const outlinePath = path.join(workDir, "outline.json");
    let outline;
    if (fs.existsSync(outlinePath) && !FORCE) {
        outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
        log("OUTLINE: postoji, preskačem");
    } else {
        // Za outline se šalju bilješke bez punih citata — plan ne treba navode.
        const lean = notes.map((n) => ({ ...n, citati: undefined }));
        outline = extractJson(await callLlm(OUTLINE_SYSTEM, outlineUser(lean)));
        fs.writeFileSync(outlinePath, JSON.stringify(outline, null, 2) + "\n", "utf8");
        log(`OUTLINE: „${outline.naslov}" — ${outline.poglavlja.length} poglavlja`);
    }

    // ── WRITE ──
    const parts = [];
    for (const ch of outline.poglavlja) {
        const out = path.join(workDir, `poglavlje_${String(ch.broj).padStart(2, "0")}.md`);
        if (fs.existsSync(out) && !FORCE) { parts.push(fs.readFileSync(out, "utf8")); log(`  pogl. ${ch.broj}: postoji`); continue; }
        const idxs = (ch.prozori || []).filter((i) => notes[i]);
        const chNotes = (idxs.length ? idxs.map((i) => notes[i]) : notes).map((n) => ({ ...n, citati: undefined }));
        const citati = (idxs.length ? idxs.map((i) => notes[i]) : notes).flatMap((n) => n.citati || []);
        const started = Date.now();
        try {
            const md = (await callLlm(WRITE_SYSTEM, writeUser(ch, chNotes, citati))).trim();
            fs.writeFileSync(out, md + "\n", "utf8");
            parts.push(md);
            log(`  pogl. ${ch.broj} „${ch.naslov}": ${md.split(/\s+/).length} riječi (${((Date.now() - started) / 1000).toFixed(0)}s)`);
        } catch (e) {
            log(`  pogl. ${ch.broj}: ✖ ${e.message.slice(0, 160)}`);
        }
    }

    // ── SASTAVI ──
    const header = [
        `# ${outline.naslov}`, "",
        `*${outline.podnaslov || ""}*`, "",
        outline.sazetak || "", "",
        `> Izvor: 11. izvanredna sjednica Hrvatskoga sabora, 20.–21. kolovoza 2026., ` +
        `4 videozapisa, ukupno 20 h 01 min. Transkripcija NVIDIA Canary 1B v2, ` +
        `dijarizacija pyannote community-1 (${aligned.total_speakers} govornika), ` +
        `imenovanje protokolarnim sidrenjem nad registrom sa sabor.hr ` +
        `(${aligned.stats.distinct_mps_named} imenovanih zastupnika, ` +
        `${aligned.stats.named_speech_pct} % govornog vremena).`,
        `> Članak sastavljen kliznim prozorom (${windows.length} prozora), model ` +
        `${BACKEND === "agy" ? AGY_MODEL : "claude-code:" + CLAUDE_MODEL}.`, "",
    ].join("\n");
    const article = header + "\n" + parts.join("\n\n");
    const outMd = path.join(workDir, "clanak.md");
    fs.writeFileSync(outMd, article + "\n", "utf8");
    log(`\nZapisano: ${outMd}`);
    log(`Ukupno: ${article.split(/\s+/).length.toLocaleString("hr")} riječi, ${parts.length} poglavlja`);
}

function slug(s) { return String(s).replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, ""); }
function log(s) { process.stderr.write(s + "\n"); }

main().catch((e) => { console.error("GREŠKA:", e.message); process.exit(1); });
