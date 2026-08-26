#!/bin/bash
# run_sabor_session.sh — jedan ulaz za obradu saborske sjednice, od konfiguracije
# do članka. Zamjenjuje ručni niz naredbi iz README-a.
#
# Bash 3 kompatibilno (macOS ima bash 3.x) — bez asocijativnih polja i mapfile.
#
# ⛔ TVRDA PRAVILA koja ova skripta PROVODI, a ne samo dokumentira:
#
#   1. Diarizacija je STRIKTAN preduvjet za sve dalje. Bez `.canary.srt` za
#      svaki dio se ne kreće — faza 03 bi inače tiho proizvela prazan rezultat.
#   2. NIKAD dva pyannote posla paralelno. Provjerava se `ps` prije koraka 02.
#   3. Prag spajanja govornika se MJERI po sjednici, nikad ne prepisuje. Ako
#      `merge_threshold.json` ne postoji, korak 02b se ne pokreće.
#   4. Transkripcija je uvijek NVIDIA Canary, nikad Whisper — i NE radi se
#      ovdje. `.canary.srt` stiže s Colaba (bulk) ili Modala (ad-hoc).
#   5. Ljudske odluke o identitetu govornika žive SAMO u `human_overrides.json`.
#      Faza 03 ih primjenjuje sama; ništa ih ne prepisuje u transkript, pa je
#      korak 03 slobodno pokretati iznova koliko god puta treba.
#
# Uporaba:
#   sabor_pipeline/run_sabor_session.sh --session <session_id>
#   sabor_pipeline/run_sabor_session.sh --session <id> --dry-run
#   sabor_pipeline/run_sabor_session.sh --session <id> --from 03
#   sabor_pipeline/run_sabor_session.sh --session <id> --article-backend claude

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION=""
OUTPUT_DIR="$REPO_ROOT/storage/output/sabor"
FROM="01"
TO="99"
DRY_RUN=0
ARTICLE_BACKEND="agy"
ARTICLE_MODEL=""
SKIP_ARTICLE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --session) SESSION="$2"; shift 2 ;;
        --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
        --from) FROM="$2"; shift 2 ;;
        --to) TO="$2"; shift 2 ;;
        --article-backend) ARTICLE_BACKEND="$2"; shift 2 ;;
        --article-model) ARTICLE_MODEL="$2"; shift 2 ;;
        --no-article) SKIP_ARTICLE=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "Nepoznat argument: $1"; exit 2 ;;
    esac
done

[ -z "$SESSION" ] && { echo "GREŠKA: --session je obavezan"; exit 2; }

SESSION_DIR="$OUTPUT_DIR/$SESSION"
STEP=""

say()  { printf '\n\033[1m━━ %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31m✖ ABORT (korak %s): %s\033[0m\n' "$STEP" "$*" >&2; exit 1; }
run()  {
    if [ "$DRY_RUN" -eq 1 ]; then printf '   [dry-run] %s\n' "$*"; return 0; fi
    "$@" || die "naredba pala: $*"
}
# Je li korak unutar traženog raspona? (leksikografski, koraci su "01".."04")
want() { [ "$1" \> "$FROM" ] || [ "$1" = "$FROM" ] && { [ "$1" \< "$TO" ] || [ "$1" = "$TO" ]; }; }

say "Sjednica: $SESSION"
info "izlaz:    $SESSION_DIR"
info "koraci:   $FROM → $TO   $([ $DRY_RUN -eq 1 ] && echo '(dry-run)')"

# ─────────────────────────── KORAK 01 — ingest ───────────────────────────
STEP=01
if want 01; then
    say "KORAK 01 — preuzimanje i spajanje (01_ingest.js)"
    CONFIG="$REPO_ROOT/sabor_pipeline/data/sessions/$(echo "$SESSION" | sed 's/_gospic$//').json"
    if [ -f "$SESSION_DIR/session_manifest.json" ]; then
        info "manifest već postoji — preskačem"
    else
        [ -f "$CONFIG" ] || die "nema konfiguracije sjednice: $CONFIG"
        run node "$REPO_ROOT/sabor_pipeline/01_ingest.js" --session "$SESSION"
    fi
fi

# ───────────────── PREDUVJET: transkripti (Canary, izvana) ─────────────────
STEP="01.5"
if want 02 || want 03; then
    say "PREDUVJET — Canary transkripti"
    if [ ! -f "$SESSION_DIR/session_manifest.json" ]; then
        [ "$DRY_RUN" -eq 1 ] && info "[dry-run] manifest još ne postoji, preskačem provjeru" || die "nema session_manifest.json"
    else
        MISSING=0
        for W in "$SESSION_DIR"/audio/part_*_16k.wav; do
            [ -e "$W" ] || continue
            case "$W" in *full_session*) continue ;; esac
            if [ ! -f "$W.canary.srt" ]; then
                info "NEDOSTAJE: $(basename "$W").canary.srt"
                MISSING=$((MISSING + 1))
            fi
        done
        if [ "$MISSING" -gt 0 ]; then
            echo ""
            echo "   Transkripcija se NE radi ovdje. Pokreni Canary 1B v2 izvana:"
            echo "     • bulk    → colab_canary/domovina_tv_canary_transcribe.ipynb (Colab G4)"
            echo "     • ad-hoc  → modal_canary (A100)"
            echo "   pa vrati .canary.srt u $SESSION_DIR/audio/"
            die "$MISSING dijelova bez transkripta — bez njih faza 03 daje prazan rezultat"
        fi
        info "svi dijelovi imaju .canary.srt ✓"
    fi
fi

# ───────────────────── KORAK 02a — diarizacija po komadima ─────────────────────
STEP=02
if want 02; then
    say "KORAK 02a — diarizacija po komadima (02_diarize.py)"
    # Pravilo 2: nikad dva pyannote posla paralelno — nema locka, pa se gleda ps.
    if ps -eo command | grep -v grep | grep -qE '02_diarize\.py|diarize_canary\.py'; then
        die "već teče pyannote posao — dva paralelna ruše stroj (24 GB, Docker VM drži 14 GiB)"
    fi
    if [ -f "$SESSION_DIR/diarization.json" ]; then
        info "diarization.json postoji — preskačem 02a i 02b"
    else
        run python3 "$REPO_ROOT/sabor_pipeline/02_diarize.py" --session "$SESSION"

        say "KORAK 02b — mjerenje praga pa globalno spajanje"
        # Pravilo 3: prag se MJERI, ne prepisuje iz specifikacije.
        if [ ! -f "$SESSION_DIR/merge_threshold.json" ]; then
            run python3 "$REPO_ROOT/sabor_pipeline/tools/calibrate_threshold.py" --session "$SESSION"
        else
            info "merge_threshold.json postoji — preskačem kalibraciju"
        fi
        [ "$DRY_RUN" -eq 0 ] && [ ! -f "$SESSION_DIR/merge_threshold.json" ] && \
            die "prag nije izmjeren — 02b se NE pokreće s prepisanom vrijednošću"
        run python3 "$REPO_ROOT/sabor_pipeline/02b_merge_speakers.py" --session "$SESSION"

        say "VALIDACIJA — rotacija predsjedavajućih"
        run python3 "$REPO_ROOT/sabor_pipeline/tools/validate_chair.py" --session "$SESSION"
    fi
fi

# ─────────────── KORAK 03 — poravnanje ASR ↔ diarizacija + imena ───────────────
STEP=03
if want 03; then
    say "KORAK 03 — registar zastupnika sa sabor.hr"
    ROSTER="$REPO_ROOT/sabor_pipeline/data/rosters/sabor_mps_11_saziv.json"
    # Registar se osvježava po sjednici: sastav Sabora se mijenja (zamjene,
    # mandati u mirovanju), a stari popis tiho imenuje krivu osobu.
    run node "$REPO_ROOT/sabor_pipeline/tools/fetch_sabor_roster.js"

    # Pravilo 1: bez diarizacije nema koraka 03.
    if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$SESSION_DIR/diarization.json" ]; then
        die "nema diarization.json — faza 03 je STRIKTNO uvjetovana fazom 02"
    fi

    say "KORAK 03 — poravnanje i protokolarno imenovanje"
    # `--output-dir` mora ići i ovdje: bez njega bi glavni prolaz pisao u
    # zadanu putanju, a referentni u $OUTPUT_DIR — pa bi se uspoređivale dvije
    # različite sjednice.
    run node "$REPO_ROOT/sabor_pipeline/03_transcribe_and_align.js" \
        --session "$SESSION" --output-dir "$OUTPUT_DIR"

    # Referentni prolaz BEZ ljudskog sloja — da se poslije zna koliko je
    # imenovanog vremena donio protokol, a koliko ljudski pregled. Računa se
    # svaki put iznova; snimak bi nakon idućeg popravka sidrenja zastario.
    if [ "$DRY_RUN" -eq 0 ]; then
        run node "$REPO_ROOT/sabor_pipeline/03_transcribe_and_align.js" \
            --session "$SESSION" --output-dir "$OUTPUT_DIR" --no-human --suffix .protokol
        if [ -f "$SESSION_DIR/human_overrides.json" ]; then
            say "REVIZIJA — sloj ljudskih odluka"
            node "$REPO_ROOT/sabor_pipeline/tools/audit_overrides.js" \
                --session "$SESSION" --output-dir "$OUTPUT_DIR" || \
                info "⚠ revizija je našla nalaze — vidi gore"
            node "$REPO_ROOT/sabor_pipeline/tools/diff_naming.js" --session "$SESSION" \
                --output-dir "$OUTPUT_DIR" \
                --before "$SESSION_DIR/aligned_transcript.protokol.json"
        fi
    fi

    say "PROVJERA — donja granica broja govornika (protokol vs klasteriranje)"
    if [ "$DRY_RUN" -eq 0 ]; then
        node "$REPO_ROOT/sabor_pipeline/tools/verify_speaker_count.js" --session "$SESSION" || \
            die "donja granica premašuje broj iz klasteriranja — spajanje je preagresivno, podigni prag"
    else
        info "[dry-run] verify_speaker_count.js"
    fi
fi

# ───────────────────────── KORAK 04 — članak ─────────────────────────
STEP=04
if want 04 && [ "$SKIP_ARTICLE" -eq 0 ]; then
    say "KORAK 04 — dugi članak kliznim prozorom (backend: $ARTICLE_BACKEND)"
    ART_ARGS="--session $SESSION --backend $ARTICLE_BACKEND --timeout 1200"
    [ -n "$ARTICLE_MODEL" ] && ART_ARGS="$ART_ARGS --model $ARTICLE_MODEL"
    # shellcheck disable=SC2086
    run node "$REPO_ROOT/sabor_pipeline/04_article_sliding_window.js" $ART_ARGS

    if [ "$DRY_RUN" -eq 0 ]; then
        say "REVIZIJA — izmišljena imena i timestampovi"
        for A in "$SESSION_DIR"/article_*/clanak.md; do
            [ -e "$A" ] || continue
            node "$REPO_ROOT/sabor_pipeline/tools/audit_article.js" \
                --session "$SESSION" --article "$A" || info "⚠ revizija je našla nalaze — vidi gore"
        done
    fi
fi

say "GOTOVO — $SESSION"
info "Diarizacija:  $SESSION_DIR/diarization.json"
info "Transkript:   $SESSION_DIR/aligned_transcript.json"
info "Govornici:    $SESSION_DIR/speaker_map.json"
info "Članak:       $SESSION_DIR/article_*/clanak.md"
echo ""
echo "   Preporučeno nakon toga (nije automatski jer troši LLM kvotu):"
echo "     node sabor_pipeline/tools/blind_speaker_check.js --session $SESSION --windows 0,4,9,14,19"
echo ""
echo "   Ljudski pregled onoga što protokol ne može imenovati (~34 % vremena):"
echo "     node sabor_review/server.js      → http://localhost:8788"
