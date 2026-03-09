#!/usr/bin/env node

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- KONFIGURACIJA ---
const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");
const COOKIES_FILE = path.join(__dirname, "automatic", "cookies.txt");
const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";

// --- PRECIZNA KONFIGURACIJA ZA TVOJ STROJ (BRAVE on MACOS) ---
const BROWSER_NAME = "brave";
const USE_BROWSER_COOKIES = true;

// Tvoj točan User-Agent header
const MY_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

// Postavke ciklusa
const BATCH_SIZE = 2;
const SLEEP_BETWEEN_DOWNLOADS_MS = 3000;

// Anti-Bot
const ERROR_THRESHOLD = 3;
const COOL_DOWN_MS = 60000;
let globalConsecutiveErrors = 0;

const YT_DLP_BASE_ARGS = [
  // --- KVALITETA VIDEA (NOVO) ---
  // Ovo kaže: Daj mi video max visine 360px (dakle 640x360) + najbolji audio
  "-f", "bestvideo[height<=360]+bestaudio/best[height<=360]",

  "-x", // Audio only (extract audio)
  "-k", // Keep video (zadrži i video datoteku - sad će biti mala 360p)
  "--audio-format", "mp3",
  "--embed-thumbnail",
  "--add-metadata",
  "--write-info-json",
  "--write-description",
  "--write-subs",
  "--sub-lang", "hr,en",
  "--write-thumbnail",
  "--convert-thumbnails", "png",

  // --- USER AGENT ---
  "--user-agent", MY_USER_AGENT,

  // --- RJEŠENJE ZA 'Requested format is not available' ---
  "--remote-components", "ejs:github",

  "--no-check-certificate",
  "--prefer-free-formats",
  "--restrict-filenames"
];

// --- AUTO-DETECT COOKIES ---
if (USE_BROWSER_COOKIES) {
  console.log(`🍪 Koristim LIVE kolačiće iz preglednika: ${BROWSER_NAME.toUpperCase()}`);
  YT_DLP_BASE_ARGS.push("--cookies-from-browser", BROWSER_NAME);
} else if (fs.existsSync(COOKIES_FILE)) {
  console.log(`🍪 Cookies datoteka pronađena: ${COOKIES_FILE}`);
  YT_DLP_BASE_ARGS.push("--cookies", COOKIES_FILE);
} else {
  console.log("⚠️ Nema kolačića. YouTube će te vjerojatno blokirati.");
}

// --- POMOĆNE FUNKCIJE ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      // Osiguraj da 'private' polje postoji (kompatibilnost sa starijim state datotekama)
      if (!Array.isArray(state.private)) state.private = [];
      return state;
    } catch (e) {
      console.error(`[GREŠKA] Neispravan JSON stanja: ${stateFile}`);
    }
  }
  return { completed: [], failed: [], private: [] };
}

function saveState(stateFile, state) {
  const tempFile = stateFile + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempFile, stateFile);
}

function downloadVideo(videoId, outputDir, filenameTemplate) {
  fs.mkdirSync(outputDir, { recursive: true });
  const finalTemplate = path.join(outputDir, filenameTemplate + ".%(ext)s");

  const args = [
    ...YT_DLP_BASE_ARGS,
    "-o", finalTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  return new Promise((resolve, reject) => {
    // Capture stderr da detektiramo private/unavailable video greške
    const proc = spawn("yt-dlp", args, {
      stdio: ["inherit", "inherit", "pipe"]  // stdin+stdout inherit, stderr capture
    });

    let stderrOutput = "";
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrOutput += text;
      // Ispiši stderr u realnom vremenu (kao i prije)
      process.stderr.write(text);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`yt-dlp exit code: ${code}`);
        // Detektiraj private/unavailable video
        if (stderrOutput.includes("This video is private") ||
          stderrOutput.includes("Video unavailable") ||
          stderrOutput.includes("Private video")) {
          err.isPrivate = true;
        }
        reject(err);
      }
    });
    proc.on("error", reject);
  });
}

class ChannelQueue {
  constructor(filePath, baseOutputDir) {
    this.filePath = filePath;
    this.baseOutputDir = baseOutputDir;
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

        const safeTitle = sanitizeDescription(data.title);
        let filenameTemplate = "";

        if (data.date && /^\d{8}$/.test(data.date) && data.date !== "NA") {
          filenameTemplate = `${data.date}_${safeTitle}_yt_${videoId}`;
        } else {
          filenameTemplate = `%(upload_date)s_${safeTitle}_yt_${videoId}`;
        }

        return { line, url: data.url, videoId, title: data.title, filenameTemplate };
      })
      .filter((e) => e && e.videoId);

    const uniqueMap = new Map();
    entries.forEach((e) => uniqueMap.set(e.videoId, e));
    this.pendingVideos = Array.from(uniqueMap.values()).filter(e =>
      !this.state.completed.includes(e.videoId) &&
      !this.state.private.includes(e.videoId)
    );

    if (this.pendingVideos.length === 0) this.isExhausted = true;
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
      const logName = video.filenameTemplate.startsWith("%")
        ? `[Auto-Date] ...${video.title.substring(0, 30)}...`
        : video.filenameTemplate;

      console.log(`   ➡️  [${i + 1}/${batch.length}] Cilj: "${logName}"`);

      try {
        await downloadVideo(video.videoId, this.outputDir, video.filenameTemplate);

        if (globalConsecutiveErrors > 0) {
          console.log(`   ✨ [OPORAVAK] Resetiram brojač grešaka.`);
        }
        globalConsecutiveErrors = 0;

        this.state.completed.push(video.videoId);
        if (this.state.failed.includes(video.videoId)) {
          this.state.failed = this.state.failed.filter((id) => id !== video.videoId);
        }
        saveState(this.stateFile, this.state);
        console.log(`   ✅  [SPREMLJENO]`);
        successCount++;
        if (i < batch.length - 1) await sleep(1000);

      } catch (err) {
        // --- PRIVATNI VIDEO: trajno preskoči, bez retry-a ---
        if (err.isPrivate) {
          console.log(`   🔒  [PRIVATNO] ${video.videoId}: Video je privatan/nedostupan — trajno preskačem`);
          if (!this.state.private.includes(video.videoId)) {
            this.state.private.push(video.videoId);
            // Ako je bio u failed, makni ga
            this.state.failed = this.state.failed.filter((id) => id !== video.videoId);
            saveState(this.stateFile, this.state);
          }
          // NE povećavaj globalConsecutiveErrors (nije bot-protection problem)
          continue;
        }

        // --- OSTALE GREŠKE: uobičajena logika ---
        globalConsecutiveErrors++;
        console.error(`   ❌  [GREŠKA] ${video.videoId}: ${err.message}`);
        console.error(`       ⚠️  Uzastopna greška br. ${globalConsecutiveErrors}`);

        if (!this.state.failed.includes(video.videoId)) {
          this.state.failed.push(video.videoId);
          saveState(this.stateFile, this.state);
        }

        if (globalConsecutiveErrors >= ERROR_THRESHOLD) {
          console.log(`\n🛑 BOT PROTECTION TRIGGERED (${globalConsecutiveErrors} grešaka).`);
          console.log(`⏳ Čekam ${COOL_DOWN_MS / 1000} sekundi...`);
          await sleep(COOL_DOWN_MS);
          console.log(`▶️  Nastavljam...`);
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

async function main() {
  const args = process.argv.slice(2);
  const outputDirIdx = args.indexOf("--output-dir");
  const baseOutputDir = outputDirIdx !== -1 ? args[outputDirIdx + 1] : DEFAULT_OUTPUT_DIR;

  if (!fs.existsSync(LISTS_DIR)) { console.error(`Nema direktorija: ${LISTS_DIR}`); process.exit(1); }
  const listFiles = fs.readdirSync(LISTS_DIR).filter((f) => f.endsWith("-lista.txt")).map((f) => path.join(LISTS_DIR, f));

  console.log("--- Inicijalizacija ---");
  let channels = listFiles.map((file) => new ChannelQueue(file, baseOutputDir));
  let activeChannels = channels.filter((c) => !c.isExhausted);

  console.log(`\n🚀 POČETAK RADA (Brave on macOS + 360p Limit)`);
  console.log(`   📂 Liste: ${LISTS_DIR}`);
  console.log(`   🍪 Browser Source: ${BROWSER_NAME.toUpperCase()}`);
  console.log(`   🎥 Video Quality: Max 360p`);

  let round = 1;
  while (activeChannels.length > 0) {
    console.log(`\n=== KRUG ${round} (Aktivnih: ${activeChannels.length}) ===`);
    for (let i = 0; i < activeChannels.length; i++) {
      const channel = activeChannels[i];
      const downloaded = await channel.processBatch(BATCH_SIZE);
      if (downloaded > 0) await sleep(SLEEP_BETWEEN_DOWNLOADS_MS);
    }
    activeChannels = activeChannels.filter((c) => !c.isExhausted);
    round++;
  }
  console.log("\n✅ GOTOVO.");
}

main().catch((err) => console.error("Fatal error:", err));