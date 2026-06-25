#!/usr/bin/env node
/**
 * colab_automation.js — Playwright + WebSocket-native automatizacija Colab Canary transkripcije
 *
 * Kako radi (umjesto DOM pollinga):
 *   Colab kernel komunicira kroz socket.io WebSocket tunel.
 *   - os.kill(os.getpid(), 9)  → kernel WS se ZATVARA (Pass 1 gotov)
 *   - runtime.unassign()       → VM terminira, sve WS veze padaju (Pass 2 gotov)
 *   Playwright prati WS close evenate — deterministički, ne ovisi o DOM selektorima.
 *
 * Two-pass flow:
 *   Pass 1: Run All → Cell 10 instalira NeMo + os.kill → WS close #1
 *   Pass 2: Run All → transkripcija → runtime.unassign() → WS close #2 (ne reconnect)
 *
 * Pokretanje:
 *   node colab_automation.js                  # puni two-pass run
 *   node colab_automation.js --skip-pass1     # preskoci instalaciju (deps vec ok)
 *   node colab_automation.js --no-shutdown    # ne cekaj na unassign (debug)
 *
 * NAPOMENA: Chrome mora biti ZATVOREN za profil mojadomovinatvojazemlja@gmail.com
 */

const { chromium } = require('playwright');
const { EventEmitter } = require('events');
const { execSync, spawn } = require('child_process');
const http = require('http');
const fs   = require('fs');
const path = require('path');

// Chrome radi CDP SAMO s ne-defaultnim user data dirom (sigurnosno ograničenje).
// Koristimo privremenu kopiju Profile 6 (pripremljenu u /tmp/colab_chrome_pw).
// Priprema: rsync -a --exclude=Cache/ ... "Profile 6/" /tmp/colab_chrome_pw/Default/
// spawnChrome() ovo priprema automatski pri svakom pokretanju.
const CHROME_USER_DATA_REAL = '/Users/ms/Library/Application Support/Google/Chrome';
const CHROME_USER_DATA      = '/tmp/colab_chrome_pw';  // kopija Profile 6 kao Default
const CHROME_BINARY    = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PROFILE   = 'Default'; // kopija mojadomovinatvojazemlja@gmail.com
const CDP_PORT         = 9224;      // port za Chrome DevTools Protocol

const NOTEBOOK_URL =
  'https://colab.research.google.com/github/domovinatv/fetch.domovina.tv/blob/main/colab_canary/domovina_tv_canary_transcribe.ipynb';

// Timeouts (ms)
const T_LOAD       = 90_000;
const T_INSTALL    = 8 * 60_000;        // NeMo install ~2 min, damo 8 min
const T_TRANSCRIBE = 4 * 60 * 60_000;  // transkripcija do 4h

const cliArgs      = process.argv.slice(2);
const SKIP_PASS1   = cliArgs.includes('--skip-pass1');
const NO_SHUTDOWN  = cliArgs.includes('--no-shutdown');
const INIT_PROFILE = cliArgs.includes('--init-profile'); // forciraj refresh profila iz Profile 6

// --- Logging ---

function ts()             { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(msg)         { console.log(`[${ts()}] ${msg}`); }
function logSection(msg)  { console.log(`\n${'═'.repeat(62)}\n  ${msg}\n${'═'.repeat(62)}`); }

// --- WebSocket tracker ---
// Playwright eventi su synchronous callbacks — koristimo EventEmitter za async čekanje.

function makeKernelTracker() {
  const events = new EventEmitter();
  events.setMaxListeners(50);

  let wsCount        = 0;  // koliko kernel WS-ova je dosad otvoreno
  let wsOpen         = 0;  // trenutno otvorenih kernel WS-ova
  let tunnelId       = null;
  let lastKernelUrl  = null;

  function attach(page) {
    page.on('websocket', ws => {
      const url = ws.url();

      // Hvatamo samo Colab kernel WebSocket-ove (socket.io tunnel ili /channels)
      const isKernelWs =
        url.includes('/channels') ||
        (url.includes('colab.research.google.com') && url.includes('socket.io'));

      if (!isKernelWs) return;

      // Izvuci tunnel instance_id ako ga imamo
      const m = url.match(/\/tun\/m\/([^/]+)\//);
      if (m && !tunnelId) {
        tunnelId = m[1];
        log(`[ws] Tunnel instance_id: ${tunnelId}`);
      }

      wsCount++;
      wsOpen++;
      lastKernelUrl = url;
      const myId = wsCount;

      log(`[ws] #${myId} OTVOREN  ${url.slice(0, 90)}`);
      events.emit('ws_open', { id: myId, url });

      // Prati svaki frame — tražimo socket.io kernel status poruke
      ws.on('framereceived', frame => {
        try {
          // Socket.io poruke počinju s "42" (EVENT tip)
          const raw = frame.payload;
          if (typeof raw !== 'string' || !raw.startsWith('42')) return;
          const json = JSON.parse(raw.slice(2));
          if (!Array.isArray(json) || json.length < 2) return;
          const [, data] = json;
          // Jupyter kernel messaging: status poruke u iopub kanalu
          if (data?.msg_type === 'status' || data?.header?.msg_type === 'status') {
            const state = data?.content?.execution_state || data?.execution_state;
            if (state) events.emit('kernel_status', { state, wsId: myId });
          }
        } catch { /* nebitno */ }
      });

      ws.on('close', () => {
        wsOpen--;
        log(`[ws] #${myId} ZATVOREN  (otvorenih: ${wsOpen})`);
        events.emit('ws_close', { id: myId, wsOpen, wsCount });
      });
    });

    // HTTP zahtjevi — za dokaz da je runtime connect pokrenut
    page.on('request', req => {
      const url = req.url();
      if (url.includes('/tun/m/') && url.includes('/api/kernels')) {
        const m = url.match(/\/tun\/m\/([^/]+)\//);
        if (m && !tunnelId) {
          tunnelId = m[1];
          log(`[http] Tunnel instance_id: ${tunnelId}`);
        }
        events.emit('kernel_api_request', url);
      }
    });
  }

  // Čeka N-to zatvaranje kernel WebSocket-a.
  // n=1 → Pass 1 (os.kill), n=2 → Pass 2 (runtime.unassign)
  function waitForWsClose(n, timeout) {
    let seen = 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() =>
        reject(new Error(`Timeout ${timeout/1000}s čekajući WS close #${n}`)), timeout);

      const handler = ({ wsOpen: open }) => {
        seen++;
        log(`[ws] Close event #${seen} (tražimo #${n}, otvorenih preostalo: ${open})`);
        if (seen >= n) {
          clearTimeout(timer);
          events.off('ws_close', handler);
          resolve({ wsOpen: open });
        }
      };
      events.on('ws_close', handler);
    });
  }

  // Čeka da se WS veza uspostavi (kernel spreman)
  function waitForWsOpen(timeout = 60_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() =>
        reject(new Error(`Timeout ${timeout/1000}s čekajući WS kernel open`)), timeout);
      const handler = (data) => {
        clearTimeout(timer);
        events.off('ws_open', handler);
        resolve(data);
      };
      events.on('ws_open', handler);
    });
  }

  return { attach, waitForWsClose, waitForWsOpen, get tunnelId() { return tunnelId; }, events };
}

// --- Runtime type ---

async function ensureGpuRuntime(page) {
  // Klik na Runtime u top-level meniju → Change runtime type
  log('Tražim GPU runtime...');

  // Pokušaj kliknuti Runtime menu — Colab koristi standardni text meni ili custom el
  const runtimeMenuSelectors = [
    'text=Runtime',
    '[data-toggle-button-id="runtime-menu"]',
    'colab-toolbar-button[title="Runtime"]',
  ];

  let menuOpened = false;
  for (const sel of runtimeMenuSelectors) {
    try {
      await page.click(sel, { timeout: 5_000 });
      menuOpened = true;
      log(`  Runtime meni otvoren (selector: ${sel})`);
      break;
    } catch { /* probaj sljedeci */ }
  }

  if (!menuOpened) {
    log('  ⚠️  Ne mogu otvoriti Runtime meni — pretpostavljam da je GPU već odabran.');
    return;
  }

  await page.waitForTimeout(500);

  // Change runtime type
  try {
    await page.click('text=Change runtime type', { timeout: 5_000 });
    await page.waitForTimeout(1_000);
    log('  "Change runtime type" dialog otvoren.');
  } catch {
    log('  "Change runtime type" nije pronađen, zatvaram meni.');
    await page.keyboard.press('Escape');
    return;
  }

  // U dialogu: odaberi hardware accelerator
  // Colab Pro+ prikazuje: None, T4 GPU, L4 GPU, A100 GPU (ili Premium GPU)
  // G4 (RTX PRO 6000 Blackwell) se dodjeljuje kad odabereš A100 na Pro+
  const hwSelectors = [
    'select[name="acceleratorType"]',
    'select[aria-label*="Hardware"]',
    'select[aria-label*="accelerator"]',
    // Colab novi UI — radio buttons u dialogu
    'input[value="GPU"]',
    'input[type="radio"][id*="GPU"]',
  ];

  let hwSet = false;
  for (const sel of hwSelectors) {
    try {
      const el = page.locator(sel).first();
      const tag = await el.evaluate(e => e.tagName, null, { timeout: 3_000 });
      if (tag === 'SELECT') {
        const opts = await el.evaluate(s =>
          Array.from(s.options).map(o => ({ v: o.value, t: o.text })));
        log(`  GPU opcije: ${opts.map(o => o.t).join(', ')}`);
        // Preferiraj A100 > L4 > T4, izbjegaj None
        for (const pref of ['A100', 'L4', 'GPU', 'T4']) {
          const opt = opts.find(o => o.t.toUpperCase().includes(pref));
          if (opt) {
            await el.selectOption(opt.v);
            log(`  Odabrano: "${opt.t}"`);
            hwSet = true;
            break;
          }
        }
      } else if (tag === 'INPUT') {
        await el.check();
        log(`  GPU radio button označen.`);
        hwSet = true;
      }
      if (hwSet) break;
    } catch { /* selector ne postoji u ovom UI */ }
  }

  if (!hwSet) log('  ⚠️  Hardware selector nije pronađen. Provjeri ručno ili preskoči.');

  // Spremi
  try {
    const saveBtn = page.locator('[role="button"]:has-text("Save"), button:has-text("Save")').first();
    await saveBtn.click({ timeout: 5_000 });
    log('  Dijaloški okvir spremljen. Runtime type postavljen.');
    await page.waitForTimeout(2_000);
  } catch {
    await page.keyboard.press('Escape');
    log('  ⚠️  Save button nije pronađen — zatvoreno s Escape.');
  }
}

// --- Run All ---

async function runAll(page) {
  // Kernel WebSocket treba biti spreman (page focused)
  await page.bringToFront();
  await page.click('body');
  await page.waitForTimeout(400);
  // Colab shortcut za Run all — radi i u novom i starom UI
  await page.keyboard.press('Control+F9');
  log('  ▶  Ctrl+F9 (Run All) poslano.');
}

// --- Chrome spawn + CDP connect ---

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForCdp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(res => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, res).on('error', res);
      req.setTimeout(1000, () => req.destroy());
    }).catch(() => {});
    // Provjeri je li HTTP odgovorio — http.get callback prima response objekt
    // Pokušaj direktnom provjerom
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return; // CDP spreman
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`CDP nije spreman na portu ${port} nakon ${timeoutMs}ms`);
}

async function setupTempProfile(forceRefresh = false) {
  // Chrome radi CDP samo s ne-defaultnim user data dirom.
  // Profil se čuva između runova da sačuva Google sesiju (sign-in jednom).
  // Koristite --init-profile flag za forcirani refresh iz Profile 6.
  const profileExists = fs.existsSync(path.join(CHROME_USER_DATA, 'Default', 'Cookies'));

  if (profileExists && !forceRefresh) {
    // Popravi samo exit_type (bez brisanja sesije)
    const prefsPath = path.join(CHROME_USER_DATA, 'Default', 'Preferences');
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      prefs.profile = prefs.profile || {};
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    } catch {}
    const sizeMb = Math.round(parseInt(execSync(`du -sk "${CHROME_USER_DATA}"`, { encoding: 'utf8' }).split('\t')[0]) / 1024);
    log(`Temp profil postoji (~${sizeMb}MB), koristim esisteću sesiju ✓`);
    return;
  }

  // Inicijalni setup ili --init-profile: kopiraj Profile 6
  log('Inicijalizacija temp profila (kopija Profile 6)...');
  execSync(`
    rm -rf "${CHROME_USER_DATA}" &&
    mkdir -p "${CHROME_USER_DATA}" &&
    rsync -a --delete \\
      --exclude="Cache/" --exclude="Code Cache/" --exclude="GPUCache/" \\
      --exclude="IndexedDB/" --exclude="Service Worker/" --exclude="CacheStorage/" \\
      --exclude="blob_storage/" --exclude="Sessions/" \\
      "${CHROME_USER_DATA_REAL}/Profile 6/" "${CHROME_USER_DATA}/Default/" &&
    cp "${CHROME_USER_DATA_REAL}/Local State" "${CHROME_USER_DATA}/" 2>/dev/null || true
  `, { stdio: 'ignore', shell: '/bin/bash' });

  const prefsPath = path.join(CHROME_USER_DATA, 'Default', 'Preferences');
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.profile = prefs.profile || {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch {}

  const sizeMb = Math.round(parseInt(execSync(`du -sk "${CHROME_USER_DATA}"`, { encoding: 'utf8' }).split('\t')[0]) / 1024);
  log(`Temp profil inicijaliziran: ~${sizeMb}MB ✓`);
}

async function spawnChrome(forceRefresh = false) {
  await setupTempProfile(forceRefresh);

  // Pokreni Chrome s debugging portom
  const chromeProc = spawn(CHROME_BINARY, [
    `--user-data-dir=${CHROME_USER_DATA}`,
    `--profile-directory=Default`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-restore-last-session',
    '--disable-session-crashed-bubble',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  chromeProc.unref();
  log(`Chrome pokrenutan (PID: ${chromeProc.pid}), čekam CDP na portu ${CDP_PORT}...`);

  await waitForCdp(CDP_PORT, 45_000);
  log(`CDP spreman na portu ${CDP_PORT} ✓`);
  return chromeProc;
}

// --- Main ---

async function main() {
  logSection('Colab Canary Automation — fetch.domovina.tv');
  log(`Profil: ${CHROME_PROFILE} (${CHROME_USER_DATA})`);
  log(`Skip pass 1: ${SKIP_PASS1} | No-shutdown: ${NO_SHUTDOWN}`);

  const tracker = makeKernelTracker();

  // Spawn Chrome s pravim profilom + CDP port, zatim se povezi
  await spawnChrome(INIT_PROFILE);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  log('Playwright spojen na Chrome via CDP ✓');

  // Dohvati ili kreiraj kontekst s pravim cookijima (Profile 6)
  const contexts = browser.contexts();
  const context  = contexts.length > 0 ? contexts[0] : await browser.newContext();

  // Otvori novi tab za Colab (naslijeđuje cookije iz Profile 6)
  const page = await context.newPage();
  tracker.attach(page);  // ← WS listener mora biti aktivan PRIJE goto()

  try {
    // 1. Otvori notebook
    logSection('1. Učitavam notebook');
    await page.goto(NOTEBOOK_URL, { timeout: T_LOAD });

    // Čekaj da se Colab UI renderira — bar jedna celija mora biti vidljiva
    log('Čekam renderiranje notebooka...');
    await page.waitForSelector(
      'colab-notebook-cell, [data-cell-id], .cell, .codecell-input-output',
      { timeout: T_LOAD }
    );
    await page.waitForTimeout(2_500);

    // Provjeri je li user prijavljen — ako nije, čekaj ručnu prijavu (do 5 min)
    const signInBtn = page.locator('a[href*="accounts.google.com"], button:has-text("Sign in"), .sign-in-button');
    const notLoggedIn = await signInBtn.first().isVisible({ timeout: 3_000 }).catch(() => false);
    if (notLoggedIn) {
      log('⚠️  Nisi prijavljen u Google! Prijavi se ručno u Chrome prozoru (max 5 min)...');
      // Čekaj da sign-in gumb nestane (= korisnik se prijavio)
      await page.waitForFunction(
        () => !document.querySelector('a[href*="accounts.google.com/ServiceLogin"], .sign-in-button'),
        { timeout: 5 * 60_000 }
      ).catch(() => log('  (Timeout čekanja na prijavu — nastavljam svejedno)'));
      await page.waitForTimeout(2_000);
      log('Prijava detektirana, nastavljam...');
    }
    log('Notebook učitan.');

    // 2. GPU runtime (samo ako ne skipamo pass1 — pri skip-u pretpostavljamo da je sve ok)
    if (!SKIP_PASS1) {
      logSection('2. GPU Runtime provjera');
      await ensureGpuRuntime(page);
    }

    // 3. PASS 1 — instalacija NeMo
    if (!SKIP_PASS1) {
      logSection('3. Pass 1 — NeMo instalacija (~2 min)');
      await runAll(page);

      log('Čekam WS open (kernel se pokrenuo)...');
      try { await tracker.waitForWsOpen(60_000); }
      catch { log('  (WS open nije uhvaćen — možda je bio prije, nastavljamo)'); }

      log('Čekam kernel crash (os.kill po završetku instalacije)...');
      await tracker.waitForWsClose(1, T_INSTALL);
      log('Pass 1 gotov ✓  Kernel se ugasio, NeMo instaliran.');

      // Daj Colabu 5s da sredi UI (kernel restart notifikacija)
      await page.waitForTimeout(5_000);
    } else {
      log('⏭  Pass 1 preskočen (--skip-pass1).');
    }

    // 4. PASS 2 — transkripcija
    logSection('4. Pass 2 — Canary transkripcija');
    await runAll(page);

    // Čekaj WS open (novi kernel po restartu ili postojeći)
    const wsBeforePass2 = SKIP_PASS1 ? 0 : 1;
    log(`Čekam WS open za Pass 2 kernel...`);
    try { await tracker.waitForWsOpen(60_000); }
    catch { log('  (WS open nije uhvaćen — možda je bio aktivan, nastavljamo)'); }

    if (NO_SHUTDOWN) {
      log('⏭  --no-shutdown: transkripcija radi u pozadini, izlazim. Prati sam log na Colabu.');
    } else {
      // runtime.unassign() zatvara WS i VM se gasi — ne otvara novi WS
      // Razlika od Pass 1: kernel restart otvori novi WS odmah, unassign ne
      log('Čekam runtime.unassign() (transkripcija završena, VM se gasi)...');
      log('(može trajati 5 min do 4 sata, ovisno o backlogu)');

      const closeCount = SKIP_PASS1 ? 1 : 2;
      const { wsOpen } = await tracker.waitForWsClose(closeCount, T_TRANSCRIBE);

      // Provjeri da nije samo kernel restart (koji bi odmah otvorio novi WS)
      // Čekamo 10s — ako se novi WS ne otvori, to je bio unassign
      log(`WS zatvoren (otvorenih: ${wsOpen}). Čekam 10s da vidim je li to unassign ili restart...`);
      const finalOpenPromise = new Promise(res => {
        tracker.events.once('ws_open', () => res('restart'));
        setTimeout(() => res('unassign'), 10_000);
      });
      const verdict = await finalOpenPromise;

      if (verdict === 'unassign') {
        logSection('✅ ZAVRŠENO — runtime.unassign() potvrđen');
        log('Canary transkripcija dovršena. Rezultati su na Google Drive.');
        log('Sljedeći korak: run_pipeline.sh (rclone sync + diarize lokalno)');
      } else {
        log('⚠️  Novi WS se otvorio — to je kernel restart, ne unassign.');
        log('Možda je Pass 2 naišao na grešku ili je AUTO_SHUTDOWN=False.');
        log('Provjerim Colab output ručno.');
      }
    }

  } catch (err) {
    logSection('❌ GREŠKA');
    log(err.message);
    log('Ostavljam browser otvoren 2 min za ručni pregled...');
    await page.waitForTimeout(120_000);
    process.exit(1);
  } finally {
    // Odspoji Playwright ali NE gasi Chrome — Colab runtime nastavlja raditi
    try { await browser.close(); } catch {}
  }
}

main();
