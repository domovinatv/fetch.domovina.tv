#!/usr/bin/env node

/**
 * archive_videos.js
 *
 * Prebacuje video ID-ove iz completed[] u archived[] u state datotekama.
 * Arhivirani videi se preskaču u svim pipeline koracima (2-9).
 *
 * Koristi se kad se datoteke fizički premjeste na vanjski disk ili arhivu,
 * da pipeline ne troši vrijeme iteriranjući nad njima.
 *
 * PRINCIP RADA:
 *   - Čita *-lista.txt i pripadajuću *-state.json za dani kanal
 *   - Filtrira video ID-ove prema kriteriju (--before datum, --video-id, ili --all-completed)
 *   - Prebacuje ih iz completed[] u archived[] (atomički zapis)
 *   - Downstream skripte ih automatski preskaču jer filtriraju samo state.completed
 *
 * BITNO: Ovo NE briše datoteke s diska! Samo ažurira state.
 *        Datoteke trebaš ručno premjestiti/obrisati prije ili poslije.
 *
 * Primjeri:
 *   node archive_videos.js --channel domovina_tv --before 20240101
 *   node archive_videos.js --channel domovina_tv --before 20240101 --dry-run
 *   node archive_videos.js --channel domovina_tv --video-id KvIhy5SESYs
 *   node archive_videos.js --channel domovina_tv --all-completed
 *   node archive_videos.js --channel domovina_tv --undo KvIhy5SESYs
 *   node archive_videos.js --list-channels
 *   node archive_videos.js --stats
 */

const fs = require("fs");
const path = require("path");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");

// Učitaj storage.conf za output direktorij
function getOutputDir() {
    const confPath = path.join(__dirname, "storage.conf");
    if (fs.existsSync(confPath)) {
        for (const line of fs.readFileSync(confPath, "utf-8").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            if (key === "DEFAULT") return trimmed.slice(eqIdx + 1).trim();
        }
    }
    return path.join(__dirname, "storage", "output");
}

// ─── UTILITY FUNKCIJE (kopirane iz fetch.js) ─────────────────────

function sanitizeDescription(str) {
    if (!str) return "nepoznat_naslov";
    str = str.toLowerCase();
    const map = {
        'č': 'c', 'ć': 'c', 'ž': 'z', 'š': 's', 'đ': 'd',
        'Č': 'c', 'Ć': 'c', 'Ž': 'z', 'Š': 's', 'Đ': 'd'
    };
    str = str.replace(/[čćžšđČĆŽŠĐ]/g, (char) => map[char] || char);
    str = str.replace(/[^a-z0-9]/g, '_');
    str = str.replace(/_+/g, '_').replace(/^_|_$/g, '');
    return str || "nepoznat_naslov";
}

function extractVideoId(url) {
    url = url.trim();
    if (!url) return null;
    const m = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

function extractDataFromLine(line) {
    line = line.trim();
    if (!line || line.startsWith("#")) return null;
    if (line.includes("|")) {
        const parts = line.split("|");
        const url = parts[parts.length - 1].trim();
        let title = "nepoznat_naslov";
        let date = "NA";
        if (parts.length >= 3) {
            date = parts[0].trim();
            title = parts.slice(1, parts.length - 1).join(" ").trim();
        } else if (parts.length === 2) {
            title = parts[0].trim();
        }
        return { url, title, date };
    }
    return { url: line, title: "nepoznat_naslov", date: "NA" };
}

function loadState(stateFile) {
    if (fs.existsSync(stateFile)) {
        try {
            const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
            if (!Array.isArray(state.completed)) state.completed = [];
            if (!Array.isArray(state.failed)) state.failed = [];
            if (!Array.isArray(state.private)) state.private = [];
            if (!Array.isArray(state.archived)) state.archived = [];
            return state;
        } catch (e) {
            console.error(`❌ Neispravan JSON stanja: ${stateFile}`);
            process.exit(1);
        }
    }
    return { completed: [], failed: [], private: [], archived: [] };
}

function saveState(stateFile, state) {
    const tempFile = stateFile + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
    fs.renameSync(tempFile, stateFile);
}

// ─── CLI ─────────────────────────────────────────────────────────

function getArg(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

// ─── PRONAĐI KANALE ──────────────────────────────────────────────

function discoverChannels() {
    const listFiles = fs.readdirSync(LISTS_DIR)
        .filter(f => f.endsWith("-lista.txt"))
        .map(f => {
            const listPath = path.join(LISTS_DIR, f);
            const statePath = listPath.replace(".txt", "-state.json");
            const rawName = f.replace("-lista.txt", "");
            const channelName = sanitizeDescription(rawName);
            return { listPath, statePath, channelName, rawName };
        });
    return listFiles;
}

/**
 * Parsira listu videa iz lista.txt datoteke.
 * Vraća mapu: videoId → { date, title }
 */
function parseVideoList(listPath) {
    const videoMap = new Map();
    const lines = fs.readFileSync(listPath, "utf-8").split("\n");
    for (const line of lines) {
        const data = extractDataFromLine(line);
        if (!data) continue;
        const videoId = extractVideoId(data.url);
        if (!videoId) continue;
        videoMap.set(videoId, { date: data.date, title: data.title });
    }
    return videoMap;
}

/**
 * Obogaćuje video mapu datumima iz naziva datoteka na disku.
 * Datoteke imaju format: YYYYMMDD_title_yt_VIDEOID.ext
 * Korisno kad lista ima "NA" za datum.
 */
function enrichDatesFromDisk(videoMap, channelName) {
    const outputDir = getArg("--output-dir") || getOutputDir();
    const channelDir = path.join(outputDir, channelName);

    if (!fs.existsSync(channelDir)) return;

    let files;
    try {
        files = fs.readdirSync(channelDir);
    } catch {
        return;
    }

    for (const [videoId, info] of videoMap) {
        if (info.date && info.date !== "NA") continue; // Već ima datum

        // Traži datoteku s _yt_VIDEOID pattern
        const match = files.find(f => f.includes(`_yt_${videoId}`) && !f.startsWith("._"));
        if (match) {
            const dateMatch = match.match(/^(\d{8})_/);
            if (dateMatch) {
                info.date = dateMatch[1];
            }
        }
    }
}

// ─── AKCIJE ──────────────────────────────────────────────────────

function listChannels() {
    const channels = discoverChannels();
    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📋 KANALI                                      ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("");
    console.log("   Kanal                         Completed  Archived  Failed  Private");
    console.log("   ─────────────────────────────────────────────────────────────────");

    let totalCompleted = 0, totalArchived = 0, totalFailed = 0, totalPrivate = 0;

    for (const ch of channels) {
        const state = loadState(ch.statePath);
        const c = state.completed.length;
        const a = state.archived.length;
        const f = state.failed.length;
        const p = state.private.length;
        totalCompleted += c; totalArchived += a; totalFailed += f; totalPrivate += p;

        if (c + a + f + p === 0) continue;

        const name = ch.channelName.padEnd(30);
        console.log(`   ${name} ${String(c).padStart(9)}  ${String(a).padStart(8)}  ${String(f).padStart(6)}  ${String(p).padStart(7)}`);
    }

    console.log("   ─────────────────────────────────────────────────────────────────");
    console.log(`   ${"UKUPNO".padEnd(30)} ${String(totalCompleted).padStart(9)}  ${String(totalArchived).padStart(8)}  ${String(totalFailed).padStart(6)}  ${String(totalPrivate).padStart(7)}`);
    console.log("");
}

function showStats() {
    const channels = discoverChannels();
    let totalCompleted = 0, totalArchived = 0;

    for (const ch of channels) {
        const state = loadState(ch.statePath);
        totalCompleted += state.completed.length;
        totalArchived += state.archived.length;
    }

    console.log("");
    console.log(`   📊 Completed: ${totalCompleted} videa (aktivni u pipelineu)`);
    console.log(`   📦 Archived:  ${totalArchived} videa (preskaču se)`);
    console.log(`   📊 Ukupno:    ${totalCompleted + totalArchived}`);
    console.log("");
}

function archiveVideos(channelFilter, beforeDate, specificVideoId, allCompleted, dryRun) {
    const channels = discoverChannels();
    const channel = channels.find(ch => ch.channelName === channelFilter);

    if (!channel) {
        console.error(`❌ Kanal "${channelFilter}" nije pronađen.`);
        console.error(`   Dostupni kanali:`);
        for (const ch of channels) {
            if (loadState(ch.statePath).completed.length > 0) {
                console.error(`     - ${ch.channelName}`);
            }
        }
        process.exit(1);
    }

    const state = loadState(channel.statePath);
    const videoMap = parseVideoList(channel.listPath);
    enrichDatesFromDisk(videoMap, channelFilter);

    // Odredi koje video ID-ove arhivirati
    let toArchive = [];

    if (specificVideoId) {
        if (!state.completed.includes(specificVideoId)) {
            console.error(`❌ Video "${specificVideoId}" nije u completed[] za kanal ${channelFilter}.`);
            if (state.archived.includes(specificVideoId)) {
                console.error(`   (Već je arhiviran.)`);
            }
            process.exit(1);
        }
        const info = videoMap.get(specificVideoId);
        toArchive.push({ videoId: specificVideoId, date: info?.date || "NA", title: info?.title || "?" });

    } else if (allCompleted) {
        for (const videoId of state.completed) {
            const info = videoMap.get(videoId);
            toArchive.push({ videoId, date: info?.date || "NA", title: info?.title || "?" });
        }

    } else if (beforeDate) {
        // Filtriraj po datumu (YYYYMMDD format)
        const cutoff = parseInt(beforeDate, 10);
        if (isNaN(cutoff) || beforeDate.length !== 8) {
            console.error(`❌ Neispravan format datuma: "${beforeDate}". Koristi YYYYMMDD (npr. 20240101).`);
            process.exit(1);
        }

        for (const videoId of state.completed) {
            const info = videoMap.get(videoId);
            const dateStr = info?.date || "NA";

            if (dateStr === "NA") continue; // Ne arhiviraj videe bez datuma

            const dateNum = parseInt(dateStr, 10);
            if (!isNaN(dateNum) && dateNum < cutoff) {
                toArchive.push({ videoId, date: dateStr, title: info?.title || "?" });
            }
        }
    } else {
        console.error("❌ Navedi kriterij: --before YYYYMMDD, --video-id ID, ili --all-completed");
        process.exit(1);
    }

    if (toArchive.length === 0) {
        console.log(`   ✨ Nema videa za arhiviranje prema zadanom kriteriju.`);
        return;
    }

    // Sortiraj po datumu
    toArchive.sort((a, b) => a.date.localeCompare(b.date));

    console.log("");
    console.log(`   📦 Kanal: ${channelFilter}`);
    console.log(`   📊 Za arhiviranje: ${toArchive.length} videa`);
    console.log(`   📊 Ostaje aktivno: ${state.completed.length - toArchive.length} videa`);
    if (dryRun) console.log("   ⚠️  DRY RUN — samo prikaz, bez promjena");
    console.log("");

    // Prikaži prvih/zadnjih N
    const showMax = 20;
    const showList = toArchive.length <= showMax ? toArchive : [
        ...toArchive.slice(0, 10),
        null, // separator
        ...toArchive.slice(-10)
    ];

    for (const item of showList) {
        if (!item) {
            console.log(`      ... (${toArchive.length - 20} skriveno) ...`);
            continue;
        }
        console.log(`      ${item.date}  ${item.videoId}  ${item.title.substring(0, 50)}`);
    }
    console.log("");

    if (dryRun) {
        console.log(`   ⚠️  DRY RUN završen. Pokreni bez --dry-run za stvarnu arhivaciju.`);
        return;
    }

    // Izvrši arhivaciju
    const archivedSet = new Set(state.archived);
    const toArchiveIds = new Set(toArchive.map(v => v.videoId));

    state.completed = state.completed.filter(id => !toArchiveIds.has(id));
    for (const id of toArchiveIds) {
        if (!archivedSet.has(id)) {
            state.archived.push(id);
        }
    }

    saveState(channel.statePath, state);

    console.log(`   ✅ Arhivirano ${toArchive.length} videa.`);
    console.log(`   📋 State: ${state.completed.length} completed, ${state.archived.length} archived`);
    console.log(`   💾 Spremljeno: ${channel.statePath}`);
    console.log("");
}

function undoArchive(channelFilter, videoId) {
    const channels = discoverChannels();
    const channel = channels.find(ch => ch.channelName === channelFilter);

    if (!channel) {
        console.error(`❌ Kanal "${channelFilter}" nije pronađen.`);
        process.exit(1);
    }

    const state = loadState(channel.statePath);

    if (!state.archived.includes(videoId)) {
        console.error(`❌ Video "${videoId}" nije u archived[] za kanal ${channelFilter}.`);
        if (state.completed.includes(videoId)) {
            console.error(`   (Već je u completed[], nije arhiviran.)`);
        }
        process.exit(1);
    }

    state.archived = state.archived.filter(id => id !== videoId);
    state.completed.push(videoId);

    saveState(channel.statePath, state);

    const videoMap = parseVideoList(channel.listPath);
    const info = videoMap.get(videoId);

    console.log(`   ✅ Vraćen iz archived u completed: ${videoId}`);
    if (info) console.log(`      📋 ${info.date} — ${info.title.substring(0, 60)}`);
    console.log(`   📋 State: ${state.completed.length} completed, ${state.archived.length} archived`);
    console.log("");
}

// ─── MAIN ────────────────────────────────────────────────────────

function main() {
    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📦 VIDEO ARCHIVER                              ║");
    console.log("╚══════════════════════════════════════════════════╝");

    if (hasFlag("--list-channels") || hasFlag("--list")) {
        listChannels();
        return;
    }

    if (hasFlag("--stats")) {
        showStats();
        return;
    }

    const channelFilter = getArg("--channel");
    const beforeDate = getArg("--before");
    const specificVideoId = getArg("--video-id");
    const allCompleted = hasFlag("--all-completed");
    const dryRun = hasFlag("--dry-run");
    const undoVideoId = getArg("--undo");

    if (!channelFilter) {
        console.log("");
        console.log("Uporaba:");
        console.log("  node archive_videos.js --list-channels");
        console.log("  node archive_videos.js --stats");
        console.log("  node archive_videos.js --channel X --before YYYYMMDD [--dry-run]");
        console.log("  node archive_videos.js --channel X --video-id VIDEO_ID");
        console.log("  node archive_videos.js --channel X --all-completed [--dry-run]");
        console.log("  node archive_videos.js --channel X --undo VIDEO_ID");
        console.log("");
        return;
    }

    if (undoVideoId) {
        undoArchive(channelFilter, undoVideoId);
        return;
    }

    archiveVideos(channelFilter, beforeDate, specificVideoId, allCompleted, dryRun);
}

main();
