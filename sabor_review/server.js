#!/usr/bin/env node

/**
 * sabor_review/server.js — lokalna aplikacija za LJUDSKI PREGLED imenovanja
 * govornika na saborskoj sjednici.
 *
 * Zamisao: AI obradi što više, čovjek pregleda SAMO ono gdje je pouzdanost
 * niska. Odluka se piše u zaseban sloj (`human_overrides.json`), faza 03 se
 * odmah ponovno pokrene, i razlika se pokaže na ekranu. Krug traje ~0.4 s,
 * pa je petlja „AI → čovjek → AI" doslovno interaktivna.
 *
 * ⛔ Aplikacija NIKAD ne piše u `aligned_transcript.json`. Piše samo u
 *    `human_overrides.json`; transkript proizvodi isključivo faza 03.
 *    Vidi `sabor_pipeline/utils/human_overrides.js` za razlog.
 *
 * Bez vanjskih ovisnosti — isti obrazac kao `dashboard/server.js`.
 *
 *   node sabor_review/server.js
 *   node sabor_review/server.js --port 8788 --output-dir storage/output/sabor
 *
 *   GET  /                        UI
 *   GET  /api/sessions            popis sjednica na disku
 *   GET  /api/queue?session=      red čekanja po pouzdanosti + sažetak
 *   GET  /api/speaker?session=&id= sve što treba za odluku o jednoj oznaci
 *   GET  /api/roster?q=           pretraga registra zastupnika
 *   GET  /api/diff?session=       razlika prema referentnom prolazu (bez ljudi)
 *   GET  /api/audit?session=      neovisna revizija ljudskog sloja
 *   POST /api/decision            zapiši odluku → faza 03 → razlika
 *   POST /api/rerun               ponovno pokreni fazu 03 (i po izboru 04)
 *   GET  /api/job?id=             stanje i log pozadinskog posla
 *   GET  /media/<session>/<part>  lokalna snimka dijela (HTTP Range)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PIPE = path.join(ROOT, "sabor_pipeline");
const args = process.argv.slice(2);
function getArg(name, fallback) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const PORT = parseInt(getArg("--port", "8788"), 10);
const OUTPUT_DIR = path.resolve(ROOT, getArg("--output-dir", "storage/output/sabor"));
// Zadani registar; STVARNI se čita iz same sjednice (vidi `roster()`), jer
// svaki saziv ima svoj popis i sjednice iz raznih saziva mogu stajati jedna
// pored druge na disku.
const DEFAULT_ROSTER_PATH = path.join(PIPE, "data", "rosters", "sabor_mps_11_saziv.json");

const humanOverrides = require(path.join(PIPE, "utils", "human_overrides.js"));
const timeMapper = require(path.join(PIPE, "utils", "time_mapper.js"));
const { handoverSentence } = require(path.join(PIPE, "utils", "protocol_parser.js"));
const { RosterMatcher, jaroWinkler } = require(path.join(PIPE, "utils", "roster_match.js"));
const diffNaming = require(path.join(PIPE, "tools", "diff_naming.js"));

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const sessionDir = (s) => path.join(OUTPUT_DIR, s);

// ============================================================================
// Učitavanje sjednice (keš po mtime — faza 03 mijenja datoteke pod nama)
// ============================================================================

const cache = new Map();

function loadSession(session) {
    const dir = sessionDir(session);
    const alignedP = path.join(dir, "aligned_transcript.json");
    if (!fs.existsSync(alignedP)) throw new Error(`nema aligned_transcript.json za ${session}`);
    const key = `${session}:${fs.statSync(alignedP).mtimeMs}`;
    const hit = cache.get(session);
    if (hit && hit.key === key) return hit.data;

    const aligned = readJson(alignedP);
    const smapP = path.join(dir, "speaker_map.json");
    const smap = fs.existsSync(smapP) ? readJson(smapP) : { speakers: {}, anchors: [], chairs: [] };
    const manifestP = path.join(dir, "session_manifest.json");
    const manifest = fs.existsSync(manifestP) ? readJson(manifestP) : null;

    // Po oznaci: vrijeme, blokovi, trenutno ime.
    const perSpeaker = new Map();
    for (const b of aligned.blocks) {
        if (!perSpeaker.has(b.speaker_id)) {
            perSpeaker.set(b.speaker_id, { sec: 0, blocks: [], name: null, source: null, role: null });
        }
        const e = perSpeaker.get(b.speaker_id);
        e.sec += b.duration_sec;
        e.blocks.push(b);
        if (b.speaker_name) { e.name = b.speaker_name; e.source = b.identity_source || "protokol"; }
        e.role = b.role;
    }

    const data = {
        dir, aligned, smap, manifest, perSpeaker,
        blind: loadBlind(dir),
        ocr: loadOcr(dir),
        overrides: humanOverrides.load(dir, session),
        key,
    };
    cache.set(session, { key, data });
    return data;
}

/**
 * Prijedlozi iz natpisa s ekrana (`sabor_pipeline/tools/ocr_captions.js`).
 *
 * Treći izvor identiteta, neovisan i o najavi predsjedavajućeg i o modelu:
 * saborska režija ispisuje ime u donjoj traci i kad nitko ništa nije rekao.
 * Mjereno na pilotu: 100 % slaganja s protokolom ondje gdje oba izvora imenuju
 * osobu (67/67), uz nula slučajeva u kojima ekran tvrdi drugu osobu.
 *
 * Uzima se SAMO `prijedlog` — odluka koja je već prošla ogradu protiv tankog
 * dokaza. Sirovi `kandidati` ostaju u datoteci kao dokaz, ali ih pregled ne
 * smije tumačiti sam: oznaka koju je ograda zaustavila („natpis na 13 %
 * sličica") ovdje mora izgledati kao da prijedloga NEMA, a ne kao slab
 * prijedlog koji bi netko u žurbi prihvatio.
 */
function loadOcr(dir) {
    const out = new Map();
    const f = path.join(dir, "ocr_captions", "prijedlozi.json");
    if (!fs.existsSync(f)) return out;
    let j;
    try { j = readJson(f); } catch { return out; }
    for (const p of j.prijedlozi || []) {
        const pr = p.prijedlog;
        if (!pr || (pr.status !== "predlozi" && pr.status !== "predlozi_izvan_registra")) continue;
        const dokazi = [];
        for (const k of p.kandidati || []) for (const d of k.dokazi || []) dokazi.push(d);
        out.set(p.speaker_id, {
            mp_id: pr.mp_id, ime: pr.puno_ime,
            u_registru: pr.status === "predlozi",
            pokrivenost: p.pokrivenost, udio: p.udio_vodeceg,
            glasova: (p.kandidati[0] || {}).glasova || 0,
            slicica_s_natpisom: p.slicica_s_natpisom,
            dokazi: dokazi.slice(0, 4),
        });
    }
    return out;
}

/** Prijedlozi slijepe provjere, grupirani po oznaci (gotova građa za pregled). */
function loadBlind(dir) {
    const out = new Map();
    const bdir = path.join(dir, "blind_check_agy");
    if (!fs.existsSync(bdir)) return out;
    for (const f of fs.readdirSync(bdir).filter((x) => /^w\d+\.json$/.test(x)).sort()) {
        let j;
        try { j = readJson(path.join(bdir, f)); } catch { continue; }
        for (const id of j.identifikacije || []) {
            if (!id.speaker_id) continue;
            if (!out.has(id.speaker_id)) out.set(id.speaker_id, []);
            out.get(id.speaker_id).push({
                prozor: f.replace(/\.json$/, ""),
                ime: id.ime || null,
                uloga: id.uloga || null,
                dokaz: id.dokaz || null,
                dokaz_timestamp: id.dokaz_timestamp || null,
                sigurnost: id.sigurnost || null,
            });
        }
    }
    return out;
}

const rosterCache = new Map();

/**
 * Registar KOJE JE SJEDNICA STVARNO KORISTILA.
 *
 * Faza 03 u `aligned_transcript.json` zapisuje `roster.path`, pa ga ovdje
 * čitamo umjesto da ga pretpostavimo. Bez toga bi sjednica iz 12. saziva bila
 * pregledavana registrom 11. saziva — imena bi se razrješavala u krive ljude,
 * i to bez ijedne poruke.
 */
function roster(session = null) {
    let p = DEFAULT_ROSTER_PATH;
    if (session) {
        try {
            const a = loadSession(session).aligned;
            if (a.roster && a.roster.path) {
                const cand = path.resolve(ROOT, a.roster.path);
                if (fs.existsSync(cand)) p = cand;
            }
        } catch { /* sjednica se ne da učitati — ostaje zadani registar */ }
    }
    if (!rosterCache.has(p)) {
        const r = readJson(p);
        rosterCache.set(p, {
            path: p, raw: r,
            byId: new Map(r.mps.map((m) => [m.id, m])),
            matcher: new RosterMatcher(r),
        });
    }
    return rosterCache.get(p);
}

// ============================================================================
// RED ČEKANJA — najprije ono gdje je pouzdanost najniža
// ============================================================================

/**
 * Poredak je zadan namjerno, ne po „ukupnoj korisnosti":
 *
 *   0  nerazriješeno   glasovi postoje ali se ne slažu → odluka je već tražena
 *   1  srednja         jedna jedina najava nosi identitet → najkrhkiji „riješen"
 *   2  neimenovano     protokol je nijem; ovdje leži 34 % vremena (§7 zaključka)
 *   3  visoka          ≥2 složne najave → pregled po želji, ne po potrebi
 *
 * Unutar razine sortira se po GOVORNOM VREMENU silazno: ista količina ljudskog
 * rada nosi više kad zatvara pola sata nego kad zatvara dvadeset sekundi.
 */
const RANG = [
    { rank: 0, label: "nerazriješeno", opis: "glasovi se ne slažu" },
    { rank: 1, label: "srednja", opis: "jedna jedina najava" },
    { rank: 2, label: "neimenovano", opis: "protokol je nijem" },
    { rank: 3, label: "visoka", opis: "dvije ili više složnih najava" },
];

function buildQueue(session) {
    const S = loadSession(session);
    const R = roster(session);
    const chairs = new Set(S.smap.chairs || []);
    const rows = [];

    for (const [sid, e] of S.perSpeaker) {
        const m = S.smap.speakers ? S.smap.speakers[sid] : null;
        const ovr = S.overrides.overrides[sid] || null;
        const blind = S.blind.get(sid) || [];
        const ocrP = S.ocr.get(sid) || null;
        // Imena modela se razrješavaju kroz registar PRIJE uspoređivanja.
        // ASR ista prezimena piše različito („Habijen"/„Habijan", „Raukar
        // Gamulin"/„Raukar-Gamulin"); bez razrješavanja bi svaka takva
        // varijanta izgledala kao da model imenuje dvije različite osobe.
        const blindIds = new Map();
        for (const b of blind) {
            if (!b.ime) continue;
            const hit = R.matcher.resolve(b.ime);
            let key = hit && hit.mp && hit.score >= 0.9 ? `mp:${hit.mp.id}` : `ime:${norm(b.ime)}`;
            if (key.startsWith("ime:")) {
                // Osobe IZVAN registra (predsjedatelj, ministri) nemaju `mp_id`
                // pa se varijante njihova imena ne mogu spojiti preko njega.
                // „Habijen"/„Habijan" bi inače prošli kao dvoje ljudi.
                const bliska = [...blindIds.keys()].find((k) =>
                    k.startsWith("ime:") && jaroWinkler(k.slice(4), key.slice(4)) >= 0.92);
                if (bliska) key = bliska;
            }
            if (!blindIds.has(key)) blindIds.set(key, hit && hit.mp && hit.score >= 0.9 ? hit.mp.puno_ime : b.ime);
        }
        const blindNames = [...blindIds.values()];
        const currentHit = e.name ? R.matcher.resolve(e.name) : null;
        const currentKey = currentHit && currentHit.mp && currentHit.score >= 0.9
            ? `mp:${currentHit.mp.id}` : (e.name ? `ime:${norm(e.name)}` : null);

        let rank;
        if (m && !m.resolved && (m.votes_total || 0) > 0) rank = 0;
        else if (m && m.resolved && m.confidence_tier === "srednja") rank = 1;
        else if (!e.name) rank = 2;
        else rank = 3;

        rows.push({
            speaker_id: sid,
            sec: Math.round(e.sec),
            minutes: Math.round(e.sec / 6) / 10,
            n_blocks: e.blocks.length,
            name: e.name,
            source: e.source,
            role: e.role,
            is_chair: chairs.has(sid),
            tier: m ? m.confidence_tier : null,
            votes: m ? m.votes : 0,
            votes_total: m ? m.votes_total : 0,
            competitors: m && m.competitors ? m.competitors : [],
            role_hint: m ? m.role_hint || null : null,
            dropped_reason: m ? m.dropped_reason || null : null,
            rank,
            rank_label: RANG[rank].label,
            blind_names: blindNames,
            has_blind: blindNames.length > 0,
            // DVA NEOVISNA POSTUPKA daju isto ime: protokolarno sidrenje iz
            // najave i model koji je čitao GOLE oznake bez registra. To je
            // najjača potvrda koju sustav ima bez slušanja snimke.
            blind_agrees: !!currentKey && blindIds.size === 1 && blindIds.has(currentKey),
            // Model koji sam sebi proturječi za istu oznaku je signal DA nešto
            // treba pogledati — ali ne i dokaz o tome ŠTO (§9.2 faze 03).
            blind_conflict: blindIds.size > 1,
            // Model imenuje, protokol šuti ili kaže drugo — najvrjedniji redak
            // u redu: tu ljudska odluka doista donosi novo ime.
            blind_disagrees: !!e.name && blindIds.size >= 1 && !blindIds.has(currentKey),
            // Natpis s ekrana — treći izvor. Bitno je da se u redu vidi
            // odvojeno od modela: model nagađa iz teksta, ekran čita ono što je
            // režija ispisala, pa „ekran + protokol" nije isto što i
            // „model + protokol".
            ocr_name: ocrP ? ocrP.ime : null,
            has_ocr: !!ocrP,
            ocr_agrees: !!ocrP && !!currentKey &&
                (ocrP.mp_id ? `mp:${ocrP.mp_id}` === currentKey : `ime:${norm(ocrP.ime)}` === currentKey),
            ocr_disagrees: !!ocrP && !!e.name && !(ocrP.mp_id
                ? `mp:${ocrP.mp_id}` === currentKey : `ime:${norm(ocrP.ime)}` === currentKey),
            decided: !!ovr,
            decision: ovr ? ovr.odluka : null,
            decided_by: ovr ? ovr.odlucio : null,
        });
    }

    rows.sort((a, b) => a.rank - b.rank || b.sec - a.sec);
    const queue = rows.filter((r) => !r.decided);
    const done = rows.filter((r) => r.decided);

    const total = rows.reduce((s, r) => s + r.sec, 0);
    const perRank = RANG.map((r) => {
        const inRank = queue.filter((q) => q.rank === r.rank);
        return {
            ...r,
            n: inRank.length,
            sec: inRank.reduce((s, q) => s + q.sec, 0),
            pct: total ? Math.round((1000 * inRank.reduce((s, q) => s + q.sec, 0)) / total) / 10 : 0,
        };
    });

    return {
        session,
        stats: S.aligned.stats,
        total_speakers: S.aligned.total_speakers,
        labels_with_speech: rows.length,
        total_sec: total,
        per_rank: perRank,
        queue, done,
    };
}

// ============================================================================
// SVE ZA ODLUKU O JEDNOJ OZNACI — na jednom ekranu
// ============================================================================

function yt(S, sec) {
    if (!S.manifest) return null;
    try { return timeMapper.globalToYoutube(S.manifest, sec); } catch { return null; }
}

function speakerDetail(session, sid) {
    const S = loadSession(session);
    const e = S.perSpeaker.get(sid);
    if (!e) throw new Error(`oznaka ${sid} ne govori u ovoj sjednici`);

    const blocksByTime = e.blocks.slice().sort((a, b) => a.start_global_sec - b.start_global_sec);
    const idxOf = new Map(S.aligned.blocks.map((b, i) => [b.block_id, i]));

    /**
     * Najava predsjedavajućeg neposredno prije bloka — isti postupak kao
     * `tools/adjudicate_blind.js`. To je JEDINI dokaz koji protokol uopće ima,
     * pa mora biti na ekranu uz tekst, ne u drugoj kartici.
     */
    function chairBefore(block) {
        const i = idxOf.get(block.block_id);
        if (i == null || i === 0) return null;
        for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
            const c = S.aligned.blocks[k];
            if (c.role !== "predsjedatelj") continue;
            const sentence = handoverSentence(c.text);
            return {
                block_id: c.block_id,
                hms: c.start_hms,
                speaker_id: c.speaker_id,
                recenica: sentence || null,
                rep: sentence ? null : c.text.slice(-280),
                // Najava se sluša s KRAJA bloka predsjedatelja — ime pada u
                // zadnjoj rečenici prije nego progovori onaj koga najavljuje,
                // a taj blok zna trajati minutama.
                youtube: yt(S, Math.max(c.start_global_sec, c.end_global_sec - 12)) || c.youtube,
            };
        }
        return null;
    }

    // Najduži istupi prvi — na njima se identitet najlakše prepozna.
    const byLen = e.blocks.slice().sort((a, b) => b.duration_sec - a.duration_sec);
    const istupi = byLen.slice(0, 12).map((b) => ({
        block_id: b.block_id,
        hms: b.start_hms,
        duration_sec: b.duration_sec,
        role: b.role,
        text: b.text,
        // Faza 03 u blok zapisuje `timestamp_sec` zaokružen na sekundu; player
        // dobiva PRECIZAN pomak, jer se identitet često čuje u prve dvije riječi.
        youtube: yt(S, b.start_global_sec) || b.youtube,
        najava: chairBefore(b),
    }));

    const anchors = (S.smap.anchors || []).filter((a) => a.target_speaker === sid).map((a) => ({
        ...a,
        hms: timeMapper.secondsToHms(a.at_global_sec),
        youtube: yt(S, a.at_global_sec),
    }));

    const m = S.smap.speakers ? S.smap.speakers[sid] : null;
    const blind = S.blind.get(sid) || [];

    // ── kandidati, svaki s izvorom i dokazom ──
    const cands = new Map();
    const R = roster(session);
    const push = (mp, ime, izvor, dokaz, score) => {
        const key = mp ? `mp:${mp.id}` : `ime:${ime}`;
        if (!cands.has(key)) {
            cands.set(key, {
                mp_id: mp ? mp.id : null,
                puno_ime: mp ? mp.puno_ime : ime,
                stranka: mp ? mp.stranka : null,
                klub: mp ? mp.klub : null,
                img: mp ? mp.img : null,
                u_registru: !!mp,
                izvori: [], dokazi: [], score: score || null,
            });
        }
        const c = cands.get(key);
        if (!c.izvori.includes(izvor)) c.izvori.push(izvor);
        if (dokaz) c.dokazi.push(dokaz);
    };

    for (const a of anchors) {
        push(R.byId.get(a.mp_id), a.mp, "najava", `${a.hms} — „${a.spoken_name}"`, a.match_score);
    }
    for (const b of blind) {
        if (!b.ime) continue;
        const hit = R.matcher.resolve(b.ime);
        const mp = hit && hit.mp && hit.score >= 0.86 ? hit.mp : null;
        push(mp, b.ime, "model", `${b.prozor} ${b.dokaz_timestamp || ""} — „${b.dokaz || ""}"`.trim(), hit ? hit.score : null);
    }
    for (const c of (m && m.competitors) || []) {
        const hit = R.matcher.resolve(c.mp);
        push(hit && hit.mp ? hit.mp : null, c.mp, "natjecatelj", `${c.votes} glas(ova)`, null);
    }
    // Natpis s ekrana. Dokaz mu je SLIKA, ne citat — pa uz svaki ide sekunda i
    // putanja sličice, da čovjek može vidjeti isto što je vidio OCR umjesto da
    // mu vjeruje na riječ.
    const ocrP = S.ocr.get(sid) || null;
    if (ocrP) {
        const mp = ocrP.mp_id ? R.byId.get(ocrP.mp_id) : null;
        const dokaz = `natpis na ${ocrP.glasova}/${ocrP.slicica_s_natpisom} sličica ` +
                      `(pokrivenost ${(ocrP.pokrivenost * 100).toFixed(0)} %)`;
        push(mp, ocrP.ime, "ekran", dokaz, null);
    }

    // Kandidat kojeg potvrđuju dva NEOVISNA izvora (protokol i model) vrijedi
    // više od bilo kojeg pojedinačnog rezultata podudaranja.
    const kandidati = [...cands.values()].sort((a, b) => b.izvori.length - a.izvori.length);

    // Ima li sjednica lokalnu snimku i je li to zvuk ili video — UI o tome
    // ovisi: video pokazuje lice i ime s ekrana, zvuk samo glas.
    const mediji = {};
    for (const p of (S.manifest && S.manifest.parts) || []) {
        const f = mediaFileFor(session, p.part);
        mediji[p.part] = f
            ? { ima: true, datoteka: f.rel, video: VIDEO_EXTS.includes(f.ext), ver: f.ver }
            : { ima: false };
    }

    return {
        session, speaker_id: sid,
        mediji,
        sec: Math.round(e.sec),
        minutes: Math.round(e.sec / 6) / 10,
        n_blocks: e.blocks.length,
        prvi_hms: blocksByTime[0].start_hms,
        zadnji_hms: blocksByTime[blocksByTime.length - 1].start_hms,
        trenutno: m || null,
        ime: e.name, izvor: e.source, uloga: e.role,
        is_chair: (S.smap.chairs || []).includes(sid),
        istupi, anchors, blind, kandidati,
        ocr: ocrP,
        override: S.overrides.overrides[sid] || null,
    };
}

// ============================================================================
// PETLJA — zapiši odluku, ponovno pokreni fazu 03, pokaži razliku
// ============================================================================

function runPhase03(session, extra = []) {
    return execFileSync("node", [
        path.join(PIPE, "03_transcribe_and_align.js"),
        "--session", session, "--output-dir", OUTPUT_DIR, ...extra,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Razlika prema REFERENTNOM prolazu — onome što bi protokol dao bez ljudi.
 * Referenca se svaki put izračuna iznova (`--no-human --suffix .protokol`):
 * snimak bi nakon idućeg popravka sidrenja zastario i ljudskom sloju pripisao
 * tuđu zaslugu.
 */
function computeDiff(session) {
    const dir = sessionDir(session);
    const refP = path.join(dir, "aligned_transcript.protokol.json");
    runPhase03(session, ["--no-human", "--suffix", ".protokol"]);
    const d = diffNaming.diff(readJson(refP), readJson(path.join(dir, "aligned_transcript.json")));
    return d;
}

/**
 * Faza 03 na stderr ispisuje i uredan tijek rada i grešku. Korisniku treba
 * SAMO greška — bez ovoga se poruka o sukobu utopi u ispisu gustoća.
 */
function phase03Error(err) {
    // `err.message` sadrži cijeli stderr još jednom — uzima se samo ako
    // stderr nije uhvaćen, inače se poruka udvostruči.
    const raw = (err.stderr || err.stdout || err.message || "").toString();
    const lines = raw.split("\n");
    const i = lines.findIndex((l) => /^GREŠKA/.test(l));
    const tekst = (i >= 0 ? lines.slice(i) : lines.slice(-6)).join("\n").trim();
    return tekst || "faza 03 je pala bez poruke";
}

function applyDecision(body) {
    const { session, speaker_id } = body;
    if (!session || !speaker_id) throw new Error("nedostaje session ili speaker_id");
    const dir = sessionDir(session);
    const doc = humanOverrides.load(dir, session);
    const prev = JSON.stringify(doc);

    if (body.odluka === "ponisti") {
        delete doc.overrides[speaker_id];
    } else {
        const entry = {
            odluka: body.odluka,
            mp_id: body.mp_id || null,
            puno_ime: body.puno_ime || null,
            stranka: body.stranka || null,
            klub: body.klub || null,
            uloga: body.uloga || null,
            razlog: body.razlog || null,
            dokaz: body.dokaz || null,
            izvor_prijedloga: body.izvor_prijedloga || null,
            odlucio: body.odlucio || whoami(),
            odluceno_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
        if (body.dopusti_dijeljenu_oznaku === true) entry.dopusti_dijeljenu_oznaku = true;
        const bad = humanOverrides.validateEntry(speaker_id, entry, roster(session).byId);
        if (bad.length) return { ok: false, errors: bad };
        doc.overrides[speaker_id] = entry;
    }

    humanOverrides.save(dir, doc);
    // Faza 03 je jedini pisac transkripta. Ako padne (npr. dvije odluke o istoj
    // osobi bez izričitog dopuštenja), sloj se VRAĆA na prijašnje stanje —
    // polovična odluka na disku bila bi gora od odbijene.
    let log;
    try {
        log = runPhase03(session);
    } catch (err) {
        fs.writeFileSync(humanOverrides.overridesPath(dir), prev + "\n", "utf8");
        return { ok: false, errors: [phase03Error(err)], rolled_back: true };
    }
    cache.delete(session);
    return { ok: true, log: log ? log.trim() : "", diff: computeDiff(session), queue: buildQueue(session) };
}

/**
 * Skupna potvrda oznaka kod kojih se PROTOKOL i MODEL slažu na isto ime.
 *
 * ⚠️ Ovo NIJE prečac za „potvrdi sve". Uvjet je da su se dva NEOVISNA postupka
 * složila — najava predsjedavajućeg i model koji je čitao gole oznake bez
 * registra. Ono što čovjek tu potvrđuje jest upravo to slaganje, i tako i
 * PIŠE u `razlog`: tko poslije čita sloj, vidi da oznaka nije preslušana nego
 * prihvaćena na temelju dva izvora. Provenijencija koja laže gora je od
 * neodlučene oznake.
 */
function batchConfirm(session, speakerIds, odlucio) {
    const dir = sessionDir(session);
    const doc = humanOverrides.load(dir, session);
    const prev = JSON.stringify(doc);
    const qrows = new Map(buildQueue(session).queue.map((r) => [r.speaker_id, r]));
    const R = roster(session);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const potvrdeno = [];
    const odbijeno = [];

    for (const sid of speakerIds) {
        const r = qrows.get(sid);
        if (!r || !r.blind_agrees) { odbijeno.push({ sid, zasto: "protokol i model se ne slažu" }); continue; }
        const hit = R.matcher.resolve(r.name);
        const mp = hit && hit.mp && hit.score >= 0.95 ? hit.mp : null;
        if (!mp) { odbijeno.push({ sid, zasto: `„${r.name}" se ne razrješava u registru` }); continue; }
        doc.overrides[sid] = {
            odluka: "potvrdi",
            mp_id: mp.id, puno_ime: mp.puno_ime, stranka: null, klub: null, uloga: null,
            razlog: "skupna potvrda: protokolarna najava i slijepa provjera modelom daju isto ime; snimka nije preslušana",
            dokaz: { citat: `slijepa provjera: ${r.blind_names[0]}`, at_hms: null, youtube_url: null },
            izvor_prijedloga: "slaganje protokola i slijepe provjere",
            odlucio: odlucio || whoami(),
            odluceno_at: now,
        };
        potvrdeno.push(sid);
    }

    if (!potvrdeno.length) return { ok: false, errors: ["nijedna oznaka nije ispunila uvjet"], odbijeno };
    humanOverrides.save(dir, doc);
    try {
        runPhase03(session);
    } catch (err) {
        fs.writeFileSync(humanOverrides.overridesPath(dir), prev + "\n", "utf8");
        return { ok: false, errors: [phase03Error(err)], rolled_back: true };
    }
    cache.delete(session);
    return { ok: true, potvrdeno, odbijeno, diff: computeDiff(session), queue: buildQueue(session) };
}

function whoami() {
    if (process.env.SABOR_REVIEWER) return process.env.SABOR_REVIEWER;
    try {
        return execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim() || "nepoznat";
    } catch { return "nepoznat"; }
}

// ============================================================================
// Pozadinski poslovi (faza 04 traje ~33 min i troši LLM kvotu)
// ============================================================================

const jobs = new Map();
let jobSeq = 0;

function startRerun(session, steps, backend) {
    const id = `job${++jobSeq}`;
    const dir = path.join(sessionDir(session), "human_review");
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, `rerun_${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    const to = steps.includes("04") ? "04" : "03";
    const argv = [
        path.join(PIPE, "run_sabor_session.sh"),
        "--session", session, "--output-dir", OUTPUT_DIR,
        "--from", "03", "--to", to,
    ];
    if (to === "03") argv.push("--no-article");
    else if (backend) argv.push("--article-backend", backend);

    const out = fs.openSync(logPath, "a");
    const child = spawn("bash", argv, { cwd: ROOT, stdio: ["ignore", out, out], detached: true });
    const job = { id, session, steps: to, log: logPath, pid: child.pid, started: new Date().toISOString(), status: "radi", code: null };
    jobs.set(id, job);
    child.on("exit", (code) => {
        job.status = code === 0 ? "gotovo" : "palo";
        job.code = code;
        job.finished = new Date().toISOString();
        cache.delete(session);
        try { fs.closeSync(out); } catch { /* zatvoreno */ }
    });
    child.unref();
    return job;
}

function jobStatus(id) {
    const j = jobs.get(id);
    if (!j) throw new Error(`nepoznat posao ${id}`);
    let tail = "";
    try {
        const buf = fs.readFileSync(j.log, "utf8");
        tail = buf.split("\n").slice(-60).join("\n");
    } catch { /* log još ne postoji */ }
    return { ...j, tail };
}


// ============================================================================
// LOKALNA SNIMKA — posluživanje s HTTP Range podrškom
// ============================================================================

/**
 * ⚠️ RANGE NIJE NEOBAVEZAN. Dio sjednice je ~350 MB `m4a`. Bez `Accept-Ranges`
 * i `206 Partial Content` preglednik mora povući CIJELU datoteku prije nego
 * uopće može skočiti na sekundu — a poanta ovog ekrana je skok na točan
 * trenutak. Uz Range skok je trenutačan i vuče se samo ono što se sluša.
 *
 * ⛔ Putanja se NIKAD ne gradi iz onoga što stigne u zahtjevu. `part` je broj,
 * a datoteka se čita iz manifesta (`raw_file`) pa se provjerava da je doista
 * unutar direktorija sjednice — inače bi `?part=` bio put do bilo koje datoteke
 * na disku.
 */
const MEDIA_MIME = { ".m4a": "audio/mp4", ".mp4": "video/mp4", ".m4v": "video/mp4",
                     ".webm": "video/webm", ".mkv": "video/x-matroska", ".wav": "audio/wav",
                     ".mp3": "audio/mpeg", ".opus": "audio/ogg" };

const VIDEO_EXTS = [".mp4", ".m4v", ".webm", ".mkv"];

/**
 * Slika se traži po DOGOVORU O IMENU (`video/part_NN.*`), ne iz manifesta.
 *
 * `sabor_pipeline/tools/fetch_video.js` namjerno ne dira `session_manifest.json`
 * — manifest je vremenska os sjednice iz koje se računa svaki deep link, i ne
 * prepisuje se zbog pomoćnog artefakta koji ne mijenja nijedno trajanje. Zato
 * slika mora biti pronađiva bez njega: preuzmeš je danas, pregled je vidi
 * odmah, bez ponovnog ingesta.
 *
 * `p.video_file` se i dalje poštuje ako ga sjednica ima — starije sjednice ga
 * smiju imati, a izričit zapis pobjeđuje nad dogovorom.
 */
function mediaFileFor(session, part) {
    const S = loadSession(session);
    if (!S.manifest) throw new Error("sjednica nema session_manifest.json");
    const p = (S.manifest.parts || []).find((x) => x.part === Number(part));
    if (!p) throw new Error(`manifest nema dio ${part}`);
    const dir = path.resolve(sessionDir(session));
    const stem = `part_${String(Number(part)).padStart(2, "0")}`;
    const kandidati = [
        p.video_file,
        ...VIDEO_EXTS.map((e) => path.join("video", stem + e)),
        p.raw_file,
        p.wav_file,
    ].filter(Boolean);

    for (const rel of kandidati) {
        const abs = path.resolve(dir, rel);
        if (!abs.startsWith(dir + path.sep)) continue;   // izlaz iz direktorija sjednice
        if (!fs.existsSync(abs)) continue;
        const st = fs.statSync(abs);
        return {
            abs, rel, ext: path.extname(abs).toLowerCase(), size: st.size,
            // Otisak ulazi u URL (`&v=`) i u ETag. `/api/media?part=1` je stalna
            // adresa, a sadržaj joj se mijenja kad se dio dopuni slikom — bez
            // otiska preglednik uz `max-age=3600` sat vremena servira stari
            // zvuk iz keša i `<video>` ostane prazan, BEZ ijednog zahtjeva na
            // poslužitelj. Izmjereno upravo tako.
            ver: `${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}`,
        };
    }
    return null;
}

function serveMedia(req, res, session, part) {
    const f = mediaFileFor(session, part);
    if (!f) { res.writeHead(404); res.end("nema lokalne snimke za taj dio"); return; }
    const size = fs.statSync(f.abs).size;
    const type = MEDIA_MIME[f.ext] || "application/octet-stream";
    const range = req.headers.range;

    // Snimka se ne mijenja, a ovaj ekran skače po njoj naprijed-natrag — bez
    // keširanja svaki skok znova vuče iste bajtove. (`no-store` drugdje u ovoj
    // aplikaciji postoji zbog JSON-a koji se mijenja pri svakoj odluci.)
    const CACHE = "private, max-age=3600";
    // ETag je druga ograda uz `&v=` u URL-u: keš koji je zapamćen prije nego
    // što je dio dobio sliku mora otpasti i ako se do te adrese dođe bez `v`.
    const ETAG = `"${f.ver}"`;

    if (!range) {
        res.writeHead(200, {
            "Content-Type": type, "Content-Length": size,
            "Accept-Ranges": "bytes", "Cache-Control": CACHE, ETag: ETAG,
        });
        return pipeAndCleanUp(fs.createReadStream(f.abs), res);
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
    // `bytes=-N` znači ZADNJIH N bajtova; MP4 s moov atomom na kraju traži baš
    // to prije nego išta reproducira, pa taj oblik mora raditi.
    let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === "" ? size - 1 : (m[2] === "" ? size - 1 : Number(m[2]));
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));

    // Otvoreni raspon (`bytes=0-`) se OGRANIČAVA na komad. Preglednik ga smije
    // dobiti manjeg nego što je tražio i sam nastavlja tražiti dalje; bez toga
    // jedan zahtjev drži 350 MB otvorenih i reprodukcija ne krene dok se ne
    // napuni. Sufiksni oblik (`bytes=-N`, moov atom na kraju) se ne dira.
    const CHUNK = 4 * 1024 * 1024;
    if (m[1] !== "" && m[2] === "" && end - start + 1 > CHUNK) {
        end = start + CHUNK - 1;
    }

    res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes", "Cache-Control": CACHE, ETag: ETAG,
    });
    pipeAndCleanUp(fs.createReadStream(f.abs, { start, end }), res);
}

/**
 * Čitanje se GASI čim veza padne. Preglednik napusti učitavanje snimke svaki
 * put kad se skoči na drugi dio, a bez ovoga tok ostane visjeti na
 * protupritisku: utičnica se drži zauzetom, Chrome je pokušava ponovno
 * upotrijebiti za idući zahtjev i novi `<video>` više ne krene — bez ijednog
 * zahtjeva koji bi se vidio u logu. Uz zvuk se to nije primjećivalo; dio
 * snimke je 1.5 GB i tok traje dovoljno dugo da se zaglavi.
 */
function pipeAndCleanUp(stream, res) {
    const gasi = () => stream.destroy();
    res.on("close", gasi);
    res.on("error", gasi);
    stream.on("error", () => { gasi(); res.destroy(); });
    stream.pipe(res);
}

// ============================================================================
// HTTP
// ============================================================================

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
}

function serveStatic(res, filePath) {
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(filePath).pipe(res);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let b = "";
        req.on("data", (c) => {
            b += c;
            if (b.length > 1e6) { req.destroy(); reject(new Error("tijelo zahtjeva preveliko")); }
        });
        req.on("end", () => {
            try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); }
        });
    });
}

/**
 * Sve sjednice na disku — i one koje se JOŠ NE MOGU pregledavati.
 *
 * ⚠️ Prva verzija je tiho odbacivala sve bez `aligned_transcript.json`. Nova
 * sjednica koja je stigla do diarizacije, ali ne i do faze 03, jednostavno se
 * ne bi pojavila, pa bi izgledalo kao da je aplikacija ne vidi. Sada se vidi,
 * uz razlog i naredbu koja je gura dalje.
 *
 * Symlink se mora izričito propustiti (`isDirectory()` je za njega `false`) —
 * kanali u ovom repou stoje na drugim diskovima.
 */
function listSessions() {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    return fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name)
        .sort()
        .map((n) => {
            const dir = path.join(OUTPUT_DIR, n);
            const alignedP = path.join(dir, "aligned_transcript.json");
            if (!fs.existsSync(alignedP)) {
                const ima = (f) => fs.existsSync(path.join(dir, f));
                const razlog = !ima("session_manifest.json")
                    ? { faza: "01", poruka: "nema session_manifest.json — sjednica nije preuzeta" }
                    : !ima("diarization.json")
                    ? { faza: "02", poruka: "nema diarization.json — diarizacija nije gotova" }
                    : { faza: "03", poruka: "diarizacija postoji, faza 03 još nije pokrenuta" };
                return {
                    session_id: n, spremna: false, ...razlog,
                    naredba: `sabor_pipeline/run_sabor_session.sh --session ${n}`,
                };
            }
            const a = readJson(alignedP);
            const ovrP = path.join(dir, humanOverrides.FILENAME);
            const ovr = fs.existsSync(ovrP) ? Object.keys(readJson(ovrP).overrides || {}).length : 0;
            return {
                session_id: n, spremna: true,
                blocks: a.total_blocks,
                speakers: a.total_speakers,
                named_pct: a.stats ? a.stats.named_speech_pct : null,
                odluka: ovr,
            };
        });
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const q = u.searchParams;
    try {
        if (u.pathname === "/" || u.pathname === "/index.html") {
            return serveStatic(res, path.join(__dirname, "index.html"));
        }
        if (u.pathname === "/api/sessions") return sendJson(res, 200, { sessions: listSessions(), reviewer: whoami() });
        if (u.pathname === "/api/queue") return sendJson(res, 200, buildQueue(q.get("session")));
        if (u.pathname === "/api/speaker") return sendJson(res, 200, speakerDetail(q.get("session"), q.get("id")));
        if (u.pathname === "/api/diff") return sendJson(res, 200, computeDiff(q.get("session")));
        if (u.pathname === "/api/roster") {
            const s = norm(q.get("q") || "");
            const mps = roster(q.get("session")).raw.mps
                .filter((m) => !s || norm(m.puno_ime).includes(s) || norm(m.stranka || "").includes(s))
                .slice(0, 40);
            return sendJson(res, 200, { mps });
        }
        if (u.pathname === "/api/audit") {
            const session = q.get("session");
            const outP = path.join(sessionDir(session), "human_review", "audit_overrides.json");
            fs.mkdirSync(path.dirname(outP), { recursive: true });
            let text = "";
            try {
                text = execFileSync("node", [
                    path.join(PIPE, "tools", "audit_overrides.js"),
                    "--session", session, "--output-dir", OUTPUT_DIR, "--json", outP,
                ], { encoding: "utf8" });
            } catch (err) {
                // Izlazni kod 1 znači „ima nalaza", ne grešku.
                text = (err.stdout || "").toString();
                if (err.status !== 1 && !text) throw err;
            }
            const nalazi = fs.existsSync(outP) ? readJson(outP).nalazi : [];
            return sendJson(res, 200, { text, nalazi });
        }
        if (u.pathname === "/api/job") return sendJson(res, 200, jobStatus(q.get("id")));
        if (u.pathname === "/api/media") {
            return serveMedia(req, res, q.get("session"), q.get("part"));
        }
        // Isti sadržaj, ali BEZ query stringa: neki preglednici i proširenja ne
        // puštaju medijske podzahtjeve s upitnikom, a `<audio>`/`<video>` tada
        // ostanu u NETWORK_LOADING bez ijednog bajta i bez greške.
        const mm = /^\/media\/([^/]+)\/(\d+)(?:\.[a-z0-9]+)?$/i.exec(u.pathname);
        if (mm) {
            return serveMedia(req, res, decodeURIComponent(mm[1]), mm[2]);
        }

        // Sličica-dokaz uz prijedlog s ekrana. Prijedlog bez slike koju čovjek
        // može pogledati je tvrdnja, ne dokaz — zato se dokazne sličice čuvaju
        // na disku i poslužuju ovdje.
        const om = /^\/ocr_frame\/([^/]+)\/([A-Za-z0-9_.-]+\.jpg)$/.exec(u.pathname);
        if (om) {
            const session = decodeURIComponent(om[1]);
            // `om[2]` je već ograničen na jednu razinu bez „/", ali putanja se
            // ipak razrješava i provjerava da leži unutar direktorija sjednice.
            const p = path.resolve(sessionDir(session), "ocr_captions", "frames", om[2]);
            const korijen = path.resolve(sessionDir(session), "ocr_captions", "frames");
            if (!p.startsWith(korijen + path.sep) || !fs.existsSync(p)) {
                res.writeHead(404); return res.end("nema sličice");
            }
            res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
            return fs.createReadStream(p).pipe(res);
        }

        if (req.method === "POST" && u.pathname === "/api/decision") {
            return sendJson(res, 200, applyDecision(await readBody(req)));
        }
        if (req.method === "POST" && u.pathname === "/api/batch_confirm") {
            const b = await readBody(req);
            return sendJson(res, 200, batchConfirm(b.session, b.speaker_ids || [], b.odlucio));
        }
        if (req.method === "POST" && u.pathname === "/api/rerun") {
            const b = await readBody(req);
            return sendJson(res, 200, startRerun(b.session, b.steps || ["03"], b.backend));
        }
        res.writeHead(404); res.end("not found");
    } catch (e) {
        sendJson(res, 500, { error: e.message, stack: e.stack });
    }
});

function norm(s) {
    return String(s).replace(/[đĐ]/g, "d").normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

server.listen(PORT, () => {
    console.log(`\n  Pregled saborskih govornika:  http://localhost:${PORT}\n`);
    console.log(`  Sjednice:   ${OUTPUT_DIR}`);
    console.log(`  Registar:   po sjednici (roster.path iz aligned_transcript.json)`);
    console.log(`  Pregledava: ${whoami()}   (promjena: SABOR_REVIEWER=…)\n`);
    console.log(`  Odluke se pišu u ${humanOverrides.FILENAME}; transkript piše ISKLJUČIVO faza 03.\n`);
});
