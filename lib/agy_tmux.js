/**
 * lib/agy_tmux.js — Gemini kroz agy (Antigravity CLI) u tmux sesiji, na Google AI Pro pretplati.
 *
 * Od 28.10.2026. jedini put za Gemini pozive (Vertex je isključen, vidi lib/vertex_auth.js).
 * `agy -p` ne vraća odgovor (bug od 1.3.5), pa upit ide kroz interaktivnu sesiju: tekst
 * upita se zapiše u datoteku, agy dobije jednu kratku rečenicu („pročitaj X, zapiši JSON u Y")
 * i čeka se da Y nastane. Isti obrazac kao best-frame u screenshot_youtube.js i
 * experiments/2026-10-10-asr/agy_refine.js, samo generički.
 *
 *   const { agyJson } = require("./lib/agy_tmux");
 *   const v = await agyJson({ system, user, session: "agyen" });   // → parsiran JSON ili baca
 *
 * Pozivi kroz istu sesiju se SERIJALIZIRAJU (jedna sesija = jedan razgovor). Gledanje:
 * `tmux attach -t <session> -r`. Radni dir mora biti „trusted" — prvo pitanje se potvrđuje samo.
 *
 * Env: AGY_MODEL (default gemini-3.8-flash-high), AGY_TIMEOUT_SEC (default 600).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_MODEL = process.env.AGY_MODEL || "gemini-3.8-flash-high";
const DEFAULT_TIMEOUT_MS = parseInt(process.env.AGY_TIMEOUT_SEC || "600", 10) * 1000;
const WORK_ROOT = path.join(os.homedir(), "git", ".agy-tmux");
// Popravak neispravnog JSON izlaza (vidi askOnce). Env samo za testove.
const BAD_JSON_SETTLE_MS = parseInt(process.env.AGY_BAD_JSON_SETTLE_SEC || "20", 10) * 1000;
const REPAIR_TIMEOUT_MS = parseInt(process.env.AGY_REPAIR_TIMEOUT_SEC || "360", 10) * 1000;
const MAX_JSON_REPAIRS = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => spawnSync("tmux", a, { encoding: "utf-8" });

const sessions = new Map();   // session → { ready, queue, dir }

function agyAvailable() {
    const which = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
    return which("tmux") && which("agy");
}

function state(session) {
    if (!sessions.has(session)) {
        sessions.set(session, { ready: false, queue: Promise.resolve(), dir: path.join(WORK_ROOT, session) });
    }
    return sessions.get(session);
}

function send(session, text) {
    tmux("send-keys", "-t", session, "-l", text);
    spawnSync("sleep", ["0.5"]);
    tmux("send-keys", "-t", session, "Enter");
}

async function ensureSession(session, model) {
    const st = state(session);
    if (st.ready && tmux("has-session", "-t", session).status === 0) return true;
    st.ready = false;
    fs.mkdirSync(st.dir, { recursive: true });
    if (tmux("has-session", "-t", session).status !== 0) {
        tmux("new-session", "-d", "-s", session, "-x", "180", "-y", "50", "-c", st.dir);
        tmux("send-keys", "-t", session, `agy --model ${model} --dangerously-skip-permissions`, "Enter");
    }
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const screen = tmux("capture-pane", "-p", "-t", session).stdout || "";
        // Novi direktorij: agy pita za povjerenje. Prva opcija je „Yes".
        if (/trust the contents/i.test(screen)) { tmux("send-keys", "-t", session, "Enter"); continue; }
        if (screen.includes("for shortcuts")) { st.ready = true; return true; }
    }
    tmux("kill-session", "-t", session);
    throw new Error(`agy se nije pokrenuo u tmux sesiji ${session} (prijava? \`agy\` ručno)`);
}

// Odgovor modela zna doći s ```json ograđivačem ili prozom oko objekta.
function parseLoose(text) {
    const cleaned = String(text).replace(/^﻿/, "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    try { return JSON.parse(cleaned); } catch (_) { /* dalje */ }
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("agy: izlaz nije JSON");
}

async function askOnce({ system, user, session, model, timeoutMs }) {
    await ensureSession(session, model);
    const st = state(session);
    const stem = `req-${process.pid}-${Date.now()}`;
    const reqFile = path.join(st.dir, `${stem}.md`);
    const outFile = path.join(st.dir, `${stem}.json`);
    fs.writeFileSync(reqFile, `# UPUTA\n\n${system}\n\n# ULAZ\n\n${user}\n`, "utf-8");
    try {
        send(session, "/clear");
        await sleep(3000);
        // /clear zna proći kao običan tekst „clear" (agyen-low 29.10.2026., iza prekinutog
        // poteza) — tada kontekst raste od prijevoda do prijevoda. Ekran nakon pravog /clear
        // nema starih upita; ako ih ima, sesija ispočetka.
        if ((tmux("capture-pane", "-p", "-t", session).stdout || "").includes("Read the file req-")) {
            process.stderr.write(`\n      🔄 agy: /clear nije očistio sesiju ${session} — pokrećem je ispočetka`);
            tmux("kill-session", "-t", session);
            await ensureSession(session, model);
        }
        send(session, `Read the file ${stem}.md and do exactly what its UPUTA section says with its ULAZ section. ` +
            `Write ONLY the resulting JSON to the file ${stem}.json — no prose, no code fences. ` +
            `Do not run scripts or other tools besides reading that file and writing that one file.`);
        // Neparsabilan izlaz NIJE „još piše": Flash na ~100 KB JSON-a zna ispustiti navodnik
        // (n38M_g__TxQ, 29.10.2026.: 3 poziva × 510 s čekanja na gotov, ali neispravan fajl).
        // Kad se datoteka smiri, a ne parsira se, agy u istoj sesiji dobije kratki potez da
        // popravi samo sintaksu — prijevod je već gotov. Nakon MAX_JSON_REPAIRS → greška odmah.
        let deadline = Date.now() + timeoutMs;
        let repairs = 0, badMtime = 0, badSince = 0, repairSentAt = 0, lastErr = "";
        while (Date.now() < deadline) {
            await sleep(3000);
            if (!fs.existsSync(outFile)) continue;
            // agy zna zapisati datoteku u dva poteza — pričekaj da se veličina smiri.
            const st1 = fs.statSync(outFile);
            await sleep(1500);
            const st2 = fs.statSync(outFile);
            if (st2.size !== st1.size || st2.mtimeMs !== st1.mtimeMs) continue;
            // Nakon zahtjeva za popravak gledamo tek novu verziju datoteke.
            if (repairSentAt && st2.mtimeMs <= repairSentAt) continue;
            try { return parseLoose(fs.readFileSync(outFile, "utf-8")); } catch (e) { lastErr = e.message; }
            if (st2.mtimeMs !== badMtime) { badMtime = st2.mtimeMs; badSince = Date.now(); continue; }
            if (Date.now() - badSince < BAD_JSON_SETTLE_MS) continue;
            if (repairs >= MAX_JSON_REPAIRS) {
                throw new Error(`agy: izlaz nije valjan JSON ni nakon ${repairs} popravka (${lastErr})`);
            }
            repairs++;
            process.stderr.write(`\n      🩹 agy: ${stem}.json nije valjan JSON (${lastErr}) — popravak ${repairs}/${MAX_JSON_REPAIRS}`);
            repairSentAt = Date.now();
            send(session, `The file ${stem}.json is not valid JSON (${lastErr}). Fix ONLY the JSON syntax ` +
                `(quotes, escapes, commas, brackets) and write the corrected JSON back to ${stem}.json. ` +
                `Do not change, add, remove or re-translate any text. No prose, no code fences.`);
            deadline = Math.max(deadline, Date.now() + REPAIR_TIMEOUT_MS);
        }
        // Prekini zaglavljeni potez, inače /clear i idući upit čekaju u redu iza njega.
        tmux("send-keys", "-t", session, "Escape");
        await sleep(2000);
        tmux("send-keys", "-t", session, "Escape");
        throw new Error(`agy: nema odgovora nakon ${Math.round(timeoutMs / 1000)} s (sesija ${session})`);
    } finally {
        fs.rmSync(reqFile, { force: true });
        fs.rmSync(outFile, { force: true });
    }
}

/**
 * Jedan JSON poziv kroz agy. Serijaliziran po sesiji. Baca grešku ako nema odgovora.
 */
function agyJson({ system, user, session = "agyt", model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const st = state(session);
    const run = st.queue.then(() => askOnce({ system, user, session, model, timeoutMs }));
    st.queue = run.catch(() => {});
    return run;
}

module.exports = { agyJson, agyAvailable, parseLoose, DEFAULT_MODEL };
