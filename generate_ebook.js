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
 * Izlaz: {channel}/{base}.epub
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
const IMAGE_WIDTH = parseInt(getArg("--image-width") || "1200", 10);
const IMAGE_QUALITY = parseInt(getArg("--image-quality") || "80", 10);
const SITE_BASE = process.env.EBOOK_SITE_BASE || "https://domovina.ai";

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
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="hr" lang="hr">
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
    const s = (summary && summary.summary) || {};
    const src = (summary && summary.source) || {};

    const title = s.title_hr || (info && info.title) || base;
    const channelName = (info && (info.channel || info.uploader)) || src.channel || channel;
    const uploadDate = (src.upload_date) ||
        ((info && info.upload_date) ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}` : null) ||
        (base.match(/^(\d{4})(\d{2})(\d{2})_/) ? base.replace(/^(\d{4})(\d{2})(\d{2})_.*$/, "$1-$2-$3") : "");
    const durationSec = src.duration_seconds || (info && info.duration) || 0;
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const siteUrl = `${SITE_BASE}/v/${videoId}`;
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
        zip.add(`OEBPS/${href}`, page(titleText, body, opts));
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
    const topics = Array.isArray(s.key_topics) ? s.key_topics : [];
    const naslovBody = `
<p class="eyebrow">${esc(channelName)}</p>
<h1>${esc(title)}</h1>
${s.abstract_hr ? `<p class="lead">${esc(s.abstract_hr)}</p>` : ""}
<table class="meta-table">
  ${uploadDate ? `<tr><th>Objavljeno</th><td>${esc(uploadDate)}</td></tr>` : ""}
  ${durationSec ? `<tr><th>Trajanje</th><td>${esc(secondsToLabel(durationSec))}</td></tr>` : ""}
  ${speakers.length ? `<tr><th>Sudionici</th><td>${speakers.map((sp) => `${esc(sp.suggested_name || sp.id)}${sp.role ? ` <span style="color:#8a929c">(${esc(sp.role)})</span>` : ""}`).join("<br/>")}</td></tr>` : ""}
  ${topics.length ? `<tr><th>Teme</th><td>${esc(topics.join(" · "))}</td></tr>` : ""}
  <tr><th>Izvor</th><td><a href="${esc(ytUrl)}">${esc(ytUrl)}</a></td></tr>
  <tr><th>Epizoda</th><td><a href="${esc(siteUrl)}">${esc(siteUrl)}</a></td></tr>
</table>
<p style="font-family:sans-serif;font-size:0.8em;color:#8a929c">Ovu je knjigu automatski složio domovina.ai iz transkripta epizode. Tekst poglavlja je uredničko-novinarska obrada razgovora, a ne doslovan prijepis.</p>
`;
    addPage("naslov", "naslov.xhtml", "Naslovnica", naslovBody, { navLabel: "O ovoj epizodi" });

    // ── Ključne točke ────────────────────────────────────────────────────────
    if (Array.isArray(s.key_points) && s.key_points.length) {
        addPage("kljucne", "kljucne-tocke.xhtml", "Ključne točke",
            `<h1>Ključne točke</h1>\n<ul>\n${s.key_points.map((p) => `<li>${esc(p)}</li>`).join("\n")}\n</ul>`);
    }

    // ── Poglavlja iz iteracija ───────────────────────────────────────────────
    const iterations = Array.isArray(article.iterations) ? article.iterations : [];
    iterations.forEach((it, i) => {
        const n = it.iteration_number || i + 1;
        const parts = [];
        parts.push(`<p class="eyebrow">Poglavlje ${n}</p>`);
        parts.push(`<h1>${esc(it.theme || `Poglavlje ${n}`)}</h1>`);
        if (it.start_time) {
            parts.push(`<p class="ts">${esc(it.start_time)} – ${esc(it.end_time || "")}</p>`);
        }
        for (const sec of it.sections || []) {
            parts.push(`<h2>${esc(sec.subtitle || "")}</h2>`);
            const tsSec = timestampToSeconds(sec.screenshot_timestamp);
            const img = images.sections.get(sec.screenshot_timestamp);
            if (img) {
                parts.push(
                    `<figure><img src="images/${img.name}" alt="${esc(sec.screenshot_description || sec.subtitle || "")}"/>` +
                    `<figcaption>${esc(sec.screenshot_description || "")}${sec.screenshot_timestamp ? ` <a href="${esc(ytUrl)}&amp;t=${tsSec}s">[${esc(secondsToLabel(tsSec))}]</a>` : ""}</figcaption></figure>`
                );
            } else if (sec.screenshot_timestamp) {
                parts.push(`<p class="ts"><a href="${esc(ytUrl)}&amp;t=${tsSec}s">${esc(secondsToLabel(tsSec))}</a></p>`);
            }
            parts.push(mdToXhtml(sec.content));
            if (Array.isArray(sec.keywords) && sec.keywords.length) {
                parts.push(`<p class="tags">${esc(sec.keywords.join(" · "))}</p>`);
            }
        }
        addPage(`pog${n}`, `pog-${n}.xhtml`, it.theme || `Poglavlje ${n}`, parts.join("\n"),
            { navLabel: `${n}. ${it.theme || ""}`.trim() });
    });

    // ── Magisterium dodatak ──────────────────────────────────────────────────
    if (magisterium && magisterium.overall) {
        const ov = magisterium.overall;
        const li = (arr) => (Array.isArray(arr) && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
        const cites = Array.isArray(ov.citations) ? ov.citations.filter((c) => c && c.document_title) : [];
        const body = `
<p class="eyebrow">Dodatak</p>
<h1>Teološka prosudba</h1>
<p class="ts">Magisterium AI · usklađenost s katoličkim naukom${magisterium.overall_score != null ? ` · <span class="score">${esc(magisterium.overall_score)}/100 — ${esc(magisterium.score_interpretation || "")}</span>` : ""}</p>
${ov.assessment ? `<p>${esc(ov.assessment)}</p>` : ""}
${li(ov.seeds_of_logos) ? `<h2>Sjemenke istine</h2>${li(ov.seeds_of_logos)}` : ""}
${li(ov.concerns) ? `<h2>Napomene i ograde</h2>${li(ov.concerns)}` : ""}
${ov.theological_context ? `<h2>Teološki kontekst</h2><p>${esc(ov.theological_context)}</p>` : ""}
${cites.length ? `<h2>Izvori</h2><ul>${cites.map((c) => `<li>${esc(c.document_title)}${c.document_author ? `, ${esc(c.document_author)}` : ""}${c.document_year ? ` (${esc(c.document_year)})` : ""}${c.document_reference ? ` — ${esc(c.document_reference)}` : ""}</li>`).join("")}</ul>` : ""}
<p style="font-family:sans-serif;font-size:0.8em;color:#8a929c">Prosudbu je izradio Magisterium AI nad tekstom poglavlja. Ocjena se odnosi na usklađenost iznesenih tvrdnji s katoličkim naukom, a ne na istinitost pojedinih povijesnih navoda.</p>
`;
        addPage("magisterium", "magisterium.xhtml", "Teološka prosudba", body);
    }

    // ── Transkript (opcionalno) ──────────────────────────────────────────────
    if (ctx.transcriptXhtml) {
        addPage("transkript", "transkript.xhtml", "Transkript", ctx.transcriptXhtml, { navLabel: "Cjeloviti transkript" });
    }

    // ── Kolofon ──────────────────────────────────────────────────────────────
    const modelLabel = (article.metadata && article.metadata.model) || "";
    addPage("kolofon", "kolofon.xhtml", "Kolofon", `
<h1>Kolofon</h1>
<div class="colophon">
<p><strong>${esc(title)}</strong><br/>${esc(channelName)}${uploadDate ? ` · ${esc(uploadDate)}` : ""}</p>
<p>Izvorna epizoda: <a href="${esc(ytUrl)}">${esc(ytUrl)}</a><br/>
Na domovina.ai: <a href="${esc(siteUrl)}">${esc(siteUrl)}</a></p>
<p>Autorska prava na izgovoreni sadržaj, snimku i kadrove pripadaju izvornom nakladniku kanala <strong>${esc(channelName)}</strong>. Ovo je izdanje izvedena, uredničko-novinarska obrada namijenjena praćenju i pretraživanju javnog sadržaja.</p>
<p>Obrada: transkripcija NVIDIA Canary 1B v2 · dijarizacija pyannote · uredničko sažimanje ${esc(modelLabel)}${magisterium ? " · teološka prosudba Magisterium AI" : ""}.<br/>
Složeno automatski, ${new Date().toISOString().slice(0, 10)}, domovina.ai.</p>
</div>
`, { navLabel: "Kolofon" });

    // ── nav.xhtml (EPUB3) + toc.ncx (EPUB2 čitači) ───────────────────────────
    const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="hr" lang="hr">
<head><meta charset="utf-8"/><title>Sadržaj</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc"><h1>Sadržaj</h1><ol>
${navItems.map((n) => `<li><a href="${esc(n.href)}">${esc(n.label)}</a></li>`).join("\n")}
</ol></nav>
</body></html>
`;
    zip.add("OEBPS/nav.xhtml", navXhtml);
    manifest.push({ id: "nav", href: "nav.xhtml", media: "application/xhtml+xml", props: "nav" });

    const uuid = stableUuid(videoId || base);
    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="hr">
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
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="hr">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
  <dc:title>${esc(title)}</dc:title>
  <dc:language>hr</dc:language>
${creators.map((c, i) => `  <dc:creator id="cre${i}">${esc(c)}</dc:creator>`).join("\n")}
  <dc:publisher>domovina.ai</dc:publisher>
  <dc:source>${esc(ytUrl)}</dc:source>
${uploadDate ? `  <dc:date>${esc(uploadDate)}</dc:date>` : ""}
${s.abstract_hr ? `  <dc:description>${esc(s.abstract_hr)}</dc:description>` : ""}
${topics.map((t) => `  <dc:subject>${esc(t)}</dc:subject>`).join("\n")}
  <dc:rights>Izvedeno izdanje. Prava na izvorni sadržaj: ${esc(channelName)}.</dc:rights>
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

function buildTranscriptXhtml(srtPath, speakers, ytUrl) {
    if (!fs.existsSync(srtPath)) return null;
    const nameById = new Map();
    for (const sp of speakers || []) {
        if (sp && sp.id && sp.suggested_name) nameById.set(sp.id, sp.suggested_name);
    }
    const blocks = fs.readFileSync(srtPath, "utf8").split(/\n\n+/);
    const out = [`<p class="eyebrow">Dodatak</p>`, `<h1>Cjeloviti transkript</h1>`,
        `<p class="ts">Automatska transkripcija (Canary 1B v2) i dijarizacija (pyannote). Moguće su pogreške u prepoznavanju riječi i pripisivanju replika.</p>`,
        `<div class="transcript">`];
    let lastSpeaker = null;
    let buf = [];
    let bufStart = 0;

    const flush = () => {
        if (!buf.length) return;
        const label = lastSpeaker ? (nameById.get(lastSpeaker) || lastSpeaker) : "";
        out.push(`<p>${label ? `<span class="spk">${esc(label)}</span> <a href="${esc(ytUrl)}&amp;t=${bufStart}s" style="color:#b0b7c0;text-decoration:none;font-size:0.75em">[${esc(secondsToLabel(bufStart))}]</a><br/>` : ""}${esc(buf.join(" "))}</p>`);
        buf = [];
    };

    for (const block of blocks) {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        const tsLine = lines.find((l) => l.includes("-->"));
        if (!tsLine) continue;
        // YouTube `t=` prima cijele sekunde — "t=41.679s" ne radi.
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

function processEpisode(channel, channelDir, ep) {
    const { base, articleFile, articlePrefix } = ep;
    const videoId = extractVideoId(base);
    const outPath = path.join(channelDir, `${base}.epub`);

    if (fs.existsSync(outPath) && !FORCE) {
        return { status: "skip", reason: "epub već postoji" };
    }
    const article = readJson(path.join(channelDir, articleFile));
    if (!article || !Array.isArray(article.iterations) || !article.iterations.length) {
        return { status: "fail", reason: "neispravan article.json" };
    }
    const summary = readJson(path.join(channelDir, `${base}.wav.canary.summary.json`));
    const magisterium = readJson(path.join(channelDir, `${articlePrefix}.article.magisterium.json`));
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
                title: s.title_hr || (info && info.title) || base,
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
                `https://www.youtube.com/watch?v=${videoId}`
            );
        }

        const result = buildEpub({ article, summary, magisterium, info, base, channel, videoId, images, transcriptXhtml });
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
            let res;
            try {
                res = processEpisode(channel, channelDir, ep);
            } catch (e) {
                res = { status: "fail", reason: e.message };
            }
            if (res.status === "skip") { skip++; continue; }
            if (!printedChannel) { console.log(`\n📁 ${channel}`); printedChannel = true; }
            done++;
            if (res.status === "ok") { ok++; console.log(`   ✅ ${ep.base}\n      ${res.reason}`); }
            else if (res.status === "dry") { console.log(`   🔍 ${ep.base} — ${res.reason}`); }
            else { fail++; console.log(`   ❌ ${ep.base} — ${res.reason}`); }
        }
        if (LIMIT && done >= LIMIT) break;
    }

    console.log(`\n📊 Gotovo: ${ok} novih · ${skip} preskočeno (postoji) · ${fail} grešaka`);
    if (fail > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { mdToXhtml, timestampToSeconds, secondsToLabel, extractVideoId, stableUuid };
