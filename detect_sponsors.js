#!/usr/bin/env node
"use strict";
/**
 * detect_sponsors.js — sponzori UGRAĐENI u snimku: tko su i GDJE su u njoj.
 *
 * Izlaz se zove `sponsors_in_video.json` (CDN: data/{id}/sponsors_in_video.json) da se
 * odvoji od dinamičkih sponzora koji sponzorstvo na domovina.ai mogu kupiti i nakon
 * snimanja — to je zaseban proizvod i zaseban izvor podataka.
 *
 * NE ZOVE NIJEDAN LLM. Sve se izvodi iz onoga što je već na disku:
 *   {base}.description / {base}.info.json   → TKO (ime, URL, opis iz opisa videa)
 *                                             + YouTube poglavlja autora
 *   {base}.wav.canary.diarized.srt          → GDJE (vremenski rasponi u snimci)
 *
 * Izlaz: {base}.sponsors_in_video.json — piše se za SVAKU epizodu s .info.json, i kad je
 * popis prazan. Flutter tako uvijek dobije 200 umjesto 404 (CDN kešira 404 —
 * vidi MEMORY cloudflare_cdn_caches_404s), a prazan niz je odgovor „nema
 * sponzora", ne „nije obrađeno".
 *
 * Zašto: sponzor kojeg je autor sam doveo nije YouTube-ov oglasivač nego partner
 * koji je omogućio epizodu. Ne sakrivamo ga i ne preskačemo — dajemo mu vidljivo
 * mjesto i gumb „poslušaj" za točan raspon.
 *
 * Vrste segmenata (`kind`):
 *   spot       producirani oglas: zaseban glas koji se u epizodi javlja samo
 *              kratko, uz barem još jedan potvrdni signal. Čiste granice → smije
 *              se pustiti na zahtjev. (Iva Kraljević ep. 50, e-Duhovne vježbe)
 *   host_read  voditelj čita poruku sponzora („Ovu epizodu podržava HiPP…")
 *   rubric     sponzorirana rubrika s najavom i odjavom („Plazma: grickaj i
 *              biraj" … „Eto, to je bila plazma pauza")
 *   mention    jedna rečenica zahvale („Hvala HiPP-u koji nas podržava")
 *   chapter    autorovo YouTube poglavlje nazvano po sponzoru, bez potvrde u
 *              transkriptu (granice su autorove, grube)
 *
 * `playable: true` samo kad su granice pouzdane (spot, rubric s odjavom,
 * host_read). mention je rečenica — link na trenutak, bez reprodukcije.
 *
 * Idempotencija: datoteka se prepisuje samo kad se sadržaj promijeni. Nema
 * `generated_at` — izlaz je determinističan, pa re-run ne stvara lažni drift
 * disk≠R2 (upload_to_r2 hvata drift po veličini).
 *
 * Primjeri:
 *   node detect_sponsors.js --video-id aue1GuuMsbA
 *   node detect_sponsors.js --channel rastuci_s_djecom --dry-run
 *   node detect_sponsors.js --channel rastuci_s_djecom --dry-run --verbose
 *   node detect_sponsors.js                    # cijeli katalog
 */

const fs = require("fs");
const path = require("path");

const GENERATOR = "detect_sponsors.js@1";
const SCHEMA_VERSION = 1;
// Tip dokumenta: sponzori UGRAĐENI u snimku (autorova suradnja). Namjerno odvojeno od
// dinamičkih sponzorstava koja se na domovina.ai mogu kupiti i NAKON snimanja —
// ona žive u vlastitom izvoru i ne smiju se miješati s ovim.
const DOC_TYPE = "sponsors_in_video";
const SITE_BASE = process.env.SPONSORS_SITE_BASE || "https://domovina.ai";

// Producirani spot: govornik koji UKUPNO govori manje od ovoga…
const SPOT_MAX_SPEAKER_SEC = 120;
// …i čija se sva pojavljivanja stanu u ovaj prozor (jedan blok, ne razasut gost).
const SPOT_MAX_SPAN_SEC = 180;
// Kratke epizode (isječci, shortsi) imaju kratke govornike po prirodi — preskoči.
const SPOT_MIN_EPISODE_SEC = 20 * 60;
// Voditeljevo čitanje: koliko daleko od sidra smije ići.
const HOST_READ_MAX_SEC = 120;
// Rubrika: koliko daleko od najave tražimo odjavu.
const RUBRIC_MAX_SEC = 10 * 60;
// Zaliha na rubovima (SRT granice su Canary segmenti, ne rezovi montaže).
const PAD_SEC = 1;

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tekst
// ─────────────────────────────────────────────────────────────────────────────

/** Mala slova, bez dijakritike, samo [a-z0-9] i razmaci. */
function norm(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/đ/g, "d")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function compact(s) {
    return norm(s).replace(/ /g, "");
}

function extractVideoId(filename) {
    const matches = [...filename.matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

function timestampToSeconds(ts) {
    const m = String(ts).trim().match(/(\d+):(\d+):(\d+)(?:[,.](\d+))?/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +`0.${m[4]}` : 0);
}

function fmtTime(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return dp[a.length][b.length];
}

/**
 * Jesu li dva kompaktna imena isti sponzor unatoč padežu i ASR-u:
 * „angelumu"/„angelomu" ↔ „angellum", „zlatarnidodic" ↔ „zlatarnadodic",
 * „mandisfarmu" ↔ „mandisfarm". Uspoređuju se prefiksi (padež je na kraju).
 */
function fuzzyNameEq(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // Oba imena moraju biti približno iste duljine: prefiks „hvalava" od „hvala vam"
    // NIJE „hvalanasimpatronima…" samo zato što mu je početak sličan.
    if (Math.min(a.length, b.length) < 0.75 * Math.max(a.length, b.length)) return false;
    const L = Math.min(a.length, b.length) - 1;
    if (L < 4) return false;
    if (a[0] !== b[0]) return false;
    const tol = L >= 6 ? 2 : 1;
    return levenshtein(a.slice(0, L), b.slice(0, L)) <= tol;
}

// ─────────────────────────────────────────────────────────────────────────────
// TKO — sponzori iz opisa videa
// ─────────────────────────────────────────────────────────────────────────────

// Riječi koje ne smiju biti alias: prečeste u govoru ili dio svakog URL-a.
const ALIAS_STOP = new Set([
    "www", "http", "https", "com", "net", "org", "shop", "store", "kava", "cafe",
    "caffe", "podcast", "instagram", "facebook", "youtube", "official", "online",
    "aplikacija", "aplikaciji", "since", "brand", "concept", "unique",
    "sponzor", "sponzori", "sponzora", "partner", "partneri", "hvala", "epizode", "epizoda",
]);

// „www.biljesestreljubice.com" bez sheme je čest u opisima.
const URL_RE = /(?:https?:\/\/|\bwww\.)[^\s)<>"']+/g;
// Linija opisa koja govori o sponzoru. Namjerno uska: „Zapratite nas na
// Instagramu" ili „Produkcija: Bljesak.info" NISU sponzori.
const DESC_CUE_RE = /(sponzor|pokrovitelj|partner(a|u)? (nas(eg|e)? )?(podcasta|epizode|emisije)|epizod\w* (podrzava|omogucuj|omogucava)|podrzava (hipp|epizod)|omogucio nam je|omogucuje\b|voditelj\w* odijeva)/;
// Naslov bloka: „Sponzori podcasta:", „SPONZORI EPIZODE", „HVALA NAŠIM PATRONIMA I SPONZORIMA:"
const SPONSOR_HEADER_RE = /^(hvala )?(nasi |nasim )?((patron\w*|pokrovitelj\w*|partner\w*) i )?sponzor\w*( i (patron\w*|partner\w*))?( (podcasta|epizode|ove epizode|emisije))?\s*$/;
// „Opremanje studija pomogli:" — podrška podcastu, ali ne sponzor epizode.
const STUDIO_HEADER_RE = /^(opremanje|opremu) studija\b|^studio (su )?(opremili|pomogli)/;
// Uloge koje se traže u transkriptu. wardrobe/studio su navedeni u opisu, ali se
// u snimci ne čitaju — i njihova imena („Gojan") su preblizu običnim riječima.
const SPOKEN_ROLES = new Set(["sponsor", "partner"]);

function roleFor(normLine) {
    if (/odijeva/.test(normLine)) return "wardrobe";
    if (/pokrovitelj/.test(normLine)) return "partner";
    if (/partner/.test(normLine)) return "partner";
    return "sponsor";
}

function hostnameOf(url) {
    try {
        return new URL(/^https?:/.test(url) ? url : "https://" + url).hostname.replace(/^www\./, "");
    } catch {
        return null;
    }
}

// Autorovo samofinanciranje (donacije, vlastita trgovina) nije sponzor epizode.
const SELF_FUNDING_HOST_RE = /(^|\.)(patreon\.com|buymeacoffee\.com|ko-fi\.com|paypal\.(com|me)|gofundme\.com|linktr\.ee|revolut\.me)$/;

function isSocialUrl(url) {
    return /instagram\.com|facebook\.com|tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com/.test(url);
}

/** Aliasi za traženje u transkriptu: kompaktno ime + distinktivni dijelovi domene. */
function aliasesFor(name, urls) {
    const out = new Set();
    if (name) {
        const c = compact(name);
        if (c.length >= 3 && !ALIAS_STOP.has(c)) out.add(c);
        // Višerječno ime ide SAMO kao cjelina: pojedine riječi („sestre" iz
        // „Bilje sestre Ljubice") pogađaju običan govor. Distinktivne dijelove
        // daje domena (eurovip-brazil-kava → „brazil").
    }
    for (const u of urls) {
        const host = hostnameOf(u);
        if (!host || isSocialUrl(u)) continue;
        const root = host.split(".").slice(0, -1).join(".");
        for (const t of root.split(/[.-]/)) {
            const n = compact(t);
            if (n.length >= 4 && !ALIAS_STOP.has(n)) out.add(n);
        }
        const whole = compact(root);
        if (whole.length >= 4 && !ALIAS_STOP.has(whole)) out.add(whole);
    }
    return [...out];
}

function cleanName(s) {
    return String(s || "")
        .replace(URL_RE, "")
        .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
        .replace(/^[\s\-–—:,•*]+|[\s\-–—:,•*.!]+$/g, "")
        .trim();
}

// Uvodne fraze koje nisu dio imena („Epizodu omogućuje HiPP:" → „HiPP").
const NAME_PREFIX_RE = /^(?:[^\p{L}\p{N}]*)(?:partner epizode|epizodu (?:podržava|omogućuje|omogućava)|voditelj\w* odijeva:?|sponzor(?:i)? podcasta:?|generaln\w* pokrovitelj\w*(?: podcasta)?:?|(?:obiteljsk\w* )?(?:tvrtk\w*|obrt\w*|trgovin\w*|aplikacij\w*|brend\w*))\s*/iu;

/** Ime iz jedne linije opisa. Vraća null kad ga nema (npr. „Hvala partneru podcasta: URL"). */
function nameFromLine(line) {
    const n = nameFromLineRaw(line);
    if (!n) return null;
    const cleaned = cleanName(n.replace(NAME_PREFIX_RE, ""));
    return cleaned.length >= 2 ? cleaned : null;
}

function nameFromLineRaw(line) {
    const noUrl = line.replace(URL_RE, "").trim();
    let m;
    // „Cafe Brazil, partner našeg podcasta, omogućio…"
    if ((m = noUrl.match(/^\s*([^,]{2,40}),\s*(partner|sponzor)/i))) return cleanName(m[1]);
    // „Partner epizode Hipp", „Epizodu omogućuje HiPP:", „Epizodu podržava HiPP – s …"
    if ((m = noUrl.match(/(?:partner epizode|epizodu (?:podržava|omogućuje|omogućava)|sponzor(?:i)? podcasta:?)\s+([^:–—,(]{2,40})/i)))
        return cleanName(m[1]);
    // „Hvala i sponzoru ove epizode, aplikaciji e-Duhovne vježbe, na podršci…"
    if ((m = noUrl.match(/sponzoru (?:ove |današnje )?(?:epizode|emisije)[,:]\s*(?:aplikaciji\s+)?([^,]{2,40})(?:,|$)/i)))
        return cleanName(m[1]);
    // „GENERALNI POKROVITELJ PODCASTA: ANGELLUM", „…pokrovitelju Angellum na podršci"
    // Fraza bez obzira na veličinu slova, ime iza nje samo riječi s velikim početnim.
    if ((m = noUrl.match(/pokrovitelj\p{L}*(?: (?:ove |današnje |ovog )?(?:podcasta|epizode|emisije))?[:,]?\s+/iu))) {
        const rest = noUrl.slice(m.index + m[0].length);
        const nm = rest.match(/^[A-ZČĆŽŠĐ][\p{L}\d-]*(?:\s+[A-ZČĆŽŠĐ][\p{L}\d-]*){0,3}/u);
        if (nm) return titleIfShouting(cleanName(nm[0]));
    }
    // „Voditeljicu odijeva: Unique Concept Store, zaprati…"
    if ((m = noUrl.match(/odijeva:?\s+([^,]{2,40})/i))) return cleanName(m[1]);
    // „HiPP: https://…", „Plazma: https://…"
    if ((m = noUrl.match(/^([^:]{2,40}):\s*$/))) return cleanName(m[1]);
    return null;
}

/** „ANGELLUM" → „Angellum" (opisi često viču). Miješana veličina slova ostaje. */
function titleIfShouting(name) {
    if (!name || name !== name.toUpperCase() || !/[A-ZČĆŽŠĐ]{3}/.test(name)) return name;
    return name.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
}

/** Ime iz retka „Lasta, since 1952 https://…" / „Unique Concept Store – https://…" (tekst ispred URL-a). */
function nameBeforeUrl(line) {
    const idx = line.search(URL_RE);
    if (idx <= 0) return null;
    const head = cleanName(line.slice(0, idx).split(/[,–—|(]/)[0]);
    return head.length >= 2 && head.length <= 40 ? head : null;
}

/**
 * Parsira opis videa u popis sponzora. Dva oblika u praksi:
 *   1. blok „Sponzori podcasta:" pa redovi „Ime: URL" + reklamni tekst
 *   2. samostalne rečenice („Partner epizode Hipp https://…")
 */
function parseDescriptionSponsors(description, channelKey = "") {
    const lines = String(description || "").split("\n");
    const found = [];
    let inBlock = false;
    let blockRole = "sponsor";
    let blankRun = 0;
    let last = null;
    let pending = null; // cue redak bez imena i URL-a („👗 Voditeljicu odijeva:") čeka idući redak

    const push = (entry) => {
        found.push(entry);
        last = entry;
    };

    for (const raw of lines) {
        const line = raw.trim();
        const n = norm(line);
        if (!line) {
            blankRun++;
            if (blankRun >= 2) last = null;
            continue;
        }
        blankRun = 0;
        // Popis poglavlja u opisu („00:56:00 - 01:00:29 | Produkcija, sponzori…") nije sponzor.
        if (/^\d{1,2}:\d{2}/.test(line)) continue;
        if (/^-{4,}/.test(line) || line.startsWith("#")) {
            inBlock = false;
            last = null;
            continue;
        }
        if (STUDIO_HEADER_RE.test(n)) {
            inBlock = true;
            blockRole = "studio";
            last = null;
            continue;
        }
        if (SPONSOR_HEADER_RE.test(n) || /^sponzor(i)? podcasta\s*$/.test(n)) {
            inBlock = true;
            blockRole = "sponsor";
            last = null;
            continue;
        }
        const urls = line.match(URL_RE) || [];

        if (pending) {
            const p = pending;
            pending = null;
            if (urls.length) {
                push({ name: nameBeforeUrl(line) || nameFromLine(line), urls, role: p.role, line: p.line + " " + line, blurb: [] });
                continue;
            }
        }

        if (inBlock) {
            const name = nameFromLine(line) || (urls.length ? nameBeforeUrl(line) : null);
            if (urls.length && name) {
                push({ name, urls, role: /odijeva/.test(n) ? "wardrobe" : blockRole, line, blurb: [] });
                continue;
            }
            if (!urls.length && last && line.length > 20) {
                last.blurb.push(line);
                continue;
            }
            if (!urls.length && !last) {
                // Tekst nakon bloka bez imena → blok je gotov.
                inBlock = false;
            }
        }

        if (DESC_CUE_RE.test(n)) {
            if (!urls.length && !nameFromLine(line) && /:\s*$/.test(line)) {
                pending = { role: roleFor(n), line };
                continue;
            }
            push({ name: nameFromLine(line), urls, role: roleFor(n), line, blurb: [] });
        }
    }

    // Spajanje: „Cafe Brazil, partner…" (ime bez URL-a) + „Hvala partneru
    // podcasta: https://eurovip-brazil-kava.com/" (URL bez imena) su isti sponzor.
    const selfKey = compact(channelKey);
    const isSelf = (u) => {
        const h = hostnameOf(u);
        return !h || SELF_FUNDING_HOST_RE.test(h) || (selfKey.length >= 5 && compact(h).includes(selfKey));
    };
    const merged = [];
    for (const f of found) {
        // Redak koji vodi SAMO na donacije/vlastitu trgovinu → nije sponzor.
        if (f.urls.length && f.urls.every((u) => isSelf(u) || isSocialUrl(u)) && f.urls.some(isSelf)) continue;
        f.urls = f.urls.filter((u) => !isSelf(u));
        f.aliases = aliasesFor(f.name, f.urls);
        // Riječi imena služe SAMO za spajanje redaka, ne za traženje u transkriptu.
        f.nameTokens = norm(f.name || "").split(" ").filter((t) => t.length >= 4 && !ALIAS_STOP.has(t));
        const twin = merged.find((m) => SPOKEN_ROLES.has(m.role) && SPOKEN_ROLES.has(f.role)
            && (m.aliases.some((a) => f.aliases.includes(a))
                || m.nameTokens.some((t) => f.aliases.includes(t))
                || f.nameTokens.some((t) => m.aliases.includes(t))));
        if (twin) {
            // Pravo ime („Cafe Brazil") ima prednost pred hostnameom.
            if (!twin.name || (!twin.explicitName && f.name)) { twin.name = f.name || twin.name; twin.explicitName = Boolean(f.name); }
            twin.nameTokens = [...new Set([...twin.nameTokens, ...f.nameTokens])];
            twin.urls = [...new Set([...twin.urls, ...f.urls])];
            twin.lines.push(f.line);
            twin.blurb.push(...f.blurb);
            twin.aliases = [...new Set([...twin.aliases, ...f.aliases])];
            if (twin.role === "sponsor" && f.role === "partner") twin.role = "partner";
        } else if (f.name || f.urls.some((u) => !isSocialUrl(u))) {
            merged.push({ ...f, lines: [f.line], explicitName: Boolean(f.name) });
        }
    }

    // „Pokrovitelj podcasta – Zorina Mast" … tri retka niže „https://zorinamast.com/"
    const allUrls = String(description || "").match(URL_RE) || [];
    for (const m of merged) {
        if (m.urls.some((u) => !isSocialUrl(u)) || !m.name) continue;
        const c = compact(m.name);
        if (c.length < 5) continue;
        const u = allUrls.find((x) => !isSocialUrl(x) && !isSelf(x) && compact(hostnameOf(x) || "").includes(c));
        if (u) m.urls.push(u);
    }
    const stripQuery = (u) => (u ? u.replace(/[?#].*$/, "") : u);
    const nameFromHost = (u) => {
        const h = hostnameOf(u);
        if (!h) return null;
        return h.split(".").slice(0, -1).join(" ").replace(/-/g, " ")
            .replace(/(^|\s)(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
    };
    return merged.map((m) => {
        const web = stripQuery(m.urls.find((u) => !isSocialUrl(u))) || null;
        const instagram = stripQuery(m.urls.find((u) => /instagram\.com/.test(u))) || null;
        const name = m.name || (web ? nameFromHost(web) : null);
        return {
            name,
            role: m.role,
            url: web,
            instagram,
            description_lines: m.lines,
            blurb: m.blurb.join(" ").slice(0, 600) || null,
            aliases: m.aliases.length ? m.aliases : aliasesFor(name, []),
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// GDJE — transkript
// ─────────────────────────────────────────────────────────────────────────────

function parseSrt(text) {
    const segs = [];
    for (const block of String(text).split(/\r?\n\r?\n+/)) {
        const l = block.split(/\r?\n/);
        const tIdx = l.findIndex((x) => x.includes("-->"));
        if (tIdx === -1) continue;
        const [a, b] = l[tIdx].split("-->");
        const body = l.slice(tIdx + 1).join(" ").trim();
        if (!body) continue;
        const m = body.match(/^\[(\w+)\]\s*(.*)$/);
        const speaker = m ? m[1] : null;
        const t = m ? m[2] : body;
        segs.push({ start: timestampToSeconds(a), end: timestampToSeconds(b), speaker, text: t, n: norm(t) });
    }
    return segs;
}

/** Nalazi li se alias u normaliziranom tekstu (tolerira ASR: „HIP-u", „Plasma", „Plazmi"). */
function textHasAlias(n, alias, fuzzy = true) {
    if (!alias) return false;
    if (alias.length >= 8 || /\d/.test(alias)) {
        if (n.replace(/ /g, "").includes(alias)) return true;
        if (!fuzzy) return false;
        const toks = n.split(" ");
        for (let i = 0; i < toks.length; i++) {
            if (fuzzyNameEq(toks[i], alias) || (toks[i + 1] && fuzzyNameEq(toks[i] + toks[i + 1], alias))) return true;
        }
        return false;
    }
    for (const tok of n.split(" ")) {
        if (tok.length < 3) continue;
        if (tok.length > alias.length + 2) continue;
        if (tok.startsWith(alias)) return true;
        // „hip" za „hipp": riječ kojoj fali samo zadnje slovo aliasa. Sigurno i bez fuzzyja.
        if (tok.length >= 3 && tok.length === alias.length - 1 && alias.startsWith(tok)) return true;
        if (!fuzzy) continue;
        // „hipp" ↔ „hip/hipu/hipa", „plazma" ↔ „plasma/plazmi"
        const head = tok.slice(0, alias.length);
        const tol = alias.length >= 5 ? 1 : (alias.length === 4 ? 1 : 0);
        if (tol && head.length >= alias.length - 1 && levenshtein(head, alias) <= tol
            && head[0] === alias[0]) return true;
    }
    return false;
}

/**
 * `withChannel`: smiju li se koristiti sponzori s DRUGIH epizoda kanala. Samo uz
 * sponzorsku frazu (host_read, mention) i bez fuzzy tolerancije — inače „Gojan"
 * (studio) pogodi „Goran" u naslovu poglavlja, a „Iđen doli" (festival iz jedne
 * epizode) postane sponzor svake epizode u kojoj se festival spomene.
 */
function sponsorsInText(n, sponsors, withChannel = false) {
    return sponsors.filter((s) => SPOKEN_ROLES.has(s.role)
        && (withChannel || !s.from_channel)
        && s.aliases.some((a) => textHasAlias(n, a, !s.from_channel)));
}

// Sidro voditeljeva čitanja. Namjerno bez „podržava" samog — „mama me podržava".
const HOST_READ_ANCHOR_RE = new RegExp([
    "(ovu|ova|ovo|jos jedna|jednu) (je )?(jos )?(jedna )?epizod\\w* (koju )?(i dalje |ponovno |nam )?(podrzava|podrzavaju|nastaje uz podrsk|omogucuj|omogucava|spon[sz]orira)",
    "epizod\\w* (koju|koja) (i dalje |ponovno )?(podrzava|podrzavaju|omogucuj)",
    "(podrzava|podrzavaju|omogucuje|omogucava) (ovu|ovo|ovaj|danasnju) (epizod|emisij|podcast)",
    "uz podrsku (nasih |nasega |naseg )?(partner|spon[sz]or)",
    "(partner|spon[sz]or)\\w* (koji|koja|koje) (nam )?(omogucuj|omogucava|podrzava)",
    "(jedan od |nas )?spon[sz]or\\w* (ove|danasnje|nase) (epizode|emisije)",
    "partner\\w* (ove |danasnje )?(epizode|emisije)",
    "(generaln\\w* )?pokrovitelj\\w* (ovog |naseg )?(podcasta|emisije|epizode)",
].join("|"));

// Rečenica koja nosi reklamni sadržaj (nastavak voditeljeva čitanja).
const COMMERCIAL_RE = /\b(brand|brend|proizvod\w*|pakiranj\w*|okus\w*|pire\w*|organsk\w*|bio|kvalitet\w*|asortiman\w*|linij\w* proizvoda|generacij\w*|sastoj\w*|keks\w*|grickalic\w*|aplikacij\w*|preuzmi\w*|besplatn\w*|ponud\w*|popust\w*|sponzor\w*|partner\w*|vjerujemo|koristimo)\b/;
// Ton oglasa u producirano spotu.
const AD_TONE_RE = /\b(preuzmi\w*|posjeti\w*|aplikacij\w*|ponud\w*|popust\w*|besplatn\w*|narudzb\w*|kupi\w*|pocni vec danas|www|prijavi\w*)\b/;
// Najava pauze prije spota.
const BREAK_CUE_RE = /\b(promo|reklam\w*|pauz\w*|predah\w*|sponzor\w*|partner\w*)\b/;
const THANKS_RE = /\b(hvala|zahval\w*|podrzava\w*|podrzal\w*|spon[sz]or\w*|pokrovitelj\w*|partner\w*|omogucil\w*|omogucio)\b/;
const RUBRIC_START_RE = /\b(rubrik\w*|trenutak|pauz\w*|predah\w*|donosi|dobrodosli u|grick\w*|gritsk\w*)\b/;
const RUBRIC_END_RE = /(vracamo se|evo nas (opet |ponovno )?nazad|natrag na temu|nazad na temu|to je bila\b.*\b(pauz|trenutak|rubrik)|kraj rubrike)/;

function speakerStats(segs) {
    const st = new Map();
    for (const s of segs) {
        if (!s.speaker) continue;
        const o = st.get(s.speaker) || { dur: 0, first: s.start, last: s.end, n: 0 };
        o.dur += Math.max(0, s.end - s.start);
        o.first = Math.min(o.first, s.start);
        o.last = Math.max(o.last, s.end);
        o.n++;
        st.set(s.speaker, o);
    }
    return st;
}

function mkSegment(kind, segs, i0, i1, extra) {
    const start = Math.max(0, Math.floor(segs[i0].start) - PAD_SEC);
    const end = Math.ceil(segs[i1].end) + PAD_SEC;
    return {
        kind,
        start,
        end,
        text: segs.slice(i0, i1 + 1).map((s) => s.text).join(" ").slice(0, 1200),
        ...extra,
    };
}

function detectSegments(segs, sponsors, chapters, durationSec) {
    const out = [];
    const used = new Set(); // indeksi segmenata već pokriveni jačim nalazom

    const claim = (i0, i1) => {
        for (let i = i0; i <= i1; i++) used.add(i);
    };
    const attribute = (text) => sponsorsInText(norm(text), sponsors).map((s) => s.name);
    const attributeWithChannel = (text) => sponsorsInText(norm(text), sponsors, true).map((s) => s.name);

    // 1) PRODUCIRANI SPOT — kratki zaseban glas + barem jedan potvrdni signal
    if (durationSec >= SPOT_MIN_EPISODE_SEC) {
        for (const [spk, st] of speakerStats(segs)) {
            if (spk === "UNKNOWN") continue;
            if (st.dur > SPOT_MAX_SPEAKER_SEC || st.last - st.first > SPOT_MAX_SPAN_SEC) continue;
            const idx = segs.map((s, i) => (s.speaker === spk ? i : -1)).filter((i) => i >= 0);
            const i0 = idx[0];
            const i1 = idx[idx.length - 1];
            const blockText = segs.slice(i0, i1 + 1).filter((s) => s.speaker === spk).map((s) => s.n).join(" ");
            const signals = ["short_distinct_voice"];
            const names = attribute(blockText);
            if (names.length) signals.push("sponsor_name_in_spot");
            if (AD_TONE_RE.test(blockText)) signals.push("ad_language");
            const before = segs.filter((s) => s.end <= segs[i0].start && s.end >= segs[i0].start - 45);
            if (before.some((s) => BREAK_CUE_RE.test(s.n))) signals.push("break_announced");
            const ch = chapters.find((c) => c.start_time < segs[i1].end && c.end_time > segs[i0].start
                && (sponsorsInText(norm(c.title), sponsors).length || /sponzor|reklam|promo|oglas/.test(norm(c.title))));
            if (ch) signals.push("youtube_chapter");
            if (signals.length < 2) continue;
            const chNames = ch ? sponsorsInText(norm(ch.title), sponsors).map((s) => s.name) : [];
            const attributed = [...new Set([...names, ...chNames])];
            // Kratak zaseban glas bez imena sponzora je najčešće isječak, najava ili
            // pitanje iz publike (izmjereno: 70 od 71 takvih u katalogu). Bez imena
            // zadržavamo samo uz barem 3 signala, i nikad kao „poslušaj".
            if (!attributed.length && signals.length < 3) continue;
            claim(i0, i1);
            out.push(mkSegment("spot", segs, i0, i1, {
                sponsors: attributed,
                playable: attributed.length > 0,
                confidence: !attributed.length ? "low" : signals.length >= 3 ? "high" : "medium",
                signals,
                speaker: spk,
            }));
        }
    }

    // 2) SPONZORIRANA RUBRIKA — najava s imenom sponzora … odjava
    for (let i = 0; i < segs.length; i++) {
        if (used.has(i)) continue;
        const names = attribute(segs[i].text);
        if (!names.length || !RUBRIC_START_RE.test(segs[i].n)) continue;
        let j = -1;
        for (let k = i + 1; k < segs.length && segs[k].start - segs[i].start <= RUBRIC_MAX_SEC; k++) {
            if (RUBRIC_END_RE.test(segs[k].n)) { j = k; break; }
        }
        if (j === -1) continue; // bez odjave nema pouzdanog kraja → pada na mention niže
        let i0 = i;
        // „Vrijeme je za mali predah…" neposredno prije najave pripada rubrici
        while (i0 > 0 && segs[i].start - segs[i0 - 1].start <= 15 && /predah|pauz|vrijeme je za/.test(segs[i0 - 1].n)) i0--;
        claim(i0, j);
        out.push(mkSegment("rubric", segs, i0, j, {
            sponsors: names,
            playable: true,
            confidence: "high",
            signals: ["rubric_intro_with_sponsor", "rubric_outro"],
        }));
        i = j;
    }

    // 3) VODITELJ ČITA PORUKU SPONZORA — sidro + nastavak istog govornika
    for (let i = 0; i < segs.length; i++) {
        if (used.has(i) || !HOST_READ_ANCHOR_RE.test(segs[i].n)) continue;
        const spk = segs[i].speaker;
        let end = i;
        let misses = 0;
        for (let k = i + 1; k < segs.length; k++) {
            if (segs[k].speaker !== spk || used.has(k)) break;
            if (segs[k].start - segs[i].start > HOST_READ_MAX_SEC) break;
            const hit = attributeWithChannel(segs[k].text).length || COMMERCIAL_RE.test(segs[k].n) || HOST_READ_ANCHOR_RE.test(segs[k].n);
            if (hit) { end = k; misses = 0; } else if (++misses >= 2) break;
        }
        const text = segs.slice(i, end + 1).map((s) => s.text).join(" ");
        const names = attributeWithChannel(text);
        const signals = ["sponsor_phrase"];
        if (names.length) signals.push("sponsor_name");
        if (end > i) signals.push("extended_read");
        claim(i, end);
        out.push(mkSegment("host_read", segs, i, end, {
            sponsors: names,
            playable: names.length > 0,
            confidence: names.length && end > i ? "high" : "medium",
            signals,
            speaker: spk,
        }));
        i = end;
    }

    // 4) ZAHVALA / SPOMEN — rečenica s imenom sponzora i riječju zahvale
    for (let i = 0; i < segs.length; i++) {
        if (used.has(i)) continue;
        const names = attributeWithChannel(segs[i].text);
        if (!names.length || !THANKS_RE.test(segs[i].n)) continue;
        claim(i, i);
        out.push(mkSegment("mention", segs, i, i, {
            sponsors: names,
            playable: false,
            confidence: "medium",
            signals: ["sponsor_name", "thanks_phrase"],
            speaker: segs[i].speaker,
        }));
    }

    // 5) AUTOROVO POGLAVLJE bez potvrde u transkriptu
    for (const c of chapters) {
        const names = sponsorsInText(norm(c.title), sponsors).map((s) => s.name);
        const generic = /sponzor|reklam|promo|oglas/.test(norm(c.title));
        if (!names.length && !generic) continue;
        if (out.some((o) => o.start < c.end_time && o.end > c.start_time)) continue;
        // Autor je poglavlje nazvao po sponzoru („Grickaj i biraj uz Plazmu") → to je
        // sponzorirana rubrika s autorovim granicama. Granice su ručne (±20 s), ali
        // dovoljno dobre za „poslušaj"; generičko „Reklama" bez imena ostaje link.
        const named = names.length && c.end_time - c.start_time >= 45;
        out.push({
            kind: named ? "rubric" : "chapter",
            start: Math.floor(c.start_time),
            end: Math.ceil(c.end_time),
            text: c.title,
            sponsors: names,
            playable: Boolean(named),
            confidence: named ? "medium" : "low",
            signals: named ? ["youtube_chapter", "sponsor_name_in_chapter"] : ["youtube_chapter"],
        });
    }

    return out.sort((a, b) => a.start - b.start);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sastavljanje izlaza
// ─────────────────────────────────────────────────────────────────────────────

// Ime izgovoreno iza sponzorske fraze. Riječi s velikim slovom (1–3), bez općih
// imenica („tvrtki", „aplikaciji"). Ostaje u padežu kako je izgovoreno („Hvaromi").
// „podržava X" samo kad je X odmah iza „epizodu" — „podržava Mateju Čuljku" je osoba.
const SPOKEN_NAME_RE = /(?:(?:epizodu|epizoda|emisiju) (?:i dalje |ponovno )?(?:podržava|podržavaju|omogućuje|omogućava)|spon[sz]or\w* (?:današnje |ove )?(?:epizode|emisije|podcasta),?(?: a to je)?|pokrovitelj\w* (?:ovog |našeg )?(?:podcasta|emisije),?)\s+(?:nas\s+)?(?:(?:tvrtki|tvrtka|aplikaciji|obrtu|trgovini|brendu|obiteljskoj tvrtki)\s+)?((?:[A-ZČĆŽŠĐ][\p{L}\d-]+)(?:\s+[A-ZČĆŽŠĐ][\p{L}\d-]+){0,2})/gu;

function spokenSponsorNames(text) {
    const out = [];
    for (const m of String(text).matchAll(SPOKEN_NAME_RE)) {
        const name = m[1].trim();
        if (/^(Ovu|Ovo|Ova|Epizod|Podcast|Hvala|I)$/i.test(name.split(" ")[0])) continue;
        if (!out.includes(name)) out.push(name);
    }
    return out;
}

function slugify(s) {
    return norm(s).replace(/ /g, "-") || "unknown";
}

/**
 * `channelSponsors`: sponzori iz opisa OSTALIH epizoda istog kanala. Služe samo
 * za prepoznavanje u transkriptu — autor često u opis ne upiše sponzora kojeg u
 * snimci uredno pročita („Ovu epizodu i dalje podržava hip…"). U izlaz ulaze
 * tek kad dobiju barem jedan segment (source: "channel").
 */
function buildSponsorsDoc({ videoId, description, chapters, segs, durationSec, channelSponsors = [], channelKey = "" }) {
    const sponsors = parseDescriptionSponsors(description, channelKey);
    const fromChannel = channelSponsors
        .filter((c) => SPOKEN_ROLES.has(c.role) && c.url)
        .filter((c) => !sponsors.some((s) => s.aliases.some((a) => c.aliases.includes(a))))
        .map((c) => ({ ...c, description_lines: [], from_channel: true }));
    const known = [...sponsors, ...fromChannel];
    const segments = segs.length ? detectSegments(segs, known, chapters, durationSec) : [];
    const hit = new Set(segments.flatMap((g) => g.sponsors));
    for (const c of fromChannel) if (hit.has(c.name)) sponsors.push(c);

    // Sponzor spomenut u transkriptu, a nema ga u opisu → ime iz sidrene rečenice.
    for (const seg of segments) {
        if (seg.sponsors.length || seg.kind === "chapter") continue;
        const resolved = [];
        for (const spoken of spokenSponsorNames(seg.text)) {
            const c = compact(spoken);
            let hit = sponsors.find((s) => s.name && (fuzzyNameEq(compact(s.name), c) || s.aliases.some((a) => fuzzyNameEq(a, c))));
            if (!hit) {
                hit = { name: spoken, role: "sponsor", url: null, instagram: null, description_lines: [], blurb: null, aliases: aliasesFor(spoken, []), from_transcript: true };
                sponsors.push(hit);
            }
            if (hit.from_channel && !sponsors.includes(hit)) sponsors.push(hit);
            if (!resolved.includes(hit.name)) resolved.push(hit.name);
        }
        seg.sponsors = resolved;
    }

    const link = (sec) => `${SITE_BASE}/v/${videoId}/t/${sec}`;
    const out = sponsors.map((s) => ({
        id: slugify(s.name),
        name: s.name,
        role: s.role,
        url: s.url,
        instagram: s.instagram,
        blurb: s.blurb,
        description_lines: s.description_lines,
        source: s.from_transcript ? "transcript" : s.from_channel ? "channel" : "description",
        segments: [],
    }));

    const unknown = { id: "_unattributed", name: null, role: "sponsor", url: null, instagram: null, blurb: null, description_lines: [], source: "transcript", segments: [] };
    for (const seg of segments) {
        const entry = {
            kind: seg.kind,
            start: seg.start,
            end: seg.end,
            duration: seg.end - seg.start,
            start_hms: fmtTime(seg.start),
            end_hms: fmtTime(seg.end),
            playable: seg.playable,
            confidence: seg.confidence,
            signals: seg.signals,
            url: link(seg.start),
            text: seg.text,
        };
        const targets = seg.sponsors.length ? out.filter((o) => seg.sponsors.includes(o.name)) : [];
        if (targets.length) for (const t of targets) t.segments.push(entry);
        else unknown.segments.push(entry);
    }
    if (unknown.segments.length) out.push(unknown);

    return {
        type: DOC_TYPE,
        schema_version: SCHEMA_VERSION,
        generator: GENERATOR,
        video_id: videoId,
        sponsors: out,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Otkrivanje epizoda i CLI
// ─────────────────────────────────────────────────────────────────────────────

function listChannelDirs(inputDir) {
    // Kanali su simlinkovi na druge diskove → isDirectory() vraća false.
    return fs
        .readdirSync(inputDir, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
}

function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

function readDescription(channelDir, base) {
    try { return fs.readFileSync(path.join(channelDir, base + ".description"), "utf8"); } catch { /* fallback */ }
    return (readJson(path.join(channelDir, base + ".info.json")) || {}).description || "";
}

/** Sponzori svih epizoda kanala, jedan po aliasu (najnoviji opis pobjeđuje). */
function collectChannelSponsors(channelDir, bases) {
    const acc = [];
    for (const b of bases) {
        for (const s of parseDescriptionSponsors(readDescription(channelDir, b), path.basename(channelDir))) {
            if (!acc.some((a) => a.aliases.some((x) => s.aliases.includes(x)))) acc.push(s);
        }
    }
    return acc;
}

function processEpisode(channelDir, base, opts) {
    const p = (suffix) => path.join(channelDir, base + suffix);
    const info = readJson(p(".info.json")) || {};
    const videoId = extractVideoId(base) || info.id;
    const description = readDescription(channelDir, base);
    const chapters = Array.isArray(info.chapters) ? info.chapters : [];
    let segs = [];
    try { segs = parseSrt(fs.readFileSync(p(".wav.canary.diarized.srt"), "utf8")); } catch { /* bez transkripta: samo opis */ }
    const durationSec = info.duration || (segs.length ? segs[segs.length - 1].end : 0);

    const doc = buildSponsorsDoc({ videoId, description, chapters, segs, durationSec, channelSponsors: opts.channelSponsors, channelKey: path.basename(channelDir) });
    doc.has_transcript = segs.length > 0;
    const json = JSON.stringify(doc, null, 2) + "\n";
    const outPath = p(".sponsors_in_video.json");
    let prev = null;
    try { prev = fs.readFileSync(outPath, "utf8"); } catch { /* novo */ }
    const changed = prev !== json;
    if (changed && !opts.dryRun) fs.writeFileSync(outPath, json);
    return { doc, changed, outPath };
}

function main() {
    const inputDir = getArg("--input-dir") || path.join(__dirname, "storage", "output");
    const channelFilter = getArg("--channel");
    const videoIdFilter = getArg("--video-id");
    const dryRun = args.includes("--dry-run");
    const verbose = args.includes("--verbose");

    const channels = channelFilter ? [channelFilter] : listChannelDirs(inputDir);
    const totals = { episodes: 0, withSponsors: 0, segments: 0, playable: 0, written: 0, byKind: {} };

    for (const ch of channels) {
        const channelDir = path.join(inputDir, ch);
        let files;
        try { files = fs.readdirSync(channelDir); } catch { continue; }
        const allBases = files
            .filter((f) => f.endsWith(".info.json") && !f.startsWith("._"))
            .map((f) => f.slice(0, -".info.json".length))
            .sort()
            .reverse();
        const bases = allBases.filter((b) => !videoIdFilter || extractVideoId(b) === videoIdFilter);
        if (!bases.length) continue;
        const channelSponsors = collectChannelSponsors(channelDir, allBases);

        for (const base of bases) {
            const { doc, changed } = processEpisode(channelDir, base, { dryRun, channelSponsors });
            totals.episodes++;
            if (changed && !dryRun) totals.written++;
            const segCount = doc.sponsors.reduce((a, s) => a + s.segments.length, 0);
            if (doc.sponsors.length) totals.withSponsors++;
            totals.segments += segCount;
            for (const s of doc.sponsors) for (const g of s.segments) {
                totals.byKind[g.kind] = (totals.byKind[g.kind] || 0) + 1;
                if (g.playable) totals.playable++;
            }

            if (!doc.sponsors.length && !verbose) continue;
            console.log(`\n▶ ${ch} / ${doc.video_id}  ${base.slice(0, 70)}${doc.has_transcript ? "" : "  (bez transkripta)"}`);
            if (!doc.sponsors.length) console.log("   — nema sponzora");
            for (const s of doc.sponsors) {
                console.log(`   • ${s.name ?? "(nepoznat)"} [${s.role}] ${s.url ?? ""}`);
                for (const g of s.segments) {
                    const t = g.text.length > 110 ? g.text.slice(0, 110) + "…" : g.text;
                    console.log(`       ${g.kind.padEnd(9)} ${g.start_hms}–${g.end_hms} (${String(g.duration).padStart(3)}s) ${g.playable ? "▶" : " "} ${g.confidence.padEnd(6)} ${g.url}`);
                    if (verbose) console.log(`           „${t}"  [${g.signals.join(", ")}]`);
                }
            }
        }
    }

    console.log(`\n📊 Epizoda: ${totals.episodes} | sa sponzorima: ${totals.withSponsors} | segmenata: ${totals.segments} (▶ ${totals.playable}) ${JSON.stringify(totals.byKind)}`);
    console.log(dryRun ? "🏜️  Suho pokretanje — ništa nije zapisano." : `💾 Zapisano/promijenjeno: ${totals.written}`);
}

if (require.main === module) main();

module.exports = {
    norm,
    parseSrt,
    parseDescriptionSponsors,
    textHasAlias,
    detectSegments,
    buildSponsorsDoc,
    HOST_READ_ANCHOR_RE,
};
