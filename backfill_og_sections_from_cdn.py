#!/usr/bin/env python3
"""
backfill_og_sections_from_cdn.py — backfill per-section OG slika (og-t) za videe kojima
og-sections fali na CDN-u, BEZ re-fetcha videa.

Radi za videe koji na CDN-u VEĆ imaju `data/{id}/article.json` + `images/{id}/screenshots/*.png`
(npr. oni koje je stari MAX_SECTIONS=50 gate preskočio). Povlači article/info/screenshote s
CDN-a, regenerira og-t composite (reuse generate_og_sections.generate_composite) u temp kanal
`storage/output/_ogbackfill/`, i piše manifest. Nakon toga upload ide preko postojećeg
upload_to_r2.js (`--channel _ogbackfill`), koji og-sections mapira na `images/{id}/`.

Usage:
  python3 backfill_og_sections_from_cdn.py --ids 3_jA9b-myNQ,4_yc9vSG4Jc
  python3 backfill_og_sections_from_cdn.py --ids-file /path/lista.txt
  python3 backfill_og_sections_from_cdn.py --ids ID --dry-run
Nakon toga:
  node upload_to_r2.js --input-dir storage/output --channel _ogbackfill
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Reuse tested composite + helpers iz produkcijske skripte.
import generate_og_sections as og

CDN = "https://cdn.domovina.ai"
SCRIPT_DIR = Path(__file__).resolve().parent
BACKFILL_CHANNEL = "_ogbackfill"


def log(icon, msg):
    print(f"   {icon} {msg}", flush=True)


def cdn_get(path):
    # Cloudflare 403-a default Python-urllib UA → postavi normalan UA (kao curl/browser).
    url = f"{CDN}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "domovina-backfill/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def cdn_get_json(path):
    return json.loads(cdn_get(path).decode("utf-8"))


def process_video(video_id, out_root, *, dry_run=False):
    res = {"id": video_id, "generated": 0, "skipped_no_ss": 0, "errors": 0, "status": "ok"}
    try:
        article = cdn_get_json(f"data/{video_id}/article.json")
    except Exception as e:
        res["status"] = f"no_article: {e}"
        return res
    try:
        info = cdn_get_json(f"data/{video_id}/info.json")
    except Exception:
        info = {}

    title = info.get("title") or video_id
    channel = info.get("uploader") or info.get("channel") or "DOMOVINA"
    try:
        duration_sec = int(info.get("duration") or 0)
    except (TypeError, ValueError):
        duration_sec = 0

    sections = [s for it in article.get("iterations", []) for s in it.get("sections", [])]
    if not sections:
        res["status"] = "no_sections"
        return res

    video_base = f"ogbf_yt_{video_id}"
    og_dir = Path(out_root) / BACKFILL_CHANNEL / f"{video_base}.og-sections"
    tmp_dir = Path(out_root) / BACKFILL_CHANNEL / f"{video_base}_srctmp"
    if not dry_run:
        og_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)

    manifest_sections = {}
    for s in sections:
        subtitle = (s.get("subtitle") or "").strip()
        ts_str = (s.get("screenshot_timestamp") or "").strip()
        if not subtitle or not ts_str:
            continue
        try:
            sec = og.timestamp_to_seconds(ts_str)
        except ValueError:
            res["errors"] += 1
            continue
        ss_name = og.sanitize_ts_for_filename(ts_str)  # HH-MM-SS
        out_jpg = og_dir / f"og-t-{sec}.jpg"
        if dry_run:
            manifest_sections[str(sec)] = f"og-t-{sec}.jpg"
            continue
        # Povuci source screenshot s CDN-a
        src_png = tmp_dir / f"{ss_name}.png"
        try:
            data = cdn_get(f"images/{video_id}/screenshots/{ss_name}.png")
            src_png.write_bytes(data)
        except Exception:
            res["skipped_no_ss"] += 1
            continue
        try:
            og.generate_composite(
                src_png, out_jpg,
                subtitle=subtitle, timestamp_str=ts_str,
                episode_title=title, channel_name=channel,
            )
            manifest_sections[str(sec)] = f"og-t-{sec}.jpg"
            res["generated"] += 1
        except Exception as e:
            log("❌", f"{video_id} t={ts_str}: {e}")
            res["errors"] += 1
        finally:
            try:
                src_png.unlink()
            except OSError:
                pass

    if not dry_run:
        # Ukloni temp source dir
        try:
            tmp_dir.rmdir()
        except OSError:
            pass

    if manifest_sections and not dry_run:
        manifest = {
            "version": "1.0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "video_id": video_id,
            "video_base": video_base,
            "title": title,
            "channel": channel,
            "duration_sec": duration_sec or None,
            "sections": dict(sorted(manifest_sections.items(), key=lambda kv: int(kv[0]))),
        }
        (og_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

    res["sections"] = len(manifest_sections)
    if not manifest_sections:
        res["status"] = "no_composites"
    return res


def main():
    ap = argparse.ArgumentParser(description="Backfill og-sections iz CDN artefakata (bez re-fetcha)")
    ap.add_argument("--ids", help="Zarezom odvojeni video ID-evi")
    ap.add_argument("--ids-file", help="Datoteka s jednim ID-em po retku")
    ap.add_argument("--output-dir", default=str(SCRIPT_DIR / "storage" / "output"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ids = []
    if args.ids:
        ids += [x.strip() for x in args.ids.split(",") if x.strip()]
    if args.ids_file:
        ids += [ln.strip() for ln in Path(args.ids_file).read_text().splitlines() if ln.strip()]
    ids = list(dict.fromkeys(ids))  # dedup, zadrži redoslijed
    if not ids:
        ap.error("nema ID-eva (--ids ili --ids-file)")

    log("🎨", f"Backfill og-sections za {len(ids)} videa{' [DRY]' if args.dry_run else ''}")
    ok = gen = 0
    for i, vid in enumerate(ids, 1):
        r = process_video(vid, args.output_dir, dry_run=args.dry_run)
        icon = "✅" if r["status"] == "ok" else "⏭️"
        log(icon, f"[{i}/{len(ids)}] {vid} → {r.get('sections', 0)} sekcija, "
                  f"{r['generated']} gen, {r['skipped_no_ss']} no-ss, {r['errors']} err "
                  f"({r['status']})")
        if r["status"] == "ok":
            ok += 1
            gen += r["generated"]
    log("🏁", f"Gotovo: {ok}/{len(ids)} videa, {gen} og-t composita generirano.")
    if not args.dry_run:
        log("👉", f"Sljedeće: node upload_to_r2.js --input-dir {args.output_dir} --channel {BACKFILL_CHANNEL}")


if __name__ == "__main__":
    main()
