#!/usr/bin/env node
/**
 * Dohvat službenog registra zastupnika Hrvatskoga sabora (11. saziv).
 *
 * IZVOR (jedini dopušten): javni JSON API koji pogoni interaktivni raspored
 * zastupnika na https://www.sabor.hr/interaktivni-raspored-zastupnika-u-hrvatskome-saboru/
 *
 *     https://www.sabor.hr/api/interaktivna-sabornica-new?_format=json
 *
 * ⛔ Imena, stranke i klubovi se NIKAD ne generiraju iz modela. Faza 03 radi
 *    fuzzy matching nad ovim popisom; izmišljeno ime bi tiho zalijepilo krivi
 *    identitet na govornika kroz svih 20 h sjednice.
 *
 * Logika normalizacije imena (uključujući `slug` fallback) preuzeta je iz
 * provjerene skripte `../izbori.domovina.ai/scripts/fetch_sabor_seating.py`.
 *
 * Izlaz: sabor_pipeline/data/rosters/sabor_mps_11_saziv.json
 *
 * Uporaba:
 *   node sabor_pipeline/tools/fetch_sabor_roster.js
 *   node sabor_pipeline/tools/fetch_sabor_roster.js --out <putanja> --dry-run
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://www.sabor.hr/api/interaktivna-sabornica-new?_format=json";
const SAZIV = 11;
// Sabor ima 151 zastupničko mjesto; raspored prikazuje samo POPUNJENA mjesta.
// Razlika nije greška (mandat u mirovanju, zamjena u tijeku) — samo se bilježi.
const SEATS_EXPECTED = 151;

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const DRY_RUN = args.includes("--dry-run");
const OUT_PATH = getArg("--out") ||
    path.join(__dirname, "..", "data", "rosters", "sabor_mps_11_saziv.json");

/** Hrvatski-svjesna normalizacija: Đ→D, skini dijakritike (NFD), VELIKA slova. */
function normalizeToken(s) {
    if (!s) return "";
    return s
        .replace(/Đ/g, "D").replace(/đ/g, "d")
        .normalize("NFD").replace(/\p{Mn}/gu, "")
        .toUpperCase().trim().replace(/^-+|-+$/g, "");
}

/** Razbij na razmake i crtice, normaliziraj, zadrži tokene ≥3 znaka. */
function nameTokens(...parts) {
    const out = [];
    for (const p of parts) {
        for (const piece of String(p || "").split(/[\s\-]+/)) {
            const n = normalizeToken(piece);
            if (n.length >= 3) out.push(n);
        }
    }
    return out;
}

/**
 * Tokeni iz slugova profila — fallback kad je API-jevo polje `ime` skraćeno.
 * Format: /hr/zastupnici/<prezime-rijeci-ime-rijeci>-<saziv>-saziv[-N]
 * npr. 'ban-vlahek-boska-11-saziv' za Boška Ban Vlahek, koja u polju `ime`
 * stoji pogrešno kao 'Ban, Boška'.
 */
function slugTokens(profileUrl) {
    if (!profileUrl) return [];
    let slug = profileUrl.replace(/\/+$/, "").split("/").pop();
    slug = slug.replace(/-\d+-saziv(?:-\d+)?$/, "");
    return slug.split("-").map(normalizeToken).filter((t) => t.length >= 3);
}

async function main() {
    process.stderr.write(`Dohvaćam ${API_URL} …\n`);
    const res = await fetch(API_URL, {
        headers: {
            "User-Agent": "domovina-sabor-pipeline/0.1 (+https://domovina.ai)",
            Accept: "application/json",
        },
        signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
        console.error(`GREŠKA: HTTP ${res.status} sa ${API_URL}`);
        process.exit(1);
    }
    const data = await res.json();

    const seats = data.sjedeca_mjesta || [];
    const clubsRaw = data.klubovi_zastupnika || {};

    const mps = [];
    const skipped = [];
    for (const seatObj of seats) {
        const z = seatObj.zastupnik || {};
        const ime = String(z.ime || "").trim();
        if (!ime.includes(",")) { skipped.push({ seat: seatObj.seat, razlog: "ime bez zareza", ime }); continue; }
        // API formatira ime kao "Prezime, Ime" — uključujući višerječna prezimena
        // ("Hajdaš Dončić, Siniša", "Selak Raspudić, Marija").
        const commaAt = ime.indexOf(",");
        const prezime = ime.slice(0, commaAt).trim();
        const imeOsobno = ime.slice(commaAt + 1).trim();
        if (!prezime || !imeOsobno) { skipped.push({ seat: seatObj.seat, razlog: "prazan dio imena", ime }); continue; }

        const profile = String(z.profile || "").trim();
        const tokens = Array.from(
            new Set([...nameTokens(prezime, imeOsobno), ...slugTokens(profile)])
        ).sort();
        if (tokens.length < 2) { skipped.push({ seat: seatObj.seat, razlog: "<2 tokena", ime }); continue; }

        mps.push({
            id: String(z.id || ""),          // stabilan Drupal ID sa sabor.hr
            ime: imeOsobno,
            prezime,
            puno_ime: `${imeOsobno} ${prezime}`,
            klub: String(z.klub || "").trim(),
            stranka: String(z.stranka || "").trim(),
            manjine: Boolean(z.manjine),
            seat: String(seatObj.seat || ""),
            profile,
            img: String(z.img || "").trim(),
            // `spol` i `duznost` NISU u izvoru → ostaju null. Ne pogađati.
            spol: null,
            duznost: null,
            tokens,
        });
    }

    if (mps.length === 0) {
        console.error("GREŠKA: nijedan zastupnik nije isparsiran — je li se payload promijenio?");
        process.exit(1);
    }

    // Provjera jedinstvenosti prezimena — faza 03 sidri po prezimenu kad
    // predsjedavajući kaže samo "kolega Matić". Dvosmislena prezimena moraju
    // biti poznata unaprijed da ih parser ne razriješi nasumično.
    const bySurname = new Map();
    for (const m of mps) {
        const key = normalizeToken(m.prezime).replace(/\s+/g, " ");
        if (!bySurname.has(key)) bySurname.set(key, []);
        bySurname.get(key).push(m.puno_ime);
    }
    const ambiguousSurnames = [...bySurname.entries()]
        .filter(([, v]) => v.length > 1)
        .map(([k, v]) => ({ prezime: k, nositelji: v.sort() }))
        .sort((a, b) => a.prezime.localeCompare(b.prezime));

    const clubs = Object.values(clubsRaw).map((c) => ({
        id: String(c.id ?? ""),
        naziv: String(c.name || ""),
        broj_clanova: Number(c.number) || 0,
        boja: String(c.color || ""),
    })).sort((a, b) => b.broj_clanova - a.broj_clanova);

    const payload = {
        saziv: SAZIV,
        source_url: API_URL,
        source_page: "https://www.sabor.hr/interaktivni-raspored-zastupnika-u-hrvatskome-saboru/",
        fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        counts: {
            seats_in_payload: seats.length,
            mps_parsed: mps.length,
            seats_expected: SEATS_EXPECTED,
            // Zbroj `number` po klubovima premašuje broj mjesta jer manjinski
            // zastupnici ulaze i u „Zastupnici nacionalnih manjina" i u svoj klub.
            skipped: skipped.length,
        },
        ambiguous_surnames: ambiguousSurnames,
        clubs,
        mps: mps.sort((a, b) => a.prezime.localeCompare(b.prezime, "hr") ||
                                a.ime.localeCompare(b.ime, "hr")),
    };
    if (skipped.length) payload.skipped = skipped;

    process.stderr.write(
        `Zastupnika: ${mps.length} (mjesta u payloadu ${seats.length}, očekivano ${SEATS_EXPECTED}), ` +
        `klubova: ${clubs.length}, dvosmislenih prezimena: ${ambiguousSurnames.length}\n`
    );
    if (ambiguousSurnames.length) {
        for (const a of ambiguousSurnames) {
            process.stderr.write(`  ⚠ ${a.prezime}: ${a.nositelji.join(" | ")}\n`);
        }
    }
    if (mps.length !== SEATS_EXPECTED) {
        process.stderr.write(
            `  ℹ razlika ${SEATS_EXPECTED - mps.length} — raspored prikazuje samo popunjena mjesta\n`
        );
    }

    if (DRY_RUN) {
        process.stderr.write("--dry-run — ništa nije zapisano\n");
        return;
    }
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
    process.stderr.write(`Zapisano: ${OUT_PATH}\n`);
}

main().catch((e) => { console.error("GREŠKA:", e.message); process.exit(1); });
