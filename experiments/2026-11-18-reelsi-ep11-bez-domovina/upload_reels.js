// node --env-file=.env upload_reels.js → clips/RdEN7Ny1bV8/…_9x16_v2.mp4 na R2, ispisuje URL-ove
const fs = require("fs");
const { S3Client, PutObjectCommand, HeadObjectCommand } = require("/Users/ms/git/domovinatv/fetch.domovina.tv/node_modules/@aws-sdk/client-s3");
const D = "/private/tmp/claude-501/-Users-ms-git-domovinatv-fetch-domovina-tv/6f06383c-7db5-4d5e-bfe9-b4511c1e7bc4/scratchpad/ep11root/muzevni_budite/20261022_redefinicija_11_epizoda_yt_RdEN7Ny1bV8.reels";
const R = [[1, "05m29s-06m52s"], [2, "12m28s-13m52s"], [4, "35m13s-36m31s"], [6, "57m08s-58m21s"]];
const s3 = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
(async () => {
    for (const [rank, span] of R) {
        const Key = `clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel${rank}_${span}_9x16_v2.mp4`;
        const Body = fs.readFileSync(`${D}/${rank}.mp4`);
        try { await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key })); throw new Error(`već postoji: ${Key}`); }
        catch (e) { if (!/NotFound|404/.test(e.name + e.message)) throw e; }
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key, Body, ContentType: "video/mp4",
            CacheControl: "public, max-age=31536000, immutable" }));
        console.log(`https://cdn.domovina.ai/${Key}`, (Body.length / 1e6).toFixed(1), "MB");
    }
})().catch((e) => { console.error(e.message); process.exit(1); });
