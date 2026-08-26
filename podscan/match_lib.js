/**
 * Normalizacija i uparivanje imena — hrvatski-svjestan.
 *
 * Zašto ovo nije trivijalno: naš registar je YouTube-centričan
 * ("Domovina TV", "Bujica — Velimir Bujanec"), a Podscan indeksira RSS naslove
 * ("Bujica Podcast", "DomovinaTV"). Dijakritika, sufiks "podcast/podkast",
 * i crtice/emojiji u naslovima su tri najčešća razloga lažnog promašaja.
 *
 * Vraćamo DVIJE normalizirane forme:
 *   norm — bez dijakritike, bez interpunkcije, sabijen razmak
 *   core — norm minus generičke riječi (podcast, show, emisija, official…)
 * `core` hvata "Bujica" ↔ "Bujica Podcast", ali sam po sebi lakše lažira
 * poklapanje, pa se rezultat uvijek nosi sa `confidence` oznakom.
 */

const DIACRITICS = { č: "c", ć: "c", ž: "z", š: "s", đ: "d", "Č": "c", "Ć": "c", "Ž": "z", "Š": "s", "Đ": "d" };

const NOISE_WORDS = new Set([
    "podcast", "podkast", "pod", "cast", "show", "emisija", "kanal", "channel",
    "official", "sluzbeni", "the", "tv", "radio", "hr", "hrvatska", "croatia",
    "epizode", "episodes", "s", "sa", "with", "by",
]);

function stripDiacritics(s) {
    return s.replace(/[čćžšđČĆŽŠĐ]/g, (c) => DIACRITICS[c] || c)
        .normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeName(s) {
    if (!s) return "";
    return stripDiacritics(String(s).toLowerCase())
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function coreName(s) {
    const toks = normalizeName(s).split(" ").filter((t) => t && !NOISE_WORDS.has(t));
    return toks.join(" ");
}

function tokens(s) {
    return new Set(normalizeName(s).split(" ").filter(Boolean));
}

/** Jaccard nad tokenima — 1.0 = isti skup riječi bez obzira na redoslijed. */
function tokenJaccard(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
}

/** Trigram similarity — hvata sitne tipfelere i sklonidbu. */
function trigrams(s) {
    const n = " " + normalizeName(s) + " ";
    const g = new Set();
    for (let i = 0; i < n.length - 2; i++) g.add(n.slice(i, i + 3));
    return g;
}

function trigramSim(a, b) {
    const A = trigrams(a), B = trigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
}

/** Izvuci YouTube handle/channel id iz proizvoljnog URL-a. */
function ytIdentity(url) {
    if (!url) return null;
    const s = String(url);
    let m = s.match(/youtube\.com\/(?:channel\/)(UC[A-Za-z0-9_-]{20,})/);
    if (m) return { kind: "channel_id", value: m[1] };
    m = s.match(/youtube\.com\/@([A-Za-z0-9._-]+)/);
    if (m) return { kind: "handle", value: "@" + m[1].toLowerCase() };
    m = s.match(/youtube\.com\/(?:c|user)\/([A-Za-z0-9._-]+)/);
    if (m) return { kind: "handle", value: "@" + m[1].toLowerCase() };
    return null;
}

/** Svi URL-ovi koje Podscan zna o jednom podcastu (za YouTube cross-match). */
function podscanUrls(p) {
    const out = [];
    const push = (v) => { if (v && typeof v === "string") out.push(v); };
    push(p.podcast_url);
    push(p.rss_url);
    push(p.reach && p.reach.website);
    for (const l of (p.reach && p.reach.social_links) || []) {
        if (typeof l === "string") push(l);
        else if (l && typeof l === "object") { push(l.url); push(l.link); }
    }
    push(p.podcast_description);
    return out;
}

module.exports = {
    stripDiacritics, normalizeName, coreName, tokenJaccard, trigramSim,
    ytIdentity, podscanUrls, NOISE_WORDS,
};

/**
 * Detekcija smeća u Podscanovom `hr` segmentu.
 *
 * Empirijski nalaz (2026-08-26): znatan dio feedova označenih `language=hr`
 * su kineski SEO/engagement-farm feedovi ("自动化平台…", 10 epizoda, identična
 * publika ~1100). Jezik im je očito krivo detektiran. Ako se ne odfiltriraju,
 * popis "podcasta koje bismo trebali imati" postane neupotrebljiv.
 *
 * Heuristika je namjerno konzervativna — gleda PISMO, ne sadržaj: ako naslov
 * sadrži CJK/arapsko/ćirilično pismo, to nije hrvatski podcast.
 */
const NON_LATIN = /[\u3000-\u9fff\uac00-\ud7af\u0600-\u06ff\u0400-\u04ff\u0e00-\u0e7f]/;

function isLikelySpam(p) {
    const name = p.podcast_name || "";
    const desc = p.podcast_description || "";
    if (NON_LATIN.test(name)) return "non-latin-name";
    // Opis pretežno ne-latinicom uz latinično ime — isti obrazac, samo prikriven.
    const nonLatinHits = (desc.match(new RegExp(NON_LATIN.source, "g")) || []).length;
    if (nonLatinHits > 20) return "non-latin-description";
    return null;
}

module.exports.isLikelySpam = isLikelySpam;
module.exports.NON_LATIN = NON_LATIN;

/**
 * Chart odgovor vraća OKRNJENU shemu podcasta: `name` umjesto `podcast_name`,
 * bez `language`/`region`/`rss_url`. Ako se ne normalizira, izvještaj tiho
 * ispusti 900 chart unosa iz uparivanja (nema `podcast_name` → prazno ime).
 *
 * Druga, važnija razlika: chart znači "ovo se sluša U HRVATSKOJ", ne "ovo je
 * hrvatski podcast" — top liste su pune stranih showova. Zato normalizirani
 * zapis nosi `_source: "chart"` i `language: null`, a ne izmišljeni "hr".
 */
function toIso(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return new Date(v * 1000).toISOString();
    if (/^\d+$/.test(String(v))) return new Date(Number(v) * 1000).toISOString();
    return String(v);
}

function normalizePodcast(p) {
    // I search odgovor zna vratiti UNIX sekunde umjesto ISO stringa — nedosljedno
    // po zapisu, ne po endpointu. Zato se datum normalizira u OBA smjera.
    if (p.podcast_name) {
        return {
            ...p,
            last_posted_at: toIso(p.last_posted_at),
            _source: p._chart_source ? "chart+search" : "search",
        };
    }
    return {
        ...p,
        // Chart odgovor daje `last_posted_at` kao UNIX SEKUNDE, dok search daje
        // ISO string. Bez ove pretvorbe Date.parse vrati NaN i svaki chart show
        // ispadne "neaktivan" — 883 živa showa tiho nestanu iz izvještaja.
        last_posted_at: toIso(p.last_posted_at),
        podcast_name: p.name || "",
        podcast_description: p.description || "",
        rss_url: p.rss_url || null,
        language: p.language || null,
        region: p.region || null,
        episode_count: p.episode_count,
        episodes_in_database: p.episodes_in_database,
        is_active: p.is_active,
        reach: p.reach || { audience_size: p.audience_size || 0, social_links: [] },
        _source: "chart",
    };
}

module.exports.normalizePodcast = normalizePodcast;
