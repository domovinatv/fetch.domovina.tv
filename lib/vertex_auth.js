/**
 * lib/vertex_auth.js — zajednički Vertex AI helper: endpoint URL po regiji +
 * OAuth access token.
 *
 * Koriste ga summarize_gemini.js, generate_article_gemini.js,
 * translate_to_english.js i refine_diarized_gemini.js (umjesto 4 kopije istog koda).
 *
 * ENDPOINTI:
 *   global          → https://aiplatform.googleapis.com/…/locations/global/…
 *   eu | us         → https://aiplatform.{eu|us}.rep.googleapis.com/…/locations/{eu|us}/…
 *                     (multi-regija s rezidencijom podataka; gemini-3.8-flash je tu
 *                     200 dok su europe-west1/3/4/9/north1 404 — test 28.09.2026.)
 *   {region}        → https://{region}-aiplatform.googleapis.com/…/locations/{region}/…
 *
 * TOKEN (prvi izvor koji postoji pobjeđuje):
 *   1. VERTEX_ACCESS_TOKEN  — gotov Bearer token (npr. izdan izvan procesa)
 *   2. VERTEX_SA_KEY_FILE   — JSON ključ service accounta; token se minta u Nodeu
 *                             (JWT-bearer grant), gcloud NIJE potreban
 *   3. gcloud auth print-access-token [--account=…]  — dosadašnji put (nightly)
 *
 * Tokeni žive ~60 min; pozivatelji ih keširaju 50 min kao i dosad.
 */
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { execSync, execFileSync } = require("child_process");

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const MULTI_REGIONS = new Set(["eu", "us"]);

function vertexEndpointUrl(project, region, model, method = "generateContent") {
    let host;
    if (region === "global") host = "aiplatform.googleapis.com";
    else if (MULTI_REGIONS.has(region)) host = `aiplatform.${region}.rep.googleapis.com`;
    else host = `${region}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:${method}`;
}

/**
 * Sinkrono vraća access token (pozivatelji su sinkroni). Baca grešku ako nijedan
 * izvor ne radi — pozivatelj ispisuje svoju poruku i izlazi.
 */
function vertexAccessToken({ account } = {}) {
    const envToken = (process.env.VERTEX_ACCESS_TOKEN || "").trim();
    if (envToken) return envToken;

    const saFile = (process.env.VERTEX_SA_KEY_FILE || "").trim();
    if (saFile) {
        // Mintanje je async (fetch), pa ga vrtimo u child procesu i čitamo stdout.
        return execFileSync(process.execPath, [__filename, "--mint-sa", saFile], { encoding: "utf-8" }).trim();
    }

    const acct = account ? ` --account=${account}` : "";
    return execSync(`gcloud auth print-access-token${acct}`, { encoding: "utf-8" }).trim();
}

/** Opisuje koji izvor tokena je aktivan — za log na početku runa. */
function vertexAuthSource({ account } = {}) {
    if ((process.env.VERTEX_ACCESS_TOKEN || "").trim()) return "VERTEX_ACCESS_TOKEN";
    if ((process.env.VERTEX_SA_KEY_FILE || "").trim()) return `service account (${process.env.VERTEX_SA_KEY_FILE})`;
    return `gcloud${account ? ` (${account})` : ""}`;
}

async function mintServiceAccountToken(keyFile) {
    const key = JSON.parse(fs.readFileSync(keyFile, "utf-8"));
    if (key.type !== "service_account" || !key.client_email || !key.private_key) {
        throw new Error(`${keyFile} nije JSON ključ service accounta`);
    }
    const tokenUri = key.token_uri || "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT", kid: key.private_key_id })}.${b64({
        iss: key.client_email, scope: CLOUD_PLATFORM_SCOPE, aud: tokenUri, iat: now, exp: now + 3600,
    })}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key.private_key).toString("base64url");
    const res = await fetch(tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: `${unsigned}.${signature}`,
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
        throw new Error(`token endpoint ${res.status}: ${body.error_description || body.error || "bez access_tokena"}`);
    }
    return body.access_token;
}

if (require.main === module && process.argv[2] === "--mint-sa") {
    mintServiceAccountToken(process.argv[3])
        .then((t) => process.stdout.write(t))
        .catch((e) => { console.error(`❌ Service account token: ${e.message}`); process.exit(1); });
}

module.exports = { vertexEndpointUrl, vertexAccessToken, vertexAuthSource, mintServiceAccountToken };
