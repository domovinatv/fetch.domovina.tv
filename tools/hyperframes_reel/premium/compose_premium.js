"use strict";
/**
 * compose_premium.js — premium reel: kompozicija iz beats.json (režija po reelu).
 *
 * Generički put (compose_reel.js) iz reels.json uzima samo SADRŽAJ kartica; izgled i
 * animacije su fiksni po tipu. Premium put dodaje REŽIJU: LLM (render_reel_premium.js)
 * bira komponente iz ove biblioteke, sidri ih i njihove unutarnje taktove na izgovorene
 * riječi, i smije nacrtati jedan predmet kroz ograničen SVG slot (samo osnovni oblici,
 * samo boje brenda). Slobodan HTML iz modela se namjerno ne prima: rušio bi
 * `hyperframes check`, brand i ujednačenost.
 *
 * Isti predložak (generic.template.html), isti raspored oko lica (reel_layout.js),
 * isti titl i potpis — razlika je samo u karticama, kameri i „raspoloženju" kadra.
 *
 * beats.json (v1):
 *   { tone, intensity: 1–3, tail_sec: 0–4, beats: [{ component, at_word, dur, params, prefer? }],
 *     camera: [{ at_word, zoom, over }], mood: [{ at_word, dur, look: "dim"|"mono" }] }
 */

const fs = require("fs");
const path = require("path");
const base = require("../compose_reel");
const { esc, q, parseNumber, splitName, captions, brandCss, brandingDir } = base;

const HERE = __dirname;
const GAP = 1.0;            // sekunda samo videa između kartica (kao generički put)
const MAX_LATE = 6.0;       // usidrena kartica kasnije od toga za riječi otpada
const MIN_DUR = 4.5;
const MAX_DUR = 10.0;
const END_MIN = 3.5;
const MAX_BEATS = 9;

const COLORS = { ink: "var(--ink)", wine: "var(--wine)", gold: "var(--gold)", paper: "var(--paper)", soft: "var(--ink-soft)", none: "none" };
const color = (v, dflt) => COLORS[v] || COLORS[dflt] || "none";
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const norm = (s) => String(s || "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "");

function textLen(p) {
    let n = 0;
    (function walk(v) {
        if (typeof v === "string") n += v.length;
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "parts" && !k.endsWith("_word")) walk(x);
    })(p);
    return n;
}
const readDur = (p) => Math.min(MAX_DUR, Math.max(MIN_DUR, 1.5 + textLen(p) / 11));

// „highlight" = doslovan dio teksta koji ide u boji brenda
function withHighlight(text, hl, cls = "hl") {
    const t = String(text || "");
    const i = hl ? t.toLowerCase().indexOf(String(hl).toLowerCase()) : -1;
    if (i < 0) return esc(t);
    return esc(t.slice(0, i)) + `<span class="${cls}">${esc(t.slice(i, i + hl.length))}</span>` + esc(t.slice(i + hl.length));
}

// ─── ograničen SVG slot ────────────────────────────────────────────
const SHAPES = {
    path: ["d"],
    rect: ["x", "y", "width", "height", "rx"],
    circle: ["cx", "cy", "r"],
    line: ["x1", "y1", "x2", "y2"],
    polyline: ["points"],
    polygon: ["points"],
};
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]{1,4000}$/;
const POINTS_RE = /^[0-9.,\s-]{1,2000}$/;

/** Očisti dijelove crteža: samo osnovni oblici, brojevi, boje iz tokena. Vraća {parts, dropped}. */
function sanitizeParts(parts, view) {
    const out = [];
    let dropped = 0;
    for (const p of (Array.isArray(parts) ? parts : []).slice(0, 48)) {
        const shape = p && SHAPES[p.shape] ? p.shape : null;
        if (!shape) { dropped++; continue; }
        const attrs = {};
        let ok = true;
        for (const k of SHAPES[shape]) {
            const v = p[k] != null ? p[k] : p.attrs && p.attrs[k];
            if (v == null) { if (k !== "rx") ok = false; continue; }
            if (k === "d") { if (!PATH_RE.test(String(v))) ok = false; else attrs.d = String(v).trim(); }
            else if (k === "points") { if (!POINTS_RE.test(String(v))) ok = false; else attrs.points = String(v).trim(); }
            else { const n = Number(v); if (!Number.isFinite(n)) ok = false; else attrs[k] = +n.toFixed(2); }
        }
        if (!ok) { dropped++; continue; }
        out.push({
            shape, attrs,
            fill: color(p.fill, shape === "line" || shape === "polyline" ? "none" : "ink"),
            stroke: color(p.stroke, "none"),
            sw: num(p.stroke_width, 0, Math.max(view[0], view[1]) / 10, 0),
            group: Math.round(num(p.group, 0, 11, 0)),
        });
    }
    return { parts: out, dropped };
}

// Grubo težište grupe iz brojeva u atributima (dovoljno za smjer „rasprsnuća")
function centroid(parts) {
    const xs = [], ys = [];
    for (const p of parts) {
        const a = p.attrs;
        if (p.shape === "rect") { xs.push(a.x + a.width / 2); ys.push(a.y + a.height / 2); }
        else if (p.shape === "circle") { xs.push(a.cx); ys.push(a.cy); }
        else if (p.shape === "line") { xs.push((a.x1 + a.x2) / 2); ys.push((a.y1 + a.y2) / 2); }
        else {
            const ns = String(a.d || a.points).match(/-?\d*\.?\d+/g) || [];
            for (let i = 0; i + 1 < ns.length; i += 2) { xs.push(+ns[i]); ys.push(+ns[i + 1]); }
        }
    }
    const avg = (v) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
    return [avg(xs), avg(ys)];
}

function svgMarkup(id, view, parts) {
    const groups = [...new Set(parts.map((p) => p.group))].sort((a, b) => a - b);
    const shape = (p) => {
        const attrs = Object.entries(p.attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
        return `<${p.shape} ${attrs} fill="${p.fill}" stroke="${p.stroke}" stroke-width="${p.sw}" stroke-linecap="round" stroke-linejoin="round" pathLength="1" />`;
    };
    const body = groups.map((g) => `<g class="g" id="${id}-g${g}">${parts.filter((p) => p.group === g).map(shape).join("")}</g>`).join("");
    const w = 640, h = Math.round(w * view[1] / view[0]);
    return `<svg class="ill-svg" width="${w}" height="${Math.min(h, 420)}" viewBox="0 0 ${view[0]} ${view[1]}" preserveAspectRatio="xMidYMid meet" overflow="visible">${body}</svg>`;
}

// ─── biblioteka komponenti ─────────────────────────────────────────
// desc/params idu doslovno u prompt režije (catalogText). Svaka komponenta: markup (HTML u .slot),
// timeline (GSAP linije), key (trenutak za storyboard: kad je kartica „gotova").
const IN = `opacity: 0, y: 16, duration: 0.6, ease: "power1.out"`;
const out = (sel, e) => `tl.to("${sel}", { opacity: 0, duration: 0.5, ease: "power1.in" }, ${q(e - 0.5)});`;

const COMPONENTS = {
    hook: {
        desc: "Udica na početku (uvijek prva, kreće u 0 s). Tvrdnja koja tjera da se gleda dalje, ne naslov epizode.",
        params: '{ "text": "do 60 znakova", "highlight": "doslovan dio teksta u boji brenda (opcionalno)" }',
        markup: (b, id) => `<div class="paper hook">${withHighlight(b.p.text, b.p.highlight)}</div>`,
        timeline: (b, id) => [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`, out(`#${id} .paper`, b.end)],
        key: (b) => b.start + 1.2,
    },
    lower_third: {
        desc: "Tko govori (ime + uloga). Jednom, rano.",
        params: '{ "name": "Ime Prezime", "role": "kratka uloga" }',
        align: "left",
        markup: (b) => `<div class="lt"><div class="bar">${esc(b.p.name)}</div>${b.p.role ? `<br /><div class="sub">${esc(b.p.role)}</div>` : ""}</div>`,
        timeline: (b, id) => [
            `tl.from("#${id} .bar", { clipPath: "inset(0 100% 0 0)", duration: 0.7, ease: "power1.inOut" }, ${b.start});`,
            `tl.from("#${id} .sub", { clipPath: "inset(0 100% 0 0)", duration: 0.7, ease: "power1.inOut" }, ${q(b.start + 0.3)});`,
            out(`#${id} .lt`, b.end)],
        key: (b) => b.start + 1.2,
    },
    context: {
        desc: "Činjenica koju gledatelj treba, a govornik je ne kaže (tko, gdje, kada, zašto). NE prepričavaj ono što se upravo čuje.",
        params: '{ "text": "do 90 znakova", "highlight": "opcionalno" }',
        markup: (b) => `<div class="paper ctx">${withHighlight(b.p.text, b.p.highlight)}</div>`,
        timeline: (b, id) => [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`, out(`#${id} .paper`, b.end)],
        key: (b) => b.start + 1.2,
    },
    quote: {
        desc: "Citat. style \"card\" = kartica; \"quiet\" = bez kartice, krupna slova na zatamnjenom kadru, za najjači trenutak (najviše jedan po reelu). " +
            "reveal \"spoken\" = riječi se pale točno kad ih govornik izgovori (tekst mora biti DOSLOVAN niz riječi od at_word), tada se titl u tom prozoru skriva.",
        params: '{ "text": "doslovno", "highlight": "opcionalno", "who": "opcionalno", "style": "card|quiet", "reveal": "whole|spoken" }',
        markup: (b) => {
            const quiet = b.p.style === "quiet";
            const t = String(b.p.text || "").replace(/^[„"“]+|[“"”]+$/g, "");
            const inner = b.spoken
                ? b.spoken.map((w, i) => `<span class="qw" id="${b.id}-w${i}">${esc(w.text)}</span>`).join(" ")
                : withHighlight(t, b.p.highlight);
            const who = b.p.who ? `<div class="who">— ${esc(b.p.who)}</div>` : "";
            return quiet ? `<div class="quiet"><div class="q">„${inner}“</div>${who}</div>` : `<div class="paper quote"><div class="q">„${inner}“</div>${who}</div>`;
        },
        veil: (b) => b.p.style === "quiet",
        timeline: (b, id) => {
            const quiet = b.p.style === "quiet";
            const box = quiet ? ".quiet" : ".paper";
            const L = [quiet
                ? `tl.from("#${id} ${box}", { opacity: 0, duration: 1.0, ease: "sine.out" }, ${b.start});`
                : `tl.from("#${id} ${box}", { ${IN} }, ${b.start});`];
            if (quiet) L.push(`tl.from("#${id} .veil", { opacity: 0, duration: 1.2, ease: "sine.inOut" }, ${q(Math.max(0, b.start - 0.4))});`);
            if (b.spoken) b.spoken.forEach((w, i) => L.push(`tl.to("#${id}-w${i}", { opacity: 1, duration: 0.25, ease: "power1.out" }, ${q(Math.max(b.start, w.t))});`));
            L.push(out(`#${id} ${box}`, b.end));
            if (quiet) L.push(`tl.to("#${id} .veil", { opacity: 0, duration: 0.6, ease: "sine.in" }, ${q(b.end - 0.6)});`);
            return L;
        },
        key: (b) => (b.spoken ? Math.min(b.end - 0.3, b.spoken[b.spoken.length - 1].t + 0.6) : b.start + 1.4),
    },
    counter: {
        desc: "Količina koja broji od nule (novac, ljudi, km, dani). Ne za godine ni datume.",
        params: '{ "value": "npr. 5.000 € / 120 km", "label": "što broj znači" }',
        markup: (b, id) => {
            const p = parseNumber(b.p.value);
            const v = p ? `<span id="${id}-n" data-to="${p.n.toLocaleString("hr-HR")}">0</span>${esc(p.rest)}` : esc(b.p.value);
            return `<div class="paper num"><div class="v">${v}</div>${b.p.label ? `<div class="s">${esc(b.p.label)}</div>` : ""}</div>`;
        },
        timeline: (b, id) => {
            const p = parseNumber(b.p.value);
            const L = [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`];
            if (p) L.push(`count("${id}-n", ${p.n}, ${q(b.start + 0.3)}, 1.4);`);
            L.push(out(`#${id} .paper`, b.end));
            return L;
        },
        key: (b) => Math.min(b.end - 0.3, b.start + 2.0),
    },
    distance: {
        desc: "Mjera između dvije stvari (udaljenost, visina, razmak): ravnalo se iscrta na izgovorenu mjeru. " +
            "orientation \"vertical\" za iznad/ispod, \"horizontal\" za ispred/iza/između.",
        params: '{ "value": "npr. 1 m", "label": "što mjera znači", "from": "kratko (gornji/lijevi kraj)", "to": "kratko (donji/desni kraj)", "orientation": "vertical|horizontal", "draw_at_word": int }',
        markup: (b) => {
            const h = b.p.orientation === "horizontal";
            return `<div class="paper dist${h ? " h" : ""}"><div class="rul"><span class="la">${esc(b.p.from || "")}</span><i class="tk a"></i><i class="ln"></i><i class="tk b"></i><span class="lb">${esc(b.p.to || "")}</span></div>` +
                `<div class="txt"><div class="v">${esc(b.p.value)}</div>${b.p.label ? `<div class="s">${esc(b.p.label)}</div>` : ""}</div></div>`;
        },
        timeline: (b, id) => {
            const h = b.p.orientation === "horizontal";
            const T = b.t("draw_at_word", b.start + 0.6);
            return [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`,
                `tl.from("#${id} .tk, #${id} .la, #${id} .lb", { opacity: 0, duration: 0.4, ease: "power1.out" }, ${q(b.start + 0.3)});`,
                `tl.from("#${id} .ln", { ${h ? "scaleX" : "scaleY"}: 0, duration: 1.0, ease: "power2.inOut" }, ${q(T)});`,
                `tl.from("#${id} .txt", { opacity: 0, x: -12, duration: 0.6, ease: "power1.out" }, ${q(T + 0.8)});`,
                out(`#${id} .paper`, b.end)];
        },
        key: (b) => Math.min(b.end - 0.3, b.t("draw_at_word", b.start + 0.6) + 1.8),
    },
    illustration: {
        desc: "Crtež JEDNOG predmeta koji je srce priče (puška, traktor, kuća, križ), samo kad predmet nosi trenutak. " +
            "Crtaš ga sam: parts su osnovni oblici u viewBoxu `view`, boje samo tokeni ink|wine|gold|paper|soft|none. " +
            "Dijelovi s istim `group` miču se zajedno. anim: draw (iscrta se), assemble (dijelovi se slože), " +
            "burst (stoji cio pa se na at_word rasprsne po grupama), drop (padne na mjesto na at_word), shake (zatrese se na at_word). " +
            "Jednostavan, čitljiv obris (6–20 dijelova), ne detaljna ilustracija.",
        params: '{ "title": "kratko iznad crteža (opcionalno)", "caption": "ispod crteža", "view": [w, h], ' +
            '"parts": [{ "shape": "path|rect|circle|line|polyline|polygon", "d|x,y,width,height,rx|cx,cy,r|x1,y1,x2,y2|points": "…", "fill": "token", "stroke": "token", "stroke_width": n, "group": 0-11 }], ' +
            '"anim": "draw|assemble|burst|drop|shake", "at_word": int }',
        prepare: (b) => {
            const view = Array.isArray(b.p.view) ? [num(b.p.view[0], 20, 1000, 200), num(b.p.view[1], 20, 1000, 100)] : [200, 100];
            const { parts, dropped } = sanitizeParts(b.p.parts, view);
            if (dropped) b.warn.push(`illustration: odbačeno ${dropped} neispravnih dijelova`);
            if (!parts.length) return false;
            b.view = view; b.parts = parts;
            const c = centroid(parts);
            b.groups = [...new Set(parts.map((p) => p.group))].sort((x, y) => x - y)
                .map((g) => ({ g, c: centroid(parts.filter((p) => p.group === g)) }))
                .map((x, i) => {
                    let dx = x.c[0] - c[0], dy = x.c[1] - c[1];
                    const len = Math.hypot(dx, dy) || 1;
                    if (len < 1e-3) { dx = i % 2 ? 1 : -1; dy = -0.5; }
                    const k = Math.max(view[0], view[1]) * 0.1;
                    return { g: x.g, dx: +(dx / len * k).toFixed(1), dy: +(dy / len * k).toFixed(1), rot: (i % 2 ? 1 : -1) * (8 + (i * 7) % 12) };
                });
            return true;
        },
        markup: (b, id) => `<div class="paper ill">${b.p.title ? `<div class="k">${esc(b.p.title)}</div>` : ""}${svgMarkup(id, b.view, b.parts)}` +
            `${b.p.caption ? `<div class="s">${esc(b.p.caption)}</div>` : ""}</div>`,
        timeline: (b, id) => {
            const anim = ["draw", "assemble", "burst", "drop", "shake"].includes(b.p.anim) ? b.p.anim : "draw";
            const T = b.t("at_word", b.start + 1.0);
            const L = [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`];
            const shapes = `#${id} .ill-svg > g > *`;
            if (anim === "draw") {
                L.push(`tl.fromTo("${shapes}", { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.4, ease: "power1.inOut", stagger: 0.05 }, ${q(Math.max(b.start + 0.3, T))});`);
                L.push(`tl.from("${shapes}", { fillOpacity: 0, duration: 0.6, ease: "power1.out" }, ${q(Math.max(b.start + 0.3, T) + 1.2)});`);
            } else if (anim === "assemble") {
                b.groups.forEach((g, i) => L.push(`tl.from("#${id}-g${g.g}", { opacity: 0, x: ${g.dx}, y: ${g.dy}, rotation: ${g.rot}, transformOrigin: "50% 50%", duration: 0.8, ease: "power2.out" }, ${q(Math.max(b.start + 0.3, T) + i * 0.12)});`));
            } else if (anim === "burst") {
                L.push(`tl.to("#${id} .ill-svg", { x: 4, duration: 0.06, repeat: 5, yoyo: true, ease: "none" }, ${q(T - 0.36)});`);
                b.groups.forEach((g) => L.push(`tl.to("#${id}-g${g.g}", { x: ${g.dx}, y: ${g.dy}, rotation: ${g.rot}, transformOrigin: "50% 50%", duration: 0.7, ease: "power3.out" }, ${q(T)});`));
            } else if (anim === "drop") {
                L.push(`tl.from("#${id} .ill-svg", { y: -160, opacity: 0, duration: 0.7, ease: "power2.in" }, ${q(T - 0.7)});`);
            } else {
                L.push(`tl.to("#${id} .ill-svg", { x: 6, duration: 0.07, repeat: 7, yoyo: true, ease: "none" }, ${q(T)});`);
            }
            L.push(out(`#${id} .paper`, b.end));
            return L;
        },
        key: (b) => Math.min(b.end - 0.3, b.t("at_word", b.start + 1.0) + (b.p.anim === "draw" ? 2.0 : 1.0)),
    },
    steps: {
        desc: "Slijed događaja (2–5 koraka) koji se pali korak po korak kako ih govornik izgovara.",
        params: '{ "title": "opcionalno", "steps": [{ "label": "do 14 znakova", "at_word": int }] }',
        markup: (b, id) => {
            const st = (b.p.steps || []).slice(0, 5);
            const dots = st.map((s, i) => `<div class="st" id="${id}-s${i}" style="left:${st.length < 2 ? 50 : (i / (st.length - 1)) * 100}%"><span>${esc(s.label)}</span></div>`).join("");
            return `<div class="paper steps">${b.p.title ? `<div class="k">${esc(b.p.title)}</div>` : ""}<div class="track"><div class="line"></div><div class="fill" id="${id}-f"></div>${dots}</div></div>`;
        },
        timeline: (b, id) => {
            const st = (b.p.steps || []).slice(0, 5);
            const L = [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`, `tl.set("#${id}-f", { scaleX: 0 }, ${b.start});`];
            st.forEach((s, i) => {
                const t = Math.max(b.start + 0.4 + i * 0.3, b.wordTime(s.at_word, b.start + 0.6 + i * 0.8));
                L.push(`tl.to("#${id}-s${i}", { backgroundColor: "var(--wine)", duration: 0.4, ease: "power1.out" }, ${q(t)});`);
                if (i) L.push(`tl.to("#${id}-f", { scaleX: ${(i / (st.length - 1)).toFixed(3)}, duration: 0.6, ease: "power1.inOut" }, ${q(t - 0.3)});`);
            });
            L.push(out(`#${id} .paper`, b.end));
            return L;
        },
        key: (b) => b.end - 0.6,
    },
    stamp: {
        desc: "Presuda/ishod u jednoj riječi kao pečat (npr. PREŽIVIO, USLIŠANO) preko kratke rečenice. Pečat udara na stamp_at_word.",
        params: '{ "text": "kratka rečenica", "stamp": "1–2 riječi", "stamp_at_word": int }',
        markup: (b) => `<div class="paper stampc"><div class="v">${esc(b.p.text)}</div><div class="stamp">${esc(b.p.stamp)}</div></div>`,
        timeline: (b, id) => {
            const T = b.t("stamp_at_word", b.start + 1.2);
            return [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`,
                `tl.fromTo("#${id} .stamp", { opacity: 0, scale: 1.8 }, { opacity: 1, scale: 1, duration: 0.35, ease: "power3.in" }, ${q(Math.max(b.start + 0.5, T))});`,
                out(`#${id} .paper`, b.end)];
        },
        key: (b) => Math.min(b.end - 0.3, Math.max(b.start + 0.5, b.t("stamp_at_word", b.start + 1.2)) + 0.8),
    },
    compare: {
        desc: "Dvije strane usporedbe (prije/poslije, očekivano/stvarno).",
        params: '{ "title": "opcionalno", "left": { "k": "oznaka", "v": "vrijednost" }, "right": { "k": "oznaka", "v": "vrijednost" } }',
        markup: (b) => {
            const col = (x, cls) => `<div class="col ${cls}"><div class="k">${esc((x || {}).k)}</div><div class="v">${esc((x || {}).v)}</div></div>`;
            return `<div class="paper cmp">${b.p.title ? `<div class="t">${esc(b.p.title)}</div>` : ""}<div class="cols">${col(b.p.left, "l")}<div class="sep"></div>${col(b.p.right, "r")}</div></div>`;
        },
        timeline: (b, id) => [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`,
            `tl.from("#${id} .col.r", { opacity: 0, x: 20, duration: 0.6, ease: "power1.out" }, ${q(b.start + 1.2)});`,
            out(`#${id} .paper`, b.end)],
        key: (b) => b.start + 2.2,
    },
    end: {
        desc: "Završna kartica (uvijek zadnja): naslov epizode ili poziv, kanal i link. Trajanje 3,5–6 s.",
        params: '{ "text": "naslov ili poziv, do 60 znakova" }',
        markup: (b, id, ctx) => `<div class="paper endc"><div class="t">${esc(b.p.text || ctx.title)}</div>
      <div class="src">${esc(ctx.channelName)}<br /><span class="url">domovina.ai/v/${esc(ctx.videoId)}</span></div></div>`,
        timeline: (b, id) => [`tl.from("#${id} .paper", { ${IN} }, ${b.start});`,
            `tl.from("#${id} .src", { opacity: 0, duration: 0.6, ease: "power1.out" }, ${q(b.start + 0.6)});`],
        key: (b) => b.start + 1.4,
    },
};

function catalogText() {
    return Object.entries(COMPONENTS).map(([k, c]) => `- ${k}: ${c.desc}\n  params: ${c.params}`).join("\n");
}

// Najkraće trajanje: brzina čitanja; citat „spoken" se čita dok se izgovara, pa traje koliko i govor
function minDuration(b, words) {
    if (b.component === "lower_third" || b.component === "hook") return 4.0;
    if (b.component === "quote" && b.p.reveal === "spoken" && Number.isInteger(b.atWord) && words[b.atWord]) {
        const n = String(b.p.text || "").split(/\s+/).filter(Boolean).length;
        const last = words[Math.min(words.length - 1, b.atWord + n - 1)];
        return Math.max(3.0, last.end - words[b.atWord].start + 0.8);
    }
    return readDur(b.p);
}

// ─── raspored ──────────────────────────────────────────────────────
// Režija daje namjeru (sidro + željeno trajanje); ovdje se provode tvrda pravila generičkog
// puta: jedna kartica u isto vrijeme, sekunda videa između, trajanje po brzini čitanja.
// Sve što je prilagođeno ide u warnings — kritika ih vidi uz storyboard.
function schedule(doc, words, dur) {
    const warnings = [];
    const wordTime = (i, d) => (Number.isInteger(i) && words[i] ? words[i].start : d);
    const raw = (Array.isArray(doc.beats) ? doc.beats : []).filter((b, i) => {
        if (b && COMPONENTS[b.component]) return true;
        warnings.push(`takt ${i}: nepoznata komponenta ${b && b.component}`);
        return false;
    });
    let beats = raw.slice(0, MAX_BEATS).map((b, i) => ({
        i, component: b.component, p: b.params || {}, prefer: b.prefer, warn: [], atWord: b.at_word,
        at: b.component === "hook" ? 0 : wordTime(b.at_word, null),
        anchored: Number.isInteger(b.at_word) && !!words[b.at_word],
        want: num(b.dur, 1, 15, null),
    }));
    if (raw.length > MAX_BEATS) warnings.push(`više od ${MAX_BEATS} taktova, višak odbačen`);
    beats = beats.filter((b) => {
        if (b.at != null) return true;
        warnings.push(`${b.component}: at_word ${raw[b.i].at_word} ne postoji`);
        return false;
    });

    let end = beats.find((b) => b.component === "end");
    beats = beats.filter((b) => b.component !== "end");
    if (!end) { end = { i: -1, component: "end", p: {}, warn: [], at: null, want: 5.5 }; warnings.push("nema end kartice, dodana zadana"); }
    const endDur = Math.min(6, Math.max(END_MIN, end.want || 5.5));
    let endStart = Math.max(0, dur - endDur);

    beats.sort((a, b) => a.at - b.at || a.i - b.i);
    const outBeats = [];
    let t = 0;
    for (const b of beats) {
        const start = Math.max(b.at, t);
        if (b.anchored && b.component !== "lower_third" && start - b.at > MAX_LATE) {
            warnings.push(`${b.component} (takt ${b.i}) otpao: kasnio bi ${(start - b.at).toFixed(1)} s za sidrom`); continue;
        }
        const minRead = minDuration(b, words);
        // prije nego što kartica otpadne, end se smije skratiti do END_MIN
        if (endStart - GAP - start < minRead && endStart < dur - END_MIN) {
            const was = endStart;
            endStart = Math.min(dur - END_MIN, Math.max(endStart, start + minRead + GAP));
            warnings.push(`end skraćen na ${(dur - endStart).toFixed(1)} s (bio ${(dur - was).toFixed(1)} s) da stane ${b.component} (takt ${b.i})`);
        }
        if (endStart - GAP - start < Math.min(minRead, MIN_DUR) * 0.8) { warnings.push(`${b.component} (takt ${b.i}) otpao: ne stane prije end kartice (treba ${minRead.toFixed(1)} s)`); continue; }
        if (start - b.at > 0.3) warnings.push(`${b.component} (takt ${b.i}) kasni ${(start - b.at).toFixed(1)} s za sidrom (prethodna kartica)`);
        let d = Math.max(minRead, b.want || minRead);
        if (b.want && b.want < minRead - 0.2) warnings.push(`${b.component} (takt ${b.i}): ${b.want} s je prekratko za čitanje, produljeno na ${minRead.toFixed(1)} s`);
        const room = endStart - GAP - start;
        if (d > room) { d = room; warnings.push(`${b.component} (takt ${b.i}) skraćen na ${room.toFixed(1)} s zbog end kartice`); }
        outBeats.push({ ...b, start: q(start), dur: q(d) });
        t = start + d + GAP;
    }
    const es = Math.max(endStart, t);
    if (es > endStart + 0.05) warnings.push(`end kartica pomaknuta na ${es.toFixed(1)} s (traje ${(dur - es).toFixed(1)} s)`);
    outBeats.push({ ...end, start: q(es), dur: q(dur - es) });

    for (const b of outBeats) {
        b.end = q(b.start + b.dur);
        b.wordTime = wordTime;
        b.t = (key, d) => { const v = wordTime(b.p[key], null); return v == null ? d : Math.min(b.end - 0.8, Math.max(b.start + 0.3, v)); };
    }
    return { beats: outBeats.filter((b) => b.dur >= 1.5), warnings };
}

// Citat „spoken": riječi citata → indeksi izgovorenih riječi od at_word (pohlepno, prozor 6)
function matchSpoken(text, words, from) {
    const toks = String(text || "").replace(/^[„"“]+|[“"”]+$/g, "").split(/\s+/).filter(Boolean);
    const outW = [];
    let j = from;
    for (const tok of toks) {
        const n = norm(tok);
        let hit = -1;
        for (let k = j; k < Math.min(words.length, j + 6); k++) if (norm(words[k].text) === n) { hit = k; break; }
        if (hit < 0) return null;
        outW.push({ text: tok, t: words[hit].start });
        j = hit + 1;
    }
    return outW.length ? outW : null;
}

// ─── kamera i raspoloženje ─────────────────────────────────────────
function cameraJs(doc, words, dur, warnings) {
    const keys = (Array.isArray(doc.camera) ? doc.camera : [])
        .map((c) => ({ t: words[c.at_word] ? words[c.at_word].start : null, z: num(c.zoom, 1, 1.15, 1.04), over: num(c.over, 0.6, 8, 2.0) }))
        .filter((c) => c.t != null).sort((a, b) => a.t - b.t);
    if (!keys.length) return `tl.fromTo("#video-wrap", { scale: 1 }, { scale: 1.04, duration: ${q(dur)}, ease: "none" }, 0);`;
    const L = [`tl.set("#video-wrap", { scale: 1 }, 0);`];
    let free = 0;
    for (const k of keys) {
        const at = Math.max(free, k.t);
        if (at > k.t + 0.5) warnings.push(`kamera na ${k.t.toFixed(1)} s pomaknuta na ${at.toFixed(1)} s (preklapanje)`);
        L.push(`tl.to("#video-wrap", { scale: ${k.z}, duration: ${q(k.over)}, ease: "sine.inOut" }, ${q(at)});`);
        free = at + k.over;
    }
    return L.join("\n      ");
}

function moodJs(doc, words, dur) {
    const L = [];
    for (const m of Array.isArray(doc.mood) ? doc.mood : []) {
        const s = words[m.at_word] ? words[m.at_word].start : null;
        if (s == null) continue;
        const e = Math.min(dur, s + num(m.dur, 1, 30, 4));
        const mono = m.look === "mono";
        L.push(`tl.to("#mood", { opacity: ${mono ? 0.35 : 0.5}, duration: 1.0, ease: "sine.inOut" }, ${q(s)});`);
        if (mono) L.push(`tl.to("#bg-video, #bg-blur", { filter: "grayscale(1) brightness(.85)", duration: 1.2, ease: "sine.inOut" }, ${q(s)});`);
        if (e < dur - 0.2) {
            L.push(`tl.to("#mood", { opacity: 0, duration: 0.8, ease: "sine.inOut" }, ${q(e)});`);
            if (mono) L.push(`tl.to("#bg-video, #bg-blur", { filter: "grayscale(0) brightness(1)", duration: 0.8, ease: "sine.inOut" }, ${q(e)});`);
        }
    }
    return L.join("\n    ");
}

// ─── predložak ─────────────────────────────────────────────────────
// Isti generic.template.html (jedan izvor istine za kadar, potpis i titl), uz tri umetka.
function premiumTemplate() {
    let tpl = fs.readFileSync(path.join(HERE, "..", "generic.template.html"), "utf8");
    const swap = (a, b) => { if (!tpl.includes(a)) throw new Error(`premium predložak: nema „${a.slice(0, 50)}…" u generic.template.html`); tpl = tpl.replace(a, b); };
    swap("</style>", fs.readFileSync(path.join(HERE, "premium.css"), "utf8") + "\n</style>");
    swap('<div id="shade"></div>', '<div id="shade"></div>\n  <div id="mood"></div>');
    swap('tl.fromTo("#video-wrap", { scale: 1 }, { scale: 1.04, duration: {{DUR}}, ease: "none" }, 0);', "{{CAMERA_JS}}");
    swap("{{CARD_JS}}", "{{CARD_JS}}\n\n    {{MOOD_JS}}");
    return tpl;
}

/**
 * @param {string} publicDir  odredište (input-video.mp4 je već ondje)
 * @param {object} o  { reel, doc (beats.json), words, dur, faces, videoId, title, channelName, brand, debug }
 * @returns {{compId, beats: object[], warnings: string[], keyTimes: number[]}}
 */
function preparePremium(publicDir, o) {
    fs.mkdirSync(path.join(publicDir, "fonts"), { recursive: true });
    fs.mkdirSync(path.join(publicDir, "vendor"), { recursive: true });
    const fontsSrc = path.join(brandingDir(), "fonts");
    for (const f of ["Montserrat-Bold.ttf", "Montserrat-ExtraBold.ttf", "Montserrat-Black.ttf"]) {
        fs.copyFileSync(path.join(fontsSrc, f), path.join(publicDir, "fonts", f));
    }
    fs.copyFileSync(path.join(HERE, "..", "vendor", "gsap.min.js"), path.join(publicDir, "vendor", "gsap.min.js"));
    fs.copyFileSync(path.join(HERE, "..", "reel_layout.js"), path.join(publicDir, "reel_layout.js"));
    fs.copyFileSync(path.join(brandingDir(), "domovina_ai", "logo_square.png"), path.join(publicDir, "domovina_logo.png"));

    const ctx = { title: o.title, channelName: o.channelName, videoId: o.videoId };
    const { beats: sched, warnings } = schedule(o.doc, o.words, o.dur);
    const beats = [];
    for (const b of sched) {
        const comp = COMPONENTS[b.component];
        b.id = `k${beats.length}`;
        if (comp.prepare && comp.prepare(b) === false) { warnings.push(`${b.component} (takt ${b.i}) otpao: prazan crtež`); continue; }
        if (b.component === "quote" && b.p.reveal === "spoken") {
            b.spoken = matchSpoken(b.p.text, o.words, Number.isInteger(b.atWord) ? b.atWord : 0);
            if (!b.spoken) warnings.push("quote reveal=spoken: tekst nije doslovan niz izgovorenih riječi od at_word, prikazan cijeli");
        }
        warnings.push(...b.warn);
        beats.push(b);
    }

    const cardHtml = beats.map((b) => {
        const comp = COMPONENTS[b.component];
        const align = comp.align || b.p.align;
        const prefer = b.prefer === "above" || b.prefer === "below" ? ` data-prefer="${b.prefer}"` : "";
        const veil = comp.veil && comp.veil(b) ? '<div class="veil"></div>' : "";
        return `<div class="card-host clip" id="${b.id}" data-start="${b.start}" data-duration="${b.dur}" data-track-index="2">
    ${veil}<div class="slot"${align ? ` data-align="${align}"` : ""}${prefer}>${comp.markup(b, b.id, ctx)}</div>
  </div>`;
    }).join("\n\n  ");
    const cardJs = beats.map((b) => COMPONENTS[b.component].timeline(b, b.id, ctx).join("\n    ")).join("\n\n    ");

    // titl se skriva dok citat „spoken" pali iste riječi
    const hide = beats.filter((b) => b.spoken).map((b) => [b.start, b.end]);
    const capWords = o.words.filter((w) => !hide.some(([s, e]) => w.start >= s - 0.1 && w.start < e));
    const cap = captions(capWords, o.dur);
    const compId = `reel-${o.videoId}-${o.reel.rank}-premium`.replace(/[^A-Za-z0-9_-]/g, "-");

    const css = brandCss(o.brand, publicDir);   // prvo: kopira brand/logo.png
    const hasLogo = fs.existsSync(path.join(publicDir, "brand", "logo.png"));
    const html = premiumTemplate()
        .replaceAll("{{COMP_ID}}", compId)
        .replaceAll("{{DUR}}", String(q(o.dur)))
        .replace("{{BRAND_CSS}}", css)
        .replace("{{CHANNEL_BUG}}", hasLogo ? '<div class="bug"><img src="brand/logo.png" alt="" /></div>' : "")
        .replace("{{CARDS}}", cardHtml)
        .replace("{{CAMERA_JS}}", cameraJs(o.doc, o.words, o.dur, warnings))
        .replace("{{CARD_JS}}", cardJs)
        .replace("{{MOOD_JS}}", moodJs(o.doc, o.words, o.dur))
        .replace("{{CAPTIONS}}", cap.html)
        .replace("{{CAPTION_JS}}", cap.js)
        .replace("{{FACES}}", JSON.stringify(o.faces))
        .replace("{{DEBUG}}", o.debug ? "true" : "false");
    fs.writeFileSync(path.join(publicDir, "index.html"), html);
    const keyTimes = beats.map((b) => +Math.min(o.dur - 0.1, Math.max(b.start + 0.2, COMPONENTS[b.component].key(b))).toFixed(2));
    return {
        compId, warnings, keyTimes,
        beats: beats.map((b) => ({ component: b.component, start: b.start, dur: b.dur })),
    };
}

module.exports = { COMPONENTS, catalogText, schedule, sanitizeParts, matchSpoken, preparePremium };
