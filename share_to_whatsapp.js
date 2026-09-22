#!/usr/bin/env node
/**
 * share_to_whatsapp.js — pošalji epizodu i sva njezina poglavlja u WhatsApp grupu.
 *
 * Svako poglavlje ide kao ZASEBNA poruka s golim linkom `https://domovina.ai/v/{id}/t/{sek}`,
 * jer WhatsApp resolva og: tagove samo za link koji stoji sam. Preview (naslov,
 * opis, slika `og-t-{sek}.jpg`) lijepi most, ne ova skripta — vidi
 * `docs/whatsapp_share_epizode.md` i zakrpu u `~/git/mcps/whatsapp-mcp`.
 *
 * Tri stvari koje ovu skriptu čine determinističkom:
 *
 *   1. Poglavlja se čitaju s CDN-a (`cdn.domovina.ai/data/{id}/article.json`), ne s diska.
 *      Disk i CDN znaju driftati, a link mora voditi na timestamp koji stvarno postoji
 *      na stranici koju će primatelj otvoriti. `--source disk` postoji za epizodu koja
 *      još nije uploadana.
 *   2. Grupa se razrješava preko `/api/groups` mosta, ne preko `messages.db`. Svježa
 *      grupa u kojoj još ništa nije poslano u `messages.db` NE postoji.
 *   3. Već poslani linkovi se preskaču (provjera u `messages.db`). Ponovno pokretanje
 *      dopunjava ono što je prošli put palo, umjesto da šalje duplikate — a most
 *      nema brisanje poruka, pa je duplikat trajan.
 *
 * Bez `--commit` skripta ništa ne šalje, samo ispiše plan.
 *
 * Primjeri:
 *   node share_to_whatsapp.js --list-groups domovina
 *   node share_to_whatsapp.js --video-id aue1GuuMsbA --group "DOMOVINA.ai#001"
 *   node share_to_whatsapp.js --video-id aue1GuuMsbA --group "DOMOVINA.ai#001" --commit
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const DEFAULT_BRIDGE = process.env.WA_BRIDGE_URL || "http://127.0.0.1:8080";
const DEFAULT_SITE_BASE = process.env.SHARE_SITE_BASE || "https://domovina.ai";
const DEFAULT_CDN_BASE = process.env.SHARE_CDN_BASE || "https://cdn.domovina.ai";
const DEFAULT_INPUT_DIR = process.env.SHARE_INPUT_DIR || "storage/output";
const DEFAULT_STORE_DB =
    process.env.WA_STORE_DB ||
    path.join(os.homedir(), ".local/share/whatsapp-mcp/store/messages.db");
const DEFAULT_DELAY_SEC = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Čiste funkcije (testirane u share_to_whatsapp.test.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "HH:MM:SS" / "MM:SS" / "H:MM:SS.mmm" → sekunde.
 * Pipeline ima oba formata i obje decimalne oznake, pa se normalizira ovdje.
 */
function timestampToSeconds(ts) {
    if (typeof ts === "number" && Number.isFinite(ts)) return Math.floor(ts);
    if (typeof ts !== "string") return null;

    const clean = ts.trim().replace(",", ".");
    if (!/^\d{1,2}(:\d{1,2}){1,2}(\.\d+)?$/.test(clean)) return null;

    const parts = clean.split(":").map(Number);
    while (parts.length < 3) parts.unshift(0);
    const [h, m, s] = parts;
    if (m >= 60 || s >= 60) return null;
    return Math.floor(h * 3600 + m * 60 + s);
}

/** Sekunde → "M:SS" / "H:MM:SS", isti format koji stoji u og: naslovu. */
function secondsToLabel(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * article.json → [{ sec, title }], sortirano i bez duplikata.
 *
 * Duplikat sekunde je stvaran slučaj (dvije sekcije s istim screenshot
 * timestampom); dva ista linka u grupi izgledaju kao greška, pa prolazi prvi.
 */
function extractChapters(article) {
    if (!article || !Array.isArray(article.iterations)) {
        throw new Error("article.json nema 'iterations' — kriva datoteka?");
    }

    const seen = new Set();
    const chapters = [];

    for (const iteration of article.iterations) {
        for (const section of iteration.sections || []) {
            const sec = timestampToSeconds(section.screenshot_timestamp);
            if (sec === null || seen.has(sec)) continue;
            seen.add(sec);
            chapters.push({ sec, title: (section.subtitle || "").trim() });
        }
    }

    chapters.sort((a, b) => a.sec - b.sec);
    return chapters;
}

/**
 * Popis poruka koje treba poslati. Prva je gola epizoda (bez `/t/`), pa poglavlja.
 * Svaka poruka je SAMO URL — bilo kakav dodatni tekst gasi WhatsApp preview.
 */
function buildMessages({ videoId, chapters, siteBase = DEFAULT_SITE_BASE, includeIntro = true }) {
    const base = `${siteBase.replace(/\/+$/, "")}/v/${videoId}`;
    const messages = [];

    if (includeIntro) {
        messages.push({ sec: null, url: base, label: "epizoda", title: "" });
    }
    for (const ch of chapters) {
        messages.push({
            sec: ch.sec,
            url: `${base}/t/${ch.sec}`,
            label: secondsToLabel(ch.sec),
            title: ch.title,
        });
    }
    return messages;
}

/**
 * Od svih `..._{datum}_{model}.article.json` za epizodu bira leksikografski
 * najveći — isti ključ po kojem dedupa ostatak pipelinea, pa `opus` > `gemini-*`
 * > `agy`. Koristi se samo za `--source disk`.
 */
function pickLatestArticle(filenames) {
    const articles = filenames.filter((f) => f.endsWith(".article.json"));
    if (articles.length === 0) return null;
    return articles.sort()[articles.length - 1];
}

/**
 * Razriješi grupu iz odgovora `/api/groups`. Prvo točan JID, pa točno ime,
 * pa podniz imena. Višeznačnost je GREŠKA, nikad "uzmi prvu" — kriva grupa
 * znači 47 poruka nepoznatim ljudima, a most nema brisanje.
 */
function resolveGroup(groups, query) {
    const q = String(query || "").trim();
    if (!q) throw new Error("--group je obavezan");

    const byJid = groups.filter((g) => g.jid === q);
    if (byJid.length === 1) return byJid[0];

    const exact = groups.filter((g) => g.name.toLowerCase() === q.toLowerCase());
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw ambiguous(q, exact);

    const partial = groups.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw ambiguous(q, partial);

    throw new Error(`Nijedna grupa ne odgovara "${q}". Popis: node share_to_whatsapp.js --list-groups`);
}

function ambiguous(query, matches) {
    const lines = matches.map((g) => `  ${g.jid}  ${g.name}`).join("\n");
    return new Error(
        `"${query}" odgovara na ${matches.length} grupa — suzi upit ili navedi JID:\n${lines}`
    );
}

/** Poruke kojih još nema u chatu. Usporedba je po točnom URL-u. */
function filterUnsent(messages, alreadySent) {
    const sent = new Set(alreadySent);
    return messages.filter((m) => !sent.has(m.url));
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

function getArg(args, name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(args, name) {
    return args.includes(name);
}

async function fetchJson(url, { timeoutMs = 30000 } = {}) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
}

async function loadArticleFromCdn(videoId, cdnBase) {
    const url = `${cdnBase.replace(/\/+$/, "")}/data/${videoId}/article.json`;
    try {
        return await fetchJson(url);
    } catch (err) {
        throw new Error(
            `Članak nije na CDN-u (${url}): ${err.message}\n` +
                `Ako epizoda još nije uploadana, probaj --source disk — ali tada linkovi ` +
                `mogu voditi na timestamp koji na stranici još ne postoji.`
        );
    }
}

function loadArticleFromDisk(videoId, inputDir) {
    const root = path.resolve(inputDir);
    if (!fs.existsSync(root)) throw new Error(`Nema direktorija ${root}`);

    // storage/output/ su symlinkovi po kanalu — isDirectory() je za njih false.
    const channels = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => path.join(root, e.name));

    for (const channelDir of channels) {
        let entries;
        try {
            entries = fs.readdirSync(channelDir);
        } catch {
            continue; // nemontiran disk ili prazan symlink — ne ruši cijeli sken
        }
        const mine = entries.filter((f) => f.includes(`_yt_${videoId}`));
        const picked = pickLatestArticle(mine);
        if (picked) {
            const full = path.join(channelDir, picked);
            console.log(`   izvor: ${full}`);
            return JSON.parse(fs.readFileSync(full, "utf8"));
        }
    }
    throw new Error(`Nema .article.json za ${videoId} pod ${root}`);
}

async function listGroups(bridgeUrl, query) {
    const url = `${bridgeUrl.replace(/\/+$/, "")}/api/groups${
        query ? `?query=${encodeURIComponent(query)}` : ""
    }`;
    let data;
    try {
        data = await fetchJson(url, { timeoutMs: 45000 });
    } catch (err) {
        throw new Error(
            `Most ne odgovara na ${url}: ${err.message}\n` +
                `Provjeri: launchctl print gui/$(id -u)/ai.domovina.whatsapp-bridge | grep state`
        );
    }
    if (!data.success) throw new Error(`/api/groups: ${data.message}`);
    return data.groups || [];
}

/**
 * URL-ovi koji su već u tom chatu. Čita se baza mosta izravno, samo za čitanje.
 * Ako baze nema, vraća prazno — skripta tada radi, ali bez zaštite od duplikata.
 */
function alreadySentUrls(chatJid, dbPath) {
    if (!fs.existsSync(dbPath)) {
        console.warn(`⚠️  Nema ${dbPath} — ne mogu provjeriti duplikate.`);
        return [];
    }
    try {
        const out = execFileSync(
            "sqlite3",
            [dbPath, `select content from messages where chat_jid = '${chatJid.replace(/'/g, "''")}';`],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
        );
        return out.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch (err) {
        console.warn(`⚠️  Čitanje ${dbPath} nije uspjelo (${err.message}) — bez zaštite od duplikata.`);
        return [];
    }
}

async function sendMessage(bridgeUrl, recipient, message) {
    const res = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient, message }),
        signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.success === true, message: data.message || `HTTP ${res.status}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
    console.log(`
share_to_whatsapp.js — epizoda + sva poglavlja u WhatsApp grupu, jedna poruka po poglavlju

  --video-id <ID>       YouTube ID epizode (obavezno, osim uz --list-groups)
  --group <JID|ime>     grupa: točan JID, točno ime ili jednoznačan podniz imena
  --commit              stvarno pošalji (bez toga je suho pokretanje)
  --list-groups [upit]  ispiši grupe s JID-om i zajednicom, pa izađi

  --source cdn|disk     odakle poglavlja (default cdn — ono što primatelj vidi)
  --delay <sek>         pauza između poruka (default ${DEFAULT_DELAY_SEC})
  --limit <n>           pošalji najviše n poruka
  --no-intro            bez uvodnog linka na epizodu
  --force               šalji i ono što je već poslano (stvara duplikate)

  --input-dir <dir>     korijen za --source disk (default ${DEFAULT_INPUT_DIR})
  --bridge <url>        most (default ${DEFAULT_BRIDGE})
  --site-base <url>     baza linkova (default ${DEFAULT_SITE_BASE})
`);
}

async function main() {
    const args = process.argv.slice(2);

    if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
        usage();
        process.exit(0);
    }

    const bridgeUrl = getArg(args, "--bridge") || DEFAULT_BRIDGE;

    if (hasFlag(args, "--list-groups")) {
        const idx = args.indexOf("--list-groups");
        const next = args[idx + 1];
        const query = next && !next.startsWith("--") ? next : null;

        const groups = await listGroups(bridgeUrl, query);
        console.log(`\n${groups.length} grupa${query ? ` za upit "${query}"` : ""}:\n`);
        for (const g of groups) {
            const tags = [
                g.is_community ? "ZAJEDNICA" : null,
                g.community_name || g.community_jid
                    ? `u zajednici: ${g.community_name || g.community_jid}`
                    : null,
                g.is_default_subgroup ? "default subgroup" : null,
                g.is_announce ? "samo admini pišu" : null,
            ].filter(Boolean);
            console.log(`  ${g.jid}`);
            console.log(`    ${g.name}  (${g.participant_count} članova)${tags.length ? `  [${tags.join(", ")}]` : ""}`);
        }
        console.log("");
        return;
    }

    const videoId = getArg(args, "--video-id");
    const groupQuery = getArg(args, "--group");
    if (!videoId || !groupQuery) {
        console.error("❌ Trebaju i --video-id i --group (ili --list-groups).");
        usage();
        process.exit(1);
    }

    const commit = hasFlag(args, "--commit");
    const force = hasFlag(args, "--force");
    const includeIntro = !hasFlag(args, "--no-intro");
    const source = getArg(args, "--source") || "cdn";
    const delayMs = Math.max(0, Number(getArg(args, "--delay") ?? DEFAULT_DELAY_SEC)) * 1000;
    const limit = getArg(args, "--limit") ? Number(getArg(args, "--limit")) : null;
    const siteBase = getArg(args, "--site-base") || DEFAULT_SITE_BASE;
    const inputDir = getArg(args, "--input-dir") || DEFAULT_INPUT_DIR;

    if (!["cdn", "disk"].includes(source)) {
        console.error(`❌ --source mora biti cdn ili disk, dobiveno "${source}"`);
        process.exit(1);
    }

    console.log(`\n📖 Epizoda ${videoId} (izvor: ${source})`);
    const article =
        source === "cdn"
            ? await loadArticleFromCdn(videoId, DEFAULT_CDN_BASE)
            : loadArticleFromDisk(videoId, inputDir);

    const chapters = extractChapters(article);
    if (chapters.length === 0) throw new Error("Članak nema nijedno poglavlje s timestampom.");
    console.log(`   ${chapters.length} poglavlja, model: ${article.metadata?.model || "nepoznat"}`);

    console.log(`\n🔍 Tražim grupu "${groupQuery}"…`);
    const group = resolveGroup(await listGroups(bridgeUrl, null), groupQuery);
    const community = group.community_name || group.community_jid;
    console.log(`   ${group.name}  ${group.jid}`);
    console.log(
        `   ${group.participant_count} članova${community ? `, zajednica: ${community}` : ""}` +
            `${group.is_announce ? ", SAMO ADMINI PIŠU" : ""}`
    );

    let messages = buildMessages({ videoId, chapters, siteBase, includeIntro });
    const total = messages.length;

    if (!force) {
        const sent = alreadySentUrls(group.jid, DEFAULT_STORE_DB);
        messages = filterUnsent(messages, sent);
        const skipped = total - messages.length;
        if (skipped > 0) console.log(`\n⏭️  ${skipped} već poslano prije, preskačem (--force gazi).`);
    }

    if (limit !== null && messages.length > limit) {
        messages = messages.slice(0, limit);
        console.log(`✂️  --limit ${limit}`);
    }

    if (messages.length === 0) {
        console.log("\n✅ Nema što slati — sve je već u grupi.\n");
        return;
    }

    console.log(`\n📤 Za slanje: ${messages.length} poruka (od ${total}), pauza ${delayMs / 1000}s`);
    console.log(`   Trajanje: ~${Math.ceil((messages.length * delayMs) / 60000)} min\n`);

    if (!commit) {
        for (const m of messages.slice(0, 5)) {
            console.log(`   ${m.label.padStart(8)}  ${m.url}  ${m.title.slice(0, 50)}`);
        }
        if (messages.length > 5) console.log(`   … i još ${messages.length - 5}`);
        console.log(`\n🔸 SUHO POKRETANJE — ništa nije poslano. Dodaj --commit.\n`);
        return;
    }

    let ok = 0;
    let failed = 0;
    for (const [i, m] of messages.entries()) {
        const n = `${i + 1}/${messages.length}`;
        try {
            const res = await sendMessage(bridgeUrl, group.jid, m.url);
            if (res.ok) {
                ok++;
                console.log(`   ${n} ✅ ${m.url}`);
            } else {
                failed++;
                console.log(`   ${n} ❌ ${m.url} — ${res.message}`);
            }
        } catch (err) {
            failed++;
            console.log(`   ${n} ❌ ${m.url} — ${err.message}`);
        }
        if (i < messages.length - 1) await sleep(delayMs);
    }

    console.log(`\n${failed === 0 ? "✅" : "⚠️"}  Poslano ${ok}, neuspjelih ${failed}, od ${messages.length}.`);
    if (failed > 0) console.log("   Ponovno pokretanje šalje samo ono što je palo.\n");
    else console.log("");

    process.exit(failed > 0 ? 1 : 0);
}

module.exports = {
    timestampToSeconds,
    secondsToLabel,
    extractChapters,
    buildMessages,
    pickLatestArticle,
    resolveGroup,
    filterUnsent,
};

if (require.main === module) {
    main().catch((err) => {
        console.error(`\n❌ ${err.message}\n`);
        process.exit(1);
    });
}
