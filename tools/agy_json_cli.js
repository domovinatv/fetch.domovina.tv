#!/usr/bin/env node
/**
 * tools/agy_json_cli.js — agyJson() za pozivatelje izvan Nodea (npr. domovina-rag Python).
 *
 *   echo "$PROMPT" | node tools/agy_json_cli.js [--session agymap] [--system "..."]
 *
 * Upit čita sa stdina, na stdout piše parsiran JSON (jedna linija). Exit 2 = agy/tmux nisu
 * dostupni, exit 1 = poziv pao. Koristi ga `../domovina-rag/scripts/vectormap_common.py`
 * za imenovanje klastera vektorske mape i mape osoba (od 31.10.2026., Vertex je DEPRECATED).
 */
const { agyJson, agyAvailable } = require("../lib/agy_tmux");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

(async () => {
    if (!agyAvailable()) {
        console.error("agy ili tmux nisu na PATH-u");
        process.exit(2);
    }
    const user = require("fs").readFileSync(0, "utf-8");
    const system = getArg("--system") || "Slijedi upute iz upita. Vrati ISKLJUČIVO valjan JSON.";
    const session = getArg("--session") || "agyt";
    try {
        const v = await agyJson({ system, user, session });
        process.stdout.write(JSON.stringify(v) + "\n");
        process.exit(0);
    } catch (e) {
        console.error(`agy poziv pao: ${e.message}`);
        process.exit(1);
    }
})();
