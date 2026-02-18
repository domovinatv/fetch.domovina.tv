#!/usr/bin/env node

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- KONFIGURACIJA ---
const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");
const COOKIES_FILE = path.join(__dirname, "automatic", "cookies.txt");
const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";

// Postavke ciklusa
const BATCH_SIZE = 2;
const SLEEP_BETWEEN_DOWNLOADS_MS = 2000;

const YT_DLP_BASE_ARGS = [
  "-x", // Audio only
  "-k", // Keep video
  "--audio-format", "mp3",
  "--embed-thumbnail",
  "--add-metadata",
  "--write-info-json",
  "--write-description",
  "--write-subs",
  "--sub-lang", "hr,en",
  "--write-thumbnail",
  "--convert-thumbnails", "png",
  "--extractor-args", "youtube:player_client=android",
  "--no-check-certificate",
  "--prefer-free-formats",
  "--restrict-filenames"
];

// --- AUTO-DETECT COOKIES ---
if (fs.existsSync(COOKIES_FILE)) {
  console.log(`🍪 Cookies datoteka pronađena: ${COOKIES_FILE}`);
  YT_DLP_BASE_ARGS.push("--cookies", COOKIES_FILE);
} else {
  console.log("⚠️ Cookies datoteka nije pronađena (nastavljam bez nje).");
}

// --- POMOĆNE FUNKCIJE ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Implementacija "Strict Snake Case" samo za opisni dio
function sanitizeDescription(str) {
  if (!str) return "nepoznat_naslov";

  // 1. Lowercase (samo za opis!)
  str = str.toLowerCase();

  // 2. Transliteracija (naši znakovi u ASCII)
  const map = {
    'č': 'c', 'ć': 'c', 'ž': 'z', 'š': 's', 'đ': 'd',
    'Č': 'c', 'Ć': 'c', 'Ž': 'z', 'Š': 's', 'Đ': 'd'
  };
  str = str.replace(/[čćžšđČĆŽŠĐ]/g, (char) => map[char] || char);

  // 3. Zamijeni sve što nije slovo ili broj s donjom crtom
  str = str.replace(/[^a-z0-9]/g, '_');

  // 4. Počisti višestruke donje crte i trimaj rubove
  str = str.replace(/_+/g, '_').replace(/^_|_$/g, '');

  return str || "nepoznat_naslov";
}

function extractVideoId(url) {
  url = url.trim();
  if (!url) return null;
  // Poboljšan regex koji hvata i youtu.be i v=
  const m = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function extractDataFromLine(line) {
  line = line.trim();
  if (!line || line.startsWith("#")) return null;

  // Format: DATUM | NASLOV | URL
  // Očekujemo da Bash skripta možda stavi "NA" za datum
  if (line.includes("|")) {
    const parts = line.split("|");
    const url = parts[parts.length - 1].trim();
    
    let title = "nepoznat_naslov";
    let date = "NA"; // Default vrijednost ako fali

    if (parts.length >= 3) {
        date = parts[0].trim(); // Prvi dio je datum (ili NA)
        title = parts.slice(1, parts.length - 1).join(" ").trim();
    } else if (parts.length === 2) {
        title = parts[0].trim();
    }
    
    return { url, title, date };
  }
  
  // Fallback za raw URL linije
  return { url: line, title: "nepoznat_naslov", date: "NA" };
}

function loadState(stateFile) {
  if (fs.existsSync(stateFile)) {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    } catch (e) {
      console.error(`[GREŠKA] Neispravan JSON stanja: ${stateFile}. Kreiram novi.`);
    }
  }
  return { completed: [], failed: [] };
}

function saveState(stateFile, state) {
  const tempFile = stateFile + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempFile, stateFile);
}

// Download funkcija koja prima template imena
function downloadVideo(videoId, outputDir, filenameTemplate) {
  fs.mkdirSync(outputDir, { recursive: true });

  // Dodajemo ekstenziju na template
  // Ovdje yt-dlp zamjenjuje %(upload_date)s ako je proslijeđen
  const finalTemplate = path.join(outputDir, filenameTemplate + ".%(ext)s");

  const args = [
    ...YT_DLP_BASE_ARGS,
    "-o", finalTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exit code: ${code}`));
    });
    proc.on("error", reject);
  });
}

// --- KLASA ZA UPRAVLJANJE KANALOM ---

class ChannelQueue {
  constructor(filePath, baseOutputDir) {
    this.filePath = filePath;
    this.baseOutputDir = baseOutputDir;

    // Ime foldera (kanal) također sanitiziramo
    const filename = path.basename(filePath).replace("-lista.txt", "").replace(".txt", "");
    this.channelName = sanitizeDescription(filename); 

    this.outputDir = path.join(baseOutputDir, this.channelName);
    this.stateFile = filePath.replace(".txt", "-state.json");
    this.state = loadState(this.stateFile);
    this.pendingVideos = [];
    this.isExhausted = false;

    this.init();
  }

  init() {
    const rawLines = fs.readFileSync(this.filePath, "utf-8").split("\n");

    const entries = rawLines
      .map((line) => {
        const data = extractDataFromLine(line);
        if (!data) return null;
        
        const videoId = extractVideoId(data.url);
        if (!videoId) return null;

        // --- PRIMJENA NAMING STANDARD V2.0 + SMART DATE ---
        
        // 1. Sanitizacija naslova
        const safeTitle = sanitizeDescription(data.title);
        
        // 2. ID ostaje originalan
        const originalId = videoId; 
        
        let filenameTemplate = "";
        
        // 3. Konstrukcija predloška
        // LOGIKA: Ako je datum valjan (8 znamenki) i NIJE "NA", koristi ga.
        // Inače koristi placeholder.
        
        if (data.date && /^\d{8}$/.test(data.date) && data.date !== "NA") {
             // Imamo pravi datum iz TXT datoteke
             filenameTemplate = `${data.date}_${safeTitle}_yt_${originalId}`;
        } else {
             // Nemamo datum (NA ili prazno) -> yt-dlp će ga umetnuti
             filenameTemplate = `%(upload_date)s_${safeTitle}_yt_${originalId}`;
        }

        return { 
            line, 
            url: data.url, 
            videoId, 
            title: data.title, 
            filenameTemplate 
        };
      })
      .filter((e) => e && e.videoId);

    // Ukloni duplikate (po ID-u)
    const uniqueMap = new Map();
    entries.forEach((e) => uniqueMap.set(e.videoId, e));
    const uniqueEntries = Array.from(uniqueMap.values());

    // Filtriraj već skinute
    this.pendingVideos = uniqueEntries.filter(
      (e) => !this.state.completed.includes(e.videoId)
    );

    if (this.pendingVideos.length === 0) {
      this.isExhausted = true;
    }
  }

  async processBatch(batchSize) {
    if (this.pendingVideos.length === 0) {
      this.isExhausted = true;
      return 0;
    }

    const batch = this.pendingVideos.slice(0, batchSize);
    let successCount = 0;

    console.log(`\n🔵 [${this.channelName.toUpperCase()}] Batch... (Preostalo: ${this.pendingVideos.length})`);

    for (let i = 0; i < batch.length; i++) {
      const video = batch[i];
      
      // Prikazujemo user-friendly log
      // Ako template počinje s %, znači da je datum automatski
      const logName = video.filenameTemplate.startsWith("%") 
        ? `[Auto-Date] ...${video.title.substring(0, 30)}...` 
        : video.filenameTemplate;
      
      console.log(`   ➡️  [${i + 1}/${batch.length}] Cilj: "${logName}"`);

      try {
        await downloadVideo(video.videoId, this.outputDir, video.filenameTemplate);

        this.state.completed.push(video.videoId);
        if (this.state.failed.includes(video.videoId)) {
          this.state.failed = this.state.failed.filter((id) => id !== video.videoId);
        }
        saveState(this.stateFile, this.state);
        
        console.log(`   ✅  [SPREMLJENO]`);
        successCount++;

        if (i < batch.length - 1) await sleep(1000);
      } catch (err) {
        console.error(`   ❌  [GREŠKA] ${video.videoId}: ${err.message}`);
        if (!this.state.failed.includes(video.videoId)) {
          this.state.failed.push(video.videoId);
          saveState(this.stateFile, this.state);
        }
      }
    }

    this.pendingVideos = this.pendingVideos.slice(batchSize);
    if (this.pendingVideos.length === 0) {
      this.isExhausted = true;
      console.log(`   🏁  [KRAJ] Kanal obrađen.`);
    }

    return successCount;
  }
}

// --- MAIN ---

async function main() {
  const args = process.argv.slice(2);
  const outputDirIdx = args.indexOf("--output-dir");
  const baseOutputDir = outputDirIdx !== -1 ? args[outputDirIdx + 1] : DEFAULT_OUTPUT_DIR;

  if (!fs.existsSync(LISTS_DIR)) {
    console.error(`Nema direktorija: ${LISTS_DIR}`);
    process.exit(1);
  }

  const listFiles = fs.readdirSync(LISTS_DIR)
    .filter((f) => f.endsWith("-lista.txt"))
    .map((f) => path.join(LISTS_DIR, f));

  if (listFiles.length === 0) {
    console.log("Nema listi.");
    process.exit(0);
  }

  console.log("--- Inicijalizacija ---");
  let channels = listFiles.map((file) => new ChannelQueue(file, baseOutputDir));
  let activeChannels = channels.filter((c) => !c.isExhausted);

  console.log(`\n🚀 POČETAK RADA (v2.0 + Smart Date)`);
  console.log(`   📂 Liste: ${LISTS_DIR}`);
  console.log(`   💾 Output: ${baseOutputDir}`);
  console.log(`   📝 Format: DATUM_naslov_yt_ID.mp3`);

  let round = 1;

  while (activeChannels.length > 0) {
    console.log(`\n=== KRUG ${round} (Aktivnih: ${activeChannels.length}) ===`);
    for (let i = 0; i < activeChannels.length; i++) {
      const channel = activeChannels[i];
      const downloaded = await channel.processBatch(BATCH_SIZE);
      if (downloaded > 0) {
        await sleep(SLEEP_BETWEEN_DOWNLOADS_MS);
      }
    }
    activeChannels = activeChannels.filter((c) => !c.isExhausted);
    round++;
  }

  console.log("\n✅ GOTOVO.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
});