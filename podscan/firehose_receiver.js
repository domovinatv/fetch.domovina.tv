#!/usr/bin/env node
/**
 * Podscan Firehose — PRIJEMNIK (ne pošiljatelj).
 *
 * Firehose je push-webhook: kad neki podcast objavi epizodu, Podscan POST-a
 * JSON na URL koji upišeš u Team Settings → Firehose. Ne postoji endpoint na
 * koji bismo MI slali podatke; jedini ulazni put je `POST /podcasts/suggest`
 * (vidi suggest_missing.js).
 *
 * Ova skripta je minimalan prijemnik za lokalno testiranje i za rad iza
 * tunela (cloudflared / ngrok / Tailscale funnel). Radi tri stvari:
 *   1. Raspakira gzip tijelo (Podscan po defaultu šalje `Content-Encoding: gzip`).
 *   2. Filtrira na ono što nas zanima (default: language/region `hr`).
 *   3. Dopisuje jedan redak po epizodi u JSONL — bez baze, bez ovisnosti.
 *
 * Transkripti u payloadu znaju biti golemi, pa se po defaultu NE spremaju
 * (`--with-transcript` ih uključuje). Bez toga JSONL ostaje čitljiv i malen.
 *
 *   node podscan/firehose_receiver.js --port 8790
 *   node podscan/firehose_receiver.js --port 8790 --all --with-transcript
 *
 * Zatim u Podscan Team Settings upiši javni URL tunela + /firehose.
 */

const http = require("http");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

function getArg(name, def = null) {
    const i = process.argv.indexOf(name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const PORT = parseInt(getArg("--port", "8790"), 10);
const ALL = process.argv.includes("--all");
const WITH_TRANSCRIPT = process.argv.includes("--with-transcript");
const OUT = getArg("--out", path.join(REPO_ROOT, "data", "podscan_firehose.jsonl"));
const LANGS = (getArg("--languages", "hr")).split(",").map((s) => s.trim().toLowerCase());

// Zajednička tajna: Podscan ne dokumentira potpis, pa ako je postavljen
// PODSCAN_FIREHOSE_KEY, tražimo ga u query stringu (?key=…) ili Authorization
// headeru. Bolje uska vrata nego otvoren endpoint na javnom tunelu.
function loadEnv() {
    const p = path.join(REPO_ROOT, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}
loadEnv();
const SECRET = process.env.PODSCAN_FIREHOSE_KEY || null;

let received = 0, kept = 0;

function matchesFilter(payload) {
    if (ALL) return true;
    const p = payload.podcast || payload;
    const lang = String(p.language || payload.podcast_language || "").toLowerCase();
    const region = String(p.region || payload.podcast_region || "").toLowerCase();
    return LANGS.includes(lang) || LANGS.includes(region);
}

const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`Podscan firehose receiver — primljeno ${received}, spremljeno ${kept}\n`);
        return;
    }
    if (SECRET) {
        const url = new URL(req.url, "http://localhost");
        const given = url.searchParams.get("key") || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (given !== SECRET) {
            res.writeHead(401).end("unauthorized");
            console.warn(`   ⚠️  odbijen POST bez ispravnog ključa (${req.socket.remoteAddress})`);
            return;
        }
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        // Podscan očekuje 2xx brzo; obrada ne smije držati njihov retry.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');

        let buf = Buffer.concat(chunks);
        try {
            if ((req.headers["content-encoding"] || "").includes("gzip")) buf = zlib.gunzipSync(buf);
        } catch (e) {
            console.warn("   ⚠️  gunzip pao:", e.message);
        }
        let payload;
        try {
            payload = JSON.parse(buf.toString("utf8"));
        } catch (e) {
            console.warn("   ⚠️  neispravan JSON:", e.message);
            return;
        }
        received++;
        if (!matchesFilter(payload)) return;

        if (!WITH_TRANSCRIPT) {
            delete payload.episode_transcript;
            if (payload.episode) delete payload.episode.episode_transcript;
        }
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.appendFileSync(OUT, JSON.stringify({ received_at: new Date().toISOString(), payload }) + "\n");
        kept++;
        const name = (payload.podcast && payload.podcast.podcast_name) || payload.podcast_name || "?";
        const ep = (payload.episode && payload.episode.episode_title) || payload.episode_title || "?";
        console.log(`   📥 ${name} — ${String(ep).slice(0, 70)}  (${kept}/${received})`);
    });
});

server.listen(PORT, () => {
    console.log(`Podscan firehose receiver sluša na :${PORT}`);
    console.log(`   filtar    : ${ALL ? "SVE" : "language/region ∈ " + LANGS.join(",")}`);
    console.log(`   transkript: ${WITH_TRANSCRIPT ? "spremam" : "izbacujem (--with-transcript da uključiš)"}`);
    console.log(`   izlaz     : ${OUT}`);
    console.log(`   ključ     : ${SECRET ? "tražim ?key= ili Bearer" : "NIJE postavljen (endpoint otvoren!)"}`);
    console.log(`\n   Podscan Team Settings → Firehose → webhook URL = <javni-tunel>/?key=<PODSCAN_FIREHOSE_KEY>`);
});
