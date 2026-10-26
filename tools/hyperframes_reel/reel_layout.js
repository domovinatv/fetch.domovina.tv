/* reel_layout.js — raspored teksta u HyperFrames reelu: nikad preko lica, uvijek u sigurnoj zoni.
 *
 * Prioriteti (tim redom):
 *   1. lice (+ kosa/brada) je zabranjena zona za svaki tekst — izvor: faces.json (face_track.py),
 *   2. sav tekst je u presjeku sigurnih zona TikTok/Reels/Shorts/Facebook (x 120–888, y 288–1248),
 *   3. kartica ne stane → kamera (#cam) se glatko pomakne gore/dolje da otvori mjesto,
 *   4. ni to ne stane → kamera se još i odzumira (do MIN_ZOOM; rub pokrije #bg-blur),
 *   5. tek onda se kartica smanji, a ispod MIN_SCALE javi upozorenje.
 * Iznimka je samo potpis (.credit, dolje desno): namjerno trajan i izvan sigurne zone.
 *
 * Upotreba (u document.fonts.ready, PRIJE tweenova kartica — from() tweenovi mijenjaju mjere):
 *   const L = ReelLayout.run(tl, { faces: REEL_FACES, camera: tl => {...zoom tweenovi #video-wrap...}, debug });
 * Kartica = element .slot unutar .clip (data-start/data-duration); animacije ciljaju UNUTARNJE
 * elemente, .slot pripada rasporedu (left/top/scale). data-prefer="below|above", data-align="left|center".
 * Titl = .cap clipovi. Izvještaj: window.__reelLayout.
 */
(function () {
  const W = 1080, H = 1920;
  const SAFE = { l: 120, r: 888, t: 288, b: 1248 };
  const GAP = 22;
  const PAD = { top: 0.30, bottom: 0.14, side: 0.16 };  // YuNet okvir (obrve–brada) → cijela glava
  const MIN_SCALE = 0.72;
  const MAX_SHIFT = 300;          // koliko smije kamera pomaknuti kadar zbog kartice
  const KEEP_HEAD = 30;           // tjeme ostaje barem toliko u kadru
  const MOVE = 0.8;               // trajanje pomaka kamere (s) — mirno, ne trzaj
  const MIN_ZOOM = 0.78;          // najviše odzumiranja #cam (ishodište x 540, y 0)
  const CAP_MIN_FONT = 50;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const win = el => { const c = el.closest("[data-start]"); const s = +c.dataset.start; return [s, s + +c.dataset.duration]; };

  function measure(el, fn) {          // clip izvan svog prozora može biti skriven → privremeno ga pokaži
    const c = el.closest("[data-start]"), d = c.style.display, v = c.style.visibility;
    c.style.display = "block"; c.style.visibility = "visible";
    try { return fn(); } finally { c.style.display = d; c.style.visibility = v; }
  }

  function run(tl, opt) {
    const F = opt.faces, report = [];
    const wrap = document.getElementById("video-wrap"), cam = document.getElementById("cam");
    const shotAt = t => F.shots.reduce((a, s) => (s.t0 <= t + 1e-6 ? s : a), F.shots[0]);

    // 1. kadriranje po snimci kamere (skok na rezu), 2. zoom iz predloška
    const s0 = F.shots[0];
    gsap.set(wrap, { left: s0.left, top: 0, width: F.wrap_w, height: F.wrap_h, transformOrigin: `${s0.ox}px ${s0.oy}px` });
    F.shots.slice(1).forEach(s => tl.set(wrap, { left: s.left, transformOrigin: `${s.ox}px ${s.oy}px` }, s.t0));
    if (opt.camera) opt.camera(tl);

    // lice na ekranu u trenutku uzorka (bez pomaka #cam); zoom se čita iz same timeline
    const base = F.samples.map(sm => {
      tl.seek(sm.t, false);
      const z = +gsap.getProperty(wrap, "scale") || 1, sh = shotAt(sm.t);
      return { t: sm.t, boxes: sm.faces.map(f => {
        const w = f[2] - f[0], h = f[3] - f[1];
        const g = [f[0] - w * PAD.side, f[1] - h * PAD.top, f[2] + w * PAD.side, f[3] + h * PAD.bottom];
        const X = x => sh.left + sh.ox + (x - sh.ox) * z, Y = y => sh.oy + (y - sh.oy) * z;
        return { x0: X(g[0]), y0: Y(g[1]), x1: X(g[2]), y1: Y(g[3]) };
      }).filter(b => b.x1 > 0 && b.x0 < W) };
    });
    tl.seek(0, false);

    let lift = [];                    // [{s, e, d, z}] pomak (y) i zoom #cam po kartici
    const NONE = { d: 0, z: 1 };
    const liftAt = t => { for (const k of lift) if (t >= k.s - MOVE && t <= k.e + MOVE) return k; return NONE; };
    const camBox = (f, c) => ({ x0: W / 2 + (f.x0 - W / 2) * c.z, x1: W / 2 + (f.x1 - W / 2) * c.z, y0: f.y0 * c.z + c.d, y1: f.y1 * c.z + c.d });
    const envelope = (s, e, withLift) => {
      let r = null;
      for (const b of base) {
        if (b.t < s - 0.25 || b.t > e + 0.25) continue;
        const c = withLift ? liftAt(b.t) : NONE;
        for (const f0 of b.boxes) { const f = camBox(f0, c);
          r = r ? { x0: Math.min(r.x0, f.x0), y0: Math.min(r.y0, f.y0), x1: Math.max(r.x1, f.x1), y1: Math.max(r.y1, f.y1) } : f; }
      }
      return r;
    };

    // titl: jedan red u širini sigurne zone (manji font prije loma), visina za rezervaciju
    const caps = [...document.querySelectorAll(".cap")];
    let capH = 0;
    caps.forEach(c => measure(c, () => {
      c.style.width = "auto"; c.style.whiteSpace = "nowrap";
      let fs = parseFloat(getComputedStyle(c).fontSize);
      while (c.offsetWidth > SAFE.r - SAFE.l && fs > CAP_MIN_FONT) { fs -= 2; c.style.fontSize = fs + "px"; }
      if (c.offsetWidth > SAFE.r - SAFE.l) c.style.whiteSpace = "normal";
      c.style.width = (SAFE.r - SAFE.l) + "px";
      c._h = c.offsetHeight; capH = Math.max(capH, c._h);
    }));

    // kartice: ispod ili iznad lica, uz pomak kamere, pa tek onda smanjenje
    const cards = [];
    [...document.querySelectorAll(".slot")].map(el => ({ el, w: win(el) })).sort((a, b) => a.w[0] - b.w[0]).forEach(({ el, w }) => {
      const [s, e] = w;
      // brojač: izmjeri s konačnom vrijednošću i zaključaj okvir, da „0 → 750“ ne raširi karticu
      const { cw, ch } = measure(el, () => {
        const ns = [...el.querySelectorAll("[data-to]")].map(n => [n, n.textContent]);
        ns.forEach(([n]) => { n.textContent = n.dataset.to; });
        const r = { cw: el.offsetWidth, ch: el.offsetHeight };
        ns.forEach(([n, t]) => { n.textContent = t; });
        if (ns.length) Object.assign(el.firstElementChild.style, { width: r.cw + "px", height: r.ch + "px", boxSizing: "border-box" });
        return r;
      });
      // bez lica (prazan kadar) = cijela sigurna zona je slobodna
      const env = envelope(s, e, false) || { x0: 0, x1: 0, y0: SAFE.t - GAP, y1: SAFE.t - GAP };
      const scW = Math.min(1, (SAFE.r - SAFE.l) / cw);
      const bottom = SAFE.b - (el.dataset.noCap != null ? 0 : capH + GAP);
      const opts = [];
      // ispod lica: pomak gore d<0 (tjeme ostaje u kadru), pa odzumiranje z<1 oko (540, 0)
      { const maxUp = Math.min(MAX_SHIFT, Math.max(0, env.y0 - KEEP_HEAD));
        const need = env.y1 + GAP + ch * scW + GAP - bottom;
        let d = -clamp(need, 0, maxUp), z = 1;
        if (need > maxUp && env.y0 > KEEP_HEAD) {   // tjeme na KEEP_HEAD: y0*z + d = KEEP_HEAD
          z = clamp((bottom - 2 * GAP - ch * scW - KEEP_HEAD) / (env.y1 - env.y0), MIN_ZOOM, 1);
          d = KEEP_HEAD - env.y0 * z;
        }
        const y1f = env.y1 * z + d, avail = bottom - y1f - 2 * GAP;
        opts.push({ where: "below", d, z, sc: Math.min(scW, avail / ch), y0: y1f + GAP, y1: bottom }); }
      // iznad lica: pomak dolje d>0
      { const maxDown = Math.min(MAX_SHIFT, Math.max(0, H - KEEP_HEAD - env.y1));
        const need = SAFE.t + ch * scW + GAP - env.y0;
        const d = clamp(need, 0, maxDown), avail = env.y0 + d - GAP - SAFE.t;
        opts.push({ where: "above", d, z: 1, sc: Math.min(scW, avail / ch), y0: SAFE.t, y1: env.y0 + d - GAP }); }
      const pref = el.dataset.prefer || "below";
      // puna veličina (preferirana strana, pa manji pomak kamere) > najveća skala
      const full = opts.filter(x => x.sc >= scW - 1e-3)
        .sort((a, b) => (b.where === pref) - (a.where === pref) || Math.abs(a.d) - Math.abs(b.d));
      const o = full[0] || opts.slice().sort((a, b) => b.sc - a.sc || (b.where === pref) - (a.where === pref))[0];
      const sc = clamp(o.sc, 0.3, 1), hh = ch * sc, ww = cw * sc;
      const top = o.y0 + Math.max(0, (o.y1 - o.y0 - hh) / 2);
      const left = el.dataset.align === "left" ? SAFE.l : (SAFE.l + SAFE.r - ww) / 2;
      gsap.set(el, { left, top, scale: sc, transformOrigin: "0 0" });
      const rect = { x0: left, y0: top, x1: left + ww, y1: top + hh, s, e };
      cards.push(rect);
      if (o.d || o.z !== 1) lift.push({ s, e, d: o.d, z: o.z });
      const warn = o.sc < MIN_SCALE ? "tijesno: kartica smanjena ispod MIN_SCALE" : "";
      report.push({ id: el.closest("[data-start]").id, where: o.where, top: Math.round(top), h: Math.round(hh),
                    scale: +sc.toFixed(2), shift: Math.round(o.d), zoom: +o.z.toFixed(2), warn });
    });

    // pomaci kamere: u kadar MOVE s prije kartice, natrag nakon; susjedne kartice idu izravno
    gsap.set(cam, { transformOrigin: `${W / 2}px 0px` });
    lift.forEach((k, i) => {
      const prev = lift[i - 1], next = lift[i + 1];
      const at = !prev || k.s - prev.e > 1.2 ? Math.max(0, k.s - MOVE) : Math.max(prev.e, k.s - MOVE);
      tl.to(cam, { y: k.d, scale: k.z, duration: MOVE, ease: "sine.inOut" }, at);
      if (!next || next.s - k.e > 1.2) tl.to(cam, { y: 0, scale: 1, duration: MOVE, ease: "sine.inOut" }, k.e);
    });
    // liftAt mora vidjeti i razmake između susjednih kartica kao pomaknute
    lift = lift.map((k, i) => { const n = lift[i + 1]; return n && n.s - k.e <= 1.2 ? Object.assign({}, k, { e: n.s }) : k; });

    // titl: stalna linija na dnu sigurne zone; seli se samo kad bi dirnuo lice ili karticu
    caps.forEach(c => {
      const [s, e] = win(c), h = c._h, env = envelope(s, e, true);
      const busy = cards.filter(r => r.s < e && s < r.e);
      const ok = y => y >= SAFE.t && y + h <= SAFE.b && ![env, ...busy].some(r => r && hit(r, { x0: SAFE.l, x1: SAFE.r, y0: y - 6, y1: y + h + 6 }));
      const tries = [SAFE.b - h, ...busy.map(r => r.y1 + GAP), env ? env.y1 + GAP : SAFE.b - h, env ? env.y0 - GAP - h : SAFE.t];
      let y = tries.find(ok);
      // nema mjesta ni za lice ni za karticu: titl smije preko lica, nikad preko teksta kartice
      const free = y => !busy.some(r => hit(r, { x0: SAFE.l, x1: SAFE.r, y0: y - 6, y1: y + h + 6 }));
      if (y == null) for (let yy = SAFE.b - h; yy >= SAFE.t; yy -= 8) if (free(yy) && (!env || !hit(env, { x0: SAFE.l, x1: SAFE.r, y0: yy, y1: yy + h }))) { y = yy; break; }
      if (y == null) for (let yy = SAFE.b - h; yy >= SAFE.t; yy -= 8) if (free(yy)) { y = yy; report.push({ id: c.id, warn: "titl preko lica (nema mjesta)" }); break; }
      if (y == null) { y = SAFE.b - h; report.push({ id: c.id, warn: "titl preko kartice (nema mjesta)" }); }
      gsap.set(c, { left: SAFE.l, top: y });
    });

    if (opt.debug) debugLayer(tl, base, liftAt, camBox, report);
    window.__reelLayout = report;
    console.log("[reel_layout] " + JSON.stringify(report));
    return report;
  }

  function debugLayer(tl, base, liftAt, camBox, report) {   // sigurna zona + zabranjena zona lica, za snapshot QA
    const st = document.getElementById("stage");
    const z = document.createElement("div");
    z.style.cssText = `position:absolute;left:${SAFE.l}px;top:${SAFE.t}px;width:${SAFE.r - SAFE.l}px;height:${SAFE.b - SAFE.t}px;outline:4px dashed #0f0;z-index:99`;
    const f = document.createElement("div");
    f.style.cssText = "position:absolute;outline:5px solid #f0f;background:rgba(255,0,255,.12);z-index:99";
    const r = document.createElement("pre");   // izvještaj rasporeda, čitljiv sa snapshota
    r.style.cssText = "position:absolute;left:8px;top:1560px;margin:0;font:16px monospace;color:#0f0;background:rgba(0,0,0,.7);z-index:99";
    r.textContent = report.map(x => JSON.stringify(x)).join("\n");
    st.append(z, f, r);
    const o = { t: 0 };
    tl.to(o, { t: base[base.length - 1].t, duration: base[base.length - 1].t, ease: "none", onUpdate() {
      const b = base.reduce((a, x) => (Math.abs(x.t - o.t) < Math.abs(a.t - o.t) ? x : a), base[0]).boxes[0];
      if (!b) { f.style.display = "none"; return; }
      const c = camBox(b, liftAt(o.t));
      Object.assign(f.style, { display: "block", left: c.x0 + "px", top: c.y0 + "px", width: c.x1 - c.x0 + "px", height: c.y1 - c.y0 + "px" });
    } }, 0);
  }

  window.ReelLayout = { run, SAFE };
})();
