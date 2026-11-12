const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
    timestampToSeconds,
    secondsToLabel,
    extractChapters,
    buildMessages,
    pickLatestArticle,
    resolveGroup,
    filterUnsent,
} = require("./share_to_whatsapp");

describe("timestampToSeconds", () => {
    it("čita oba formata koja pipeline stvarno proizvodi", () => {
        assert.equal(timestampToSeconds("00:00:27"), 27);
        assert.equal(timestampToSeconds("2:39:30"), 9570);
        assert.equal(timestampToSeconds("5:00"), 300); // MM:SS, bez sati
    });

    it("prihvaća i zarez i točku kao decimalnu oznaku (SRT vs JSON)", () => {
        assert.equal(timestampToSeconds("00:07:25,500"), 445);
        assert.equal(timestampToSeconds("00:07:25.500"), 445);
    });

    it("odbija smeće umjesto da vrati 0 — 0 bi poslalo link na početak", () => {
        for (const bad of ["", "nema", null, undefined, "27", "1:2:3:4", "00:70:00"]) {
            assert.equal(timestampToSeconds(bad), null, `${bad} bi trebao biti null`);
        }
    });
});

describe("secondsToLabel", () => {
    it("prelazi na sate tek kad treba, kao og: naslov", () => {
        assert.equal(secondsToLabel(27), "0:27");
        assert.equal(secondsToLabel(445), "7:25");
        assert.equal(secondsToLabel(9570), "2:39:30");
    });
});

describe("extractChapters", () => {
    const article = {
        iterations: [
            {
                sections: [
                    { screenshot_timestamp: "00:05:00", subtitle: "Druga tema" },
                    { screenshot_timestamp: "00:00:27", subtitle: "Prva tema" },
                ],
            },
            {
                sections: [
                    { screenshot_timestamp: "01:00:00", subtitle: "Treća tema" },
                ],
            },
        ],
    };

    it("spaja sve iteracije i sortira po vremenu", () => {
        assert.deepEqual(extractChapters(article), [
            { sec: 27, title: "Prva tema" },
            { sec: 300, title: "Druga tema" },
            { sec: 3600, title: "Treća tema" },
        ]);
    });

    it("izbacuje duplikat sekunde — dva ista linka izgledaju kao greška", () => {
        const dup = {
            iterations: [
                {
                    sections: [
                        { screenshot_timestamp: "00:01:00", subtitle: "Prva" },
                        { screenshot_timestamp: "00:01:00", subtitle: "Ista sekunda" },
                    ],
                },
            ],
        };
        assert.deepEqual(extractChapters(dup), [{ sec: 60, title: "Prva" }]);
    });

    it("preskače sekciju s neispravnim timestampom, ostale zadrži", () => {
        const broken = {
            iterations: [
                {
                    sections: [
                        { screenshot_timestamp: "nema", subtitle: "Slomljena" },
                        { screenshot_timestamp: "00:02:00", subtitle: "Dobra" },
                    ],
                },
            ],
        };
        assert.deepEqual(extractChapters(broken), [{ sec: 120, title: "Dobra" }]);
    });

    it("puca na datoteci koja nije članak", () => {
        assert.throws(() => extractChapters({ foo: 1 }), /iterations/);
        assert.throws(() => extractChapters(null), /iterations/);
    });
});

describe("buildMessages", () => {
    const chapters = [
        { sec: 27, title: "Prva" },
        { sec: 9570, title: "Zadnja" },
    ];

    it("prva poruka je gola epizoda, pa poglavlja", () => {
        const msgs = buildMessages({ videoId: "aue1GuuMsbA", chapters });
        assert.equal(msgs.length, 3);
        assert.equal(msgs[0].url, "https://domovina.ai/v/aue1GuuMsbA");
        assert.equal(msgs[1].url, "https://domovina.ai/v/aue1GuuMsbA/t/27");
        assert.equal(msgs[2].url, "https://domovina.ai/v/aue1GuuMsbA/t/9570");
    });

    it("poruka je SAMO URL — dodatni tekst gasi WhatsApp preview", () => {
        for (const m of buildMessages({ videoId: "X", chapters })) {
            assert.match(m.url, /^https:\/\/\S+$/);
        }
    });

    it("--no-intro izbaci samo uvodni link", () => {
        const msgs = buildMessages({ videoId: "X", chapters, includeIntro: false });
        assert.equal(msgs.length, 2);
        assert.equal(msgs[0].sec, 27);
    });

    it("ne udvostručuje kosu crtu kad baza završava njome", () => {
        const [first] = buildMessages({
            videoId: "X",
            chapters: [],
            siteBase: "https://domovina.ai/",
        });
        assert.equal(first.url, "https://domovina.ai/v/X");
    });

    it("linkovi NIKAD ne vode na YouTube", () => {
        const msgs = buildMessages({ videoId: "aue1GuuMsbA", chapters });
        for (const m of msgs) assert.ok(!/youtu/.test(m.url), m.url);
    });
});

describe("pickLatestArticle", () => {
    it("opus pobjeđuje gemini, gemini pobjeđuje agy (leksikografski)", () => {
        const files = [
            "ep_2026-09-19_agy.article.json",
            "ep_2026-09-19_opus.article.json",
            "ep_2026-09-19_gemini-3.5-flash.article.json",
        ];
        assert.equal(pickLatestArticle(files), "ep_2026-09-19_opus.article.json");
    });

    it("ne zamijeni članak s outlineom ili prijevodom uz njega", () => {
        const files = ["ep_2026-09-19_opus.outline.json", "ep.summary.json"];
        assert.equal(pickLatestArticle(files), null);
    });
});

describe("resolveGroup", () => {
    const groups = [
        { jid: "111@g.us", name: "DOMOVINA.ai#001" },
        { jid: "222@g.us", name: "DOMOVINA" },
        { jid: "333@g.us", name: "DOMOVINA" },
    ];

    it("točan JID ide prvi, i kad bi ime bilo višeznačno", () => {
        assert.equal(resolveGroup(groups, "333@g.us").jid, "333@g.us");
    });

    it("točno ime pobjeđuje podniz", () => {
        assert.equal(resolveGroup(groups, "DOMOVINA.ai#001").jid, "111@g.us");
    });

    it("ne mari za velika i mala slova", () => {
        assert.equal(resolveGroup(groups, "domovina.ai#001").jid, "111@g.us");
    });

    it("višeznačnost je GREŠKA — kriva grupa se ne može povući", () => {
        assert.throws(() => resolveGroup(groups, "DOMOVINA"), /odgovara na 2 grupa/);
    });

    it("prazan upit i promašaj pucaju, ne biraju prvu", () => {
        assert.throws(() => resolveGroup(groups, ""), /--group je obavezan/);
        assert.throws(() => resolveGroup(groups, "nepostojeca"), /Nijedna grupa/);
    });
});

describe("filterUnsent", () => {
    it("preskače točno one URL-ove koji su već u chatu", () => {
        const messages = [
            { url: "https://domovina.ai/v/X" },
            { url: "https://domovina.ai/v/X/t/27" },
            { url: "https://domovina.ai/v/X/t/300" },
        ];
        const sent = ["https://domovina.ai/v/X", "https://domovina.ai/v/X/t/300", "bok"];
        assert.deepEqual(filterUnsent(messages, sent).map((m) => m.url), [
            "https://domovina.ai/v/X/t/27",
        ]);
    });

    it("/t/27 nije isto što i /t/270 — prefiks se ne smije brojati kao poslan", () => {
        const messages = [{ url: "https://domovina.ai/v/X/t/27" }];
        assert.equal(filterUnsent(messages, ["https://domovina.ai/v/X/t/270"]).length, 1);
    });
});

// ─── postavke kanala (S7 točka 6, odluka 110) ─────────────────────
describe("shareDecision + locateEpisode", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const cs = require("./lib/channel_settings");
    const { shareDecision, locateEpisode } = require("./share_to_whatsapp");
    const UC_W = "UCaaaaaaaaaaaaaaaaaaaaaa", UC_C = "UCcccccccccccccccccccccc", UC_A = "UCssssssssssssssssssssss";
    const opts = { registryPath: "/nepostojeci/registry.json" };
    const g = cs.gateFromSnapshot({ ok: true, settings: {
        [UC_W]: { status: "withdrawn", off: [] },
        [UC_C]: { status: "active", off: ["share_clips"] },
        [UC_A]: { status: "active", off: ["article_summary"] },     // članak off → share_clips pada (odluka 108)
    } }, opts);

    it("povučen kanal → odbij; share_clips off → samo epizoda; bez retka → sve", () => {
        assert.match(shareDecision(g, { uc: UC_W }, { commit: true }).refuse, /povukao/);
        const c = shareDecision(g, { uc: UC_C }, { commit: true });
        assert.equal(c.refuse, null);
        assert.match(c.noChapters, /share_clips/);
        assert.match(shareDecision(g, { uc: UC_A }).noChapters, /share_clips/);
        assert.deepEqual(shareDecision(g, { uc: "UCnnnnnnnnnnnnnnnnnnnnnn" }, { commit: true }), { refuse: null, noChapters: null, warn: null });
    });

    it("stale izvor: --commit odbija, suho pokretanje samo upozori", () => {
        const s = cs.gateFromSnapshot({ ok: true, settings: {} }, opts);
        s.stale = "izvor nedostupan (HTTP 503) i nema zadnje uspješne snimke — bez filtra";
        assert.match(shareDecision(s, {}, { commit: true }).refuse, /nisu svježe/);
        const dry = shareDecision(s, {}, { commit: false });
        assert.equal(dry.refuse, null);
        assert.match(dry.warn, /HTTP 503/);
    });

    it("locateEpisode: info.json iz direktorija kanala, slug s `-`", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-"));
        fs.mkdirSync(path.join(root, "neki_kanal"));
        const info = path.join(root, "neki_kanal", "20261110_naslov_yt_abcdefghijk.info.json");
        fs.writeFileSync(info, JSON.stringify({ channel_id: UC_C }));
        assert.deepEqual(locateEpisode("abcdefghijk", root), { slug: "neki-kanal", infoPath: info });
        assert.equal(locateEpisode("zzzzzzzzzzz", root), null);
        assert.match(shareDecision(g, locateEpisode("abcdefghijk", root)).noChapters, /share_clips/);
    });
});
