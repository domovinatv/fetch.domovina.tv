const test = require("node:test");
const assert = require("node:assert/strict");
const { vertexEndpointUrl, vertexAccessToken, vertexAuthSource } = require("./vertex_auth");

test("global endpoint nema region prefiks", () => {
    assert.equal(vertexEndpointUrl("p", "global", "gemini-3.8-flash"),
        "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3.8-flash:generateContent");
});

test("eu multi-regija ide na .eu.rep. host (ne eu-aiplatform)", () => {
    assert.equal(vertexEndpointUrl("p", "eu", "gemini-3.8-flash"),
        "https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu/publishers/google/models/gemini-3.8-flash:generateContent");
});

test("pojedinačna regija zadržava stari oblik", () => {
    assert.equal(vertexEndpointUrl("p", "europe-west1", "gemini-2.5-flash"),
        "https://europe-west1-aiplatform.googleapis.com/v1/projects/p/locations/europe-west1/publishers/google/models/gemini-2.5-flash:generateContent");
});

test("VERTEX_ACCESS_TOKEN ima prednost pred SA ključem i gcloudom", () => {
    const prev = { t: process.env.VERTEX_ACCESS_TOKEN, f: process.env.VERTEX_SA_KEY_FILE };
    process.env.VERTEX_ACCESS_TOKEN = "  tok-123 \n";
    process.env.VERTEX_SA_KEY_FILE = "/nepostoji.json";
    try {
        assert.equal(vertexAccessToken({ account: "x@y" }), "tok-123");
        assert.equal(vertexAuthSource(), "VERTEX_ACCESS_TOKEN");
    } finally {
        if (prev.t === undefined) delete process.env.VERTEX_ACCESS_TOKEN; else process.env.VERTEX_ACCESS_TOKEN = prev.t;
        if (prev.f === undefined) delete process.env.VERTEX_SA_KEY_FILE; else process.env.VERTEX_SA_KEY_FILE = prev.f;
    }
});
