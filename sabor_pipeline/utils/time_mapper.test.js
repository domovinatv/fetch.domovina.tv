#!/usr/bin/env node

/**
 * Testovi za time_mapper.js
 *
 * Pokretanje: node --test sabor_pipeline/utils/time_mapper.test.js
 *
 * Fiksture su STVARNA trajanja 11. izvanredne sjednice (yt-dlp, 2026-08-24):
 *   NKT3niyWwaY 20681s | xrZ4FHQSZec 22125s | i-wvlWqLcJ0 22297s | Pmg2XI-qnWo 6971s
 * Ukupno 72074 s = 20 h 01 min 14 s (README-ov "18 sati" je bila procjena).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
    buildParts,
    totalDuration,
    findPart,
    globalToYoutube,
    youtubeToGlobal,
    secondsToHms,
} = require("./time_mapper");

const RAW = [
    { part: 1, video_id: "NKT3niyWwaY", duration_sec: 20681 },
    { part: 2, video_id: "xrZ4FHQSZec", duration_sec: 22125 },
    { part: 3, video_id: "i-wvlWqLcJ0", duration_sec: 22297 },
    { part: 4, video_id: "Pmg2XI-qnWo", duration_sec: 6971 },
];

const MANIFEST = { parts: buildParts(RAW) };

describe("buildParts", () => {
    it("računa kumulativne pomake", () => {
        assert.deepEqual(
            MANIFEST.parts.map((p) => p.offset_global_sec),
            [0, 20681, 42806, 65103]
        );
        assert.deepEqual(
            MANIFEST.parts.map((p) => p.end_global_sec),
            [20681, 42806, 65103, 72074]
        );
    });

    it("sortira po part broju bez obzira na ulazni poredak", () => {
        const shuffled = buildParts([RAW[2], RAW[0], RAW[3], RAW[1]]);
        assert.deepEqual(shuffled.map((p) => p.part), [1, 2, 3, 4]);
        assert.equal(shuffled[0].offset_global_sec, 0);
        assert.equal(shuffled[3].offset_global_sec, 65103);
    });

    it("odbija dio bez izmjerenog trajanja", () => {
        assert.throws(() => buildParts([{ part: 1, duration_sec: null }]), /duration_sec/);
        assert.throws(() => buildParts([{ part: 1, duration_sec: 0 }]), /duration_sec/);
    });

    it("ne mutira ulazne objekte", () => {
        const input = [{ part: 1, video_id: "X", duration_sec: 10 }];
        buildParts(input);
        assert.equal(input[0].offset_global_sec, undefined);
    });
});

describe("sample-točni pomaci", () => {
    it("dodaje kumulativne uzorke kad su poznati", () => {
        const withSamples = buildParts([
            { part: 1, video_id: "A", duration_sec: 20681.317, duration_samples: 330901072 },
            { part: 2, video_id: "B", duration_sec: 22124.66937, duration_samples: 353994727 },
        ]);
        assert.equal(withSamples[0].offset_global_samples, 0);
        assert.equal(withSamples[1].offset_global_samples, 330901072);
        assert.equal(withSamples[1].end_global_samples, 684895799);
    });

    it("izostavlja polja kad ijedan dio nema broj uzoraka", () => {
        const mixed = buildParts([
            { part: 1, duration_sec: 10, duration_samples: 160000 },
            { part: 2, duration_sec: 10 },
        ]);
        assert.equal(mixed[0].offset_global_samples, undefined);
    });
});

describe("totalDuration", () => {
    it("vraća kraj zadnjeg dijela", () => {
        assert.equal(totalDuration(MANIFEST), 72074);
    });
});

describe("findPart / granice", () => {
    it("interval je poluotvoren — granica pripada sljedećem dijelu", () => {
        assert.equal(findPart(MANIFEST, 20680.999).part, 1);
        assert.equal(findPart(MANIFEST, 20681).part, 2);
        assert.equal(findPart(MANIFEST, 42806).part, 3);
        assert.equal(findPart(MANIFEST, 65103).part, 4);
    });

    it("clampa kraj sjednice na zadnji dio", () => {
        assert.equal(findPart(MANIFEST, 72074).part, 4);
        assert.equal(findPart(MANIFEST, 999999).part, 4);
    });

    it("clampa negativno vrijeme na prvi dio", () => {
        assert.equal(findPart(MANIFEST, -5).part, 1);
    });
});

describe("globalToYoutube", () => {
    it("mapira sredinu 2. dijela", () => {
        // 20681 + 1427 = 22108 → part 2 @ 1427s (primjer iz 04_llm_structuring_and_export.md)
        const r = globalToYoutube(MANIFEST, 22108);
        assert.equal(r.part, 2);
        assert.equal(r.video_id, "xrZ4FHQSZec");
        assert.equal(r.timestamp_sec, 1427);
        assert.equal(r.url, "https://www.youtube.com/watch?v=xrZ4FHQSZec&t=1427s");
    });

    it("FLOOR-a sekunde — deep link nikad ne preskoči početak rečenice", () => {
        assert.equal(globalToYoutube(MANIFEST, 12.9).timestamp_sec, 12);
        assert.equal(globalToYoutube(MANIFEST, 20681.999).timestamp_sec, 0);
        assert.equal(globalToYoutube(MANIFEST, 20681.999).part, 2);
    });

    it("t=0 je početak prvog dijela", () => {
        const r = globalToYoutube(MANIFEST, 0);
        assert.equal(r.part, 1);
        assert.equal(r.timestamp_sec, 0);
    });

    it("kraj sjednice ne prelije u nepostojeći 5. dio", () => {
        const r = globalToYoutube(MANIFEST, 72074);
        assert.equal(r.part, 4);
        assert.ok(r.timestamp_sec < 6971, `očekivan timestamp unutar videa, dobiven ${r.timestamp_sec}`);
    });
});

describe("youtubeToGlobal", () => {
    it("je inverz globalToYoutube na cijelim sekundama", () => {
        for (const globalSec of [0, 5000, 20681, 42806, 60000, 65103, 72000]) {
            const yt = globalToYoutube(MANIFEST, globalSec);
            assert.equal(youtubeToGlobal(MANIFEST, yt.part, yt.timestamp_sec), globalSec);
        }
    });

    it("puca na nepostojećem dijelu", () => {
        assert.throws(() => youtubeToGlobal(MANIFEST, 9, 10), /dio 9/);
    });
});

describe("secondsToHms", () => {
    it("formatira 20-satnu sjednicu bez prelijevanja u dane", () => {
        assert.equal(secondsToHms(72074), "20:01:14");
        assert.equal(secondsToHms(0), "00:00:00");
        assert.equal(secondsToHms(59.9), "00:00:59");
    });
});

describe("prima i goli niz dijelova (bez omotača)", () => {
    it("radi nad parts[] direktno", () => {
        assert.equal(globalToYoutube(MANIFEST.parts, 100).part, 1);
    });
});
