#!/usr/bin/env node
/**
 * render_reel_premium.js — premium reel: LLM režija po reelu → storyboard → kritika → (render).
 *
 * Generički reel (render_reels.js) ima fiksan izgled po tipu kartice. Ovdje Opus za JEDAN
 * trenutak iz reels.json napiše režiju (beats.json: komponente iz biblioteke
 * tools/hyperframes_reel/premium/compose_premium.js, usidrene na izgovorene riječi), složi
 * se storyboard, drugi Opus poziv ga pogleda (vidi sliku) i vrati jednu reviziju, pa se
 * složi storyboard v2 uz standardni za usporedbu. Render tek uz --render, i samo lokalno:
 * ova skripta NIŠTA ne objavljuje i ne dira reels.json — čovjek prvo odobri storyboard.
 *
 * Trošak: 2 Opus poziva po reelu pod pretplatom (režija ~15k/5k tokena, kritika sa slikom
 * ~25k/6k). Bez Claudea u petlji: --beats <file> preskače režiju, --no-critique kritiku.
 *
 * Upotreba:
 *   node render_reel_premium.js --video-id ja70p_gJWZA --rank 1
 *   node render_reel_premium.js --video-id ja70p_gJWZA --rank 1 --reuse-clip --beats beats.v2.json --no-critique --render
 *
 * Zastavice: --video-id, --rank (1), --reuse-clip (isječak i lica iz prošlog runa),
 *   --beats <json> (gotova režija), --hint "<ideja urednika>", --no-critique, --render, --debug (sigurna zona)
 * Radni dir: ~/.cache/domovina-reels/work/premium_<id>_<rank>/ (ostaje; tu su beats, ploče i mp4).
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { reelWords, loadBrand, prepareClip, storyboard, renderVideo, run, readJson, probe, WORK_ROOT, HF, NPX } = require("./render_reels");
const { catalogText, preparePremium } = require("./tools/hyperframes_reel/premium/compose_premium");
const { claudeWindowClosed, claudeWindowReason } = require("./lib/claude_window");

const ROOT = __dirname;
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const VIDEO_ID = getArg("--video-id");
const RANK = parseInt(getArg("--rank") || "1", 10);
const BEATS_FILE = getArg("--beats");
const REUSE_CLIP = args.includes("--reuse-clip");
const CRITIQUE = !args.includes("--no-critique");
const RENDER = args.includes("--render");
const DEBUG = args.includes("--debug");
const HINT = getArg("--hint");   // urednikova ideja za režiju (npr. „rasprsnuta puška na 'iskakalo'")
const INPUT_DIR = path.join(ROOT, "storage", "output");
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "opus";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "high";
// neutralni cwd: inače se CLAUDE.md repoa učita u svaki poziv
const CLAUDE_CWD = path.join(os.tmpdir(), "domovina_claude_cli");

// ─── epizoda ───────────────────────────────────────────────────────
function locate(vid) {
    const hits = [];
    for (const ch of fs.readdirSync(INPUT_DIR, { withFileTypes: true })) {
        if (!(ch.isDirectory() || ch.isSymbolicLink()) || ch.name.startsWith(".")) continue;
        const dir = path.join(INPUT_DIR, ch.name);
        let files;
        try { files = fs.readdirSync(dir); } catch (_) { continue; }
        for (const f of files) {
            if (f.endsWith(`_yt_${vid}.reels.json`)) hits.push({ channel: ch.name, dir, base: f.slice(0, -".reels.json".length), vid, reelsPath: path.join(dir, f) });
        }
    }
    // kanalska kopija pobjeđuje `_unlisted`, kao u render_reels.js
    return hits.find((h) => h.channel !== "_unlisted") || hits[0] || null;
}

// ─── Claude (pretplata) ────────────────────────────────────────────
// Isti kritični flagovi kao select_reels.js: neutralni cwd, --setting-sources "", NIKAD --bare.
// Kritika treba vidjeti sliku, pa dobiva samo Read i pristup radnom diru.
function callClaude(system, user, { tools = "", addDir = null, maxTurns = 1 } = {}) {
    if (claudeWindowClosed()) throw new Error(`claude prozor zatvoren: ${claudeWindowReason()}`);
    return new Promise((resolve, reject) => {
        fs.mkdirSync(CLAUDE_CWD, { recursive: true });
        const argv = ["-p", "--model", CLAUDE_MODEL, "--effort", CLAUDE_EFFORT, "--output-format", "json",
            "--setting-sources", "", "--strict-mcp-config", "--max-turns", String(maxTurns), "--tools", tools,
            "--system-prompt", system];
        if (tools) argv.push("--allowedTools", tools);
        if (addDir) argv.push("--add-dir", addDir);
        const proc = spawn("claude", argv, { stdio: ["pipe", "pipe", "pipe"], cwd: CLAUDE_CWD });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("error", (err) => reject(new Error(`claude CLI spawn: ${err.message}`)));
        proc.on("close", (code) => {
            let env;
            try { env = JSON.parse(stdout); } catch (_) { return reject(new Error(`claude CLI exit ${code}: ${(stderr || stdout).slice(0, 400)}`)); }
            if (env.is_error || env.subtype !== "success") return reject(new Error(`claude CLI greška (${env.subtype}): ${String(env.result || "").slice(0, 300)}`));
            const u = env.usage || {};
            resolve({
                text: env.result || "",
                usage: { input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output_tokens: u.output_tokens || 0 },
                turns: env.num_turns, cost_usd: env.total_cost_usd,
            });
        });
        proc.stdin.write(user);
        proc.stdin.end();
    });
}

function parseJson(text) {
    const t = String(text);
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error(`odgovor nije JSON: ${text.slice(0, 200)}`);
    return JSON.parse(t.slice(a, b + 1));
}

// ─── promptovi ─────────────────────────────────────────────────────
const PRINCIPLES = `Načela (tvrda):
1. Mirno, ne TikTok. Jedna kartica u isto vrijeme, između kartica barem 1 s samo videa. Kartica stoji dok se ne pročita (≈ 1,5 s + znakovi/11, najmanje 4,5 s); citat s reveal "spoken" traje koliko i izgovor (+0,8 s), a end se po potrebi skraćuje do 3,5 s. Za 60–90 s reela 4–7 taktova ukupno; manje je bolje od natrpanog.
2. Svaka kartica mora DODATI nešto što se ne vidi i ne čuje: kontekst, mjeru, predmet, ishod. Zabranjeno je prepričavati ono što govornik upravo kaže („X govori o Y", „On opisuje…").
3. Sidro je izgovorena riječ: at_word = indeks riječi na kojoj kartica počinje, obično 0,5–2 s PRIJE ključne riječi da je gledatelj stigne pogledati. Unutarnji taktovi (draw_at_word, stamp_at_word, at_word u illustration, steps[].at_word) padaju TOČNO na riječ koju ilustriraju.
4. Ton određuje intenzitet. Svjedočanstvo (rat, smrt, bolest, gubitak) = suzdržano: bez pečata, bez tresenja, bez šaljivih crteža, kamera polako, tišina na kraju. Humor smije više pokreta. Objašnjenje = brojke, mjere, slijed. Molitva = minimum.
5. illustration samo za predmet koji nosi priču, i samo ako ga možeš nacrtati prepoznatljivo kao jednostavnu siluetu od 6–20 osnovnih oblika. Bolje bez crteža nego nejasan crtež.
6. Najjači trenutak (obično pri kraju) smije dobiti quote style "quiet" (+ reveal "spoken") i mood "dim" ili "mono". Najviše jedan takav trenutak.
7. end je obavezan i zadnji, 3,5–6 s. Ako trenutak traje do zadnje riječi, zadaj tail_sec (0–4): isječak se produlji iza govora, zvuk se utiša, pa end stane iza zadnje riječi. Kartica koja ne stane otpada.
8. camera: najviše 3 pomaka, zoom 1.00–1.12, over 1,5–4 s; polako se približi kad priča ulazi u ključni trenutak, vrati na 1.0 poslije.
9. Hrvatski, bez emojija. Ne izmišljaj činjenice kojih nema u prijepisu ili kontekstu. lower_third samo ako znaš ime i ulogu.
Raspored oko lica i sigurna zona rješavaju se automatski; ti biraš samo ŠTO, KADA i KOLIKO. prefer "above" stavlja karticu iznad lica (rijetko).`;

const SCHEMA = `{"tone":"svjedocanstvo|humor|objasnjenje|molitva|razgovor","intensity":1-3,"idea":"jedna rečenica: režijska ideja","tail_sec":0-4,
"beats":[{"component":"...","at_word":int,"dur":sekunde,"params":{...},"prefer":"below|above (opcionalno)","why":"zašto baš ovdje"}],
"camera":[{"at_word":int,"zoom":1.0-1.12,"over":sekunde}],"mood":[{"at_word":int,"dur":sekunde,"look":"dim|mono"}]}`;

const DIRECTOR_SYSTEM = `Ti si redatelj kratkih vertikalnih videa (reels, 9:16) za domovina.ai. Dobivaš JEDAN već izabrani trenutak iz hrvatskog podcasta: riječi s indeksima i vremenima, kontekst epizode i prijedlog kartica iz automatskog odabira. Tvoj posao je režija: koje komponente, na kojim riječima, koliko dugo, s kojim pokretom — tako da reel bude jasniji i jači od generičkog, a ostane dostojanstven.

${PRINCIPLES}

Katalog komponenti (samo ove; params točno ovako):
${catalogText()}

Odgovori SAMO JSON-om, bez teksta oko njega:
${SCHEMA}`;

const CRITIC_SYSTEM = `Ti si urednik koji pregledava storyboard premium reela (9:16) prije rendera. Storyboard je jedna slika: po jedan kadar za svaki takt, u trenutku kad je kartica „gotova" (crtež nacrtan, brojka izbrojena), redom slijeva nadesno pa u novi red. Vidiš i režiju (beats.json) iz koje je kadar složen i upozorenja slagača (što je pomaknuto, skraćeno ili odbačeno).

Prvo pročitaj sliku alatom Read. Za svaki kadar napiši što STVARNO vidiš (ne što je namjera), pa sudi:
- čitljivost (veličina, kontrast, je li tekst prekriven ili prekriva lice/titl),
- je li crtež prepoznatljiv kao predmet koji treba biti — ako nije, popravi oblike ili ga izbaci,
- dodaje li kartica informaciju ili prepričava,
- ritam i ton (svjedočanstvo traži suzdržanost),
- što je slagač morao prilagoditi (upozorenja) — popravi uzrok u režiji.
Zatim vrati JEDNU revidiranu režiju (cijelu, ne razliku). Ako je nešto dobro, ne mijenjaj ga.

${PRINCIPLES}

Katalog komponenti:
${catalogText()}

Odgovori SAMO JSON-om:
{"seen":["kadar 1: …", …],"issues":["…"],"beats":${SCHEMA}}`;

function wordsBlock(words) {
    const lines = [];
    for (let i = 0; i < words.length; i += 10) {
        lines.push(words.slice(i, i + 10).map((w, k) => `${i + k}:${w.text}@${w.start.toFixed(1)}`).join(" "));
    }
    return lines.join("\n");
}

function directorMessage(ctx) {
    const r = ctx.reel;
    return [
        `Kanal: ${ctx.channelName}`,
        `Epizoda: ${ctx.title}`,
        `Govornik: ${r.speaker || "?"}`,
        `Govor traje do ${ctx.speechEnd.toFixed(1)} s (bez tail_sec reel tu i završava)`,
        `Odabir (9.9): naslov „${r.title}", udica „${r.hook}", vrsta ${r.kind}, ocjena ${r.score}`,
        `Zašto je izabran: ${r.why}`,
        r.quote ? `Ključni citat: „${r.quote}"` : "",
        "",
        "Kontekst PRIJE isječka (gledatelj ga NE čuje):",
        ...ctx.before.map((s) => `  ${s}`),
        "",
        "Prijedlog kartica iz generičkog odabira (smiješ ga koristiti, mijenjati ili odbaciti):",
        JSON.stringify(r.cards || []),
        "",
        HINT ? `IDEJA UREDNIKA (ostvari je ako ne krši načela; ako krši, objasni u "idea"): ${HINT}` : "",
        "",
        "RIJEČI REELA (indeks:riječ@sekunda od početka reela):",
        wordsBlock(ctx.words),
    ].filter((l) => l !== "").join("\n");
}

function criticMessage(ctx, doc, comp, boardPath) {
    return [
        `Storyboard: ${boardPath}`,
        `Kadrovi (redom): ${comp.beats.map((b, i) => `${i + 1}. ${b.component} ${b.start.toFixed(1)}–${(b.start + b.dur).toFixed(1)} s, kadar u ${comp.keyTimes[i]} s`).join("; ")}`,
        "",
        `Upozorenja slagača: ${comp.warnings.length ? comp.warnings.join(" | ") : "nema"}`,
        ctx.checkError ? `hyperframes check je PAO: ${ctx.checkError}` : "hyperframes check: prošao",
        "",
        "Režija (beats.json) iz koje je storyboard složen:",
        JSON.stringify(doc),
        "",
        directorMessage(ctx),
    ].join("\n");
}

// ─── kompozicija + ploča ───────────────────────────────────────────
// isječak i lica: ponovno samo kad se promijeni tail_sec (ili bez --reuse-clip u prvom pozivu)
function ensureClip(ctx, ep, tail) {
    const meta = path.join(ctx.work, "clip.json");
    const prev = readJson(meta);
    const have = prev && prev.tail === tail && fs.existsSync(path.join(ctx.pub, "input-video.mp4"));
    if (have && (REUSE_CLIP || ctx.clipFresh)) {
        Object.assign(ctx, { dur: prev.dur, faces: readJson(path.join(ctx.work, "faces.json")) });
        return;
    }
    // prepareClip briše radni dir — sačuvaj režiju, ploče i potrošnju
    const keep = fs.existsSync(ctx.work) ? fs.readdirSync(ctx.work).filter((f) => /\.(json|txt|jpg)$/.test(f) && f !== "clip.json" && f !== "faces.json")
        .map((f) => [f, fs.readFileSync(path.join(ctx.work, f))]) : [];
    const clip = prepareClip(ep, ctx.reel, ctx.work, { tail });
    for (const [f, buf] of keep) fs.writeFileSync(path.join(ctx.work, f), buf);
    fs.writeFileSync(meta, JSON.stringify({ dur: clip.dur, r_s: clip.r_s, source: clip.source, tail }));
    Object.assign(ctx, { dur: clip.dur, faces: clip.faces, clipFresh: true });
    console.log(`   🎞️  isječak ${clip.dur.toFixed(1)} s (${clip.source}${tail ? `, +${tail} s iza govora` : ""}), lica OK`);
}

function composeAndBoard(ctx, ep, doc, name) {
    const tail = Math.round(Math.min(4, Math.max(0, Number(doc.tail_sec) || 0)) * 10) / 10;
    ensureClip(ctx, ep, tail);
    fs.writeFileSync(path.join(ctx.work, `${name.replace("storyboard", "beats")}.json`), JSON.stringify(doc, null, 2));
    const comp = preparePremium(ctx.pub, {
        reel: ctx.reel, doc, words: ctx.words, dur: ctx.dur, faces: ctx.faces, brand: ctx.brand, debug: DEBUG,
        videoId: ctx.vid, title: ctx.title, channelName: ctx.channelName,
    });
    let checkError = null;
    try { run(NPX, ["--yes", HF, "check", ctx.pub], { timeout: 5 * 60 * 1000 }); } catch (e) { checkError = e.message.split("\n").slice(-6).join(" ").slice(0, 600); }
    const board = storyboard(ctx.pub, ctx.work, comp.keyTimes.map((t) => t.toFixed(2)), name, { check: false });
    // ploča za kritiku: veći kadrovi, da se crtež i sitan tekst vide
    const big = storyboard(ctx.pub, ctx.work, comp.keyTimes.map((t) => t.toFixed(2)), `${name}_big`, { check: false, geometry: "432x768+8+8" });
    fs.writeFileSync(path.join(ctx.work, `${name}.compose.json`), JSON.stringify({ ...comp, checkError }, null, 2));
    console.log(`   🧩 ${name}: ${comp.beats.map((b) => `${b.component}@${b.start}`).join(", ")}`);
    if (comp.warnings.length) console.log(`   ⚠️  ${comp.warnings.join("\n   ⚠️  ")}`);
    console.log(checkError ? `   ❌ check: ${checkError}` : "   ✅ check");
    return { comp, board, big, checkError };
}

function logUsage(work, step, res) {
    const p = path.join(work, "usage.json");
    const all = readJson(p) || [];
    all.push({ step, at: new Date().toISOString(), ...res.usage, turns: res.turns, cost_usd_equiv: res.cost_usd });
    fs.writeFileSync(p, JSON.stringify(all, null, 2));
    console.log(`   💬 ${step}: ${res.usage.input_tokens} in / ${res.usage.output_tokens} out${res.turns ? `, ${res.turns} turn` : ""}`);
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
    if (!VIDEO_ID) throw new Error("treba --video-id");
    const ep = locate(VIDEO_ID);
    if (!ep) throw new Error(`nema reels.json za ${VIDEO_ID}`);
    const doc = readJson(ep.reelsPath);
    const reel = (doc.reels || []).find((r) => r.rank === RANK);
    if (!reel) throw new Error(`nema ranga ${RANK} u ${ep.reelsPath}`);
    const brand = loadBrand(ep.channel);
    const work = path.join(WORK_ROOT, `premium_${VIDEO_ID}_${RANK}`);
    console.log(`🎬 premium reel ${ep.channel}/${VIDEO_ID} #${RANK} — ${reel.title}\n   radni dir: ${work}`);

    // 1. riječi (ne trebaju isječak: vremena su relativna na početak reela)
    const r_s = Math.max(0, reel.start_sec - 0.12);   // PAD_START iz render_reels.js
    const segs = fs.readFileSync(path.join(ep.dir, ep.base + ".segments.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const ctx = {
        vid: VIDEO_ID, reel, brand, work, pub: path.join(work, "public"),
        speechEnd: reel.end_sec + 0.45 - r_s,              // PAD_END
        words: reelWords(ep, reel, r_s),
        title: doc.title, channelName: (brand && brand.json.name) || doc.channel || ep.channel,
        before: segs.filter((s) => s.seq >= reel.start_seq - 3 && s.seq < reel.start_seq).map((s) => `${s.speaker || "?"}: ${s.text}`),
    };
    fs.mkdirSync(work, { recursive: true });

    // 2. režija
    let v1;
    if (BEATS_FILE) {
        v1 = readJson(path.resolve(BEATS_FILE));
        if (!v1) throw new Error(`ne mogu pročitati ${BEATS_FILE}`);
        console.log(`   📝 režija iz ${BEATS_FILE}`);
    } else {
        console.log("   🎬 režija (Opus)…");
        const res = await callClaude(DIRECTOR_SYSTEM, directorMessage(ctx));
        fs.writeFileSync(path.join(work, "direction.raw.txt"), res.text);
        logUsage(work, "režija", res);
        v1 = parseJson(res.text);
    }
    if (v1.idea) console.log(`   💡 ${v1.idea}`);
    const s1 = composeAndBoard(ctx, ep, v1, "storyboard.v1");

    // 3. kritika → jedna revizija
    let final = s1, finalDoc = v1;
    if (CRITIQUE) {
        console.log("   🔍 kritika storyboarda (Opus, sa slikom)…");
        const res = await callClaude(CRITIC_SYSTEM, criticMessage({ ...ctx, checkError: s1.checkError }, v1, s1.comp, s1.big),
            { tools: "Read", addDir: work, maxTurns: 4 });
        fs.writeFileSync(path.join(work, "critique.raw.txt"), res.text);
        logUsage(work, "kritika", res);
        const crit = parseJson(res.text);
        fs.writeFileSync(path.join(work, "critique.json"), JSON.stringify({ seen: crit.seen, issues: crit.issues }, null, 2));
        for (const i of crit.issues || []) console.log(`   • ${i}`);
        finalDoc = crit.beats;
        final = composeAndBoard(ctx, ep, finalDoc, "storyboard.v2");
    }
    if (final.checkError) throw new Error("hyperframes check nije prošao na zadnjoj verziji — nema rendera");

    // 4. usporedba sa standardnim
    const std = path.join(ep.dir, ep.base + ".reels", `${RANK}.storyboard.jpg`);
    if (fs.existsSync(std) && final.board) {
        const cmp = path.join(work, "compare.jpg");
        run("magick", [std, final.board, "-background", "#111", "-gravity", "west", "-splice", "0x0", "-append", cmp]);
        console.log(`   🆚 gore standardni, dolje premium: ${cmp}`);
    }

    // 5. render (lokalno, bez objave)
    if (RENDER) {
        console.log("   🎥 render…");
        const t0 = Date.now();
        const mp4 = renderVideo(ctx.pub, work);
        const out = path.join(work, "premium.mp4");
        fs.renameSync(mp4, out);
        const pr = probe(out);
        console.log(`   ✅ ${out} ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${pr.w}×${pr.h}, ${pr.dur.toFixed(1)} s, ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    console.log(`\n📁 ${work}`);
}

main().catch((e) => { console.error(`❌ ${e.stack || e.message}`); process.exit(1); });
