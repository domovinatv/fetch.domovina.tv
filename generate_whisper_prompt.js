#!/usr/bin/env node

/**
 * generate_whisper_prompt.js
 *
 * Čita YouTube .info.json metapodatke i generira whisper_prompt.txt
 * datoteku s ključnim riječima za lokalni whisper.cpp CLI.
 *
 * Koristi lokalni LLM (LM Studio) za semantičku ekstrakciju:
 * imena, prezimena, nazive tvrtki, lokacije, tech termine.
 *
 * Format izlaza: riječi odvojene zarezom, BEZ razmaka nakon zareza,
 * razmaci unutar pojmova zamijenjeni podcrtom (_).
 *
 * PREDUVJET: LM Studio mora biti pokrenut na localhost:1234
 *
 * Primjer:
 *   node generate_whisper_prompt.js --channel domovina_tv
 *   node generate_whisper_prompt.js --channel domovina_tv --dry-run
 *   node generate_whisper_prompt.js  (svi kanali)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

// --- KONFIGURACIJA ---
const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");
const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";

// LM Studio API
const LM_STUDIO_URL = "http://localhost:1234/v1/chat/completions";
const LM_STUDIO_MODEL = "qwen2.5-7b-instruct";

// Sistemski prompt za LLM
const SYSTEM_PROMPT = `Ti si specijalizirani AI asistent za ekstrakciju metapodataka i ključnih riječi namijenjen za pripremu "prompt" datoteke za lokalni whisper.cpp CLI. 

Tvoj zadatak je iz priloženog teksta (opisa eventa, podcasta ili videa) izvući sve ključne riječi: imena i prezimena, nazive tvrtki, lokacije, te specifične tehnološke ili stručne termine (npr. IT alati, engleski izrazi u hrvatskom tekstu). Ovi pojmovi služe kako bi Whisper AI ispravno prepoznao izgovor.

MORAŠ se strogo pridržavati sljedećih pravila formatiranja. Upute za formatiranje proizlaze iz tehničkih ograničenja Bash/Zsh terminala i whisper.cpp parsera:

1. VRATI ISKLJUČIVO NIZ RIJEČI ODVOJENIH ZAREZOM.
2. ZABRANJENI SU RAZMACI NAKON ZAREZA. 
   - Zašto: Terminal parsira razmake kao nove argumente naredbe. Razmak nakon zareza uzrokovat će rušenje whisper-cli alata i baciti "stoi" (string-to-integer) grešku.
3. ZAMJENI SVE RAZMAKE UNUTAR POJMOVA PODCRTOM (_). 
   - Zašto: Ako je pojam sastavljen od više riječi (npr. "Matija Stepanić" ili "Cloud Firestore"), razmak će prekinuti string u terminalu. Korištenjem podcrte ("Matija_Stepanić") terminal to čita kao jednu cjelinu, a Whisper AI i dalje uspješno prepoznaje semantiku pojma.
4. BEZ DODATNOG TEKSTA.
   - Zašto: Tvoj izlaz se automatski sprema u .txt datoteku i prosljeđuje direktno u komandnu liniju preko $(cat prompt.txt). Bilo kakav uvod (npr. "Evo ključnih riječi:") ili Markdown formatiranje (poput \`\`\`text) trajno će oštetiti izvršavanje skripte.
5. ZADRŽI DIJAKRITIČKE ZNAKOVE (č, ć, ž, š, đ) jer su ključni za hrvatski Whisper model.`;

// --- POMOĆNE FUNKCIJE (isto kao u fetch.js / convert_to_wav.js) ---

function sanitizeDescription(str) {
    if (!str) return "nepoznat_naslov";
    str = str.toLowerCase();
    const map = {
        'č': 'c', 'ć': 'c', 'ž': 'z', 'š': 's', 'đ': 'd',
        'Č': 'c', 'Ć': 'c', 'Ž': 'z', 'Š': 's', 'Đ': 'd'
    };
    str = str.replace(/[čćžšđČĆŽŠĐ]/g, (char) => map[char] || char);
    str = str.replace(/[^a-z0-9]/g, '_');
    str = str.replace(/_+/g, '_').replace(/^_|_$/g, '');
    return str || "nepoznat_naslov";
}

function extractVideoId(url) {
    url = url.trim();
    if (!url) return null;
    const m = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

function extractDataFromLine(line) {
    line = line.trim();
    if (!line || line.startsWith("#")) return null;
    if (line.includes("|")) {
        const parts = line.split("|");
        const url = parts[parts.length - 1].trim();
        let title = "nepoznat_naslov";
        let date = "NA";
        if (parts.length >= 3) {
            date = parts[0].trim();
            title = parts.slice(1, parts.length - 1).join(" ").trim();
        } else if (parts.length === 2) {
            title = parts[0].trim();
        }
        return { url, title, date };
    }
    return { url: line, title: "nepoznat_naslov", date: "NA" };
}

function loadState(stateFile) {
    if (fs.existsSync(stateFile)) {
        try {
            return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        } catch (e) {
            console.error(`[GREŠKA] Neispravan JSON stanja: ${stateFile}`);
        }
    }
    return { completed: [], failed: [] };
}

// --- LLM EKSTRAKCIJA KLJUČNIH RIJEČI ---

/**
 * Šalje naslov + opis LLM-u i vraća formatirane ključne riječi.
 */
function callLLM(title, description) {
    const userMessage = `NASLOV: ${title}\n\nOPIS:\n${description}`;

    const payload = JSON.stringify({
        model: LM_STUDIO_MODEL,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage }
        ],
        temperature: 0.0,
        max_tokens: 300
    });

    return new Promise((resolve, reject) => {
        const url = new URL(LM_STUDIO_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    if (json.choices && json.choices[0] && json.choices[0].message) {
                        let content = json.choices[0].message.content.trim();
                        // Čisti eventualni markdown formatting koji LLM ponekad doda
                        content = content.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
                        content = content.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
                        resolve(content);
                    } else {
                        reject(new Error(`Neočekivan LLM odgovor: ${data.substring(0, 200)}`));
                    }
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message} — odgovor: ${data.substring(0, 200)}`));
                }
            });
        });

        req.on("error", (err) => {
            reject(new Error(`LM Studio nije dostupan (${err.message}). Je li pokrenut na ${LM_STUDIO_URL}?`));
        });

        req.write(payload);
        req.end();
    });
}

/**
 * Validira i čisti LLM output — osigurava ispravan format.
 */
function sanitizeLLMOutput(raw) {
    // Makni sve što nije dio ključnih riječi (LLM ponekad doda uvodni tekst)
    let cleaned = raw.trim();

    // Ako ima više linija, uzmi samo prvu koja izgleda kao lista ključnih riječi
    const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
        // Linija koja sadrži zareze i nema razmaka nakon zareza izgleda kao ispravan output
        if (line.includes(',') && !line.includes(': ')) {
            cleaned = line;
            break;
        }
    }

    // Zamijeni eventualne razmake nakon zareza
    cleaned = cleaned.replace(/,\s+/g, ',');

    // Zamijeni eventualne razmake unutar pojmova podcrtom
    // (LLM ponekad zaboravi pravilo o podcrti)
    const parts = cleaned.split(',');
    const fixed = parts
        .map(p => p.trim().replace(/\s+/g, '_'))
        .filter(p => p.length >= 2);

    return fixed.join(',');
}

// --- PRONAĐI .info.json ZA VIDEO ID ---

function findInfoJson(outputDir, videoId) {
    if (!fs.existsSync(outputDir)) return null;

    const files = fs.readdirSync(outputDir);
    const match = files.find(f =>
        !f.startsWith("._") && f.includes(`_yt_${videoId}`) && f.endsWith(".info.json")
    );

    return match ? path.join(outputDir, match) : null;
}

// --- GLAVNI PROGRAM ---

async function main() {
    const args = process.argv.slice(2);
    const outputDirIdx = args.indexOf("--output-dir");
    const baseOutputDir = outputDirIdx !== -1 ? args[outputDirIdx + 1] : DEFAULT_OUTPUT_DIR;
    const dryRun = args.includes("--dry-run");
    const channelIdx = args.indexOf("--channel");
    const channelFilter = channelIdx !== -1 ? args[channelIdx + 1] : null;

    if (!fs.existsSync(LISTS_DIR)) {
        console.error(`❌ Nema direktorija s listama: ${LISTS_DIR}`);
        process.exit(1);
    }

    if (!fs.existsSync(baseOutputDir)) {
        console.error(`❌ Output direktorij ne postoji: ${baseOutputDir}`);
        console.error(`   Je li disk DOMOVINA1TB mountan?`);
        process.exit(1);
    }

    // Testiraj LM Studio konekciju
    try {
        console.log("🔌 Testiram LM Studio konekciju...");
        await callLLM("Test", "Test konekcije");
        console.log("✅ LM Studio je dostupan!\n");
    } catch (err) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    }

    // Pronađi liste
    let listFiles = fs.readdirSync(LISTS_DIR)
        .filter(f => f.endsWith("-lista.txt"))
        .map(f => path.join(LISTS_DIR, f));

    // Filtriraj po kanalu
    if (channelFilter) {
        listFiles = listFiles.filter(f => {
            const filename = path.basename(f).replace("-lista.txt", "").replace(".txt", "");
            const channelName = sanitizeDescription(filename);
            return channelName === channelFilter;
        });
        if (listFiles.length === 0) {
            console.error(`❌ Kanal "${channelFilter}" nije pronađen.`);
            console.error(`   Dostupni kanali:`);
            fs.readdirSync(LISTS_DIR)
                .filter(f => f.endsWith("-lista.txt"))
                .forEach(f => {
                    const name = sanitizeDescription(path.basename(f).replace("-lista.txt", ""));
                    console.error(`     - ${name}`);
                });
            process.exit(1);
        }
    }

    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📝 GENERIRANJE WHISPER PROMPTOVA (LLM)       ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Liste: ${LISTS_DIR}`);
    console.log(`   💾 Output: ${baseOutputDir}`);
    console.log(`   🤖 Model: ${LM_STUDIO_MODEL}`);
    if (channelFilter) console.log(`   🎯 Kanal: ${channelFilter}`);
    console.log(`   📋 Pronađeno lista: ${listFiles.length}`);
    if (dryRun) console.log("   ⚠️  DRY RUN - samo prikaz, bez zapisivanja");
    console.log("");

    let totalGenerated = 0;
    let totalSkipped = 0;
    let totalMissing = 0;
    let totalErrors = 0;

    for (const listFile of listFiles) {
        const filename = path.basename(listFile).replace("-lista.txt", "").replace(".txt", "");
        const channelName = sanitizeDescription(filename);
        const outputDir = path.join(baseOutputDir, channelName);
        const stateFile = listFile.replace(".txt", "-state.json");
        const state = loadState(stateFile);

        const rawLines = fs.readFileSync(listFile, "utf-8").split("\n");
        const entries = rawLines
            .map(line => {
                const data = extractDataFromLine(line);
                if (!data) return null;
                const videoId = extractVideoId(data.url);
                if (!videoId) return null;
                return { videoId, title: data.title };
            })
            .filter(e => e && e.videoId);

        const completedEntries = entries.filter(e => state.completed.includes(e.videoId));
        if (completedEntries.length === 0) continue;

        console.log(`\n🔵 [${channelName.toUpperCase()}] — ${completedEntries.length} video zapisa`);

        for (const entry of completedEntries) {
            const infoJsonFile = findInfoJson(outputDir, entry.videoId);

            if (!infoJsonFile) {
                console.log(`   ⚠️  .info.json nije pronađen za: ${entry.videoId}`);
                totalMissing++;
                continue;
            }

            // Odredi izlaznu datoteku: isti basename ali _whisper_prompt.txt
            const baseName = path.basename(infoJsonFile, ".info.json");
            const promptFile = path.join(outputDir, `${baseName}_whisper_prompt.txt`);

            // Preskoči ako već postoji
            if (fs.existsSync(promptFile)) {
                console.log(`   ⏭️  [POSTOJI] ${baseName}_whisper_prompt.txt`);
                totalSkipped++;
                continue;
            }

            try {
                // Čitaj info.json
                const infoData = JSON.parse(fs.readFileSync(infoJsonFile, "utf-8"));

                const title = infoData.title || "";
                const description = infoData.description || "";

                if (!title && !description) {
                    console.log(`   ⚠️  [PRAZNO] Nema naslova/opisa za: ${baseName}`);
                    totalMissing++;
                    continue;
                }

                // Pozovi LLM za ekstrakciju ključnih riječi
                console.log(`   🤖 [LLM] Obrađujem: ${title.substring(0, 60)}...`);
                const rawResponse = await callLLM(title, description);
                const promptContent = sanitizeLLMOutput(rawResponse);

                if (!promptContent || promptContent.length < 3) {
                    console.log(`   ⚠️  [PRAZNO] LLM nije vratio ključne riječi za: ${baseName}`);
                    totalMissing++;
                    continue;
                }

                if (dryRun) {
                    console.log(`   🔄 [GENERIRAO BI] ${baseName}_whisper_prompt.txt`);
                    console.log(`      📋 ${promptContent.substring(0, 120)}...`);
                    totalGenerated++;
                } else {
                    fs.writeFileSync(promptFile, promptContent, "utf-8");
                    console.log(`   ✅ [GENERIRANO] ${baseName}_whisper_prompt.txt`);
                    console.log(`      📋 ${promptContent.substring(0, 120)}...`);
                    totalGenerated++;
                }
            } catch (err) {
                console.error(`   ❌ [GREŠKA] ${baseName}: ${err.message}`);
                totalErrors++;
            }
        }
    }

    // --- SAŽETAK ---
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK                                    ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Generirano:       ${totalGenerated}`);
    console.log(`   ⏭️  Preskočeno:      ${totalSkipped} (već postoji)`);
    console.log(`   ⚠️  Nedostaje/prazno: ${totalMissing}`);
    console.log(`   ❌ Grešaka:          ${totalErrors}`);
    console.log("");
}

main().catch((err) => console.error("Fatal error:", err));
