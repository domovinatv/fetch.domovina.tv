"use strict";
/**
 * compose_reel.js — HyperFrames kompozicija (9:16) iz jednog reela iz reels.json.
 *
 * Zamjena za ručni predložak po trenutku: kartice (hook, lower_third, context, quote,
 * number, pin, end) dolaze iz select_reels.js kao podaci, ovdje dobiju HTML i GSAP
 * animaciju po tipu, a raspored oko lica i u sigurnoj zoni radi reel_layout.js.
 * Titl riječ po riječ je ista logika kao build_composition.py / render_reel.py.
 *
 * Koristi ga render_reels.js; `preparePublic()` slaže cijeli public/ direktorij.
 */

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const REPO = path.join(HERE, "..", "..");
const FPS = 25;

const q = (t) => Math.round(Math.round(t * FPS) / FPS * 10000) / 10000;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ─── raspored kartica u vremenu ────────────────────────────────────
// Jedna kartica u isto vrijeme (kao u ručnim predlošcima): hook 0–4.5 s, lower-third iza,
// ostale na svoje sidro ili čim prethodna nestane, kraj zadnjih ~5.5 s.
// Mirno, ne TikTok (Matija, 26.10.2026.): kartica stoji dok se ne pročita (~11 znakova/s),
// između kartica je sekunda samo videa, a sljedeća kartica čeka umjesto da skrati prethodnu.
// Kartica koja bi zakasnila više od MAX_LATE za izgovorenim sidrom otpada.
const HOOK_DUR = 4.5;
const LT_DUR = 5.0;
const GAP = 1.0;
const MIN_DUR = 4.5;
const MAX_DUR = 10.0;
const END_DUR = 5.5;
const MAX_LATE = 6.0;

function readDuration(card) {
    const len = String(card.text || "").length + String(card.value || "").length;
    return Math.min(MAX_DUR, Math.max(MIN_DUR, 1.5 + len / 11));
}

function scheduleCards(reel, dur, ctx) {
    const cards = (reel.cards || []).filter((c) => c && c.type && (c.text || c.value));
    const out = [];
    let hook = cards.find((c) => c.type === "hook");
    if (!hook && reel.hook) hook = { type: "hook", text: reel.hook, at_sec: 0 };
    if (hook) out.push({ ...hook, start: 0, dur: HOOK_DUR });

    let end = cards.find((c) => c.type === "end");
    if (!end) end = { type: "end", text: ctx.title || "" };
    const endStart = Math.max(0, dur - END_DUR);

    let t = hook ? HOOK_DUR + GAP : 0;
    const middle = cards.filter((c) => c.type !== "hook" && c.type !== "end")
        .map((c, i) => ({ ...c, _i: i, _at: c.type === "lower_third" ? 0 : (c.at_sec || 0) }))
        .sort((a, b) => a._at - b._at || a._i - b._i);
    for (let i = 0; i < middle.length; i++) {
        const c = middle[i];
        const start = Math.max(c._at, t);
        // usidrena kartica prekasno za izgovorenim više ne pripada tom trenutku
        if (c.type !== "lower_third" && c.anchored === true && start - c._at > MAX_LATE) continue;
        if (start > endStart - MIN_DUR) break;           // ne stane prije završne kartice
        const want = c.type === "lower_third" ? LT_DUR : readDuration(c);
        const d = Math.max(MIN_DUR, Math.min(want, endStart - start - GAP));
        out.push({ ...c, start, dur: d });
        t = start + d + GAP;
    }
    out.push({ ...end, start: Math.max(endStart, t), dur: dur - Math.max(endStart, t) });
    return out.filter((c) => c.dur >= 1.5).map((c) => ({ ...c, start: q(c.start), dur: q(c.dur) }));
}

// „10 km" → {n:10, rest:" km"}; godine i omjeri ostaju statični
function parseNumber(value) {
    const m = String(value || "").trim().match(/^(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,\d+)?(.*)$/);
    if (!m) return null;
    const n = parseInt(m[1].replace(/[.\s]/g, ""), 10);
    if (!Number.isFinite(n) || (n >= 1000 && n <= 2100 && !m[2].trim())) return null;
    if (/^[\/:x×]/.test(m[2].trim())) return null;
    return { n, rest: m[2] };
}

// ─── HTML i animacija po tipu kartice ──────────────────────────────
const PIN_SVG = '<svg width="96" height="128" viewBox="0 0 60 80"><path d="M30 2C15 2 4 13 4 28c0 20 26 50 26 50s26-30 26-50C56 13 45 2 30 2z" fill="var(--wine)"/><circle cx="30" cy="28" r="10" fill="var(--paper)"/></svg>';

function splitName(text) {
    const s = String(text || "");
    for (const sep of [" · ", " — ", " – ", ", ", " - "]) {
        const i = s.indexOf(sep);
        if (i > 0) return [s.slice(0, i), s.slice(i + sep.length)];
    }
    return [s, ""];
}

function cardMarkup(c, id, ctx) {
    const host = (inner, align) => `<div class="card-host clip" id="${id}" data-start="${c.start}" data-duration="${c.dur}" data-track-index="2">
    <div class="slot"${align ? ` data-align="${align}"` : ""}>${inner}</div>
  </div>`;
    switch (c.type) {
        case "hook": {
            const words = String(c.text).split(/\s+/).filter(Boolean);
            const hl = Math.max(0, words.length - 2);    // zadnje dvije riječi u boji brenda
            const spans = words.map((w, i) => `<span class="wd${i >= hl ? " hl" : ""}">${esc(w)}</span>`).join(" ");
            return host(`<div class="paper hook"><img class="brand-logo" src="brand/logo.png" alt="" />${spans}</div>`);
        }
        case "lower_third": {
            const [name, role] = splitName(c.text);
            return host(`<div class="lt"><div class="bar">${esc(name)}</div>${role ? `<br /><div class="sub">${esc(role)}</div>` : ""}</div>`, "left");
        }
        case "quote":
            return host(`<div class="paper quote"><div class="q">„${esc(String(c.text).replace(/^[„"“]+|[“"”]+$/g, ""))}“</div>${ctx.speaker ? `<div class="who">— ${esc(ctx.speaker)}</div>` : ""}</div>`);
        case "number": {
            const p = parseNumber(c.value);
            // data-to: reel_layout.js mjeri karticu s konačnim brojem (brojač je inače raširi u titl)
            const v = p ? `<span id="${id}-n" data-to="${p.n.toLocaleString("hr-HR")}">0</span>${esc(p.rest)}` : esc(c.value || "");
            return host(`<div class="paper num"><div class="v">${v}</div>${c.text ? `<div class="s">${esc(c.text)}</div>` : ""}</div>`);
        }
        case "pin":
            return host(`<div class="paper pin">${PIN_SVG}<div><div class="v">${esc(c.value || c.text)}</div>${c.value && c.text ? `<div class="s">${esc(c.text)}</div>` : ""}</div></div>`);
        case "end":
            return host(`<div class="paper endc"><img class="brand-logo" src="brand/logo.png" alt="" /><div class="t">${esc(c.text || ctx.title)}</div>
      <div class="src">${esc(ctx.channelName)}<br /><span class="url">domovina.ai/v/${esc(ctx.videoId)}</span></div></div>`);
        default:   // context i nepoznati tipovi
            return host(`<div class="paper ctx">${esc(c.text)}</div>`);
    }
}

function cardTimeline(c, id) {
    // Mirno: samo fade s malim pomakom, bez back/bounce/scale „popa"; izlaz je čisti fade.
    const s = c.start, e = q(c.start + c.dur);
    const out = [];
    const sel = `#${id}`;
    const IN = `opacity: 0, y: 16, duration: 0.6, ease: "power1.out"`;
    const OUT = (el) => `tl.to("${sel} ${el}", { opacity: 0, duration: 0.5, ease: "power1.in" }, ${q(e - 0.5)});`;
    if (c.type === "lower_third") {
        out.push(`tl.from("${sel} .bar", { clipPath: "inset(0 100% 0 0)", duration: 0.7, ease: "power1.inOut" }, ${s});`);
        out.push(`tl.from("${sel} .sub", { clipPath: "inset(0 100% 0 0)", duration: 0.7, ease: "power1.inOut" }, ${q(s + 0.3)});`);
        out.push(OUT(".lt"));
    } else if (c.type === "end") {
        out.push(`tl.from("${sel} .paper", { ${IN} }, ${s});`);
        out.push(`tl.from("${sel} .src", { opacity: 0, duration: 0.6, ease: "power1.out" }, ${q(s + 0.6)});`);
    } else {
        out.push(`tl.from("${sel} .paper", { ${IN} }, ${s});`);
        if (c.type === "number") {
            const p = parseNumber(c.value);
            if (p) out.push(`count("${id}-n", ${p.n}, ${q(s + 0.3)}, ${Math.min(1.6, Math.max(0.6, c.dur - 1.2))});`);
        }
        out.push(OUT(".paper"));
    }
    return out.join("\n    ");
}

// ─── titl riječ po riječ ───────────────────────────────────────────
function captions(words, dur) {
    const chunks = [];
    let cur = [];
    for (const w of words) {
        if (cur.length && (cur.length >= 3 || [...cur, w].map((x) => x.text).join(" ").length > 20
            || /[.,?!:;]$/.test(cur[cur.length - 1].text) || w.start - cur[cur.length - 1].end > 0.35)) {
            chunks.push(cur); cur = [];
        }
        cur.push(w);
    }
    if (cur.length) chunks.push(cur);
    const html = [], js = [];
    chunks.forEach((c, i) => {
        const s = q(Math.max(0, c[0].start));
        const nx = chunks[i + 1];
        const e = q(Math.min(dur, nx && nx[0].start - c[c.length - 1].end < 0.6 ? nx[0].start : c[c.length - 1].end + 0.25));
        if (e - s <= 0) return;
        const spans = c.map((x, j) => `<span class="w" id="w${i}_${j}">${esc(x.text)}</span>`).join(" ");
        html.push(`<div class="cap clip" id="c${i}" data-start="${s}" data-duration="${q(e - s)}" data-track-index="9">${spans}</div>`);
        js.push(`tl.fromTo("#c${i}",{opacity:0},{opacity:1,duration:0.12,ease:"power1.out"},${s});`);
        c.forEach((x, j) => {
            const t = q(Math.max(s, x.start));
            js.push(`tl.set("#w${i}_${j}",{color:"var(--gold)"},${t});`);
            if (j) js.push(`tl.set("#w${i}_${j - 1}",{color:"#fff"},${t});`);
        });
    });
    return { html: html.join("\n  "), js: js.join("\n    "), count: chunks.length };
}

// ─── branding ──────────────────────────────────────────────────────
function brandingDir() {
    return process.env.DOMOVINA_BRANDING_DIR || path.join(REPO, "data", "branding");
}

function loadBrand(name) {
    const dir = path.join(brandingDir(), name);
    const p = path.join(dir, "brand.json");
    if (!fs.existsSync(p)) return null;
    return { dir, json: JSON.parse(fs.readFileSync(p, "utf8")) };
}

// ─── kontrast (WCAG 2.x) ───────────────────────────────────────────
// Boje brenda su s weba kanala, ne iz videa: primary često stoji na tamnoj podlozi
// (Mladi za domovinu: bordo #840C0C na navy #071A35 = 1,6 : 1, nečitljivo).
function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    const ch = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    if (la === null || lb === null) return 0;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Prva boja s popisa koja na `bg` ima kontrast ≥ min; inače ona s najvećim. */
function pickContrast(candidates, bg, min = 4.5) {
    const list = candidates.filter((x) => luminance(x) !== null);
    return list.find((x) => contrast(x, bg) >= min)
        || list.reduce((best, x) => (contrast(x, bg) > contrast(best, bg) ? x : best), list[0]);
}

function brandCss(brand, publicDir) {
    if (!brand) return "";
    const b = brand.json;
    const c = b.colors || {};
    const col = (v) => c[v] || v;
    fs.mkdirSync(path.join(publicDir, "brand"), { recursive: true });
    const faces = [];
    for (const role of ["title", "body", "caption"]) {
        const src = b.typography && b.typography[role] && path.join(brand.dir, b.typography[role]);
        if (src && fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(publicDir, "brand", `${role}.ttf`));
            faces.push(`@font-face { font-family: "Brand-${role}"; src: url("brand/${role}.ttf") format("truetype"); font-display: block; }`);
        }
    }
    const logo = b.logo && (b.logo.wide || b.logo.square);
    if (logo && fs.existsSync(path.join(brand.dir, logo))) {
        fs.copyFileSync(path.join(brand.dir, logo), path.join(publicDir, "brand", "logo.png"));
    }
    const r = b.reel || {};
    // --wine je TEKST na podlozi kartice (brojka, istaknuta riječ, URL) i pozadina trake s
    // imenom; --bar-ink je tekst na toj traci. Uloga iz brand.json ima prednost ako prolazi prag.
    const paper = col("background");
    const wine = pickContrast([r.accent_text, "primary", "accent", "highlight", "secondary", "text"]
        .filter(Boolean).map(col), paper) || col("primary");
    const barInk = pickContrast([col("background"), col("text"), "#000000", "#FFFFFF"], wine) || col("background");
    const font = (role, fb) => faces.some((f) => f.includes(`Brand-${role}`)) ? `"Brand-${role}"` : fb;
    return faces.join("\n") + `
:root { --paper: ${col("background")}; --ink: ${col("text")}; --ink-soft: rgba(255,255,255,.72); --rule: rgba(255,255,255,.18);
  --wine: ${wine}; --gold: ${col(r.caption_active || "highlight")}; --edge: ${col("primary")}; --bar-ink: ${barInk};
  --f-head: ${font("title", '"Montserrat"')}; --f-body: ${font("body", '"Montserrat"')}; --f-cap: ${font("caption", '"Montserrat"')}; }
`;
}

// ─── public/ ───────────────────────────────────────────────────────
/**
 * @param {string} publicDir  odredište (input-video.mp4 je već ondje)
 * @param {object} o  { reel, words:[{text,start,end}] relativno na klip, dur, faces (objekt),
 *                      videoId, title, channelName, brand: loadBrand() | null, debug }
 * @returns {{compId:string, cards:object[], captions:number}}
 */
function preparePublic(publicDir, o) {
    fs.mkdirSync(path.join(publicDir, "fonts"), { recursive: true });
    fs.mkdirSync(path.join(publicDir, "vendor"), { recursive: true });
    const fontsSrc = path.join(brandingDir(), "fonts");
    for (const f of ["Montserrat-Bold.ttf", "Montserrat-ExtraBold.ttf", "Montserrat-Black.ttf"]) {
        fs.copyFileSync(path.join(fontsSrc, f), path.join(publicDir, "fonts", f));
    }
    fs.copyFileSync(path.join(HERE, "vendor", "gsap.min.js"), path.join(publicDir, "vendor", "gsap.min.js"));
    fs.copyFileSync(path.join(HERE, "reel_layout.js"), path.join(publicDir, "reel_layout.js"));
    fs.copyFileSync(path.join(brandingDir(), "domovina_ai", "logo_square.png"), path.join(publicDir, "domovina_logo.png"));

    const ctx = { title: o.title, channelName: o.channelName, videoId: o.videoId, speaker: o.reel.speaker };
    const cards = scheduleCards(o.reel, o.dur, ctx);
    const cardHtml = cards.map((c, i) => cardMarkup(c, `k${i}`, ctx)).join("\n\n  ");
    const cardJs = cards.map((c, i) => cardTimeline(c, `k${i}`)).join("\n\n    ");
    const cap = captions(o.words, o.dur);
    const compId = `reel-${o.videoId}-${o.reel.rank}`.replace(/[^A-Za-z0-9_-]/g, "-");

    // logo kanala trajno gore desno (.bug u predlošku), zrcalno potpisu domovina.ai dolje desno
    const css = brandCss(o.brand, publicDir);   // prvo: kopira brand/logo.png
    const hasLogo = fs.existsSync(path.join(publicDir, "brand", "logo.png"));
    const tpl = fs.readFileSync(path.join(HERE, "generic.template.html"), "utf8");
    const html = tpl
        .replaceAll("{{COMP_ID}}", compId)
        .replaceAll("{{DUR}}", String(q(o.dur)))
        .replace("{{BRAND_CSS}}", css)
        .replace("{{CHANNEL_BUG}}", hasLogo ? '<div class="bug"><img src="brand/logo.png" alt="" /></div>' : "")
        .replace("{{CARDS}}", cardHtml)
        .replace("{{CARD_JS}}", cardJs)
        .replace("{{CAPTIONS}}", cap.html)
        .replace("{{CAPTION_JS}}", cap.js)
        .replace("{{FACES}}", JSON.stringify(o.faces))
        .replace("{{DEBUG}}", o.debug ? "true" : "false");
    fs.writeFileSync(path.join(publicDir, "index.html"), html);
    return { compId, cards, captions: cap.count };
}

module.exports = { contrast, pickContrast, scheduleCards, parseNumber, captions, splitName, preparePublic, loadBrand, brandingDir };
