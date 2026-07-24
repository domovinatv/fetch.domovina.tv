#!/usr/bin/env node

/**
 * Regresijski testovi za generate_article_gemini.js
 *
 * Pokretanje: node --test generate_article_gemini.test.js
 *
 * Koristi Node.js ugrađeni test runner (node:test) — nema vanjskih ovisnosti.
 * Fiksture su bazirane na stvarnim Gemini API odgovorima s diska.
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
    extractJsonFromText,
    tryRepairMalformedJson,
    tryRepairTruncatedJson,
    sanitizeJsonControlChars,
    buildRoundRobinQueue,
    findLatestFile,
    hasCompleteArticle,
    discoverPendingFiles,
    processFile,
    callGemini,
    DIARIZED_SRT_SUFFIX,
    loadPublisherChapters,
    countSpeakers,
    buildNameTokenSet,
    extractNameCandidates,
    auditNames,
    STRICT_SPEAKER_THRESHOLD,
    MODEL_SLUG,
    sectionsMissingFields,
    _setTestToken,
} = require("./generate_article_gemini.js");


// ─── FIKSTURE bazirane na stvarnim podacima ─────────────────────

const FIXTURE_OUTLINE = {
    iterations: [
        {
            iteration_number: 1,
            start_time: "00:00:00",
            end_time: "00:41:17",
            theme: "Duhovno razmatranje o križu i zaštiti života",
            reason_for_cut: "Rez napravljen nakon završetka bloka osobnih zahvala.",
            chapters: [
                { timestamp: "00:00:00", topic: "Uvodna meditacija o Kristovoj muci" },
                { timestamp: "00:07:03", topic: "Navještaj evanđelja: Raspeće" },
                { timestamp: "00:09:41", topic: "Značenje kampanje 40 dana za život" },
            ],
        },
        {
            iteration_number: 2,
            start_time: "00:41:17",
            end_time: "01:03:58",
            theme: "Zagovorne molitve, litanije i završni blagoslov",
            reason_for_cut: "Završni dio pobožnosti s litanijama i blagoslovom.",
            chapters: [
                { timestamp: "00:41:17", topic: "Zagovorna molitva za Crkvu" },
                { timestamp: "00:46:23", topic: "Molitva za kršćansko jedinstvo" },
            ],
        },
    ],
};

const FIXTURE_SECTIONS = [
    {
        subtitle: "Unutarnje borbe i trenutak odluke",
        screenshot_timestamp: "00:01:45",
        screenshot_description: "Majka opisuje trenutak odluke.",
        content: "Razgovor započinje potresnim svjedočanstvom majke koja opisuje emocionalni kaos.\n\nIpak, sudbonosni susret promijenio je sve.",
        keywords: ["svjedočanstvo", "pobačaj", "život"],
        entities: ["Betlehem", "bolnica Merkur"],
    },
    {
        subtitle: "Globalna kriza: Statistika koja oduzima dah",
        screenshot_timestamp: "00:04:15",
        screenshot_description: "Ante Čaljkušić iznosi podatke.",
        content: "Voditelj inicijative, **Ante Čaljkušić**, stavlja priče u širi kontekst.",
        keywords: ["statistika", "kriza", "pobačaj"],
        entities: ["Ante Čaljkušić"],
    },
    {
        subtitle: "Tri stupa inicijative: Molitva, bdijenje i osvješćivanje",
        screenshot_timestamp: "00:07:50",
        screenshot_description: "Prikaz molitelja ispred bolnice.",
        content: "Inicijativa **40 dana za život** predstavljena je kao najveća ekumenska pro-life inicijativa.",
        keywords: ["molitva", "bdijenje", "osvješćivanje"],
        entities: ["Petra Tišljarić", "Ante Čaljkušić"],
    },
];

const FIXTURE_ARTICLE = {
    metadata: {
        source_file: "20200406_test.wav.canary.diarized.srt",
        generated_at: "2026-03-16T19:27:22.608Z",
        model: "gemini-2.5-flash",
    },
    iterations: [
        {
            iteration_number: 1,
            start_time: "00:00:00",
            end_time: "00:41:17",
            theme: "Duhovno razmatranje",
            sections: FIXTURE_SECTIONS,
        },
        {
            iteration_number: 2,
            start_time: "00:41:17",
            end_time: "01:03:58",
            theme: "Zagovorne molitve",
            sections: [FIXTURE_SECTIONS[0]],
        },
    ],
};

const FIXTURE_SRT = `1
00:00:00,000 --> 00:00:05,000
SPEAKER_00: Dobro došli u emisiju.

2
00:00:05,000 --> 00:00:12,000
SPEAKER_01: Hvala, drago mi je biti ovdje.

3
00:00:12,000 --> 00:00:20,000
SPEAKER_00: Danas ćemo razgovarati o važnoj temi.
`;


// ─── HELPERS ────────────────────────────────────────────────────

/** Kreira privremeni direktorij za test */
function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-"));
}

/** Čisti privremeni direktorij */
function rmTmpDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}


// ═══════════════════════════════════════════════════════════════
// TESTOVI: extractJsonFromText
// ═══════════════════════════════════════════════════════════════

describe("extractJsonFromText", () => {
    it("parsira validan JSON objekt", () => {
        const input = JSON.stringify(FIXTURE_OUTLINE);
        const result = extractJsonFromText(input);
        assert.equal(result.iterations.length, 2);
        assert.equal(result.iterations[0].theme, FIXTURE_OUTLINE.iterations[0].theme);
    });

    it("parsira validan JSON niz", () => {
        const input = JSON.stringify(FIXTURE_SECTIONS);
        const result = extractJsonFromText(input);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 3);
        assert.equal(result[0].subtitle, FIXTURE_SECTIONS[0].subtitle);
    });

    it("uklanja markdown code block wrapper (```json ... ```)", () => {
        const input = "```json\n" + JSON.stringify(FIXTURE_OUTLINE) + "\n```";
        const result = extractJsonFromText(input);
        assert.equal(result.iterations.length, 2);
    });

    it("uklanja goli markdown wrapper (``` ... ```)", () => {
        const input = "```\n" + JSON.stringify({ sections: FIXTURE_SECTIONS }) + "\n```";
        const result = extractJsonFromText(input);
        assert.equal(result.sections.length, 3);
    });

    it("popravlja JSON s kontrolnim znakovima", () => {
        // Ubaci sirovi tab i null byte unutar stringa
        const raw = '{"sections": [{"subtitle": "Test\x00s\tnaslov", "content": "ok"}]}';
        const result = extractJsonFromText(raw);
        assert.equal(result.sections.length, 1);
        assert.ok(result.sections[0].subtitle.includes("Test"));
    });

    it("popravlja skraćeni (truncated) JSON — sekcije u objektu", () => {
        const fullJson = JSON.stringify({ sections: FIXTURE_SECTIONS });
        // Odsijeci u sredini treće sekcije
        const truncated = fullJson.substring(0, fullJson.indexOf('"Tri stupa') + 5);
        const result = extractJsonFromText(truncated);
        assert.equal(result.sections.length, 2);
        assert.equal(result.sections[0].subtitle, FIXTURE_SECTIONS[0].subtitle);
        assert.equal(result.sections[1].subtitle, FIXTURE_SECTIONS[1].subtitle);
    });

    it("popravlja skraćeni (truncated) JSON — goli niz", () => {
        const fullJson = JSON.stringify(FIXTURE_SECTIONS);
        const truncated = fullJson.substring(0, fullJson.indexOf('"Tri stupa') + 5);
        const result = extractJsonFromText(truncated);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 2);
    });

    it("baca grešku za potpuno nepopravljiv JSON", () => {
        assert.throws(() => extractJsonFromText("ovo nije json uopće"));
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: tryRepairMalformedJson
// ═══════════════════════════════════════════════════════════════

describe("tryRepairMalformedJson", () => {
    it("popravlja goli key-value par u nizu (nedostaje {)", () => {
        // Gemini ponekad vrati ["key": "val"] umjesto [{"key": "val"}]
        const malformed = '[  "subtitle": "Test", "content": "Tekst" ]';
        const result = tryRepairMalformedJson(malformed);
        assert.notEqual(result, null);
        assert.ok(Array.isArray(result));
        assert.equal(result[0].subtitle, "Test");
    });

    it("popravlja nedostajuću } prije ]", () => {
        const malformed = '[{"subtitle": "A", "content": "x" ]';
        const result = tryRepairMalformedJson(malformed);
        assert.notEqual(result, null);
    });

    it("ne popravlja nedostajući separator između zatvorenih objekata (ograničenje)", () => {
        // Ovo tryRepairMalformedJson ne pokriva — pokriva samo slučaj
        // kad nedostaje i '}' i ',' (tj. [{"a": 1 {"b": 2}])
        const malformed = '[{"a": 1} {"b": 2}]';
        const result = tryRepairMalformedJson(malformed);
        assert.equal(result, null);
    });

    it("vraća null za nepopravljiv JSON", () => {
        const broken = "{{{{";
        const result = tryRepairMalformedJson(broken);
        assert.equal(result, null);
    });

    it("vraća parsirani rezultat za validan JSON", () => {
        const valid = '{"key": "value"}';
        const result = tryRepairMalformedJson(valid);
        assert.deepEqual(result, { key: "value" });
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: tryRepairTruncatedJson
// ═══════════════════════════════════════════════════════════════

describe("tryRepairTruncatedJson", () => {
    it("spašava kompletne sekcije iz skraćenog objekta", () => {
        const full = { sections: FIXTURE_SECTIONS };
        const json = JSON.stringify(full);
        // Odsijeci u sredini zadnje sekcije
        const cutPoint = json.lastIndexOf('"Tri stupa');
        const truncated = json.substring(0, cutPoint + 5);
        const result = tryRepairTruncatedJson(truncated);
        assert.notEqual(result, null);
        assert.equal(result.sections.length, 2);
    });

    it("spašava kompletne elemente iz skraćenog niza", () => {
        const json = JSON.stringify(FIXTURE_SECTIONS);
        const cutPoint = json.lastIndexOf('"Tri stupa');
        const truncated = json.substring(0, cutPoint + 5);
        const result = tryRepairTruncatedJson(truncated);
        assert.notEqual(result, null);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 2);
    });

    it("radi s escaped navodnicima u sadržaju", () => {
        const data = {
            sections: [
                { subtitle: "First", content: 'She said "hello" to him' },
                { subtitle: "Second", content: 'He said "wor' },
            ],
        };
        // Ručno konstruiraj truncated JSON s escaped navodnicima
        const json = JSON.stringify(data);
        // Odsijeci u sredini drugog elementa
        const cutPoint = json.indexOf('"Second"') + 15;
        const truncated = json.substring(0, cutPoint);
        const result = tryRepairTruncatedJson(truncated);
        assert.notEqual(result, null);
        assert.equal(result.sections.length, 1);
        assert.equal(result.sections[0].subtitle, "First");
    });

    it("vraća null kad nema kompletnog objekta", () => {
        const truncated = '{"sections": [{"subtitle": "start';
        const result = tryRepairTruncatedJson(truncated);
        assert.equal(result, null);
    });

    it("radi s ugniježđenim nizovima (keywords, entities)", () => {
        const full = { sections: FIXTURE_SECTIONS };
        const json = JSON.stringify(full);
        // Odsijeci nakon drugog elementa ali u sredini trećeg
        const thirdStart = json.indexOf('"Tri stupa');
        const truncated = json.substring(0, thirdStart + 20);
        const result = tryRepairTruncatedJson(truncated);
        assert.notEqual(result, null);
        assert.equal(result.sections.length, 2);
        // Provjeri da su keywords i entities sačuvani u prvom elementu
        assert.deepEqual(result.sections[0].keywords, FIXTURE_SECTIONS[0].keywords);
        assert.deepEqual(result.sections[0].entities, FIXTURE_SECTIONS[0].entities);
    });

    it("popravlja JSON odrezan na samom kraju (nedostaje ]}", () => {
        const full = { sections: [FIXTURE_SECTIONS[0]] };
        const json = JSON.stringify(full);
        // Ukloni zadnja 2 znaka (]} )
        const truncated = json.substring(0, json.length - 2);
        const result = tryRepairTruncatedJson(truncated);
        assert.notEqual(result, null);
        assert.equal(result.sections.length, 1);
    });

    it("spašava outline iteracije iz skraćenog odgovora", () => {
        const json = JSON.stringify(FIXTURE_OUTLINE);
        // Odsijeci u sredini druge iteracije
        const cutPoint = json.indexOf('"Zagovorna molitva') + 10;
        const truncated = json.substring(0, cutPoint);
        const result = tryRepairTruncatedJson(truncated);
        assert.notEqual(result, null);
        assert.equal(result.iterations.length, 1);
        assert.equal(result.iterations[0].iteration_number, 1);
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: sanitizeJsonControlChars
// ═══════════════════════════════════════════════════════════════

describe("sanitizeJsonControlChars", () => {
    it("uklanja null byte", () => {
        const input = 'test\x00text';
        assert.equal(sanitizeJsonControlChars(input), "testtext");
    });

    it("uklanja bell, backspace i ostale opskurne kontrolne znakove", () => {
        const input = 'ab\x07cd\x08ef\x0Egh';
        assert.equal(sanitizeJsonControlChars(input), "abcdefgh");
    });

    it("escapea tab u \\t", () => {
        const input = 'before\tafter';
        assert.equal(sanitizeJsonControlChars(input), "before\\tafter");
    });

    it("ne dira tekst bez kontrolnih znakova", () => {
        const input = '{"key": "normalan tekst s hrvatskim dijakritikama čćžšđ"}';
        assert.equal(sanitizeJsonControlChars(input), input);
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: buildRoundRobinQueue
// ═══════════════════════════════════════════════════════════════

describe("buildRoundRobinQueue", () => {
    it("isprepliće kanale ravnomjerno", () => {
        const byChannel = new Map([
            ["kanal_a", ["/a/1.srt", "/a/2.srt"]],
            ["kanal_b", ["/b/1.srt", "/b/2.srt"]],
        ]);
        const queue = buildRoundRobinQueue(byChannel);
        assert.equal(queue.length, 4);
        // Prvih dvoje su po jedan iz svakog kanala
        assert.equal(queue[0].channel, "kanal_a");
        assert.equal(queue[1].channel, "kanal_b");
        assert.equal(queue[2].channel, "kanal_a");
        assert.equal(queue[3].channel, "kanal_b");
    });

    it("radi s nejednakim brojem datoteka po kanalu", () => {
        const byChannel = new Map([
            ["kanal_a", ["/a/1.srt", "/a/2.srt", "/a/3.srt"]],
            ["kanal_b", ["/b/1.srt"]],
        ]);
        const queue = buildRoundRobinQueue(byChannel);
        assert.equal(queue.length, 4);
        assert.equal(queue[0].channel, "kanal_a");
        assert.equal(queue[1].channel, "kanal_b");
        assert.equal(queue[2].channel, "kanal_a");
        assert.equal(queue[3].channel, "kanal_a");
    });

    it("radi s jednim kanalom", () => {
        const byChannel = new Map([
            ["solo", ["/s/1.srt", "/s/2.srt"]],
        ]);
        const queue = buildRoundRobinQueue(byChannel);
        assert.equal(queue.length, 2);
        assert.equal(queue[0].channel, "solo");
        assert.equal(queue[1].channel, "solo");
    });

    it("vraća prazan niz za prazan ulaz", () => {
        const queue = buildRoundRobinQueue(new Map());
        assert.equal(queue.length, 0);
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: findLatestFile (koristi privremeni direktorij)
// ═══════════════════════════════════════════════════════════════

describe("findLatestFile", () => {
    let tmpDir;

    before(() => {
        tmpDir = makeTmpDir();
        // Kreiraj testne datoteke s različitim datumima
        fs.writeFileSync(path.join(tmpDir, `test_2026-03-10_${MODEL_SLUG}.outline.json`), "{}");
        fs.writeFileSync(path.join(tmpDir, `test_2026-03-15_${MODEL_SLUG}.outline.json`), "{}");
        fs.writeFileSync(path.join(tmpDir, `test_2026-03-15_${MODEL_SLUG}.article.json`), "{}");
        // macOS resource fork datoteka — treba biti ignorirana
        fs.writeFileSync(path.join(tmpDir, `._test_2026-03-20_${MODEL_SLUG}.outline.json`), "{}");
    });

    after(() => rmTmpDir(tmpDir));

    it("pronalazi najnoviju outline datoteku", () => {
        const result = findLatestFile(tmpDir, "test", "outline");
        assert.ok(result);
        assert.ok(result.includes("2026-03-15"));
        assert.ok(result.endsWith(".outline.json"));
    });

    it("pronalazi article datoteku", () => {
        const result = findLatestFile(tmpDir, "test", "article");
        assert.ok(result);
        assert.ok(result.endsWith(".article.json"));
    });

    it("vraća null kad nema podudaranja", () => {
        const result = findLatestFile(tmpDir, "nepostojeci", "outline");
        assert.equal(result, null);
    });

    it("ignorira macOS resource fork datoteke (._)", () => {
        const result = findLatestFile(tmpDir, "test", "outline");
        assert.ok(!result.includes("._"));
        assert.ok(!result.includes("2026-03-20"));
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: hasCompleteArticle (koristi privremeni direktorij)
// ═══════════════════════════════════════════════════════════════

describe("hasCompleteArticle", () => {
    let tmpDir;

    before(() => {
        tmpDir = makeTmpDir();
    });

    after(() => rmTmpDir(tmpDir));

    it("vraća true za kompletiran članak s ispravnim brojem iteracija", () => {
        const basename = "complete_test.wav.canary.diarized";
        fs.writeFileSync(
            path.join(tmpDir, `${basename}_2026-03-15_${MODEL_SLUG}.outline.json`),
            JSON.stringify(FIXTURE_OUTLINE)
        );
        fs.writeFileSync(
            path.join(tmpDir, `${basename}_2026-03-15_${MODEL_SLUG}.article.json`),
            JSON.stringify(FIXTURE_ARTICLE)
        );
        assert.equal(hasCompleteArticle(tmpDir, basename + ".srt"), true);
    });

    it("vraća false kad članak ima manje iteracija nego outline", () => {
        const basename = "incomplete_iter.wav.canary.diarized";
        fs.writeFileSync(
            path.join(tmpDir, `${basename}_2026-03-15_${MODEL_SLUG}.outline.json`),
            JSON.stringify(FIXTURE_OUTLINE) // 2 iteracije
        );
        const partialArticle = {
            ...FIXTURE_ARTICLE,
            iterations: [FIXTURE_ARTICLE.iterations[0]], // samo 1 iteracija
        };
        fs.writeFileSync(
            path.join(tmpDir, `${basename}_2026-03-15_${MODEL_SLUG}.article.json`),
            JSON.stringify(partialArticle)
        );
        assert.equal(hasCompleteArticle(tmpDir, basename + ".srt"), false);
    });

    it("vraća false kad iteracija ima prazan sections niz", () => {
        const basename = "empty_sections.wav.canary.diarized";
        const articleEmptySections = {
            ...FIXTURE_ARTICLE,
            iterations: [
                { ...FIXTURE_ARTICLE.iterations[0] },
                { ...FIXTURE_ARTICLE.iterations[1], sections: [] },
            ],
        };
        fs.writeFileSync(
            path.join(tmpDir, `${basename}_2026-03-15_${MODEL_SLUG}.outline.json`),
            JSON.stringify(FIXTURE_OUTLINE)
        );
        fs.writeFileSync(
            path.join(tmpDir, `${basename}_2026-03-15_${MODEL_SLUG}.article.json`),
            JSON.stringify(articleEmptySections)
        );
        assert.equal(hasCompleteArticle(tmpDir, basename + ".srt"), false);
    });

    it("vraća false kad nema article datoteke", () => {
        assert.equal(hasCompleteArticle(tmpDir, "nonexistent.wav.canary.diarized.srt"), false);
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: discoverPendingFiles (koristi privremeni direktorij)
// ═══════════════════════════════════════════════════════════════

describe("discoverPendingFiles", () => {
    let tmpDir;

    before(() => {
        tmpDir = makeTmpDir();

        // Kanal A: 2 SRT-a, 1 kompletiran, 1 pending
        const chA = path.join(tmpDir, "channel_a");
        fs.mkdirSync(chA);
        // Kompletiran video
        const baseDone = "20260101_done_yt_abc123.wav.canary.diarized";
        fs.writeFileSync(path.join(chA, baseDone + ".srt"), FIXTURE_SRT);
        fs.writeFileSync(
            path.join(chA, `${baseDone}_2026-03-15_${MODEL_SLUG}.outline.json`),
            JSON.stringify({ iterations: [FIXTURE_OUTLINE.iterations[0]] })
        );
        fs.writeFileSync(
            path.join(chA, `${baseDone}_2026-03-15_${MODEL_SLUG}.article.json`),
            JSON.stringify({
                metadata: {},
                iterations: [{
                    iteration_number: 1,
                    sections: FIXTURE_SECTIONS,
                }],
            })
        );
        // Pending video
        const basePending = "20260201_pending_yt_def456.wav.canary.diarized";
        fs.writeFileSync(path.join(chA, basePending + ".srt"), FIXTURE_SRT);

        // Kanal B: 1 blokirani SRT
        const chB = path.join(tmpDir, "channel_b");
        fs.mkdirSync(chB);
        const baseBlocked = "20260301_blocked_yt_ghi789.wav.canary.diarized";
        fs.writeFileSync(path.join(chB, baseBlocked + ".srt"), FIXTURE_SRT);
        fs.writeFileSync(
            path.join(chB, `${baseBlocked}.blocked.json`),
            JSON.stringify({ blocked_at: new Date().toISOString(), reason: "PROHIBITED_CONTENT" })
        );

        // Kanal C: 1 pending SRT
        const chC = path.join(tmpDir, "channel_c");
        fs.mkdirSync(chC);
        const basePendingC = "20260315_test_yt_jkl012.wav.canary.diarized";
        fs.writeFileSync(path.join(chC, basePendingC + ".srt"), FIXTURE_SRT);
    });

    after(() => rmTmpDir(tmpDir));

    it("pronalazi SRT datoteke bez kompletiranog članka", () => {
        const { byChannel } = discoverPendingFiles(tmpDir, null, new Set());
        // channel_a ima 1 pending, channel_b ima 0 (blokirano), channel_c ima 1
        assert.equal(byChannel.size, 2);
        assert.ok(byChannel.has("channel_a"));
        assert.ok(byChannel.has("channel_c"));
        assert.ok(!byChannel.has("channel_b"));
    });

    it("preskače blokirane datoteke", () => {
        const { byChannel } = discoverPendingFiles(tmpDir, "channel_b", new Set());
        assert.equal(byChannel.size, 0);
    });

    it("filtrira po kanalu", () => {
        const { byChannel } = discoverPendingFiles(tmpDir, "channel_c", new Set());
        assert.equal(byChannel.size, 1);
        assert.ok(byChannel.has("channel_c"));
        assert.equal(byChannel.get("channel_c").length, 1);
    });

    it("preskače kompletiran članak", () => {
        const { byChannel } = discoverPendingFiles(tmpDir, "channel_a", new Set());
        assert.equal(byChannel.get("channel_a").length, 1);
        const pendingFile = path.basename(byChannel.get("channel_a")[0]);
        assert.ok(pendingFile.includes("pending"));
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: Regresija na stvarnim datotekama s diska
// ═══════════════════════════════════════════════════════════════

describe("regresija na stvarnim podacima s diska", () => {
    const REAL_DATA_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output/40_dana_za_zivot";
    const REAL_RAW_DIR = path.join(
        REAL_DATA_DIR,
        "20190411_40_dana_40_days_yt_AAzm0ftoqsg.wav.canary.diarized_2026-03-16_gemini-3-flash-preview_raw"
    );

    // Preskoči testove ako disk nije mountan
    function skipIfNoData() {
        if (!fs.existsSync(REAL_DATA_DIR)) {
            return true;
        }
        return false;
    }

    it("parsira stvarni Faza 1 raw odgovor (outline)", () => {
        if (skipIfNoData()) return;
        const rawPath = path.join(REAL_RAW_DIR, "faza1_outline.raw.txt");
        if (!fs.existsSync(rawPath)) return;

        const raw = fs.readFileSync(rawPath, "utf-8");
        const result = extractJsonFromText(raw);

        assert.ok(result.iterations || Array.isArray(result));
        const iterations = result.iterations || result;
        assert.ok(iterations.length >= 1);
        assert.ok(iterations[0].start_time);
        assert.ok(iterations[0].chapters.length >= 1);
    });

    it("parsira stvarni Faza 2 raw odgovor (sekcije)", () => {
        if (skipIfNoData()) return;
        const rawPath = path.join(REAL_RAW_DIR, "faza2_iteracija_1.raw.txt");
        if (!fs.existsSync(rawPath)) return;

        const raw = fs.readFileSync(rawPath, "utf-8");
        const result = extractJsonFromText(raw);

        const sections = result.sections || (Array.isArray(result) ? result : []);
        assert.ok(sections.length >= 1);
        assert.ok(sections[0].subtitle);
        assert.ok(sections[0].content);
        assert.ok(sections[0].screenshot_timestamp);
    });

    it("simulira truncation na stvarnom raw odgovoru i spašava sekcije", () => {
        if (skipIfNoData()) return;
        const rawPath = path.join(REAL_RAW_DIR, "faza2_iteracija_1.raw.txt");
        if (!fs.existsSync(rawPath)) return;

        const raw = fs.readFileSync(rawPath, "utf-8");
        const fullResult = extractJsonFromText(raw);
        const fullSections = fullResult.sections || (Array.isArray(fullResult) ? fullResult : []);

        // Odsijeci na 60% duljine (simulira MAX_TOKENS truncation)
        const cutAt = Math.floor(raw.length * 0.6);
        const truncated = raw.substring(0, cutAt);

        const repaired = tryRepairTruncatedJson(truncated);
        assert.notEqual(repaired, null, "Repair trebao uspjeti na skraćenom stvarnom odgovoru");

        const repairedSections = repaired.sections || (Array.isArray(repaired) ? repaired : []);
        assert.ok(repairedSections.length >= 1, "Trebao spasiti bar 1 sekciju");
        assert.ok(repairedSections.length < fullSections.length, "Skraćeni rezultat ima manje sekcija");

        // Provjeri da su spašene sekcije identične originalnima
        for (let i = 0; i < repairedSections.length; i++) {
            assert.equal(repairedSections[i].subtitle, fullSections[i].subtitle,
                `Sekcija ${i} subtitle treba biti identičan originalu`);
            assert.equal(repairedSections[i].content, fullSections[i].content,
                `Sekcija ${i} content treba biti identičan originalu`);
        }
    });

    it("simulira truncation na 90% stvarnog odgovora — spašava većinu sekcija", () => {
        if (skipIfNoData()) return;
        const rawPath = path.join(REAL_RAW_DIR, "faza2_iteracija_1.raw.txt");
        if (!fs.existsSync(rawPath)) return;

        const raw = fs.readFileSync(rawPath, "utf-8");
        const fullResult = extractJsonFromText(raw);
        const fullSections = fullResult.sections || (Array.isArray(fullResult) ? fullResult : []);

        const cutAt = Math.floor(raw.length * 0.9);
        const truncated = raw.substring(0, cutAt);

        const repaired = tryRepairTruncatedJson(truncated);
        assert.notEqual(repaired, null);

        const repairedSections = repaired.sections || (Array.isArray(repaired) ? repaired : []);
        // Na 90% bi trebalo spasiti većinu sekcija
        assert.ok(
            repairedSections.length >= Math.floor(fullSections.length * 0.7),
            `Spašeno ${repairedSections.length}/${fullSections.length} sekcija — očekivano >= 70%`
        );
    });

    it("hasCompleteArticle potvrđuje stvarni kompletiran članak", () => {
        if (skipIfNoData()) return;
        const srtName = "20190411_40_dana_40_days_yt_AAzm0ftoqsg.wav.canary.diarized.srt";
        const basename = srtName.replace(/\.srt$/, "");

        // hasCompleteArticle je scopean na MODEL_SLUG (promjena modela = regeneracija).
        // Fikstura na disku sadrži članke starijih modela, pa test ima smisla samo ako
        // postoji članak za TRENUTNO konfigurirani model — inače nema što potvrditi.
        const hasFixture = fs.readdirSync(REAL_DATA_DIR)
            .some(f => f.startsWith(`${basename}_`) && f.endsWith(`_${MODEL_SLUG}.article.json`) && !f.startsWith("._"));
        if (!hasFixture) return;

        const result = hasCompleteArticle(REAL_DATA_DIR, srtName);
        assert.equal(result, true, "Stvarni kompletiran članak bi trebao biti prepoznat");
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: processFile integracija s mockanim Gemini API-jem
// ═══════════════════════════════════════════════════════════════

describe("processFile s mockanim API-jem", () => {
    let tmpDir;
    let srtPath;
    let originalFetch;

    before(() => {
        originalFetch = global.fetch;
        tmpDir = makeTmpDir();

        // Kreiraj testni SRT
        srtPath = path.join(tmpDir, "20260101_test_yt_abc123.wav.canary.diarized.srt");
        fs.writeFileSync(srtPath, FIXTURE_SRT);

        // Postavi fake token da se ne poziva gcloud auth
        _setTestToken("fake-test-token-12345");
    });

    after(() => {
        global.fetch = originalFetch;
    });

    it("generira outline i article s mockanim odgovorima", async () => {
        let callCount = 0;

        // Outline s jednom iteracijom (pojednostavljeno za brži test)
        const simpleOutline = {
            iterations: [{
                iteration_number: 1,
                start_time: "00:00:00",
                end_time: "00:00:20",
                theme: "Testna tema",
                reason_for_cut: "Kratki transkript.",
                chapters: [
                    { timestamp: "00:00:00", topic: "Uvod" },
                ],
            }],
        };

        const simpleSections = {
            sections: [{
                subtitle: "Testni podnaslov",
                screenshot_timestamp: "00:00:05",
                screenshot_description: "Test screenshot.",
                content: "Testni sadržaj članka.",
                keywords: ["test"],
                entities: ["TestEntity"],
            }],
        };

        global.fetch = async (url, opts) => {
            callCount++;
            const responseText = callCount === 1
                ? JSON.stringify(simpleOutline)
                : JSON.stringify(simpleSections);

            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: {
                            parts: [{ text: responseText }],
                        },
                        finishReason: "STOP",
                    }],
                }),
            };
        };

        const result = await processFile(srtPath, { exitOnError: false });
        assert.equal(result, true, "processFile bi trebao uspjeti");
        assert.equal(callCount, 2, "Trebala su biti 2 API poziva (outline + 1 iteracija)");

        // Provjeri da su generirane datoteke
        const files = fs.readdirSync(tmpDir);
        const outlineFile = files.find((f) => f.endsWith(".outline.json"));
        const articleFile = files.find((f) => f.endsWith(".article.json"));
        assert.ok(outlineFile, "Outline datoteka bi trebala postojati");
        assert.ok(articleFile, "Article datoteka bi trebala postojati");

        // Provjeri sadržaj article datoteke
        const article = JSON.parse(fs.readFileSync(path.join(tmpDir, articleFile), "utf-8"));
        assert.equal(article.iterations.length, 1);
        assert.equal(article.iterations[0].sections.length, 1);
        assert.equal(article.iterations[0].sections[0].subtitle, "Testni podnaslov");
    });

    it("preskače već kompletiran članak", async () => {
        let callCount = 0;
        global.fetch = async () => {
            callCount++;
            return { ok: true, status: 200, json: async () => ({}) };
        };

        // processFile iz prethodnog testa je kreirao datoteke — ponovni poziv ih preskače
        const result = await processFile(srtPath, { exitOnError: false });
        assert.equal(result, true);
        assert.equal(callCount, 0, "Ne smije biti API poziva za već kompletiran članak");
    });

    it("nastavlja od postojećeg outlinea bez ponovnog poziva za Fazu 1", async () => {
        const tmpDir2 = makeTmpDir();
        const srtPath2 = path.join(tmpDir2, "20260201_resume_yt_xyz789.wav.canary.diarized.srt");
        fs.writeFileSync(srtPath2, FIXTURE_SRT);

        // Spremi outline unaprijed
        const basename = "20260201_resume_yt_xyz789.wav.canary.diarized";
        const today = new Date().toISOString().split("T")[0];
        const outlinePath = path.join(tmpDir2, `${basename}_${today}_${MODEL_SLUG}.outline.json`);
        const simpleOutline = {
            iterations: [{
                iteration_number: 1,
                start_time: "00:00:00",
                end_time: "00:00:20",
                theme: "Resume test",
                reason_for_cut: "Test.",
                chapters: [{ timestamp: "00:00:00", topic: "Uvod" }],
            }],
        };
        fs.writeFileSync(outlinePath, JSON.stringify(simpleOutline));

        let callCount = 0;
        global.fetch = async () => {
            callCount++;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    sections: [{ subtitle: "S", screenshot_timestamp: "00:00:05", screenshot_description: "D", content: "C", keywords: ["k"], entities: ["e"] }],
                                }),
                            }],
                        },
                        finishReason: "STOP",
                    }],
                }),
            };
        };

        const result = await processFile(srtPath2, { exitOnError: false });
        assert.equal(result, true);
        assert.equal(callCount, 1, "Samo 1 API poziv (Faza 2), jer outline već postoji");

        rmTmpDir(tmpDir2);
    });

    it("spašava parcijalni članak kad Gemini vrati truncated JSON", async () => {
        const tmpDir3 = makeTmpDir();
        const srtPath3 = path.join(tmpDir3, "20260301_truncated_yt_trn123.wav.canary.diarized.srt");
        fs.writeFileSync(srtPath3, FIXTURE_SRT);

        // Outline s 2 iteracije
        const outline2 = {
            iterations: [
                {
                    iteration_number: 1,
                    start_time: "00:00:00",
                    end_time: "00:00:10",
                    theme: "Prva tema",
                    reason_for_cut: "Test.",
                    chapters: [{ timestamp: "00:00:00", topic: "A" }],
                },
                {
                    iteration_number: 2,
                    start_time: "00:00:10",
                    end_time: "00:00:20",
                    theme: "Druga tema",
                    reason_for_cut: "Test.",
                    chapters: [{ timestamp: "00:00:10", topic: "B" }],
                },
            ],
        };

        let callCount = 0;
        global.fetch = async () => {
            callCount++;
            let responseText;
            if (callCount === 1) {
                // Faza 1: outline
                responseText = JSON.stringify(outline2);
            } else if (callCount === 2) {
                // Faza 2, iteracija 1: normalan odgovor
                responseText = JSON.stringify({
                    sections: [{
                        subtitle: "Sekcija 1",
                        screenshot_timestamp: "00:00:02",
                        screenshot_description: "D",
                        content: "Sadržaj prve sekcije.",
                        keywords: ["k"],
                        entities: ["e"],
                    }],
                });
            } else {
                // Faza 2, iteracija 2: truncated JSON!
                const full = JSON.stringify({
                    sections: [
                        { subtitle: "Sekcija A", screenshot_timestamp: "00:00:12", screenshot_description: "X", content: "Kompletna sekcija A.", keywords: ["a"], entities: ["A"] },
                        { subtitle: "Sekcija B", screenshot_timestamp: "00:00:15", screenshot_description: "Y", content: "Ova sekcija ce biti odsjecena u sredini" },
                    ],
                });
                // Odsijeci u sredini Sekcije B
                responseText = full.substring(0, full.indexOf("Ova sekcija") + 15);
            }

            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: { parts: [{ text: responseText }] },
                        finishReason: callCount === 3 ? "MAX_TOKENS" : "STOP",
                    }],
                }),
            };
        };

        const result = await processFile(srtPath3, { exitOnError: false });
        assert.equal(result, true, "processFile bi trebao uspjeti unatoč truncation");

        // Provjeri article
        const files = fs.readdirSync(tmpDir3);
        const articleFile = files.find((f) => f.endsWith(".article.json"));
        assert.ok(articleFile);

        const article = JSON.parse(fs.readFileSync(path.join(tmpDir3, articleFile), "utf-8"));
        assert.equal(article.iterations.length, 2);
        // Iteracija 1 — normalna
        assert.equal(article.iterations[0].sections.length, 1);
        // Iteracija 2 — samo Sekcija A spašena (B je odrezana)
        assert.equal(article.iterations[1].sections.length, 1);
        assert.equal(article.iterations[1].sections[0].subtitle, "Sekcija A");

        rmTmpDir(tmpDir3);
    });
});

// ─── ATRIBUCIJA GOVORNIKA: chapter-mapa + strict-mode + name-audit ───────
// Vidi docs/speaker_attribution_hallucination_2026-07.md.
describe("atribucija govornika — chapter-mapa i strict-mode", () => {
    let tmpDir;
    before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attr-test-")); });
    after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it("loadPublisherChapters parsira .description 'MM:SS Ime' retke", () => {
        const ep = "ep1";
        fs.writeFileSync(path.join(tmpDir, `${ep}.description`),
            "Neki uvodni tekst bez timestampa\n00:00 Početak\n03:05 Petar Buljan\n14:20 Fra Marin Karačić\nwww.link.com\n");
        const ch = loadPublisherChapters(tmpDir, ep);
        assert.equal(ch.length, 3);
        assert.deepEqual(ch[1], { seconds: 185, label: "Petar Buljan" });
    });

    it("loadPublisherChapters preferira .info.json chapters (strukturirano)", () => {
        const ep = "ep2";
        fs.writeFileSync(path.join(tmpDir, `${ep}.info.json`), JSON.stringify({
            chapters: [{ start_time: 0, title: "Uvod" }, { start_time: 185.4, title: "Petar Buljan" }]
        }));
        fs.writeFileSync(path.join(tmpDir, `${ep}.description`), "05:00 Netko Drugi\n");
        const ch = loadPublisherChapters(tmpDir, ep);
        assert.equal(ch.length, 2);              // iz info.json, ne iz .description
        assert.equal(ch[1].label, "Petar Buljan");
        assert.equal(ch[1].seconds, 185);        // zaokruženo
    });

    it("loadPublisherChapters vraća [] kad nema ni info.json ni description", () => {
        assert.deepEqual(loadPublisherChapters(tmpDir, "nepostoji"), []);
    });

    it("countSpeakers broji jedinstvene [SPEAKER_XX]", () => {
        const srt = "1\n00:00:01,000 --> 00:00:02,000\n[SPEAKER_00] a\n\n2\n00:00:03,000 --> 00:00:04,000\n[SPEAKER_05] b\n\n3\n[SPEAKER_00] c\n";
        assert.equal(countSpeakers(srt), 2);
    });

    it("name-audit flag-a IZMIŠLJENA imena, a NE prava (iz mape/transkripta), tolerira hrv. deklinaciju", () => {
        const chapters = [
            { seconds: 72, label: "Marko Perković Thompson" },
            { seconds: 185, label: "Petar Buljan" },
            { seconds: 164, label: "mons. Vlado Košić" },
        ];
        const srt = "[SPEAKER_01] Bilo mi je drago sa Markom i cijelim bendom. Ivan pozdravlja.";
        const tokenSet = buildNameTokenSet(chapters, srt, []);
        const article = { iterations: [{ sections: [
            { subtitle: "Petar Buljan: bend", content: "**Petar Buljan** je s **Markom Perkovićem Thompsonom** pjevao.", entities: ["Petar Buljan"] },
            { subtitle: "Tiho Orlić", content: "**Tiho Orlić** i bend **Opća Opasnost** te **Marija Husar Rimac**.", entities: ["Tiho Orlić", "Opća Opasnost"] },
            { subtitle: "Blagoslov", content: "Govori **mons. Vlado Košić** o životu i o **Bogu**.", entities: ["Bog"] },
        ] }] };
        const flagged = auditNames(article, tokenSet);
        // izmišljena → flag
        assert.ok(flagged.some(n => n.includes("Tiho")), "Tiho Orlić mora biti flagan");
        assert.ok(flagged.includes("Opća Opasnost"), "Opća Opasnost mora biti flagan");
        assert.ok(flagged.some(n => n.includes("Marija Husar")), "Marija Husar Rimac mora biti flagan");
        // prava (iz mape) → NE flag, uključujući sklonjene oblike i titulu
        assert.ok(!flagged.includes("Petar Buljan"), "Petar Buljan (iz mape) NE smije biti flagan");
        assert.ok(!flagged.some(n => n.includes("Perkovi")), "Thompson (sklonjen, iz mape) NE smije biti flagan");
        assert.ok(!flagged.some(n => n.includes("Košić")), "mons. Vlado Košić (iz mape) NE smije biti flagan");
        // jednorječni religijski pojam (Bog) se ne hvata heuristikom
        assert.ok(!flagged.includes("Bog"));
    });

    it("strict-mode odluka: OFF za mali podcast bez mape, ON za highlights/mapu", () => {
        // mali podcast: 3 govornika, bez chaptera → strict OFF (nepromijenjeno ponašanje)
        assert.equal(3 > STRICT_SPEAKER_THRESHOLD || 0 >= 3, false);
        // highlights: 25 govornika → strict ON
        assert.equal(25 > STRICT_SPEAKER_THRESHOLD, true);
    });
});


// ═══════════════════════════════════════════════════════════════
// TESTOVI: schema guard za obavezna polja sekcija
// (Vertex responseMimeType forsira samo JSON sintaksu, ne shemu —
//  Opus je 2026-07-25 u jednom runu ispustio keywords + entities.)
// ═══════════════════════════════════════════════════════════════

describe("sectionsMissingFields", () => {
    const full = {
        subtitle: "Podnaslov",
        screenshot_timestamp: "00:01:23",
        screenshot_description: "opis",
        content: "Tekst odlomka.",
        keywords: ["a", "b"],
        entities: ["Zagreb"],
    };

    it("vraća prazan niz kad su sva obavezna polja prisutna", () => {
        assert.deepEqual(sectionsMissingFields([full]), []);
    });

    it("detektira polje koje potpuno nedostaje", () => {
        const { entities, ...bezEntities } = full;
        assert.deepEqual(sectionsMissingFields([bezEntities]), ["entities"]);
    });

    it("prazan niz i prazan string tretira kao nedostajuće", () => {
        const missing = sectionsMissingFields([{ ...full, keywords: [], subtitle: "   " }]);
        assert.deepEqual(missing.sort(), ["keywords", "subtitle"]);
    });

    it("prijavljuje polje ako fali u BAR JEDNOJ sekciji", () => {
        const { keywords, ...bezKeywords } = full;
        assert.deepEqual(sectionsMissingFields([full, bezKeywords, full]), ["keywords"]);
    });

    it("ne prijavljuje ništa za prazan ulaz (nema sekcija = drugi problem)", () => {
        assert.deepEqual(sectionsMissingFields([]), []);
        assert.deepEqual(sectionsMissingFields(null), []);
    });
});
