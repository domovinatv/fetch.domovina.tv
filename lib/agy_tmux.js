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
        send(session, `Read the file ${stem}.md and do exactly what its UPUTA section says with its ULAZ section. ` +
            `Write ONLY the resulting JSON to the file ${stem}.json — no prose, no code fences. ` +
            `Do not run scripts or other tools besides reading that file and writing that one file.`);
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            await sleep(3000);
            if (!fs.existsSync(outFile)) continue;
            // agy zna zapisati datoteku u dva poteza — pričekaj da se veličina smiri.
            const size = fs.statSync(outFile).size;
            await sleep(1500);
            if (fs.statSync(outFile).size !== size) continue;
            try { return parseLoose(fs.readFileSync(outFile, "utf-8")); } catch (_) { /* još piše */ }
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
