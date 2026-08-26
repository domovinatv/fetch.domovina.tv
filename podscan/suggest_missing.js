#!/usr/bin/env node
/**
 * KORAK 3 — pošalji Podscanu ono što ON nema, a mi imamo.
 *
 * ⚠️ ISPRAVAK ČESTE ZABUNE: Firehose NIJE kanal za slanje. Firehose je webhook
 * koji Podscan gura NAMA (push, njihov server → naš URL). Jedini ulazni put u
 * njihovu bazu je `POST /podcasts/suggest`, i on prima **RSS feed URL** —
 * ne YouTube link, ne ime kanala. Feed mora biti valjan i dohvatljiv.
 *
 * Posljedica za naš registar: kanal koji postoji SAMO na YouTubeu nije moguće
 * predložiti. To nije ograničenje ove skripte nego definicija njihovog indeksa.
 * Zato skripta radi nad popisom feedova (--feeds datoteka ili --url), a ne
 * nad registrom naslijepo.
 *
 *   node podscan/suggest_missing.js --url https://primjer.hr/feed/podcast
 *   node podscan/suggest_missing.js --feeds feeds.txt          # jedan URL po retku
 *   node podscan/suggest_missing.js --feeds feeds.txt --commit # bez ovoga je dry-run
 *
 * Default je DRY-RUN — prijedlog je vanjska, javna radnja i ne izvodi se slučajno.
 */

const fs = require("fs");
const path = require("path");
const { call, budgetStatus, REPO_ROOT } = require("./podscan_client");

const LOG_FILE = path.join(REPO_ROOT, "data", "podscan_cache", "suggested_feeds.jsonl");

function getArg(name, def = null) {
    const i = process.argv.indexOf(name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const COMMIT = process.argv.includes("--commit");

function alreadySuggested() {
    const seen = new Set();
    if (!fs.existsSync(LOG_FILE)) return seen;
    for (const line of fs.readFileSync(LOG_FILE, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { seen.add(JSON.parse(line).url); } catch (_) { /* preskoči pokvaren redak */ }
    }
    return seen;
}

async function main() {
    const single = getArg("--url");
    const feedsFile = getArg("--feeds");
    let urls = [];
    if (single) urls = [single];
    else if (feedsFile) {
        urls = fs.readFileSync(feedsFile, "utf8").split("\n")
            .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    } else {
        console.error("Koristi --url <rss> ili --feeds <datoteka>. Bez --commit je dry-run.");
        process.exit(1);
    }

    const seen = alreadySuggested();
    const todo = urls.filter((u) => !seen.has(u));
    console.log(`Feedova: ${urls.length} | već predloženo ranije: ${urls.length - todo.length} | za slanje: ${todo.length}`);
    console.log(`Kvota danas: ${JSON.stringify(budgetStatus())}`);
    if (!COMMIT) {
        console.log("\n🔍 DRY-RUN — ništa se ne šalje. Dodaj --commit.\n");
        for (const u of todo) console.log("   POST /podcasts/suggest  ←", u);
        return;
    }

    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    let ok = 0, fail = 0;
    for (const url of todo) {
        try {
            const res = await call("/podcasts/suggest", { method: "POST", body: { url } });
            console.log(`   ✅ ${url} → ${JSON.stringify(res.data).slice(0, 160)}`);
            fs.appendFileSync(LOG_FILE, JSON.stringify({ url, at: new Date().toISOString(), response: res.data }) + "\n");
            ok++;
        } catch (e) {
            if (e.code === "BUDGET_EXHAUSTED") { console.log(`\n⏹  ${e.message}`); break; }
            console.warn(`   ❌ ${url} → ${e.message.slice(0, 200)}`);
            fail++;
        }
    }
    console.log(`\nPoslano: ${ok} | neuspjelo: ${fail} | kvota: ${JSON.stringify(budgetStatus())}`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
