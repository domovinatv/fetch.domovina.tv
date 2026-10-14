#!/usr/bin/env node
// Faza 3b, izvještaj: data/slijepo/<id>/ocjena.json + kljuc.json + data/logs/faza2_pozivi.jsonl
//   → results/llm_metrics.md + results/llm_metrics.json. Nula API poziva.
//   node experiments/2026-10-11-asr-llm/judge_report.js
"use strict";
const fs = require("fs"), path = require("path");
const EXP = __dirname, DST = path.join(EXP, "data/slijepo"), RES = path.join(EXP, "results");
const key = JSON.parse(fs.readFileSync(path.join(DST, "kljuc.json"), "utf-8"));
const CRIT = ["utemeljenost", "imena", "pokrivenost", "jezik", "struktura", "ukupno"];

// ── trošak i pouzdanost iz poziva (samo uspješni pokušaji; proba je uključena) ──
const calls = fs.readFileSync(path.join(EXP, "data/logs/faza2_pozivi.jsonl"), "utf-8").trim().split("\n").map(l => JSON.parse(l));
const cost = {};
for (const c of calls) {
    const m = cost[c.model] || (cost[c.model] = { calls: 0, err: 0, eps: new Set(), inTok: 0, outTok: 0, thinkTok: 0, usd: 0, ms: 0, strict: 0, lenient: 0, firstTry: 0, firstStrict: 0 });
    m.calls++; m.eps.add(c.id);
    if (c.error) { m.err++; continue; }
    m.inTok += c.inTok; m.outTok += c.outTok; m.thinkTok += c.thinkTok || 0; m.usd += c.usd; m.ms += c.ms;
    if (c.attempt === 1) { m.firstTry++; if (c.jsonStrict) m.firstStrict++; if (c.jsonLenient) m.lenient++; }
}

// ── ocjene ──
const agg = {}, perEp = [], errs = {};
for (const id of Object.keys(key)) {
    const p = path.join(DST, id, "ocjena.json");
    if (!fs.existsSync(p)) continue;
    let o; try { o = JSON.parse(fs.readFileSync(p, "utf-8")); } catch (e) { console.warn(`⚠️  ${id}: neispravan ocjena.json`); continue; }
    const row = { id, rang: (o.rang || []).map(L => key[id][L] || L), napomena: o.napomena || "" };
    for (const [L, sc] of Object.entries(o.kandidati || {})) {
        const m = key[id][L]; if (!m) continue;
        const a = agg[m] || (agg[m] = { n: 0, sum: Object.fromEntries(CRIT.map(k => [k, 0])), rank1: 0, rankSum: 0, teske: 0, srednje: 0, lake: 0 });
        a.n++; for (const k of CRIT) a.sum[k] += Number(sc[k]) || 0;
        const r = row.rang.indexOf(m); if (r >= 0) { a.rankSum += r + 1; if (r === 0) a.rank1++; }
        row[m] = sc.ukupno;
    }
    for (const g of o.greske || []) {
        const m = key[id][g.kandidat]; if (!m || !agg[m]) continue;
        agg[m][{ teska: "teske", srednja: "srednje", laka: "lake" }[g.tezina] || "lake"]++;
        (errs[m] || (errs[m] = [])).push({ id, ...g });
    }
    perEp.push(row);
}

const models = Object.keys(agg).sort((a, b) => agg[b].sum.ukupno / agg[b].n - agg[a].sum.ukupno / agg[a].n);
const f1 = (x) => x.toFixed(1);
const L = [];
L.push(`# Faza 3b — slijepa ocjena članaka (${perEp.length} epizoda)`, "",
    "Ocjenjivač: Opus subagent po epizodi, kandidati anonimizirani A–E (nasumičan poredak po epizodi, `judge_prep.js`),",
    "upute `judge_prompt.md`. Ulaz za sve modele isti: Speechmatics Enhanced dijarizirani SRT. `produkcija-opus` = produkcijski",
    "članak (drugi transkript: Speechmatics + Gemini refine), samo na 2 referentne epizode.", "",
    "## Prosječne ocjene (1–10)", "",
    `| model | n | ${CRIT.join(" | ")} | prosj. rang | 1. mjesta | greške teške/srednje/lake |`,
    `|---|---|${CRIT.map(() => "---").join("|")}|---|---|---|`);
for (const m of models) {
    const a = agg[m];
    L.push(`| ${m} | ${a.n} | ${CRIT.map(k => f1(a.sum[k] / a.n)).join(" | ")} | ${f1(a.rankSum / a.n)} | ${a.rank1} | ${a.teske}/${a.srednje}/${a.lake} |`);
}
L.push("", "## Trošak i pouzdanost (svi pozivi faze 2, uklj. probu)", "",
    "| model | ep | pozivi | greške poziva | ulaz Mtok | izlaz ktok | 💭 ktok | $ ukupno | $/ep | s/poziv | JSON strogo na 1. pokušaj | JSON blago |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [m, c] of Object.entries(cost)) {
    const ok = c.calls - c.err;
    L.push(`| ${m} | ${c.eps.size} | ${c.calls} | ${c.err} | ${(c.inTok / 1e6).toFixed(2)} | ${(c.outTok / 1e3).toFixed(0)} | ${(c.thinkTok / 1e3).toFixed(0)} | ${c.usd.toFixed(2)} | ${(c.usd / c.eps.size).toFixed(3)} | ${(c.ms / ok / 1000).toFixed(0)} | ${c.firstStrict}/${c.firstTry} | ${c.lenient}/${c.firstTry} |`);
}
L.push("", "Napomene: Sonnet $ je ekvivalent (pretplata, `total_cost_usd` iz CLI-ja). Anthropic ne odvaja razmišljanje od izlaza",
    "(💭 = samo Gemini `thoughtsTokenCount`). Claude tokenizer broji ~1,5× više tokena za isti hrvatski tekst.", "",
    "## Po epizodi (ukupna ocjena)", "", `| epizoda | ${models.join(" | ")} | rang |`, `|---|${models.map(() => "---").join("|")}|---|`);
for (const r of perEp) L.push(`| ${r.id} | ${models.map(m => r[m] ?? "—").join(" | ")} | ${r.rang.join(" > ")} |`);
L.push("", "## Teške greške", "");
for (const m of models) {
    const t = (errs[m] || []).filter(g => g.tezina === "teska");
    L.push(`### ${m} (${t.length})`, "");
    for (const g of t) L.push(`- **${g.id}** [${g.vrsta}] ${g.opis}${g.citat ? ` — „${String(g.citat).slice(0, 160)}"` : ""}${g.transkript ? ` (transkript: ${String(g.transkript).slice(0, 120)})` : ""}`);
    L.push("");
}
L.push("## Napomene ocjenjivača", "");
for (const r of perEp) if (r.napomena) L.push(`- **${r.id}:** ${r.napomena}`);

fs.mkdirSync(RES, { recursive: true });
fs.writeFileSync(path.join(RES, "llm_metrics.md"), L.join("\n") + "\n");
fs.writeFileSync(path.join(RES, "llm_metrics.json"), JSON.stringify({ agg, perEp, errs,
    cost: Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, { ...v, eps: [...v.eps] }])) }, null, 2));
console.log(`results/llm_metrics.md — ${perEp.length} epizoda ocijenjeno`);
