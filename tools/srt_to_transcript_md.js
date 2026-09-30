#!/usr/bin/env node
/**
 * srt_to_transcript_md.js — .canary.diarized.srt → čitljiv prijepis u Markdownu.
 *
 * Za dijeljenje IZVAN domovina.ai (Drive, mail, demo), par alatu
 * tools/article_to_md.js. Uzastopni segmenti istog govornika spajaju se u
 * odlomke (najviše 8 segmenata po odlomku), svaki s vremenom početka.
 * Nula API poziva.
 *
 *   node tools/srt_to_transcript_md.js <diarized.srt> <out.md> ["Naslov"] \
 *        [--name SPEAKER_00="vlč. Ime Prezime"] ...
 *
 * Vidi docs/2026-09-26-audio-datoteka-u-clanak.md.
 */
const fs = require("fs");

const args = process.argv.slice(2);
const names = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
        const [k, ...v] = args[++i].split("=");
        names[k] = v.join("=");
    } else pos.push(args[i]);
}
const [src, out, title] = pos;
if (!src || !out) {
    console.error('Upotreba: node tools/srt_to_transcript_md.js <diarized.srt> <out.md> ["Naslov"] [--name SPEAKER_00="Ime"]');
    process.exit(1);
}

const MAX_SEG_PER_PARA = 8;
const blocks = fs.readFileSync(src, "utf8").trim().split(/\n\n+/).map(b => {
    const l = b.split("\n");
    const text = l.slice(2).join(" ");
    const m = text.match(/^\[(\w+)\]\s*(.*)$/s);
    return { t: (l[1] || "").slice(0, 8), sp: m ? m[1] : "?", tx: m ? m[2] : text };
});

const L = [`# ${title || "Prijepis"}`, "",
    "_Automatski prijepis. Moguće su sitne pogreške u prepoznavanju riječi._", ""];
const flush = p => { if (p) L.push(`**[${p.t}] ${names[p.sp] || p.sp}:** ${p.tx.join(" ")}`, ""); };
let cur = null;
for (const b of blocks) {
    if (!cur || cur.sp !== b.sp || cur.tx.length >= MAX_SEG_PER_PARA) {
        flush(cur);
        cur = { sp: b.sp, t: b.t, tx: [] };
    }
    cur.tx.push(b.tx);
}
flush(cur);
fs.writeFileSync(out, L.join("\n"));
console.log(`✅ ${out} (${blocks.length} segmenata)`);
