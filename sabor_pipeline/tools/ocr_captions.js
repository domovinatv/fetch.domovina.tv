#!/usr/bin/env node
"use strict";

/**
 * ocr_captions.js — natpis s ekrana kao NEOVISAN izvor identiteta govornika.
 *
 * Saborska režija ispisuje donju traku s imenom govornika i vrstom istupa.
 * Ta traka ne ovisi o tome je li predsjedavajući ikoga najavio, pa dohvaća
 * upravo onu klasu govornika na kojoj protokolarno sidrenje staje
 * (`docs/sabor_pilot_zakljucak_2026-08.md` §7: 19 od 28 preostalih govornika
 * predsjedavajući nikad ne imenuje).
 *
 * ⛔ OVAJ ALAT NE PIŠE TRANSKRIPT. Proizvodi PRIJEDLOGE. Ime ulazi u proizvod
 *    isključivo kroz `human_overrides.json`, preko aplikacije za pregled, a
 *    `aligned_transcript.json` i dalje piše samo faza 03. Time run ostaje
 *    ponovljiv — `docs/sabor_human_in_the_loop_2026-08.md` §1.
 *
 * ═══════════════════ ŠTO JE IZMJERENO PRIJE NEGO JE OVO NAPISANO ═══════════
 *
 * 1. **Natpis se pojavljuje i BEZ najave** — to je bilo pitanje koje je moglo
 *    srušiti cijelu zamisao. Pokus na 20 oznaka koje protokol ne imenuje:
 *    19 ih je dobilo ime s ekrana, među njima SPEAKER_012 (27 min govora,
 *    Milorad Pupovac) i replike koje predsjedavajući ne najavljuje poimence.
 *
 * 2. **480p je dovoljno, 360p nije.** Ista 23 trenutka, čitanje uspoređeno s
 *    1080p: 360p 14/23 identično (gubi dijakritiku — „Markovic", „stromar"),
 *    480p **22/23**, 720p 22/23. 720p ne donosi ništa, pa je 480p (`-f 135`)
 *    default. RosterMatcher doduše proguta i 360p greške, ali bez potrebe.
 *
 * 3. **Mrežni seek pobjeđuje preuzimanje.** Mjereno na ovoj sjednici:
 *      seek (ffmpeg -ss prije -i, conc 16) → 269 ms/sličica  → ~11 min za 2400
 *      preuzimanje 480p avc1 (4.4 GiB @ 5.4 MiB/s) → ~14 min + 4.4 GB diska
 *    Vrijeme je izjednačeno, ali seek ne traži 4.4 GB na disku koji je na 95 %,
 *    i prekinut posao se nastavlja po sličici umjesto ispočetka.
 *    Sam OCR je zanemariv: **55 ms/sličica** (Vision, Neural Engine, offline).
 *
 * 4. **Vision nema `hr-HR`.** Podržani popis nema hrvatski. Mjereno je da to
 *    ne smeta: uz `usesLanguageCorrection=false` en-US čita „Siniša Hajdaš
 *    Dončić" i „Urša Raukar Gamulin" s dijakritikom i pouzdanošću 1.00, a
 *    cs-CZ/pl-PL daju ISTI tekst uz nižu pouzdanost. Zato en-US.
 *
 * ═══════════════════ DVIJE ZAMKE KOJE TIHO PROIZVODE KRIVO IME ═════════════
 *
 * a) **Transparenti u dvorani padnu u traku natpisa.** Zastupnici su držali
 *    plakate „ODGOVORNOST ZAKOPANA"; Vision ih čita, i jedan je pao točno u
 *    koordinate imena. Zato natpis nije „prvi redak odozdo" nego geometrija
 *    (`POLJE_IME`) + tri strukturna uvjeta (vidi `procitajNatpis`).
 *
 * b) **Traka zna nositi SAMO vrstu istupa, bez imena** („Odgovor na repliku").
 *    Tada vrsta klizne u pojas gdje inače stoji ime. Prijedlog s takvim
 *    „imenom" bio bi čista izmišljotina, pa se rječnik vrsta izričito odbija.
 *
 * ═══════════════════ ZAJEDNIČKI TERMIN NIJE JEDNA OSOBA ════════════════════
 *
 * Natpis „Vučković-Hrstić-Habijan" ili „Hajdaš Dončić-Zmajlović" je oznaka
 * TERMINA koji dijeli više govornika, ne ime osobe. Pripisati ga jednoj oznaci
 * značilo bi zalijepiti krivi identitet. Razlikuje se mjerenjem, ne osjećajem:
 * dijelovi se razriješe pojedinačno i ako ih dvoje ili više padne na RAZLIČITE
 * zastupnike, to je zajednički termin. Provjereno da ne lovi prava dvostruka
 * prezimena: „Mrak-Taritaš" → oba dijela daju istu osobu, dakle nije termin.
 *
 * ═══════════════════ NEOVISNA PROVJERA ═════════════════════════════════════
 *
 * `--validate` pušta isti postupak na oznake koje je protokol već imenovao i
 * mjeri slaganje. Bez toga bi OCR bio još jedan determinizam koji je „siguran"
 * 1.0 i kad pogodi i kad promaši (`docs/sabor_human_in_the_loop_2026-08.md` §7).
 *
 * Uporaba:
 *   node sabor_pipeline/tools/ocr_captions.js --session sabor_11_izvanredna_11_gospic
 *   node sabor_pipeline/tools/ocr_captions.js --session <id> --validate
 *   node sabor_pipeline/tools/ocr_captions.js --session <id> --only SPEAKER_012,SPEAKER_035
 */

const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const { RosterMatcher, normalizeToken } = require("../utils/roster_match.js");

// ─── Geometrija natpisa ────────────────────────────────────────────────────
// Vision vraća normalizirane koordinate s ishodištem DOLJE-LIJEVO (y raste
// prema gore). Izmjereno na 1080p i potvrđeno na 480p — traka je nepomična:
//   ime    x≈0.080  y≈0.103–0.114
//   vrsta  x≈0.080  y≈0.064–0.069
//   štoperica x≈0.865 y≈0.046–0.049
const POLJE_IME    = (b) => b[0] > 0.055 && b[0] < 0.105 && b[1] > 0.085 && b[1] < 0.175;
const POLJE_VRSTA  = (b) => b[0] > 0.055 && b[0] < 0.105 && b[1] > 0.045 && b[1] < 0.085;
const POLJE_SAT    = (b) => b[0] > 0.830 && b[0] < 0.915 && b[1] > 0.020 && b[1] < 0.095;

/**
 * Rječnik vrsta istupa. Služi DVAPUT: kao potvrda da je traka doista na
 * ekranu, i kao filtar protiv vrste koja je kliznula u pojas imena.
 */
const VRSTE = [
    /^replika/i, /^odgovor na repliku/i, /^pojedina[čc]na rasprava/i,
    /^izno[šs]enje stajali[šs]ta/i, /^u ime vlade/i, /^klub zastupnika/i,
    /^obrazlaganje/i, /^povreda poslovnika/i, /^stanka/i, /^zavr[šs]n/i,
    /^predlagatelj/i, /^izvjestitelj/i, /^amandman/i, /^glasovanje/i,
    /^u ime predlagatelja/i, /^replika na/i,
];
const jeVrsta = (s) => !!s && VRSTE.some((re) => re.test(s.trim()));

/** Prag podudaranja s registrom — isti koji već koristi aplikacija za pregled. */
const PRAG_REGISTAR = 0.86;

/**
 * ═══ OGRADA PROTIV IZMIŠLJENOG IMENA ═══
 *
 * Oznaka koja skuplja kratke upadice („SPEAKER_015": 121 blok, 15 min) rijetko
 * dobije VLASTITI natpis — a natpis koji u tom trenutku JEST na ekranu pripada
 * osobi koja drži riječ. Slaba pokrivenost zato nije samo tanak dokaz nego
 * dokaz o KRIVOJ osobi. Bez ograde bi `SPEAKER_015` dobio ime iz jednog jedinog
 * očitanja od tri, a preostala dva imenuju dvoje drugih ljudi.
 *
 * Pragovi nisu pogođeni nego očitani s provjerenog skupa. Među 68 oznaka koje
 * je protokol imenovao i za koje se OCR složio 100 %:
 *
 *     najniža pokrivenost natpisa      0.29
 *     najniži udio vodećeg kandidata   0.57   (18 od 68 ima i manjinske glasove)
 *
 * Prag je namjerno ISPOD tih podova, pa dokazano ne odbacuje ni jednu oznaku
 * koja je neovisno potvrđena kao točna, a odbacuje `SPEAKER_015` (0.13 / 0.33)
 * i `SPEAKER_037` (0.13). Kad se ograda oglasi, ispravan izlaz je „nedovoljno
 * dokaza", ne ime — ne zna se tko je to, i to je točan odgovor.
 */
const MIN_POKRIVENOST = 0.25;
const MIN_UDIO_VODECEG = 0.50;

/**
 * Mehaničko čišćenje OCR artefakata — NE pogađanje imena.
 *
 * Dopuštene su samo dvije preinake, obje bez ijedne pretpostavke o tome tko je
 * osoba: podcrtnica koju je Vision stavio umjesto razmaka, i razmak izgubljen
 * na granici malo→veliko slovo. Izmjereno na provjeri: „Darko_Klasic" i
 * „MariniMandarić" nisu drugi ljudi nego isti ljudi s izgubljenim razmakom,
 * a bez ovoga oba padnu na „nema kandidata".
 *
 * ⛔ Ovdje se NE ispravljaju slova. „Magdalena Klimes" (registar: Komes) ostaje
 *    nerazriješena i to je ispravan ishod — popravljanje slova do najbližeg
 *    zastupnika je upravo onaj tihi promašaj koji prag 0.86 postoji da spriječi.
 */
function ocistiOcrArtefakte(s) {
    return String(s || "")
        .replace(/[_·]+/g, " ")
        .replace(/([a-zšđčćž])([A-ZŠĐČĆŽ])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
}

// ─── CLI (Pattern B) ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def = null) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : def;
}
const hasFlag = (n) => args.includes(n);

const SESSION = getArg("--session");
const OUTPUT_DIR = getArg("--output-dir", "storage/output/sabor");
const FMT = getArg("--fmt", "135");               // 135 = 854x480 avc1 (mjereno: dovoljno)
const SAMPLES = +getArg("--samples", 3);
const BLOCKS_PER_LABEL = +getArg("--blocks-per-label", 8);
const CONCURRENCY = +getArg("--concurrency", 12);
const ONLY = (getArg("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);
const VALIDATE = hasFlag("--validate");
const KEEP_FRAMES = hasFlag("--keep-frames");
const DRY_RUN = hasFlag("--dry-run");
const OCR_BIN = path.join(__dirname, "ocr", "vision_ocr");

if (!SESSION) {
    console.error("Nedostaje --session <id>");
    process.exit(2);
}

const sessionDir = path.join(OUTPUT_DIR, SESSION);
const outDir = path.join(sessionDir, "ocr_captions");
const frameDir = path.join(outDir, "frames");

// ─── Učitavanje ────────────────────────────────────────────────────────────
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));

/**
 * Referenca za „tko je imenovan" je PROTOKOLARNI prolaz, ne konačni transkript.
 * Konačni već nosi ljudske odluke, pa bi mjerenje slaganja s njim bilo
 * mjerenje protiv samog sebe — čovjek je te oznake već imenovao rukom.
 */
function ucitajTranskript() {
    const proto = path.join(sessionDir, "aligned_transcript.protokol.json");
    const konac = path.join(sessionDir, "aligned_transcript.json");
    if (fs.existsSync(proto)) return { t: readJson(proto), izvor: "protokol" };
    if (fs.existsSync(konac)) {
        console.warn("⚠️  Nema aligned_transcript.protokol.json — mjerenje slaganja " +
                     "uspoređivalo bi OCR s ljudskim slojem. Pokreni fazu 03 s --no-human --suffix .protokol.");
        return { t: readJson(konac), izvor: "konacni" };
    }
    throw new Error(`Nema transkripta u ${sessionDir}`);
}

// ─── Odabir trenutaka ──────────────────────────────────────────────────────
function lokalno(manifest, globalSec) {
    for (const p of manifest.parts) {
        if (globalSec >= p.start_global_sec && globalSec < p.end_global_sec) {
            return { part: p.part, video_id: p.video_id, local: globalSec - p.start_global_sec };
        }
    }
    return null;
}

/**
 * Trenutci unutar bloka. Početak bloka NIJE dobra točka: izmjereno je da na
 * +3 s traka često još nije na ekranu (režija je stavi kad se kamera prebaci),
 * dok je sredina i kraj bloka pogađaju pouzdano. Zato uzorci idu po udjelu
 * trajanja, a ne fiksnim odmakom od početka.
 */
function trenutciZaBlok(b, n) {
    const d = b.duration_sec;
    if (d < 6) return [b.start_global_sec + d / 2];
    const udjeli = n === 1 ? [0.5] : Array.from({ length: n }, (_, i) => 0.25 + (0.5 * i) / (n - 1));
    return udjeli.map((u) => {
        const t = b.start_global_sec + d * u;
        return Math.min(b.end_global_sec - 1.5, Math.max(b.start_global_sec + 2, t));
    });
}

// ─── yt-dlp / ffmpeg ───────────────────────────────────────────────────────
function streamUrl(videoId) {
    // Izričit `-f 135` (ili što je zadano), NE „bestvideo". Zamka iz
    // screenshot_youtube.js: lanac koji krene od live-only HLS formata tiho
    // padne na 360p progressive, a na 360p OCR gubi dijakritiku (mjereno).
    const cmd = `yt-dlp -f ${FMT} --get-url --no-check-certificate ` +
                `--cookies-from-browser brave 'https://www.youtube.com/watch?v=${videoId}'`;
    const out = execSync(cmd, { encoding: "utf-8", timeout: 90000, stdio: ["pipe", "pipe", "pipe"] });
    return out.trim().split("\n")[0].trim();
}

function izvuciSlicicu(source, sec, outPath) {
    return new Promise((resolve) => {
        // -ss PRIJE -i = seek bez dekodiranja svega do te točke.
        const p = spawn("ffmpeg", [
            "-nostdin", "-ss", String(sec.toFixed(2)), "-i", source,
            "-frames:v", "1", "-update", "1", "-q:v", "2", "-y", outPath,
        ], { stdio: "ignore" });
        p.on("close", (c) => resolve(c === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000));
        p.on("error", () => resolve(false));
    });
}

async function paralelno(items, worker, conc) {
    let i = 0;
    const radnik = async () => {
        while (i < items.length) {
            const k = i++;
            await worker(items[k], k);
        }
    };
    await Promise.all(Array.from({ length: Math.min(conc, items.length) }, radnik));
}

// ─── Čitanje natpisa ───────────────────────────────────────────────────────
/**
 * Iz jednog OCR zapisa izvuci natpis. Tri strukturna uvjeta, svaki postoji
 * zbog konkretnog promašaja viđenog u pokusu:
 *
 *  1. **vrsta mora postojati** u svom pojasu — bez nje traka nije na ekranu,
 *     a ono što je Vision našao u pojasu imena je nešto drugo iz dvorane;
 *  2. **ime ne smije biti VELIKIM SLOVIMA** — natpis je Title Case, a
 *     transparenti („ODGOVORNOST", „ZAKOPANA") su verzal; ovaj uvjet je uhvatio
 *     jedini transparent koji je pao točno u koordinate imena;
 *  3. **ime ne smije biti iz rječnika vrsta** — kad govornik nema ime na traci,
 *     vrsta klizne gore u pojas imena („Odgovor na repliku").
 */
function procitajNatpis(lines) {
    const uPolju = (f) => lines.filter((l) => f(l.box)).sort((a, b) => b.box[1] - a.box[1]);
    const vrste = uPolju(POLJE_VRSTA).map((l) => l.text.trim()).filter(Boolean);
    const vrsta = vrste.find(jeVrsta) || vrste[0] || null;
    const sat = uPolju(POLJE_SAT).map((l) => l.text.trim()).find((t) => /^\d{1,2}:\d{2}$/.test(t)) || null;

    if (!vrsta) return { ime: null, vrsta: null, sat, odbijeno: "nema vrste istupa u traci" };

    for (const kand of uPolju(POLJE_IME)) {
        const t = kand.text.trim().replace(/[-_·.,]+$/, "").trim();
        if (!t) continue;
        if (t === t.toUpperCase() && /[A-ZŠĐČĆŽ]{3,}/.test(t)) continue;  // transparent
        if (jeVrsta(t)) continue;                                          // vrsta u pojasu imena
        if (!/^[A-ZŠĐČĆŽ]/.test(t)) continue;
        return { ime: t, vrsta, sat, conf: kand.conf, odbijeno: null };
    }
    return { ime: null, vrsta, sat, odbijeno: "traka bez imena (samo vrsta istupa)" };
}

// ─── Razrješavanje u registar ──────────────────────────────────────────────
/**
 * Zajednički termin: natpis koji imenuje VIŠE govornika jednog termina.
 * Mjerljiva razlika prema pravom dvostrukom prezimenu: razriješi dijelove
 * odvojeno i broji RAZLIČITE zastupnike. „Mrak-Taritaš" → oba dijela ista
 * osoba (nije termin); „Hajdaš Dončić-Zmajlović" → Hajdaš Dončić i Zmajlović,
 * dvoje ljudi (jest termin).
 */
function jeZajednickiTermin(ime, matcher) {
    const dijelovi = ime.split(/\s*[-–]\s*/).map((s) => s.trim()).filter((s) => s.length >= 3);
    if (dijelovi.length < 2) return null;
    const ids = new Set();
    for (const d of dijelovi) {
        const h = matcher.resolve(d);
        if (h.mp && h.score >= PRAG_REGISTAR) ids.add(h.mp.id);
    }
    // 1) dijelovi padaju na DVOJE ILI VIŠE zastupnika → termin
    if (ids.size >= 2) return { dijelovi, razlicitih: ids.size, po: "registar" };
    // 2) dijelovi padaju na JEDNU osobu → pravo dvostruko prezime („Mrak-Taritaš")
    if (ids.size === 1) return null;
    // 3) nitko od dijelova nije u registru. To su ministri — Vlada nije u
    //    registru zastupnika, pa ih pravilo (1) ne može vidjeti i
    //    „Vučković-Hrstić-Habijan" bi prošao kao ime osobe. Razlikovni znak je
    //    da termin nabraja SAMA PREZIMENA: nijedan dio nema osobno ime uza se.
    //    Pravo dvostruko prezime na traci uvijek dolazi s osobnim imenom
    //    („Anka Mrak Taritaš"), pa ovo pravilo na njega ne može opaliti.
    if (dijelovi.every((d) => d.split(/\s+/).length === 1)) {
        return { dijelovi, razlicitih: dijelovi.length, po: "sama prezimena" };
    }
    return null;
}

function razrijesi(imeSirovo, vrsta, matcher) {
    const ime = ocistiOcrArtefakte(imeSirovo);
    // Članovi Vlade NISU u registru (registar sa sabor.hr je raspored sjedenja
    // zastupnika). Natpis „U ime Vlade RH" to kaže izravno — nema smisla tražiti
    // ih u registru ni tumačiti neuspjeh podudaranja kao lošu OCR.
    const vlada = /^u ime vlade/i.test(vrsta || "");
    const termin = jeZajednickiTermin(ime, matcher);
    if (termin) {
        return { mp: null, score: 0, status: "zajednicki_termin",
                 razlog: `natpis imenuje ${termin.razlicitih} osobe (${termin.dijelovi.join(" + ")}) — termin, ne osoba` };
    }
    const h = matcher.resolve(ime);
    if (h.mp && h.score >= PRAG_REGISTAR) {
        return { mp: h.mp, score: h.score, status: "u_registru", razlog: h.reason };
    }
    if (vlada) {
        return { mp: null, score: h.score, status: "izvan_registra_vlada",
                 razlog: "natpis „U ime Vlade RH\" — članovi Vlade nisu u registru zastupnika" };
    }
    return { mp: null, score: h.score, status: "nerazrijeseno", razlog: h.reason };
}

/**
 * Odluka je li dokaz s ekrana dovoljan da se ime UOPĆE predloži.
 * Vraća `status` koji aplikacija za pregled prikazuje doslovno — „nedovoljno
 * dokaza" je pun i točan odgovor, a ne izostanak odgovora.
 */
function odluciPrijedlog(vodeci, pokrivenost, udio, nijeIme = []) {
    if (!vodeci) {
        // Nijedno očitanje ne imenuje osobu. Razlog nije uvijek isti, a razlika
        // je za pregled bitna: „ekran nijem" znači da trake nema, dok
        // „zajednički termin" znači da je traka BILA tu i izričito rekla da
        // riječ dijeli više govornika.
        const termin = nijeIme.find((k) => k.status === "zajednicki_termin");
        if (termin) {
            return { status: "zajednicki_termin", mp_id: null, puno_ime: null, razlog: termin.razlog };
        }
        const nerazrijeseno = nijeIme.find((k) => k.status === "nerazrijeseno");
        if (nerazrijeseno) {
            return { status: "nerazrijeseno", mp_id: null, puno_ime: null,
                     razlog: `natpis pročitan („${nerazrijeseno.ocitanja.join(" / ")}") ali se ne da razriješiti u registar — ` +
                             "ime se NE pogađa na najbližeg zastupnika" };
        }
        return { status: "nijem", mp_id: null, puno_ime: null,
                 razlog: "ni na jednoj sličici nema natpisa s imenom" };
    }
    if (pokrivenost < MIN_POKRIVENOST) {
        return { status: "nedovoljno_dokaza", mp_id: null, puno_ime: null,
                 razlog: `natpis samo na ${(pokrivenost * 100).toFixed(0)} % sličica (prag ${MIN_POKRIVENOST * 100} %) — ` +
                         "oznaka vjerojatno skuplja upadice, pa natpis pripada onome tko drži riječ" };
    }
    if (udio < MIN_UDIO_VODECEG) {
        return { status: "nedovoljno_dokaza", mp_id: null, puno_ime: null,
                 razlog: `vodeći kandidat nosi tek ${(udio * 100).toFixed(0)} % očitanja (prag ${MIN_UDIO_VODECEG * 100} %) — ` +
                         "natpisi na istoj oznaci imenuju različite ljude" };
    }
    return {
        status: vodeci.status === "u_registru" ? "predlozi" : "predlozi_izvan_registra",
        mp_id: vodeci.mp_id, puno_ime: vodeci.puno_ime,
        udio: +udio.toFixed(3), pokrivenost: +pokrivenost.toFixed(3),
        razlog: vodeci.razlog,
    };
}

// ─── Glavni tok ────────────────────────────────────────────────────────────
async function main() {
    const { t: transkript, izvor: izvorImena } = ucitajTranskript();
    const manifest = readJson(path.join(sessionDir, "session_manifest.json"));
    // Registar KOJI JE SJEDNICA STVARNO KORISTILA — faza 03 ga zapisuje u
    // `roster.path`. Pretpostaviti 11. saziv značilo bi da se sjednica drugog
    // saziva razrješava krivim popisom, i to bez ijedne poruke (isti razlog
    // zbog kojeg `sabor_review/server.js` čita to isto polje).
    const rosterPath = transkript.roster && transkript.roster.path
        ? path.resolve(__dirname, "..", "..", transkript.roster.path)
        : path.join(__dirname, "..", "data", "rosters", "sabor_mps_11_saziv.json");
    const roster = readJson(rosterPath);
    const matcher = new RosterMatcher(roster);

    // ── koje oznake gledamo ──
    const poOznaci = new Map();
    for (const b of transkript.blocks) {
        if (!poOznaci.has(b.speaker_id)) {
            poOznaci.set(b.speaker_id, { speaker_id: b.speaker_id, ime_protokol: null, blocks: [], sec: 0 });
        }
        const e = poOznaci.get(b.speaker_id);
        e.blocks.push(b);
        e.sec += b.duration_sec;
        if (b.speaker_name) e.ime_protokol = b.speaker_name;
    }

    let oznake = [...poOznaci.values()];
    if (ONLY.length) oznake = oznake.filter((o) => ONLY.includes(o.speaker_id));
    else if (VALIDATE) oznake = oznake.filter((o) => o.ime_protokol);   // provjera na već imenovanima
    oznake.sort((a, b) => b.sec - a.sec);

    // ── trenutci ──
    const zadaci = [];
    for (const o of oznake) {
        const blokovi = [...o.blocks].sort((a, b) => b.duration_sec - a.duration_sec).slice(0, BLOCKS_PER_LABEL);
        for (const b of blokovi) {
            for (const [i, gsec] of trenutciZaBlok(b, SAMPLES).entries()) {
                const l = lokalno(manifest, gsec);
                if (!l) continue;
                zadaci.push({
                    speaker_id: o.speaker_id, block_id: b.block_id,
                    global_sec: +gsec.toFixed(2), local_sec: +l.local.toFixed(2),
                    part: l.part, video_id: l.video_id,
                    file: path.join(frameDir, `${o.speaker_id}_b${b.block_id}_${i}.jpg`),
                });
            }
        }
    }

    const videji = [...new Set(zadaci.map((z) => z.video_id))];
    console.log(`📺 Sjednica ${SESSION}`);
    console.log(`   oznaka: ${oznake.length}${VALIDATE ? " (provjera na protokolarno imenovanima)" : ""}` +
                `, sličica: ${zadaci.length}, videa: ${videji.length}, format: ${FMT}`);
    if (DRY_RUN) {
        console.log("   (--dry-run — ništa se ne dohvaća)");
        return;
    }

    fs.mkdirSync(frameDir, { recursive: true });

    // ── stream URL-ovi (traju ~6 h, mjereno — dosta za cijeli prolaz) ──
    const urls = {};
    for (const v of videji) {
        process.stdout.write(`   🔗 stream URL ${v} … `);
        try { urls[v] = streamUrl(v); console.log("ok"); }
        catch (err) {
            console.log("PAO");
            console.error(`   ⛔ yt-dlp ne daje stream za ${v}. Ako je anti-bot, preuzmi dio ` +
                          `(yt-dlp -f ${FMT}) i pokreni ponovno — ffmpeg jednako radi s lokalnom datotekom.`);
            process.exit(1);
        }
    }

    // ── sličice ──
    const t0 = Date.now();
    let ok = 0, pao = 0, presk = 0;
    await paralelno(zadaci, async (z) => {
        if (fs.existsSync(z.file) && fs.statSync(z.file).size > 1000) { presk++; ok++; return; }
        const uspjeh = await izvuciSlicicu(urls[z.video_id], z.local_sec, z.file);
        uspjeh ? ok++ : pao++;
        const n = ok + pao;
        if (n % 100 === 0) {
            const s = (Date.now() - t0) / 1000;
            console.log(`   🎞️  ${n}/${zadaci.length} — ${(s / n * 1000).toFixed(0)} ms/sličica, ETA ${((zadaci.length - n) * s / n / 60).toFixed(1)} min`);
        }
    }, CONCURRENCY);
    console.log(`   🎞️  sličice: ${ok} ok (${presk} već postojalo), ${pao} palo, ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    // ── OCR ──
    const postoje = zadaci.filter((z) => fs.existsSync(z.file));
    const t1 = Date.now();
    const ocrOut = path.join(outDir, "ocr.jsonl");
    await new Promise((res, rej) => {
        const p = spawn(OCR_BIN, ["--languages", "en-US", "-"], { stdio: ["pipe", "pipe", "inherit"] });
        const ws = fs.createWriteStream(ocrOut);
        p.stdout.pipe(ws);
        p.on("close", (c) => (c === 0 ? res() : rej(new Error(`vision_ocr exit ${c}`))));
        p.on("error", rej);
        p.stdin.end(postoje.map((z) => z.file).join("\n") + "\n");
    });
    console.log(`   🔎 OCR: ${postoje.length} sličica za ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    // ── čitanje natpisa ──
    const poFajlu = new Map(postoje.map((z) => [z.file, z]));
    const citanja = [];
    for (const line of fs.readFileSync(ocrOut, "utf-8").trim().split("\n")) {
        if (!line) continue;
        const r = JSON.parse(line);
        const z = poFajlu.get(r.path);
        if (!z) continue;
        const n = procitajNatpis(r.lines);
        citanja.push({ ...z, ...n, file: path.relative(sessionDir, z.file) });
    }

    // ── glasovanje po oznaci ──
    const prijedlozi = [];
    for (const o of oznake) {
        const moja = citanja.filter((c) => c.speaker_id === o.speaker_id);
        const sImenom = moja.filter((c) => c.ime);
        const glasovi = new Map();
        for (const c of sImenom) {
            const rz = razrijesi(c.ime, c.vrsta, matcher);
            // Ime izvan registra (članovi Vlade) nema `mp_id`, pa se glasovi
            // grupiraju po tekstu — ali po NORMALIZIRANOM tekstu. Sirovi ključ
            // je „Marija Vučković" i „Marija Vuckovic" držao kao dvije osobe i
            // time prepolovio glasove ministrice s najviše govornog vremena.
            const kljuc = rz.mp ? `mp:${rz.mp.id}` : `txt:${normalizeToken(ocistiOcrArtefakte(c.ime))}`;
            if (!glasovi.has(kljuc)) {
                glasovi.set(kljuc, {
                    kljuc, mp_id: rz.mp ? rz.mp.id : null,
                    puno_ime: rz.mp ? rz.mp.puno_ime : c.ime,
                    stranka: rz.mp ? rz.mp.stranka : null,
                    klub: rz.mp ? rz.mp.klub : null,
                    status: rz.status, razlog: rz.razlog, match_score: rz.score,
                    glasova: 0, ocitanja: [], dokazi: [],
                });
            }
            const g = glasovi.get(kljuc);
            g.glasova++;
            if (!g.ocitanja.includes(c.ime)) g.ocitanja.push(c.ime);
            if (g.dokazi.length < 4) {
                g.dokazi.push({ block_id: c.block_id, at_global_sec: c.global_sec, vrsta: c.vrsta,
                                sat: c.sat, slicica: c.file });
            }
        }
        const svi = [...glasovi.values()].sort((a, b) => b.glasova - a.glasova);
        // Glasa se SAMO među očitanjima koja nekoga IMENUJU. Niz koji se ne da
        // razriješiti („Martina Vlašić lljkić") ne imenuje nikoga, pa ne može
        // ni nadglasati ime — prije ovoga je upravo takav šum preglasao točno
        // očitanje i oznaka je ostala bez prijedloga. Zajednički termin je
        // izričita TVRDNJA da to nije jedna osoba, pa također nije kandidat.
        const rang = svi.filter((k) => k.status === "u_registru" || k.status === "izvan_registra_vlada");
        const nijeIme = svi.filter((k) => !rang.includes(k));
        const ukupnoGlasova = rang.reduce((a, k) => a + k.glasova, 0);
        const pokrivenost = moja.length ? sImenom.length / moja.length : 0;
        const vodeci = rang[0] || null;
        const udio = vodeci && ukupnoGlasova ? vodeci.glasova / ukupnoGlasova : 0;
        prijedlozi.push({
            speaker_id: o.speaker_id,
            govorno_vrijeme_sec: Math.round(o.sec),
            blokova: o.blocks.length,
            ime_protokol: o.ime_protokol,
            slicica_ukupno: moja.length,
            slicica_s_natpisom: sImenom.length,
            pokrivenost: +pokrivenost.toFixed(3),
            udio_vodeceg: +udio.toFixed(3),
            kandidati: rang,
            ocitanja_bez_identiteta: nijeIme,
            prijedlog: odluciPrijedlog(vodeci, pokrivenost, udio, nijeIme),
            // „Jednoglasno" znači: SVE sličice s natpisom pokazuju istu osobu.
            // Nesloga nije šum nego signal — ili je oznaka spojila dvoje ljudi,
            // ili je natpis zajednički termin.
            jednoglasno: rang.length === 1 && sImenom.length > 0,
        });
    }

    fs.mkdirSync(outDir, { recursive: true });
    const meta = {
        session_id: SESSION, generated_at: new Date().toISOString(),
        format: FMT, samples_per_block: SAMPLES, blocks_per_label: BLOCKS_PER_LABEL,
        izvor_imena_reference: izvorImena,
        napomena: "PRIJEDLOZI, ne transkript. Ime ulazi u proizvod samo kroz human_overrides.json.",
    };
    // ⚠️ `--validate` gleda SAMO protokolarno imenovane oznake, pa mu izlaz nije
    // skup prijedloga nego mjerenje. Kad su oba pisala u `prijedlozi.json`,
    // provjera je tiho zamijenila 117 oznaka s 68 i aplikacija za pregled je
    // ostala bez prijedloga za upravo one bezimene zbog kojih alat postoji.
    const osnovica = VALIDATE ? "provjera" : "prijedlozi";
    fs.writeFileSync(path.join(outDir, `citanja${VALIDATE ? ".provjera" : ""}.json`),
        JSON.stringify({ ...meta, citanja }, null, 1));
    fs.writeFileSync(path.join(outDir, `${osnovica}.json`),
        JSON.stringify({ ...meta, nacin: osnovica, prijedlozi }, null, 1));

    // Čisti se SAMO u punom glavnom prolazu. `--validate` i `--only` gledaju
    // podskup oznaka, pa bi im „nedokazna sličica" značila i svaku sličicu svih
    // ostalih oznaka — pospremanje bi pobrisalo dokaze glavnog prolaza.
    if (!KEEP_FRAMES && !VALIDATE && !ONLY.length) {
        // Sličice koje ni jedan prijedlog ne navodi kao dokaz su smeće — 190 MB
        // na disku koji je tijesan. Dokazne se ČUVAJU: prijedlog bez slike koju
        // čovjek može pogledati nije dokaz nego tvrdnja.
        const cuvaj = new Set();
        for (const p of prijedlozi) for (const k of p.kandidati) for (const d of k.dokazi) cuvaj.add(d.slicica);
        let obrisano = 0;
        for (const z of postoje) {
            if (cuvaj.has(path.relative(sessionDir, z.file))) continue;
            try { fs.unlinkSync(z.file); obrisano++; } catch { /* nevažno */ }
        }
        console.log(`   🧹 obrisano ${obrisano} nedokaznih sličica (--keep-frames ih zadržava)`);
    }

    izvjestaj(prijedlozi, matcher);
}

function izvjestaj(prijedlozi, matcher) {
    console.log("");
    if (VALIDATE) {
        // ── neovisna provjera: slaganje s protokolom ──
        //
        // Dvije vrste neslaganja NISU ista stvar i ne smiju stajati u istom
        // retku. „Ekran kaže DRUGU OSOBU" znači da jedan od dva izvora lijepi
        // krivi identitet — to je jedini nalaz koji ruši povjerenje u OCR.
        // „Očitanje se ne da razriješiti" je znakovni šum: prag 0.86 ga je
        // odbio, nikakvo ime nije predloženo, i nitko nije ugrožen.
        // Prva verzija ovog izvještaja ih je zbrojila u „drukčije ime: 3" i
        // time sakrila da je opasna kategorija bila PRAZNA.
        // ⚠️ Mjeri se `p.prijedlog` — TOČNO ona odluka koja ide u aplikaciju za
        // pregled. Provjeravati vlastiti, blaži put (npr. sirovi `kandidati[0]`,
        // bez ograde) značilo bi mjeriti kod koji se nikad ne isporučuje, a
        // upravo je to način da provjera pokaže 100 % za sustav koji griješi.
        let slaze = 0, drugaOsoba = 0;
        const suzdrzano = new Map();
        const sporni = [], sumni = [];
        for (const p of prijedlozi) {
            const pr = p.prijedlog;
            if (pr.status !== "predlozi" && pr.status !== "predlozi_izvan_registra") {
                suzdrzano.set(pr.status, (suzdrzano.get(pr.status) || 0) + 1);
                sumni.push(`   ~ ${p.speaker_id}  protokol „${p.ime_protokol}"  → bez prijedloga: ${pr.razlog}`);
                continue;
            }
            if (normalizeToken(pr.puno_ime) === normalizeToken(p.ime_protokol)) slaze++;
            else {
                drugaOsoba++;
                sporni.push(`   ✗ ${p.speaker_id}  protokol „${p.ime_protokol}"  ekran „${pr.puno_ime}"`);
            }
        }
        const n = prijedlozi.length;
        console.log("═══ NEOVISNA PROVJERA — OCR protiv protokolarnog imenovanja ═══");
        console.log(`   oznaka u provjeri:               ${n}`);
        console.log(`   ✅ isti zastupnik:               ${slaze}  (${(slaze / n * 100).toFixed(1)} %)`);
        console.log(`   ⛔ ekran tvrdi DRUGU OSOBU:      ${drugaOsoba}`);
        for (const [s, c] of suzdrzano) console.log(`   ~  bez prijedloga (${s}):${" ".repeat(Math.max(1, 12 - s.length))}${c}`);
        const mjerodavno = slaze + drugaOsoba;
        if (mjerodavno) {
            console.log(`   → ondje gdje ekran IMENUJE osobu: ${(slaze / mjerodavno * 100).toFixed(1)} % slaganja (${slaze}/${mjerodavno})`);
        }
        // Suzdržanost NIJE besplatna: svaka oznaka koju ograda zaustavi, a
        // protokol je zna, je propuštena prilika. Broji se naglas da se prag ne
        // može tiho stegnuti do „100 % točnosti, nula prijedloga".
        const cijena = suzdrzano.get("nedovoljno_dokaza") || 0;
        if (cijena) console.log(`   ⚠️  ograda je zaustavila ${cijena} oznaku/e koju protokol ZNA — to je cijena praga`);
        sporni.slice(0, 25).forEach((s) => console.log(s));
        sumni.slice(0, 25).forEach((s) => console.log(s));
        if (mjerodavno === 0) {
            console.log("   ⚠️  Ni jedno slaganje ni nesuglasje — provjera ništa ne mjeri. Pogledaj pokrivenost.");
        }
        return;
    }

    const bezImena = prijedlozi.filter((p) => !p.ime_protokol);
    const po = (s) => bezImena.filter((p) => p.prijedlog.status === s);
    const rijeseni = po("predlozi");
    const vlada = po("predlozi_izvan_registra");
    const termini = po("zajednicki_termin");
    const tanko = po("nedovoljno_dokaza");
    const nerazr = po("nerazrijeseno");
    const nijemi = po("nijem");
    const sati = (a) => (a.reduce((x, p) => x + p.govorno_vrijeme_sec, 0) / 3600).toFixed(1);

    console.log("═══ PRIJEDLOZI S EKRANA ═══");
    console.log(`   oznaka bez protokolarnog imena:   ${bezImena.length}  (${sati(bezImena)} h govora)`);
    console.log(`   ✅ predloženo iz registra:         ${rijeseni.length}  (${sati(rijeseni)} h)`);
    console.log(`   🏛️  predloženo izvan registra:     ${vlada.length}  (${sati(vlada)} h — Vlada; traži ručni unos uloge)`);
    console.log(`   ⧉  zajednički termin (≥2 osobe):  ${termini.length}  (NE predlaže se identitet)`);
    console.log(`   ⚠️  nedovoljno dokaza:             ${tanko.length}  (${sati(tanko)} h — ograda je zaustavila prijedlog)`);
    console.log(`   ~  natpis nerazriješen:           ${nerazr.length}  (${sati(nerazr)} h — ime se ne pogađa)`);
    console.log(`   ⌀  ekran nijem:                   ${nijemi.length}  (${sati(nijemi)} h)`);
    console.log("");
    for (const p of [...rijeseni, ...vlada].sort((a, b) => b.govorno_vrijeme_sec - a.govorno_vrijeme_sec)) {
        const k = p.kandidati[0];
        const spor = p.kandidati.length > 1 ? `  ⚠️ +${p.kandidati.length - 1} druk. čitanje` : "";
        const izvan = p.prijedlog.status === "predlozi_izvan_registra" ? " 🏛️" : "";
        console.log(`   ${p.speaker_id.padEnd(14)} ${String(Math.round(p.govorno_vrijeme_sec / 60) + " min").padStart(7)}  → ${k.puno_ime}${izvan}` +
                    ` (${k.stranka || "izvan registra"}, ${k.glasova}/${p.slicica_s_natpisom} glas., pokr. ${(p.pokrivenost * 100).toFixed(0)} %)${spor}`);
    }
    const bezPrijedloga = [...tanko, ...termini, ...nerazr].sort((a, b) => b.govorno_vrijeme_sec - a.govorno_vrijeme_sec);
    if (bezPrijedloga.length) {
        console.log("\n   — oznake bez prijedloga, i zašto —");
        for (const p of bezPrijedloga) {
            console.log(`   ${p.speaker_id.padEnd(14)} ${String(Math.round(p.govorno_vrijeme_sec / 60) + " min").padStart(7)}  ⚠️ ${p.prijedlog.razlog}`);
            const sve = [...p.kandidati, ...(p.ocitanja_bez_identiteta || [])];
            console.log(`   ${"".padEnd(14)} ${"".padStart(7)}    očitanja: ${sve.map((k) => `${k.glasova}× ${k.puno_ime}`).join(", ") || "—"}`);
        }
    }
    console.log("");
    console.log(`   → ${path.join(outDir, "prijedlozi.json")}`);
    console.log("   ⛔ Ovo su PRIJEDLOZI. Ime ulazi u transkript samo preko human_overrides.json (aplikacija :8788).");
}

main().catch((err) => { console.error("⛔", err.message); process.exit(1); });
