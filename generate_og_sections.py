#!/usr/bin/env python3
"""
generate_og_sections.py

Per-section OG share composite slike (Tier B social sharing).

Tier A: jedna generic og-share.jpg po videu (generate_og_image.js, KORAK 9.5)
Tier B: zasebna og-t-{sec}.jpg po section-u (ovaj script, KORAK 9.6) — worker
        u domovina.ai bira na temelju tSec query param-a za /v/<ytId>/t/<sec> share URL-ove.

Input per video:
  {channel}/{base}.article.json                     subtitle + screenshot_timestamp
  {channel}/{base}.article.en.json                  subtitle_en (opcionalno, za -en varijantu)
  {channel}/{base}.info.json                        title, uploader, channel, duration
  {channel}/{base}_screenshots/{base}_{HH-MM-SS}.png  postojeci frame (REUSE)

Output:
  {channel}/{base}.og-sections/og-t-{sec}.jpg       composite per section (HR)
  {channel}/{base}.og-sections/og-t-{sec}-en.jpg    isto, subtitle_en iz article.en.json
  {channel}/{base}.og-sections/manifest.json        {sections, sections_en} -> filename

Composite specs (jednako Tier A za WhatsApp/FB/LinkedIn kompatibilnost):
  - 1200x630 (OG canonical 1.91:1)
  - Progressive JPEG, q=85, sRGB
  - Cilj < 600 KB (WhatsApp hard limit)

Layout:
  +-------------------------------------------+
  | [ frame iz videa cover-crop 1200x630   ] |
  | [ tamni gradijent na donja ~60% visine ] |
  | (sat) HH:MM:SS  ●                         |
  | Subtitle iz article.json (max 2 linije)   |
  | ─── (CRO navy linija)                     |
  | Episode title (truncate na ~70 chara)     |
  | DOMOVINA.ai · channel                     |
  +-------------------------------------------+

Idempotentno: skip ako og-t-{sec}.jpg postoji i noviji je od article.json + source PNG.
Whole-video skip:
  - article.json missing ili sections empty
  - duration < 5 min (kratki video, generic og-share dovoljan)
  - > 50 sections (vjerojatno corrupt article)
Section skip:
  - subtitle prazan
  - source screenshot PNG ne postoji (worker fallback-a na og-share.jpg)

Flags:
  --input-dir DIR    storage/output (default)
  --channel NAME     filter samo na taj kanal
  --limit N          procesiraj max N videa (testing)
  --force            regeneriraj sve, ignoriraj idempotency
  --dry-run          ispis bez pisanja

Primjer:
  python3 generate_og_sections.py --input-dir storage/output --channel domovina_tv --limit 2
  python3 generate_og_sections.py --input-dir storage/output --force
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.stderr.write("❌ Pillow nije instaliran. pip3 install Pillow\n")
    sys.exit(1)


# --- KONSTANTE ---
OG_WIDTH = 1200
OG_HEIGHT = 630
JPEG_QUALITY = 85
HARD_MAX_BYTES = 600 * 1024

CRO_NAVY = (0, 47, 108)
CRO_RED = (220, 28, 28)  # malo tamniji nego pure red da ne bode oci na social previewu
WHITE = (255, 255, 255)
LIGHT_GRAY = (220, 220, 220)
GRADIENT_MAX_ALPHA = 220  # 0..255; ~0.86

# Whole-video skip pragovi. Namjerno labavi: og-t sekcije se generiraju IZ article
# sekcija + postojećih screenshot frame-ova, pa se vežemo uz njih, ne uz trajanje.
# - MIN_DURATION_SEC 60: preskoči samo mikro-klipove; ad-hoc/X videi (npr. 245s) prolaze.
#   (prije 300 → blokiralo legit kratke videe kao CUJmOc91C64 4min).
# - MAX_SECTIONS 250: guard protiv korumpiranog article.json-a, ne protiv dugih videa.
#   (prije 50 → blokiralo legit duge videe s puno sekcija, npr. 74min → 68 sekcija).
MIN_DURATION_SEC = 60
MAX_SECTIONS = 250

# Font paths (macOS standard) — Helvetica.ttc index 0=Regular, 1=Bold po default-u
FONT_PATH = '/System/Library/Fonts/Helvetica.ttc'
FONT_PATH_FALLBACK = '/System/Library/Fonts/HelveticaNeue.ttc'


# --- HELPERS ---

def ts():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def log(emoji, msg):
    print(f"   {emoji} [{ts()}] {msg}", flush=True)


def human_size(bytes_):
    if bytes_ < 1024:
        return f"{bytes_} B"
    if bytes_ < 1024 * 1024:
        return f"{bytes_ / 1024:.1f} KB"
    return f"{bytes_ / (1024 * 1024):.1f} MB"


def timestamp_to_seconds(ts_str):
    parts = ts_str.strip().split(':')
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    raise ValueError(f"Bad timestamp: {ts_str!r}")


def sanitize_ts_for_filename(ts_str):
    return ts_str.replace(':', '-')


def extract_video_id(base):
    """{base} sadrži '_yt_<11chars>' suffix."""
    m = re.search(r'_yt_([A-Za-z0-9_-]{11})', base)
    return m.group(1) if m else None


def load_info_json(path):
    """Robustno čita info.json — yt-dlp ponekad upisuje non-UTF-8 byte-ove."""
    with open(path, 'rb') as f:
        raw = f.read()
    return json.loads(raw.decode('utf-8', errors='replace'))


def load_article_json(path):
    with open(path, 'rb') as f:
        raw = f.read()
    return json.loads(raw.decode('utf-8', errors='replace'))


# --- IMAGE COMPOSITION ---

_FONT_CACHE = {}


def get_font(size, bold=False):
    key = (size, bold)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    # Helvetica.ttc — index 0=Regular, ali bold ce vuci index 1 ili posebnu pojavu.
    # Pillow ImageFont.truetype prima index parametar.
    index = 1 if bold else 0
    font = None
    for fp in (FONT_PATH, FONT_PATH_FALLBACK):
        try:
            font = ImageFont.truetype(fp, size, index=index)
            break
        except Exception:
            try:
                font = ImageFont.truetype(fp, size)
                break
            except Exception:
                continue
    if font is None:
        font = ImageFont.load_default()
    _FONT_CACHE[key] = font
    return font


def draw_clock_icon(draw, x, y, size, color, stroke=2):
    """Vektorska ikona sata (brojčanik + dvije kazaljke + krunica).

    NE crtamo znak ⏱ (U+23F1): Helvetica.ttc ga nema, pa ga Pillow renderira kao
    .notdef — prazan kvadratić. Bilo je vidljivo na SVAKOJ og-t slici u
    WhatsApp/FB previewu (izmjereno 15.9.2026. na og-t-1185.jpg). Vektor nema
    ovisnost o fontu pa ne može tiho pasti na isti način.
    """
    r = size / 2.0
    cx, cy = x + r, y + r
    # Krunica (stopwatch stem) — kratka crtica iznad brojčanika.
    draw.line(
        [(cx, y - max(stroke, 2)), (cx, y + stroke * 0.5)],
        fill=color, width=stroke,
    )
    draw.ellipse((x, y, x + size, y + size), outline=color, width=stroke)
    # Minutna kazaljka gore, satna dolje-desno (čitljivo i na 20 px).
    draw.line([(cx, cy), (cx, cy - r * 0.58)], fill=color, width=stroke)
    draw.line([(cx, cy), (cx + r * 0.44, cy + r * 0.30)], fill=color, width=stroke)


def cover_crop(img, target_w, target_h):
    """Resize image to cover target dim, center-crop overflow (kao CSS background-size: cover)."""
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    new_w = int(src_w * scale)
    new_h = int(src_h * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


def make_gradient_overlay(width, height, start_y_frac=0.35, max_alpha=GRADIENT_MAX_ALPHA):
    """Linear gradient from transparent (top) to (0,0,0,max_alpha) at bottom.
    Gradient krene na start_y_frac * height i ide do dna."""
    overlay = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    start_y = int(height * start_y_frac)
    grad_h = height - start_y
    for y in range(grad_h):
        # Easing: gradient acceleration prema dnu (ne linearno)
        t = y / max(grad_h - 1, 1)
        alpha = int(max_alpha * (t ** 1.5))
        draw.line([(0, start_y + y), (width - 1, start_y + y)], fill=(0, 0, 0, alpha))
    return overlay


def wrap_text(text, font, max_width, max_lines):
    """Greedy word wrap u max_lines. Ellipsis na zadnjoj liniji ako ne stane."""
    if not text:
        return []
    words = text.split()
    if not words:
        return []
    lines = []
    current = words[0]
    for w in words[1:]:
        trial = current + ' ' + w
        if font.getbbox(trial)[2] <= max_width:
            current = trial
        else:
            lines.append(current)
            if len(lines) >= max_lines:
                # Više rijeci ne stane — truncate
                current = ''
                break
            current = w
    if current:
        lines.append(current)
    lines = lines[:max_lines]
    # Truncate zadnju liniju ako preko sirine
    if lines and font.getbbox(lines[-1])[2] > max_width:
        last = lines[-1]
        while last and font.getbbox(last + '…')[2] > max_width:
            last = last[:-1]
        lines[-1] = last + '…'
    return lines


def truncate_to_width(text, font, max_width):
    if not text:
        return ''
    if font.getbbox(text)[2] <= max_width:
        return text
    while text and font.getbbox(text + '…')[2] > max_width:
        text = text[:-1]
    return text + '…'


def generate_composite(src_png_path, out_jpg_path, *, subtitle, timestamp_str,
                       episode_title, channel_name):
    """Generira jedan composite. Vraća (saved_bytes, oversized)."""
    src = Image.open(src_png_path).convert('RGB')
    frame = cover_crop(src, OG_WIDTH, OG_HEIGHT)

    # Convert frame to RGBA da bismo mogli stack-ati overlay
    canvas = frame.convert('RGBA')
    overlay = make_gradient_overlay(OG_WIDTH, OG_HEIGHT)
    canvas = Image.alpha_composite(canvas, overlay)

    draw = ImageDraw.Draw(canvas)

    margin_x = 56
    inner_w = OG_WIDTH - 2 * margin_x

    # --- Section subtitle (glavni naslov) ---
    subtitle_font = get_font(48, bold=True)
    subtitle_lines = wrap_text(subtitle, subtitle_font, inner_w, max_lines=2)

    # --- Timestamp badge ---
    # Ikona se CRTA (draw_clock_icon), ne piše kao ⏱ — Helvetica nema taj glyph.
    ts_font = get_font(28, bold=True)
    ts_label = timestamp_str
    digit_top, digit_bottom = ts_font.getbbox('0')[1], ts_font.getbbox('0')[3]
    icon_size = max(digit_bottom - digit_top, 8)
    icon_gap = 10
    ts_w = icon_size + icon_gap + ts_font.getbbox(ts_label)[2]

    # --- Episode title (donji manji red) ---
    title_font = get_font(22, bold=False)
    title_truncated = truncate_to_width(episode_title, title_font, inner_w)

    # --- Brand bar ---
    brand_font = get_font(18, bold=False)
    brand_text = f"DOMOVINA.ai · {channel_name}"
    brand_w = brand_font.getbbox(brand_text)[2]

    # --- Compute vertical positions (build from bottom up) ---
    bottom_margin = 32
    brand_h = brand_font.getbbox(brand_text)[3]
    title_h = title_font.getbbox(title_truncated)[3] if title_truncated else 0
    subtitle_line_h = subtitle_font.getbbox('Hg')[3] + 6  # line height s leading
    subtitle_block_h = subtitle_line_h * len(subtitle_lines)
    divider_gap = 16
    divider_h = 3  # CRO navy linija
    ts_h = max(ts_font.getbbox(ts_label)[3], digit_top + icon_size) + 8  # padding ispod
    block_gap = 12

    total_h = ts_h + subtitle_block_h + divider_gap + divider_h + divider_gap + title_h + 8 + brand_h
    start_y = OG_HEIGHT - bottom_margin - total_h
    y = max(start_y, int(OG_HEIGHT * 0.45))  # ne preko gornje polovice

    # Timestamp — vektorska ikona sata + brojke, poravnate po visini znamenki
    draw_clock_icon(draw, margin_x, y + digit_top, icon_size, WHITE)
    draw.text((margin_x + icon_size + icon_gap, y), ts_label, font=ts_font, fill=WHITE)
    # Mali CRO red dot pored timestampa
    dot_r = 5
    dot_x = margin_x + ts_w + 14
    dot_y = y + digit_top + icon_size // 2
    draw.ellipse((dot_x - dot_r, dot_y - dot_r, dot_x + dot_r, dot_y + dot_r), fill=CRO_RED)
    y += ts_h + block_gap

    # Subtitle (multiline)
    for line in subtitle_lines:
        draw.text((margin_x, y), line, font=subtitle_font, fill=WHITE)
        y += subtitle_line_h
    y += divider_gap

    # CRO navy divider linija
    draw.rectangle((margin_x, y, margin_x + 80, y + divider_h), fill=CRO_NAVY)
    y += divider_h + divider_gap

    # Episode title
    if title_truncated:
        draw.text((margin_x, y), title_truncated, font=title_font, fill=LIGHT_GRAY)
        y += title_h + 8

    # Brand
    draw.text((margin_x, y), brand_text, font=brand_font, fill=LIGHT_GRAY)

    # --- Save kao progressive JPEG ---
    final = canvas.convert('RGB')
    out_jpg_path.parent.mkdir(parents=True, exist_ok=True)
    final.save(
        out_jpg_path,
        format='JPEG',
        quality=JPEG_QUALITY,
        optimize=True,
        progressive=True,
        subsampling=2,  # 4:2:0
    )
    size = out_jpg_path.stat().st_size
    return size, size > HARD_MAX_BYTES


# --- DISCOVERY ---

def discover_channels(input_dir, channel_filter=None):
    """Vraća listu (name, path) channel direktorija."""
    result = []
    for entry in sorted(os.listdir(input_dir)):
        # Samo hidden (.) preskačemo. `_`-kanale (npr. _unlisted = ad-hoc videi
        # koji se publishaju na /v/{id}) MORAMO obraditi — KORAK 10 screenshot i
        # KORAK 12 upload ih već uključuju, pa im inače fale per-section og slike.
        if entry.startswith('.'):
            continue
        full = os.path.join(input_dir, entry)
        if not os.path.isdir(full) and not os.path.islink(full):
            continue
        if channel_filter and entry != channel_filter:
            continue
        result.append((entry, full))
    return result


_BASE_RE = re.compile(r'^(.+?)\.article\.json$')


def discover_videos(channel_dir):
    """Vraća listu video base-ova u kanalu, dedup-irano per video.

    Article filename pattern: {base}.wav.canary.diarized_{date}_{model}.article.json
    npr. ...wav.canary.diarized_2026-03-20_gemini-2.5-flash.article.json

    Više article.json file-ova istog videa nastaje od različitih runs
    Gemini generacije (date + model). screenshot_youtube.js koristi
    leksikografski najveci filename kao "latest" (datum YYYY-MM-DD sortira
    ispravno, model kao tiebreaker). Koristimo istu konvenciju da se output
    poklapa s onim za što su screenshots ekstrahirani.

    videoBase = "{YYYYMMDD}_{title}_yt_{id}" — sve prije ".wav.canary.diarized".

    Vraća: lista {video_base, article_path} za najnoviju article verziju per video.
    """
    by_video = {}
    try:
        entries = os.listdir(channel_dir)
    except OSError:
        return []
    for entry in entries:
        if entry.startswith('.') or entry.startswith('._'):
            continue
        if not entry.endswith('.article.json'):
            continue
        # Strip ".article.json" suffix
        stem = entry[: -len('.article.json')]
        # video_base = sve prije ".wav.canary.diarized"
        if '.wav.canary.diarized' in stem:
            video_base = stem.split('.wav.canary.diarized')[0]
        else:
            # Fallback ako se patterns promijeni
            m = re.search(r'^(.+?)_\d{4}-\d{2}-\d{2}_', stem)
            video_base = m.group(1) if m else stem
        # Keep latest by lexicographic filename comparison (matches screenshot_youtube.js)
        existing = by_video.get(video_base)
        if existing is None or entry > os.path.basename(existing):
            by_video[video_base] = os.path.join(channel_dir, entry)
    return [
        {'video_base': vb, 'article_path': ap}
        for vb, ap in by_video.items()
    ]


def find_article_en(channel_dir, video_base):
    """Najnoviji `{video_base}*.article.en.json` u kanalu, ili None.

    Ista leksikografska konvencija kao `discover_videos` za HR članak, ali
    NEOVISNO o njemu — EN prijevod često postoji samo uz stariju generaciju.
    """
    best = None
    try:
        entries = os.listdir(channel_dir)
    except OSError:
        return None
    for entry in entries:
        if entry.startswith('.') or not entry.endswith('.article.en.json'):
            continue
        if not entry.startswith(video_base + '.'):
            continue
        if best is None or entry > best:
            best = entry
    return os.path.join(channel_dir, best) if best else None


# --- IDEMPOTENCY ---

def should_regenerate(out_path, *deps, force=False):
    """Vraća True ako out_path nedostaje ILI je stariji od bilo kojeg dep-a."""
    if force:
        return True
    if not out_path.exists():
        return True
    try:
        out_mtime = out_path.stat().st_mtime
        for d in deps:
            if d and Path(d).exists() and Path(d).stat().st_mtime > out_mtime:
                return True
        return False
    except OSError:
        return True


# --- MAIN VIDEO PROCESSOR ---

def process_video(video_info, channel_dir, *, force=False, dry_run=False):
    """Procesira jedan video. Vraća dict s rezultatima."""
    video_base = video_info['video_base']
    article_path = video_info['article_path']

    result = {
        'video_base': video_base,
        'status': 'unknown',
        'sections_total': 0,
        'sections_generated': 0,
        'sections_skipped': 0,
        'sections_skipped_no_png': 0,
        'sections_skipped_empty_subtitle': 0,
        'sections_generated_en': 0,
        'errors': 0,
        'oversized': 0,
    }

    # Učitaj article.json
    try:
        article = load_article_json(article_path)
    except Exception as e:
        result['status'] = f'article_load_error: {e}'
        return result

    # Učitaj info.json
    info_path = os.path.join(channel_dir, f"{video_base}.info.json")
    info = {}
    if os.path.exists(info_path):
        try:
            info = load_info_json(info_path)
        except Exception:
            info = {}

    # Whole-video skip kriteriji
    duration_sec = 0
    try:
        duration_sec = int(info.get('duration') or 0)
    except (TypeError, ValueError):
        duration_sec = 0

    if duration_sec and duration_sec < MIN_DURATION_SEC:
        result['status'] = f'skip:duration<{MIN_DURATION_SEC}s ({duration_sec}s)'
        return result

    # Iz article-a izvuci sve sekcije
    all_sections = []
    for iteration in article.get('iterations', []):
        for section in iteration.get('sections', []):
            all_sections.append(section)
    result['sections_total'] = len(all_sections)

    if not all_sections:
        result['status'] = 'skip:no_sections'
        return result

    if len(all_sections) > MAX_SECTIONS:
        result['status'] = f'skip:too_many_sections({len(all_sections)})'
        return result

    # Episode title + channel iz info.json (fallback: derive iz path-a)
    episode_title = info.get('title') or video_base
    channel_name = info.get('uploader') or info.get('channel') or os.path.basename(channel_dir)

    video_id = extract_video_id(video_base) or 'unknown'

    # Output direktorij
    og_dir = Path(channel_dir) / f"{video_base}.og-sections"
    screenshots_dir = Path(channel_dir) / f"{video_base}_screenshots"

    def run_sections(sections, *, subtitle_key, filename_suffix, source_path):
        """Generira composite po sekciji. Vraća {sec: filename}.

        `subtitle_key` je 'subtitle' (HR) ili 'subtitle_en' (EN prijevod iz
        article.en.json). Sekcija bez tog ključa se preskoči — worker tada
        padne na HR sliku, što je bolje od prazne.
        """
        out_map = {}
        for section in sections:
            subtitle = (section.get(subtitle_key) or '').strip()
            ts_str = (section.get('screenshot_timestamp') or '').strip()

            if not subtitle or not ts_str:
                result['sections_skipped_empty_subtitle'] += 1
                continue

            try:
                sec = timestamp_to_seconds(ts_str)
            except ValueError:
                result['errors'] += 1
                continue

            # Source PNG mora postojati
            png_name = f"{video_base}_{sanitize_ts_for_filename(ts_str)}.png"
            src_png = screenshots_dir / png_name
            if not src_png.exists():
                result['sections_skipped_no_png'] += 1
                continue

            out_filename = f"og-t-{sec}{filename_suffix}.jpg"
            out_path = og_dir / out_filename

            # Idempotency
            if not should_regenerate(out_path, source_path, str(src_png), force=force):
                result['sections_skipped'] += 1
                out_map[str(sec)] = out_filename
                continue

            if dry_run:
                log('🧪', f'[DRY] {video_base[:60]} t={ts_str} → {out_filename}')
                out_map[str(sec)] = out_filename
                continue

            try:
                size, oversized = generate_composite(
                    src_png, out_path,
                    subtitle=subtitle,
                    timestamp_str=ts_str,
                    episode_title=episode_title,
                    channel_name=channel_name,
                )
                result['sections_generated'] += 1
                if oversized:
                    result['oversized'] += 1
                out_map[str(sec)] = out_filename
            except Exception as e:
                log('❌', f'{video_base[:60]} t={ts_str}: {e}')
                result['errors'] += 1
                continue
        return out_map

    # Process sections (HR)
    manifest_sections = run_sections(
        all_sections, subtitle_key='subtitle',
        filename_suffix='', source_path=article_path,
    )

    # Process sections (EN) — samo ako postoji paralelni article.en.json.
    # Bez ovoga /v/<id>/t/<sec>/en share nosi hrvatski ispisan subtitle u slici
    # čak i kad je epizoda prevedena (izmjereno 15.9.2026.).
    manifest_sections_en = {}
    # EN članak NE mora pripadati istoj generaciji kao odabrani HR članak:
    # `discover_videos` bira leksikografski najveći `*.article.json`, a prijevod
    # je često rađen nad starijim (drugi datum/model) i drugi run ga nije
    # ponovio. Deriviranje EN putanje iz odabrane HR promašilo je 8 od 47
    # prevedenih epizoda (izmjereno 15.9.2026.). Tražimo zato BILO KOJI
    # `{video_base}*.article.en.json`, najnoviji po istoj konvenciji.
    article_en_path = find_article_en(channel_dir, video_base)
    if article_en_path:
        try:
            article_en = load_article_json(article_en_path)
            en_sections = [
                sec for it in article_en.get('iterations', [])
                for sec in it.get('sections', [])
            ]
            if en_sections and len(en_sections) <= MAX_SECTIONS:
                manifest_sections_en = run_sections(
                    en_sections, subtitle_key='subtitle_en',
                    filename_suffix='-en', source_path=article_en_path,
                )
        except Exception as e:
            log('⚠️ ', f'{video_base[:60]} article.en.json: {e}')

    result['sections_generated_en'] = len(manifest_sections_en)

    # Manifest
    if manifest_sections and not dry_run:
        manifest = {
            'version': '1.1',
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'video_id': video_id,
            'video_base': video_base,
            'title': episode_title,
            'channel': channel_name,
            'duration_sec': duration_sec or None,
            'sections': dict(sorted(manifest_sections.items(), key=lambda kv: int(kv[0]))),
            'sections_en': dict(sorted(manifest_sections_en.items(), key=lambda kv: int(kv[0]))),
        }
        manifest_path = og_dir / 'manifest.json'
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

    result['status'] = 'ok'
    return result


# --- ENTRY POINT ---

def main():
    parser = argparse.ArgumentParser(description='Generate per-section OG composite images')
    parser.add_argument('--input-dir', default='storage/output')
    parser.add_argument('--channel', default=None, help='Filter na samo taj kanal')
    parser.add_argument('--limit', type=int, default=None, help='Procesiraj max N videa')
    parser.add_argument('--force', action='store_true', help='Regeneriraj sve')
    parser.add_argument('--dry-run', action='store_true', help='Ispis bez pisanja')
    args = parser.parse_args()

    input_dir = os.path.abspath(args.input_dir)
    if not os.path.isdir(input_dir):
        sys.stderr.write(f"❌ Input dir ne postoji: {input_dir}\n")
        sys.exit(1)

    log('🎨', f'OG-sections generator — 1200×630 progressive JPEG q={JPEG_QUALITY}')
    log('📂', f'Input: {input_dir}')
    if args.channel:
        log('🔎', f'Channel filter: {args.channel}')
    if args.limit:
        log('🔢', f'Limit: {args.limit} videa')
    if args.force:
        log('♻️ ', 'Force regeneracija')
    if args.dry_run:
        log('🧪', 'DRY RUN')
    print('')

    channels = discover_channels(input_dir, args.channel)
    if not channels:
        sys.stderr.write(f"❌ Nema kanala (filter: {args.channel!r})\n")
        sys.exit(1)

    totals = {
        'videos_total': 0, 'videos_with_output': 0,
        'sections_generated': 0, 'sections_skipped': 0,
        'sections_skipped_no_png': 0, 'sections_skipped_empty_subtitle': 0,
        'errors': 0, 'oversized': 0,
        'video_skip_no_sections': 0, 'video_skip_duration': 0,
        'video_skip_too_many': 0, 'video_skip_article_err': 0,
    }
    videos_processed = 0
    t_start = time.time()

    for ch_name, ch_dir in channels:
        videos = discover_videos(ch_dir)
        if not videos:
            continue
        log('📺', f'{ch_name} — {len(videos)} videa')
        for v in videos:
            if args.limit is not None and videos_processed >= args.limit:
                break
            videos_processed += 1
            totals['videos_total'] += 1
            res = process_video(v, ch_dir, force=args.force, dry_run=args.dry_run)
            # Aggregate
            if res['sections_generated'] > 0 or (res['status'] == 'ok' and res['sections_skipped'] > 0):
                totals['videos_with_output'] += 1
                log('✅', f"{v['video_base'][:60]} → {res['sections_generated']} gen, {res['sections_skipped']} skip, {res['sections_skipped_no_png']} no-png")
            elif res['status'].startswith('skip:'):
                key_map = {
                    'skip:no_sections': 'video_skip_no_sections',
                    'skip:duration<300s': 'video_skip_duration',
                }
                k = None
                if res['status'].startswith('skip:duration'):
                    k = 'video_skip_duration'
                elif res['status'].startswith('skip:too_many'):
                    k = 'video_skip_too_many'
                elif res['status'] == 'skip:no_sections':
                    k = 'video_skip_no_sections'
                if k:
                    totals[k] += 1
                log('⏭️ ', f"{v['video_base'][:60]} — {res['status']}")
            elif res['status'].startswith('article_load_error'):
                totals['video_skip_article_err'] += 1
                log('⚠️ ', f"{v['video_base'][:60]} — {res['status']}")
            for k in ('sections_generated', 'sections_skipped', 'sections_skipped_no_png',
                     'sections_skipped_empty_subtitle', 'errors', 'oversized'):
                totals[k] += res[k]
        if args.limit is not None and videos_processed >= args.limit:
            break

    elapsed = time.time() - t_start
    print('')
    log('📊', f"Videa: {totals['videos_total']} (s outputom: {totals['videos_with_output']})")
    log('📊', f"Sekcija gen: {totals['sections_generated']} | skip-postojeci: {totals['sections_skipped']} | skip-no-png: {totals['sections_skipped_no_png']} | skip-empty: {totals['sections_skipped_empty_subtitle']}")
    log('📊', f"Video skip — no_sections: {totals['video_skip_no_sections']} | short: {totals['video_skip_duration']} | too_many: {totals['video_skip_too_many']} | article_err: {totals['video_skip_article_err']}")
    log('📊', f"Greske: {totals['errors']} | Iznad 600KB: {totals['oversized']} | Trajalo: {elapsed:.1f}s")
    print('')


if __name__ == '__main__':
    main()
