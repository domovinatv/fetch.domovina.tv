#!/usr/bin/env node
"use strict";
/**
 * generate_ebook.js — KORAK 11.5: EPUB e-knjiga iz već obrađene epizode.
 *
 * NE ZOVE NIJEDAN LLM. Sav tekst i sve slike već postoje na disku nakon
 * koraka 8 (članak), 9.5/9.7 (thumbnail varijante) i 10 (screenshotovi) —
 * ovaj korak ih samo preslaguje u EPUB 3.0 arhivu. Trošak = CPU + par MB
 * diska. Zato smije ići u nightly bez razmišljanja o kvoti.
 *
 * Ulaz (sve iz {channel}/{base}.*):
 *   {base}_{date}_{model}.article.json          OBAVEZNO (poglavlja + sekcije)
 *   {base}.wav.canary.summary.json              opcionalno (sažetak, govornici)
 *   {base}_{date}_{model}.article.magisterium.json  opcionalno (teološki dodatak)
 *   {base}.info.json                            opcionalno (YouTube metapodaci)
 *   {base}.png / .og-share.jpg                  opcionalno (naslovnica)
 *   {base}_screenshots/{base}_HH-MM-SS.png      opcionalno (ilustracije sekcija)
 *   {base}.wav.canary.diarized.srt              samo uz --with-transcript
 *
 * Izlaz: {channel}/{base}.epub  (+ {base}.en.epub kad postoji `.article.en.json`)
 *
 * Linkovi: svi klikabilni linkovi (timestampovi poglavlja, potpisi slika,
 * transkript, kolofon) vode na domovina.ai `/v/:id` i `/v/:id/t/:sec`, nikad na
 * YouTube — knjiga se dijeli izvan našeg kanala i mora voditi natrag k nama.
 * Bazu mijenja `EBOOK_SITE_BASE`.
 *
 * Idempotencija: postojeći .epub se preskače osim uz --force. Izvedena
 * datoteka JE signal — ne vodi se zaseban state file.
 *
 * Ovisnosti: ffprobe nije potreban; ImageMagick (`magick`) se koristi za
 * skaliranje slika i naslovnicu, uz fallback na originalne datoteke ako ga
 * nema. ZIP se piše ručno (lib/zip_writer.js) — nema npm ovisnosti.
 *
 * Primjeri:
 *   node generate_ebook.js --video-id h_6vqQEL2uc
 *   node generate_ebook.js --channel muzevni_budite --limit 5
 *   node generate_ebook.js --video-id h_6vqQEL2uc --with-transcript --force
 *   node generate_ebook.js --force            # regeneracija katalogа (npr. linkovi)
 *   node generate_ebook.js --only-en          # samo engleska izdanja
 *   node generate_ebook.js --force --older-than 2026-09-15T13:00  # nastavak prekinutog prolaza
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { ZipWriter } = require("./lib/zip_writer");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
function hasFlag(name) {
    return args.includes(name);
}

const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const ONLY_VIDEO_ID = getArg("--video-id");
const LIMIT = parseInt(getArg("--limit") || "0", 10) || 0;
const FORCE = hasFlag("--force");
const DRY_RUN = hasFlag("--dry-run");
const WITH_TRANSCRIPT = hasFlag("--with-transcript");
const NO_IMAGES = hasFlag("--no-images");
// Regeneracija preko postojeće knjige (npr. link-backfill) smije je samo POBOLJŠATI.
// Ako su screenshotovi u međuvremenu nestali s diska (bulk restore, preseljenje
// kanala), nova bi knjiga izašla bez slika i tiho pregazila dobru — i na disku i,
// nakon uploada, na CDN-u. Zato se vidljivo manja knjiga ne piše bez privole.
const ALLOW_SHRINK = hasFlag("--allow-shrink");
// Englesko izdanje se gradi automatski kad postoji `.article.en.json` (kao što
// 9.6 radi EN og-sections). `--no-en` ga gasi, `--only-en` preskače hrvatsko.
// Nastavak prekinutog katalog-wide `--force` prolaza: preskoči knjige koje su
// već regenerirane poslije zadanog trenutka. Postojeći .epub je i inače signal
// idempotencije — ovdje mu samo dodajemo vrijeme, umjesto da se vodi state file.
const OLDER_THAN = (() => {
    const v = getArg("--older-than");
    if (!v) return 0;
    const t = new Date(v).getTime();
    if (Number.isNaN(t)) { console.error(`❌ --older-than: neispravan datum "${v}"`); process.exit(1); }
    return t;
})();
const NO_EN = hasFlag("--no-en");
const ONLY_EN = hasFlag("--only-en");
const SHRINK_RATIO = 0.6;
const IMAGE_WIDTH = parseInt(getArg("--image-width") || "1200", 10);
const IMAGE_QUALITY = parseInt(getArg("--image-quality") || "80", 10);
const SITE_BASE = process.env.EBOOK_SITE_BASE || "https://domovina.ai";

// ─────────────────────────────────────────────────────────────────────────────
// Linkovi: SVAKI klikabilan link u knjizi ide kroz domovina.ai.
//
// EPUB je datoteka koja putuje sama (WhatsApp, mail, Telegram) i nadživi svaku
// našu objavu — ti su linkovi jedini put natrag prema nama. Ako vode na
// youtube.com, knjigu smo poklonili YouTubeu: promet, kontekst, prijevod,
// teološka prosudba i pretraga ostaju izvan dohvata čitatelja.
//
// `/v/:id/t/:sec` je stvarna ruta Flutter aplikacije (domovina.ai
// `lib/router/app_router.dart`) — otvara epizodu i pozicionira player na
// sekundu, isto što je YouTube `&t=Ns` radio.
//
// YouTube smije ostati SAMO kao neklikabilan navod izvora (atribucija
// nakladniku), nikad kao <a href>.
// ─────────────────────────────────────────────────────────────────────────────
const episodeUrl = (videoId, lang) => `${SITE_BASE}/v/${videoId}${lang === "en" ? "/en" : ""}`;
const deepLinkUrl = (videoId, sec, lang) =>
    `${SITE_BASE}/v/${videoId}/t/${Math.max(0, Math.floor(sec || 0))}${lang === "en" ? "/en" : ""}`;

// ─────────────────────────────────────────────────────────────────────────────
// Dvojezičnost
//
// `translate_to_english.js` piše ADITIVNO: `.article.en.json` ima i `theme` i
// `theme_en`, `content` i `content_en`. Knjiga zato ne treba drugi format —
// treba samo birati sufiks. `pickLang()` pada natrag na hrvatsko polje ako
// prijevod tog polja nema (npr. `role` govornika, koji se ne prevodi).
// ─────────────────────────────────────────────────────────────────────────────
const STRINGS = {
    hr: {
        lang: "hr",
        naslovnica: "Naslovnica", oEpizodi: "O ovoj epizodi", sadrzaj: "Sadržaj",
        objavljeno: "Objavljeno", trajanje: "Trajanje", sudionici: "Sudionici",
        teme: "Teme", epizoda: "Epizoda", izvornik: "Izvornik",
        kljucneTocke: "Ključne točke", poglavlje: (n) => `Poglavlje ${n}`,
        dodatak: "Dodatak", prosudba: "Teološka prosudba",
        prosudbaLead: "Magisterium AI · usklađenost s katoličkim naukom",
        sjemenke: "Sjemenke istine", ograde: "Napomene i ograde",
        kontekst: "Teološki kontekst", izvori: "Izvori",
        transkript: "Transkript", transkriptNav: "Cjeloviti transkript",
        transkriptNaslov: "Cjeloviti transkript",
        kolofon: "Kolofon",
        knjiguSlozio: "Ovu je knjigu automatski složio domovina.ai iz transkripta epizode. Tekst poglavlja je uredničko-novinarska obrada razgovora, a ne doslovan prijepis.",
        prosudbuIzradio: "Prosudbu je izradio Magisterium AI nad tekstom poglavlja. Ocjena se odnosi na usklađenost iznesenih tvrdnji s katoličkim naukom, a ne na istinitost pojedinih povijesnih navoda.",
        transkriptNapomena: "Automatska transkripcija (Canary 1B v2) i dijarizacija (pyannote). Moguće su pogreške u prepoznavanju riječi i pripisivanju replika.",
        cijelaEpizoda: "Cijela epizoda, transkript i prijevod",
        prava: (kanal) => `Autorska prava na izgovoreni sadržaj, snimku i kadrove pripadaju izvornom nakladniku kanala <strong>${kanal}</strong>. Ovo je izdanje izvedena, uredničko-novinarska obrada namijenjena praćenju i pretraživanju javnog sadržaja.`,
        obrada: (model, mag) => `Obrada: transkripcija NVIDIA Canary 1B v2 · dijarizacija pyannote · uredničko sažimanje ${model}${mag ? " · teološka prosudba Magisterium AI" : ""}.`,
        slozeno: (datum) => `Složeno automatski, ${datum}, domovina.ai.`,
        izvedenoIzdanje: (kanal) => `Izvedeno izdanje. Prava na izvorni sadržaj: ${kanal}.`,
    },
    en: {
        lang: "en",
        naslovnica: "Cover", oEpizodi: "About this episode", sadrzaj: "Contents",
        objavljeno: "Published", trajanje: "Duration", sudionici: "Participants",
        teme: "Topics", epizoda: "Episode", izvornik: "Original",
        kljucneTocke: "Key points", poglavlje: (n) => `Chapter ${n}`,
        dodatak: "Appendix", prosudba: "Theological assessment",
        prosudbaLead: "Magisterium AI · alignment with Catholic teaching",
        sjemenke: "Seeds of truth", ograde: "Notes and caveats",
        kontekst: "Theological context", izvori: "Sources",
        transkript: "Transcript", transkriptNav: "Full transcript (Croatian)",
        transkriptNaslov: "Full transcript (original language)",
        kolofon: "Colophon",
        knjiguSlozio: "This book was assembled automatically by domovina.ai from the episode transcript. The chapters are an edited, journalistic treatment of the conversation, translated from Croatian — not a verbatim transcript.",
        prosudbuIzradio: "The assessment was produced by Magisterium AI over the chapter text. The score concerns how the stated claims align with Catholic teaching, not the factual accuracy of individual historical claims.",
        transkriptNapomena: "Automatic transcription (Canary 1B v2) and diarization (pyannote), in the original Croatian. Word recognition and speaker attribution may contain errors.",
        cijelaEpizoda: "Full episode, transcript and translation",
        prava: (kanal) => `Copyright in the spoken content, the recording and the footage belongs to the original publisher of the channel <strong>${kanal}</strong>. This is a derived, editorial edition made for following and searching public content.`,
        obrada: (model, mag) => `Processing: transcription NVIDIA Canary 1B v2 · diarization pyannote · editorial summarisation ${model}${mag ? " · theological assessment Magisterium AI" : ""}.`,
        slozeno: (datum) => `Assembled automatically, ${datum}, domovina.ai.`,
        izvedenoIzdanje: (kanal) => `Derived edition. Rights to the original content: ${kanal}.`,
    },
};

// Uloge govornika (`summary.speakers[].role`) prijevod NEMA — `translate_to_english.js`
// ih ne dira. Rep je dug (78 različitih vrijednosti), ali prvih pet pokriva ~90 %,
// pa mali rječnik s fallbackom na original odradi posao bez LLM poziva.
const ROLE_EN = {
    "gost": "guest", "gošća": "guest", "voditelj": "host", "voditeljica": "host",
    "sugovornik": "interlocutor", "sugovornica": "interlocutor",
    "predavač": "lecturer", "predavačica": "lecturer",
    "propovjednik": "preacher", "svećenik": "priest", "poduzetnik": "entrepreneur",
    "pozivatelj": "caller", "sudionik": "participant", "sudionica": "participant",
    "narator": "narrator", "naracija": "narration", "govornik": "speaker",
    "pjevač": "singer", "pjevačica": "singer", "izvođač": "performer",
    "novinar": "journalist", "novinarka": "journalist", "moderator": "moderator",
    "gost u prilogu": "guest in the segment", "reklama": "advertisement",
};

/** „voditelj/propovjednik" → „host/preacher"; nepoznato ostaje kako jest. */
function translateRole(role, lang) {
    if (lang !== "en" || !role) return role;
    return String(role).split("/")
        .map((part) => ROLE_EN[part.trim().toLowerCase()] || part.trim())
        .join("/");
}

/** Za `en` vraća `field_en` ako postoji, inače hrvatski original. */
function pickLang(obj, field, lang) {
    if (!obj) return undefined;
    if (lang === "en") {
        const v = obj[`${field}_en`];
        if (v !== undefined && v !== null && (!Array.isArray(v) || v.length)) return v;
    }
    return obj[field];
}

// ─────────────────────────────────────────────────────────────────────────────
// Zajedničke pomoćne funkcije (kopirane iz ostalih pipeline skripti — repo
// namjerno nema shared modul; ako mijenjaš, grepaj ime funkcije po svim
// datotekama)
// ─────────────────────────────────────────────────────────────────────────────

/** Zadnji `_yt_XXXXXXXXXXX` u imenu — naslovi znaju sadržavati "_yt_". */
function extractVideoId(filename) {
    const matches = [...filename.matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

function timestampToSeconds(ts) {
    if (!ts) return 0;
    const parts = String(ts).trim().replace(",", ".").split(":").map(Number);
    if (parts.some(Number.isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
}

function secondsToLabel(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function esc(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Mini-markdown → XHTML. Članci iz koraka 8 koriste samo **bold**, *italic*
 * i povremeno 'navodnike'. Escapeamo PRIJE zamjena da tekst ne može ubaciti
 * markup u EPUB (sadržaj je LLM output — tretiramo ga kao nepovjerljiv).
 */
function mdToXhtml(text) {
    const paragraphs = String(text || "")
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
    return paragraphs
        .map((p) => {
            let html = esc(p)
                .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
                .replace(/\n/g, "<br/>");
            return `<p>${html}</p>`;
        })
        .join("\n");
}

/** Deterministički UUID iz YouTube ID-a — isti video uvijek isti dc:identifier. */
function stableUuid(seed) {
    const h = crypto.createHash("sha1").update(String(seed)).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

let magickChecked = null;
function hasMagick() {
    if (magickChecked !== null) return magickChecked;
    try {
        execFileSync("magick", ["-version"], { stdio: "ignore" });
        magickChecked = true;
    } catch {
        magickChecked = false;
    }
    return magickChecked;
}

// ─────────────────────────────────────────────────────────────────────────────
// Otkrivanje epizoda
// ─────────────────────────────────────────────────────────────────────────────

function listChannelDirs(inputDir) {
    // Kanali su simlinkovi na druge diskove → isDirectory() vraća false.
    return fs
        .readdirSync(inputDir, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
}

/**
 * Za svaki base bira leksikografski NAJVEĆI `_{date}_{model}.article.json`.
 * Isti dedup kao downstream (`'o' > 'g' > 'a'` → opus > gemini > agy), pa
 * e-knjiga uvijek prati onaj članak koji se i servira.
 */
function findEpisodes(channelDir) {
    let files;
    try {
        files = fs.readdirSync(channelDir);
    } catch {
        return [];
    }
    const byBase = new Map();
    for (const f of files) {
        if (!f.endsWith(".article.json")) continue;
        // Model slug SADRŽI točke ("gemini-3.5-flash") → non-greedy, ne [^.]+
        const m = f.match(/^(.*)\.wav\.canary\.diarized_(\d{4}-\d{2}-\d{2})_(.+?)\.article\.json$/);
        if (!m) continue;
        const [, base, , model] = m;
        const prev = byBase.get(base);
        if (!prev || f > prev.articleFile) {
            byBase.set(base, { base, model, articleFile: f, articlePrefix: f.replace(/\.article\.json$/, "") });
        }
    }
    return [...byBase.values()].sort((a, b) => b.base.localeCompare(a.base));
}

function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slike
// ─────────────────────────────────────────────────────────────────────────────

/** Skalira i pretvara u JPEG; bez ImageMagicka vraća original (veći EPUB). */
function prepareImage(srcPath, tmpDir, outName) {
    if (!fs.existsSync(srcPath)) return null;
    const outPath = path.join(tmpDir, outName);
    if (!hasMagick()) {
        const ext = path.extname(srcPath).toLowerCase();
        const fallback = path.join(tmpDir, outName.replace(/\.jpg$/, ext));
        fs.copyFileSync(srcPath, fallback);
        return { path: fallback, media: ext === ".png" ? "image/png" : "image/jpeg" };
    }
    try {
        execFileSync(
            "magick",
            [srcPath, "-resize", `${IMAGE_WIDTH}x>`, "-strip", "-interlace", "none",
             "-quality", String(IMAGE_QUALITY), outPath],
            { stdio: "ignore" }
        );
        return { path: outPath, media: "image/jpeg" };
    } catch {
        return null;
    }
}

/**
 * Naslovnica 1600×2400: thumbnail gore, naslov + kanal dolje na tamnoj podlozi.
 * ffmpeg u ovom setupu nema drawtext (bez libfreetype), pa ide ImageMagick.
 * Bez ImageMagicka fallback je goli thumbnail — čitači ga i dalje prikažu.
 */
function buildCover(thumbPath, tmpDir, meta) {
    const out = path.join(tmpDir, "cover.jpg");
    if (!hasMagick()) return prepareImage(thumbPath, tmpDir, "cover.jpg");

    const W = 1600, H = 2400;
    const font = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                  "/Library/Fonts/Arial Unicode.ttf"].find((f) => fs.existsSync(f));
    const fontReg = ["/System/Library/Fonts/Supplemental/Arial.ttf",
                     "/Library/Fonts/Arial Unicode.ttf"].find((f) => fs.existsSync(f));
    try {
        const argv = [
            "-size", `${W}x${H}`, "xc:#12161d",
        ];
        if (thumbPath && fs.existsSync(thumbPath)) {
            // Thumbnail preko cijele širine, ~16:9, na 300px od vrha.
            argv.push("(", thumbPath, "-resize", `${W}x`, ")", "-geometry", "+0+340", "-composite");
        }
        argv.push(
            "-fill", "#f4c542", "-font", font, "-pointsize", "48",
            "-annotate", "+110+240", meta.channel || "domovina.ai",
            // caption: naslijedi -background; bez "none" dobiješ bijeli pravokutnik
            // preko kojega je bijeli tekst nevidljiv (prva verzija je imala taj bug).
            "(", "-background", "none", "-fill", "#ffffff", "-font", font,
            "-pointsize", "88", "-size", `${W - 220}x760`, "-gravity", "NorthWest",
            "caption:" + (meta.title || ""), ")",
            "-gravity", "NorthWest", "-geometry", "+110+1320", "-composite",
            "-fill", "#9aa4b2", "-font", fontReg || font, "-pointsize", "44",
            "-annotate", `+110+${H - 220}`, meta.dateLabel || "",
            "-fill", "#9aa4b2", "-font", fontReg || font, "-pointsize", "40",
            "-annotate", `+110+${H - 150}`, "domovina.ai",
            "-quality", "88", out
        );
        execFileSync("magick", argv, { stdio: "ignore" });
        return { path: out, media: "image/jpeg" };
    } catch (e) {
        return prepareImage(thumbPath, tmpDir, "cover.jpg");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// XHTML gradnja
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `@charset "utf-8";
body { font-family: Georgia, "Times New Roman", serif; line-height: 1.55; margin: 0 6%; hyphens: auto; }
h1 { font-size: 1.6em; line-height: 1.25; margin: 1.2em 0 0.2em; }
h2 { font-size: 1.18em; line-height: 1.3; margin: 1.8em 0 0.3em; page-break-after: avoid; }
h3 { font-size: 1.02em; margin: 1.4em 0 0.2em; }
p { margin: 0 0 0.85em; text-align: justify; }
.cover { margin: 0; padding: 0; text-align: center; }
.cover img { max-width: 100%; height: auto; }
.eyebrow { font-family: sans-serif; font-size: 0.8em; letter-spacing: 0.12em; text-transform: uppercase; color: #7a828c; margin-bottom: 0.2em; }
.lead { font-size: 1.05em; color: #33383f; }
figure { margin: 1.1em 0; page-break-inside: avoid; }
figure img { width: 100%; height: auto; }
figcaption { font-family: sans-serif; font-size: 0.78em; color: #6b737d; margin-top: 0.35em; line-height: 1.4; }
.ts { font-family: sans-serif; font-size: 0.78em; color: #8a929c; margin: 0 0 0.5em; }
.ts a { color: #8a929c; text-decoration: none; }
.tags { font-family: sans-serif; font-size: 0.76em; color: #6b737d; margin: 0.4em 0 0; }
ul, ol { margin: 0 0 1em 1.1em; padding: 0; }
li { margin-bottom: 0.45em; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #d8dce1; color: #444; font-style: italic; }
.meta-table { font-family: sans-serif; font-size: 0.85em; width: 100%; border-collapse: collapse; margin: 1.2em 0; }
.meta-table th { text-align: left; color: #6b737d; font-weight: normal; padding: 0.3em 0.8em 0.3em 0; vertical-align: top; white-space: nowrap; }
.meta-table td { padding: 0.3em 0; vertical-align: top; }
.score { font-family: sans-serif; display: inline-block; padding: 0.15em 0.6em; border-radius: 0.5em; background: #eef2f7; color: #33383f; font-size: 0.85em; }
.transcript p { text-align: left; font-size: 0.92em; margin-bottom: 0.5em; }
.transcript .spk { font-family: sans-serif; font-weight: bold; font-size: 0.8em; color: #4a5260; }
.colophon { font-family: sans-serif; font-size: 0.85em; color: #5a626c; }
hr { border: none; border-top: 1px solid #dde1e6; margin: 2em 0; }
`;

function page(title, bodyXhtml, opts = {}) {
    const lg = opts.lang === "en" ? "en" : "hr";
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lg}" lang="${lg}">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body${opts.bodyClass ? ` class="${opts.bodyClass}"` : ""}>
${bodyXhtml}
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Glavna gradnja jedne knjige
// ─────────────────────────────────────────────────────────────────────────────

function buildEpub(ctx) {
    const { article, summary, magisterium, info, base, channel, videoId, images } = ctx;
    const lang = ctx.lang === "en" ? "en" : "hr";
    const T = STRINGS[lang];
    const L = (obj, field) => pickLang(obj, field, lang);
    const s = (summary && summary.summary) || {};
    const src = (summary && summary.source) || {};

    const title = (lang === "en" ? (s.title_en || s.title_hr) : s.title_hr) || (info && info.title) || base;
    const channelName = (info && (info.channel || info.uploader)) || src.channel || channel;
    const uploadDate = (src.upload_date) ||
        ((info && info.upload_date) ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}` : null) ||
        (base.match(/^(\d{4})(\d{2})(\d{2})_/) ? base.replace(/^(\d{4})(\d{2})(\d{2})_.*$/, "$1-$2-$3") : "");
    const durationSec = src.duration_seconds || (info && info.duration) || 0;
    // Beamly audio-only epizode imaju sintetički _yt_ ID — YouTube URL za njih
    // ne postoji, pa se navod izvora izostavlja (vidi `_yt_matched` marker).
    const ytRef = (info && info._yt_matched === false)
        ? null
        : `youtube.com/watch?v=${videoId}`;
    const siteUrl = episodeUrl(videoId, lang);
    const zip = new ZipWriter(new Date(`${uploadDate || "2026-01-01"}T12:00:00Z`));

    // 1) mimetype MORA biti prvi i nekomprimiran
    zip.add("mimetype", "application/epub+zip", { store: true });
    zip.add("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`);
    zip.add("OEBPS/style.css", CSS);

    const manifest = [];   // {id, href, media, props}
    const spine = [];      // idref redom
    const navItems = [];   // {href, label}

    function addPage(id, href, titleText, body, opts = {}) {
        zip.add(`OEBPS/${href}`, page(titleText, body, { ...opts, lang }));
        manifest.push({ id, href, media: "application/xhtml+xml", props: opts.props });
        spine.push(id);
        if (opts.nav !== false) navItems.push({ href, label: opts.navLabel || titleText });
    }

    // ── Naslovnica ───────────────────────────────────────────────────────────
    if (images.cover) {
        zip.add(`OEBPS/images/${images.cover.name}`, fs.readFileSync(images.cover.path));
        manifest.push({ id: "cover-img", href: `images/${images.cover.name}`, media: images.cover.media, props: "cover-image" });
        addPage("cover", "cover.xhtml", title,
            `<div class="cover"><img src="images/${images.cover.name}" alt="${esc(title)}"/></div>`,
            { bodyClass: "cover", nav: false });
    }

    // ── Naslovna stranica + o epizodi ────────────────────────────────────────
    const speakers = Array.isArray(s.speakers) ? s.speakers : [];
    const topics = Array.isArray(L(s, "key_topics")) ? L(s, "key_topics") : [];
    const abstract = lang === "en" ? (s.abstract_en || s.abstract_hr) : s.abstract_hr;
    const naslovBody = `
<p class="eyebrow">${esc(channelName)}</p>
<h1>${esc(title)}</h1>
${abstract ? `<p class="lead">${esc(abstract)}</p>` : ""}
<table class="meta-table">
  ${uploadDate ? `<tr><th>${esc(T.objavljeno)}</th><td>${esc(uploadDate)}</td></tr>` : ""}
  ${durationSec ? `<tr><th>${esc(T.trajanje)}</th><td>${esc(secondsToLabel(durationSec))}</td></tr>` : ""}
  ${speakers.length ? `<tr><th>${esc(T.sudionici)}</th><td>${speakers.map((sp) => `${esc(sp.suggested_name || sp.id)}${sp.role ? ` <span style="color:#8a929c">(${esc(translateRole(sp.role, lang))})</span>` : ""}`).join("<br/>")}</td></tr>` : ""}
  ${topics.length ? `<tr><th>${esc(T.teme)}</th><td>${esc(topics.join(" · "))}</td></tr>` : ""}
  <tr><th>${esc(T.epizoda)}</th><td><a href="${esc(siteUrl)}">${esc(siteUrl)}</a></td></tr>
  ${ytRef ? `<tr><th>${esc(T.izvornik)}</th><td>${esc(channelName)} · ${esc(ytRef)}</td></tr>` : ""}
</table>
<p style="font-family:sans-serif;font-size:0.8em;color:#8a929c">${esc(T.knjiguSlozio)}</p>
`;
    addPage("naslov", "naslov.xhtml", T.naslovnica, naslovBody, { navLabel: T.oEpizodi });

    // ── Ključne točke ────────────────────────────────────────────────────────
    const keyPoints = L(s, "key_points");
    if (Array.isArray(keyPoints) && keyPoints.length) {
        addPage("kljucne", "kljucne-tocke.xhtml", T.kljucneTocke,
            `<h1>${esc(T.kljucneTocke)}</h1>\n<ul>\n${keyPoints.map((p) => `<li>${esc(p)}</li>`).join("\n")}\n</ul>`);
    }

    // ── Poglavlja iz iteracija ───────────────────────────────────────────────
    const iterations = Array.isArray(article.iterations) ? article.iterations : [];
    iterations.forEach((it, i) => {
        const n = it.iteration_number || i + 1;
        const parts = [];
        const theme = L(it, "theme") || T.poglavlje(n);
        parts.push(`<p class="eyebrow">${esc(T.poglavlje(n))}</p>`);
        parts.push(`<h1>${esc(theme)}</h1>`);
        if (it.start_time) {
            parts.push(`<p class="ts">${esc(it.start_time)} – ${esc(it.end_time || "")}</p>`);
        }
        for (const sec of it.sections || []) {
            parts.push(`<h2>${esc(L(sec, "subtitle") || "")}</h2>`);
            const tsSec = timestampToSeconds(sec.screenshot_timestamp);
            const img = images.sections.get(sec.screenshot_timestamp);
            if (img) {
                parts.push(
                    `<figure><img src="images/${img.name}" alt="${esc(L(sec, "screenshot_description") || L(sec, "subtitle") || "")}"/>` +
                    `<figcaption>${esc(L(sec, "screenshot_description") || "")}${sec.screenshot_timestamp ? ` <a href="${esc(deepLinkUrl(videoId, tsSec, lang))}">[${esc(secondsToLabel(tsSec))}]</a>` : ""}</figcaption></figure>`
                );
            } else if (sec.screenshot_timestamp) {
                parts.push(`<p class="ts"><a href="${esc(deepLinkUrl(videoId, tsSec, lang))}">${esc(secondsToLabel(tsSec))}</a></p>`);
            }
            parts.push(mdToXhtml(L(sec, "content")));
            const kw = L(sec, "keywords");
            if (Array.isArray(kw) && kw.length) {
                parts.push(`<p class="tags">${esc(kw.join(" · "))}</p>`);
            }
        }
        addPage(`pog${n}`, `pog-${n}.xhtml`, theme, parts.join("\n"),
            { navLabel: `${n}. ${theme}`.trim() });
    });

    // ── Magisterium dodatak ──────────────────────────────────────────────────
    if (magisterium && magisterium.overall) {
        const ov = magisterium.overall;
        const li = (arr) => (Array.isArray(arr) && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
        const cites = Array.isArray(ov.citations) ? ov.citations.filter((c) => c && c.document_title) : [];
        // Citati su naslovi dokumenata Učiteljstva (Denzinger, enciklike) — ne prevode se.
        const interp = pickLang(magisterium, "score_interpretation", lang) || "";
        const body = `
<p class="eyebrow">${esc(T.dodatak)}</p>
<h1>${esc(T.prosudba)}</h1>
<p class="ts">${esc(T.prosudbaLead)}${magisterium.overall_score != null ? ` · <span class="score">${esc(magisterium.overall_score)}/100 — ${esc(interp)}</span>` : ""}</p>
${L(ov, "assessment") ? `<p>${esc(L(ov, "assessment"))}</p>` : ""}
${li(L(ov, "seeds_of_logos")) ? `<h2>${esc(T.sjemenke)}</h2>${li(L(ov, "seeds_of_logos"))}` : ""}
${li(L(ov, "concerns")) ? `<h2>${esc(T.ograde)}</h2>${li(L(ov, "concerns"))}` : ""}
${L(ov, "theological_context") ? `<h2>${esc(T.kontekst)}</h2><p>${esc(L(ov, "theological_context"))}</p>` : ""}
${cites.length ? `<h2>${esc(T.izvori)}</h2><ul>${cites.map((c) => `<li>${esc(c.document_title)}${c.document_author ? `, ${esc(c.document_author)}` : ""}${c.document_year ? ` (${esc(c.document_year)})` : ""}${c.document_reference ? ` — ${esc(c.document_reference)}` : ""}</li>`).join("")}</ul>` : ""}
<p style="font-family:sans-serif;font-size:0.8em;color:#8a929c">${esc(T.prosudbuIzradio)}</p>
`;
        addPage("magisterium", "magisterium.xhtml", T.prosudba, body);
    }

    // ── Transkript (opcionalno) ──────────────────────────────────────────────
    if (ctx.transcriptXhtml) {
        addPage("transkript", "transkript.xhtml", T.transkript, ctx.transcriptXhtml, { navLabel: T.transkriptNav });
    }

    // ── Kolofon ──────────────────────────────────────────────────────────────
    const modelLabel = (article.metadata && article.metadata.model) || "";
    addPage("kolofon", "kolofon.xhtml", T.kolofon, `
<h1>${esc(T.kolofon)}</h1>
<div class="colophon">
<p><strong>${esc(title)}</strong><br/>${esc(channelName)}${uploadDate ? ` · ${esc(uploadDate)}` : ""}</p>
<p>${esc(T.cijelaEpizoda)}: <a href="${esc(siteUrl)}">${esc(siteUrl)}</a>${ytRef ? `<br/>${esc(T.izvornik)}: ${esc(ytRef)}` : ""}</p>
<p>${T.prava(esc(channelName))}</p>
<p>${esc(T.obrada(modelLabel, !!magisterium))}<br/>
${esc(T.slozeno(new Date().toISOString().slice(0, 10)))}</p>
</div>
`, { navLabel: T.kolofon });

    // ── nav.xhtml (EPUB3) + toc.ncx (EPUB2 čitači) ───────────────────────────
    const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(T.sadrzaj)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc"><h1>${esc(T.sadrzaj)}</h1><ol>
${navItems.map((n) => `<li><a href="${esc(n.href)}">${esc(n.label)}</a></li>`).join("\n")}
</ol></nav>
</body></html>
`;
    zip.add("OEBPS/nav.xhtml", navXhtml);
    manifest.push({ id: "nav", href: "nav.xhtml", media: "application/xhtml+xml", props: "nav" });

    const uuid = stableUuid(`${videoId || base}${lang === "en" ? ":en" : ""}`);
    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${lang}">
<head><meta name="dtb:uid" content="urn:uuid:${uuid}"/><meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${navItems.map((n, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(n.label)}</text></navLabel><content src="${esc(n.href)}"/></navPoint>`).join("\n")}
</navMap></ncx>
`;
    zip.add("OEBPS/toc.ncx", ncx);
    manifest.push({ id: "ncx", href: "toc.ncx", media: "application/x-dtbncx+xml" });

    // ── Slike sekcija u manifest ─────────────────────────────────────────────
    let imgIdx = 0;
    for (const img of images.sections.values()) {
        if (img.added) continue;
        img.added = true;
        zip.add(`OEBPS/images/${img.name}`, fs.readFileSync(img.path));
        manifest.push({ id: `img${++imgIdx}`, href: `images/${img.name}`, media: img.media });
    }

    // ── content.opf ──────────────────────────────────────────────────────────
    const authors = speakers.length
        ? speakers.filter((sp) => sp.suggested_name && !/^Gost \(/.test(sp.suggested_name)).map((sp) => sp.suggested_name)
        : [];
    const creators = (authors.length ? authors : [channelName]).slice(0, 4);
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
  <dc:title>${esc(title)}</dc:title>
  <dc:language>${lang}</dc:language>
${creators.map((c, i) => `  <dc:creator id="cre${i}">${esc(c)}</dc:creator>`).join("\n")}
  <dc:publisher>domovina.ai</dc:publisher>
  <dc:source>${esc(siteUrl)}</dc:source>
${ytRef ? `  <dc:relation>${esc(ytRef)}</dc:relation>` : ""}
${uploadDate ? `  <dc:date>${esc(uploadDate)}</dc:date>` : ""}
${s.abstract_hr ? `  <dc:description>${esc(s.abstract_hr)}</dc:description>` : ""}
${topics.map((t) => `  <dc:subject>${esc(t)}</dc:subject>`).join("\n")}
  <dc:rights>${esc(T.izvedenoIzdanje(channelName))}</dc:rights>
  <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
${images.cover ? `  <meta name="cover" content="cover-img"/>` : ""}
</metadata>
<manifest>
${manifest.map((m) => `  <item id="${m.id}" href="${esc(m.href)}" media-type="${m.media}"${m.props ? ` properties="${m.props}"` : ""}/>`).join("\n")}
</manifest>
<spine toc="ncx">
${spine.map((id) => `  <itemref idref="${id}"/>`).join("\n")}
</spine>
</package>
`;
    zip.add("OEBPS/content.opf", opf);

    return { buffer: zip.toBuffer(), chapters: iterations.length, pages: spine.length, imageCount: imgIdx + (images.cover ? 1 : 0) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transkript (opcionalno)
// ─────────────────────────────────────────────────────────────────────────────

function buildTranscriptXhtml(srtPath, speakers, videoId, lang = "hr") {
    const T = STRINGS[lang === "en" ? "en" : "hr"];
    if (!fs.existsSync(srtPath)) return null;
    const nameById = new Map();
    for (const sp of speakers || []) {
        if (sp && sp.id && sp.suggested_name) nameById.set(sp.id, sp.suggested_name);
    }
    const blocks = fs.readFileSync(srtPath, "utf8").split(/\n\n+/);
    const out = [`<p class="eyebrow">${esc(T.dodatak)}</p>`, `<h1>${esc(T.transkriptNaslov)}</h1>`,
        `<p class="ts">${esc(T.transkriptNapomena)}</p>`,
        `<div class="transcript">`];
    let lastSpeaker = null;
    let buf = [];
    let bufStart = 0;

    const flush = () => {
        if (!buf.length) return;
        const label = lastSpeaker ? (nameById.get(lastSpeaker) || lastSpeaker) : "";
        out.push(`<p>${label ? `<span class="spk">${esc(label)}</span> <a href="${esc(deepLinkUrl(videoId, bufStart, lang))}" style="color:#b0b7c0;text-decoration:none;font-size:0.75em">[${esc(secondsToLabel(bufStart))}]</a><br/>` : ""}${esc(buf.join(" "))}</p>`);
        buf = [];
    };

    for (const block of blocks) {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        const tsLine = lines.find((l) => l.includes("-->"));
        if (!tsLine) continue;
        // `/t/:sec` prima cijele sekunde (isto ograničenje koje je imao YouTube `&t=`).
        const start = Math.floor(timestampToSeconds(tsLine.split("-->")[0].trim()));
        let text = lines.slice(lines.indexOf(tsLine) + 1).join(" ").trim();
        const m = text.match(/^\[(\w+)\]\s*/);
        let speaker = lastSpeaker;
        if (m) {
            speaker = m[1];
            text = text.slice(m[0].length);
        }
        if (speaker !== lastSpeaker) {
            flush();
            lastSpeaker = speaker;
            bufStart = start;
        }
        if (!buf.length) bufStart = start;
        if (text) buf.push(text);
    }
    flush();
    out.push(`</div>`);
    return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Obrada jedne epizode
// ─────────────────────────────────────────────────────────────────────────────

function processEpisode(channel, channelDir, ep, lang = "hr") {
    const { base, articleFile, articlePrefix } = ep;
    const EN = lang === "en";
    const videoId = extractVideoId(base);
    const outPath = path.join(channelDir, `${base}${EN ? ".en" : ""}.epub`);

    const oldStat = fs.existsSync(outPath) ? fs.statSync(outPath) : null;
    const oldSize = oldStat ? oldStat.size : 0;
    if (oldSize && !FORCE) {
        return { status: "skip", reason: "epub već postoji" };
    }
    if (OLDER_THAN && oldStat && oldStat.mtimeMs >= OLDER_THAN) {
        return { status: "skip", reason: "već regenerirana" };
    }
    // EN izdanje se gradi iz `.article.en.json` (aditivan prijevod: HR i EN polja
    // jedno uz drugo), pa poglavlja sigurno prate isti outline i iste timestampove
    // kao hrvatska knjiga i kao screenshotovi.
    const articleName = EN ? articleFile.replace(/\.article\.json$/, ".article.en.json") : articleFile;
    const article = readJson(path.join(channelDir, articleName));
    if (!article || !Array.isArray(article.iterations) || !article.iterations.length) {
        return { status: "fail", reason: `neispravan ${EN ? "article.en.json" : "article.json"}` };
    }
    const summary = readJson(path.join(channelDir, `${base}.wav.canary.summary${EN ? ".en" : ""}.json`))
        || (EN ? readJson(path.join(channelDir, `${base}.wav.canary.summary.json`)) : null);
    const magisterium = readJson(path.join(channelDir, `${articlePrefix}.article.magisterium${EN ? ".en" : ""}.json`))
        || (EN ? readJson(path.join(channelDir, `${articlePrefix}.article.magisterium.json`)) : null);
    const info = readJson(path.join(channelDir, `${base}.info.json`));

    if (DRY_RUN) {
        const nsec = article.iterations.reduce((a, it) => a + (it.sections || []).length, 0);
        return { status: "dry", reason: `${article.iterations.length} poglavlja, ${nsec} sekcija` };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-"));
    try {
        // Slike
        const images = { cover: null, sections: new Map() };
        if (!NO_IMAGES) {
            const thumbCandidates = [`${base}.png`, `${base}.og-share.jpg`, `${base}.webp`]
                .map((f) => path.join(channelDir, f))
                .filter((p) => fs.existsSync(p));
            const s = (summary && summary.summary) || {};
            const cover = buildCover(thumbCandidates[0] || null, tmpDir, {
                title: (EN ? (s.title_en || s.title_hr) : s.title_hr) || (info && info.title) || base,
                channel: (info && (info.channel || info.uploader)) || channel,
                dateLabel: base.match(/^(\d{4})(\d{2})(\d{2})_/)
                    ? base.replace(/^(\d{4})(\d{2})(\d{2})_.*$/, "$3.$2.$1.")
                    : "",
            });
            if (cover) images.cover = { ...cover, name: path.basename(cover.path) };

            const shotsDir = path.join(channelDir, `${base}_screenshots`);
            if (fs.existsSync(shotsDir)) {
                let i = 0;
                for (const it of article.iterations) {
                    for (const sec of it.sections || []) {
                        const ts = sec.screenshot_timestamp;
                        if (!ts || images.sections.has(ts)) continue;
                        const shot = path.join(shotsDir, `${base}_${ts.replace(/:/g, "-")}.png`);
                        const prepared = prepareImage(shot, tmpDir, `s${String(++i).padStart(3, "0")}.jpg`);
                        if (prepared) images.sections.set(ts, { ...prepared, name: path.basename(prepared.path) });
                    }
                }
            }
        }

        // Transkript
        let transcriptXhtml = null;
        if (WITH_TRANSCRIPT) {
            transcriptXhtml = buildTranscriptXhtml(
                path.join(channelDir, `${base}.wav.canary.diarized.srt`),
                (summary && summary.summary && summary.summary.speakers) || [],
                videoId,
                lang
            );
        }

        const result = buildEpub({ article, summary, magisterium, info, base, channel, videoId, images, transcriptXhtml, lang });
        if (oldSize && !ALLOW_SHRINK && result.buffer.length < oldSize * SHRINK_RATIO) {
            const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
            return {
                status: "fail",
                reason: `nova knjiga je bitno manja (${mb(oldSize)} → ${mb(result.buffer.length)}), ` +
                    `vjerojatno nedostaju screenshotovi — postojeća NIJE prepisana ` +
                    `(restore_derived_from_r2.js, ili --allow-shrink ako je namjerno)`,
            };
        }
        fs.writeFileSync(outPath, result.buffer);
        return {
            status: "ok",
            reason: `${(result.buffer.length / 1024 / 1024).toFixed(1)} MB · ${result.chapters} poglavlja · ${result.pages} stranica · ${result.imageCount} slika`,
            outPath,
        };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
    if (!fs.existsSync(INPUT_DIR)) {
        console.error(`❌ Ulazni direktorij ne postoji: ${INPUT_DIR}`);
        process.exit(1);
    }
    if (!hasMagick()) {
        console.log("⚠️  ImageMagick (magick) nije dostupan — slike idu u originalnoj veličini, naslovnica bez teksta.");
    }
    console.log(`📚 EPUB generiranje — ulaz: ${INPUT_DIR}`);
    if (WITH_TRANSCRIPT) console.log("   ℹ️  --with-transcript: doslovan prijepis ide u dodatak knjige.");

    const channels = ONLY_CHANNEL ? [ONLY_CHANNEL] : listChannelDirs(INPUT_DIR);
    let ok = 0, skip = 0, fail = 0, done = 0;

    for (const channel of channels) {
        const channelDir = path.join(INPUT_DIR, channel);
        let episodes = findEpisodes(channelDir);
        if (ONLY_VIDEO_ID) episodes = episodes.filter((e) => extractVideoId(e.base) === ONLY_VIDEO_ID);
        if (!episodes.length) continue;

        let printedChannel = false;
        for (const ep of episodes) {
            if (LIMIT && done >= LIMIT) break;

            // Koja izdanja gradimo: HR uvijek, EN kad prijevod članka postoji.
            // `translate_to_english.js` je aditivan i ne pokriva cijeli katalog
            // (~47 epizoda), pa je EN uvjetovan datotekom, ne zastavicom.
            const langs = [];
            if (!ONLY_EN) langs.push("hr");
            if (!NO_EN) {
                const enArticle = path.join(channelDir, ep.articleFile.replace(/\.article\.json$/, ".article.en.json"));
                if (fs.existsSync(enArticle)) langs.push("en");
            }

            for (const lang of langs) {
                let res;
                try {
                    res = processEpisode(channel, channelDir, ep, lang);
                } catch (e) {
                    res = { status: "fail", reason: e.message };
                }
                if (res.status === "skip") { skip++; continue; }
                if (!printedChannel) { console.log(`\n📁 ${channel}`); printedChannel = true; }
                done++;
                const tag = lang === "en" ? " [EN]" : "";
                if (res.status === "ok") { ok++; console.log(`   ✅ ${ep.base}${tag}\n      ${res.reason}`); }
                else if (res.status === "dry") { console.log(`   🔍 ${ep.base}${tag} — ${res.reason}`); }
                else { fail++; console.log(`   ❌ ${ep.base}${tag} — ${res.reason}`); }
            }
        }
        if (LIMIT && done >= LIMIT) break;
    }

    console.log(`\n📊 Gotovo: ${ok} novih · ${skip} preskočeno (postoji) · ${fail} grešaka`);
    if (fail > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { mdToXhtml, timestampToSeconds, secondsToLabel, extractVideoId, stableUuid, episodeUrl, deepLinkUrl, pickLang, translateRole, STRINGS };
