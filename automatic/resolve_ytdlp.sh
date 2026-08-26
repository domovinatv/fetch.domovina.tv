#!/usr/bin/env bash
# resolve_ytdlp.sh — odaberi NAJNOVIJI yt-dlp na PATH-u i stavi ga na čelo.
#
# Zašto postoji: na ovom Macu žive DVA yt-dlp-a — homebrew (/opt/homebrew/bin, ide
# uz rclone/ffmpeg/jq) i Python 3.13 Framework (/Library/Frameworks/…, ide uz Pillow
# za generate_og_sections.py). Oba su nužna iz drugih razloga, pa PATH blok u
# nightly/priority skriptama prependa oba — i onaj zadnji prepend tiho odluči koji
# yt-dlp pobjeđuje, bez veze s tim koji je noviji.
#
# 2026-08-26 je upravo to palo: nightly je vrtio homebrew yt-dlp 2026.03.17 (5 mj.
# star) dok je interaktivni shell imao 2026.08.17. Stari ekstraktor je dobivao
# `HTTP Error 403: Forbidden` na medijskom streamu (format 396+251) — metapodaci
# (.info.json/.description/thumbnail) su prolazili, pa je na disku ostajala epizoda
# bez medija, a fetch.js ju je gurnuo u failed[]. 12 videa u 8 dana.
#
# PATH redoslijed je krivo mjesto za tu odluku: popravak "homebrew prije Pythona"
# vrijedi samo dok je homebrew slučajno noviji. Zato ovdje biramo po VERZIJI.
#
# Koristi se: . "$SCRIPT_DIR/resolve_ytdlp.sh"  (nakon što je PATH složen)

# Verzija yt-dlp-a je YYYY.MM.DD[.HHMMSS], ali mjesec/dan NISU zero-padded u svim
# buildovima (2026.3.17 vs 2026.08.19), pa leksikografska usporedba laže. Normaliziraj
# u YYYYMMDD broj.
_ytdlp_version_key() {
    local v="$1" y m d
    y="${v%%.*}"; v="${v#*.}"
    m="${v%%.*}"; v="${v#*.}"
    d="${v%%.*}"
    case "$y$m$d" in *[!0-9]*|"") echo 0; return;; esac
    # 10# je obavezan: "08" bi se inače parsirao kao oktal i pao ("value too great").
    printf '%d%02d%02d\n' "$((10#$y))" "$((10#$m))" "$((10#$d))"
}

resolve_ytdlp() {
    local best_bin="" best_key=0 bin key ver

    # `type -a` poštuje trenutni PATH i vraća sve kandidate, po redu.
    for bin in $(type -a -p yt-dlp 2>/dev/null); do
        ver="$("$bin" --version 2>/dev/null)" || continue
        key="$(_ytdlp_version_key "$ver")"
        if [ "$key" -gt "$best_key" ]; then
            best_key="$key"; best_bin="$bin"
        fi
    done

    if [ -z "$best_bin" ]; then
        echo "⚠️  resolve_ytdlp: nema yt-dlp na PATH-u — KORAK 1 (fetch) će pasti."
        return 0   # ne-fatalno: nightly ima korake koji ne trebaju yt-dlp
    fi

    export PATH="$(dirname "$best_bin"):$PATH"
    echo "🎬 yt-dlp: $best_bin ($("$best_bin" --version 2>/dev/null))"

    # YouTube lomi stare ekstraktore. Preko ~90 dana je zona 403-ova — javi glasno,
    # jer se u logu inače vidi tek kao yt-dlp-ov vlastiti WARNING među stotinama redaka.
    local now
    now="$(date +%Y%m%d)"
    if [ "$((now - best_key))" -gt 300 ]; then
        echo "⚠️  yt-dlp je stariji od ~90 dana → očekuj 'HTTP Error 403: Forbidden'"
        echo "    na medijskom streamu (metapodaci i dalje prolaze). Fix: brew upgrade yt-dlp"
    fi
}

resolve_ytdlp
