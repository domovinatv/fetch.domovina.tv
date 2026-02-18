#!/bin/bash

# --- KONFIGURACIJA ---
OUTPUT_DIR="./podcasts"
COOKIE_FILE="./cookies.txt"
CHUNK_SIZE=50
MAX_CHUNKS=40      # 40 * 50 = 2000 videa max po kanalu
MIN_DURATION=901  # Sekunde dohvati sve sto je dulje od 15:01 da se eliminiraju reels clipovi i kratke reklame

mkdir -p "$OUTPUT_DIR"

# Popis svih kanala
KANALI=(
    "iva-kraljevic|https://www.youtube.com/@ivakraljevic./videos"
    "mladi-za-domovinu|https://www.youtube.com/@mladizadomovinu1074/videos"
    "40-dana-za-zivot|https://www.youtube.com/@40danaza%C5%BEivot-Hrvatskaza%C5%BDivot/videos"
    "catholic-futurist|https://www.youtube.com/@CatholicFuturist/videos"
    "bozja-pobjeda|https://www.youtube.com/@Bo%C5%BEjapobjeda/videos"
    "muzevni-budite|https://www.youtube.com/@muzevnibudite/videos"
    "marin-miletic|https://www.youtube.com/@MileticMarin_/videos"
    "neuspjeh-prvaka|https://www.youtube.com/@neuspjehprvaka/videos"
    "radio-mreznica|https://www.youtube.com/@radiomreznica2174/videos"
    "poduzetnistvo-s-povjerenjem|https://www.youtube.com/@poduzetnistvospovjerenjem/videos"
    "budi-frajer|https://www.youtube.com/@budiFRAjer/videos"
    "kko-hr|https://www.youtube.com/@kkohr/videos"
    "glas-koncila|https://www.youtube.com/@gkonline1/videos"
    "nanovoroeni|https://www.youtube.com/@nanovoroeni3392/videos"
    "rastuci-s-djecom|https://www.youtube.com/@Rastucisdjecom/videos"
    "ad-deum-podcast|https://www.youtube.com/@AdDeumPodcast/videos"
    "lood-podcast|https://www.youtube.com/@lood/videos"
    "hnb|https://www.youtube.com/@hrvatskanarodnabankacroati9475/videos"
    "podcast-za-bolju-hrvatsku|https://www.youtube.com/@PodcastzaBoljuHrvatsku/videos"
    "horizonti-liderstva|https://www.youtube.com/@HorizontiLiderstva/videos"
    "sapere-aude|https://www.youtube.com/@SapereAudeCro/videos"
    "mislav-kolakusic|https://www.youtube.com/@mislavkolakusichr/videos"
    "ikra-institut|https://www.youtube.com/@ikra-institut/videos"
    "mreze-rijeci|https://www.youtube.com/@mrezerijeci/videos"
    "gorica-tv|https://www.youtube.com/@GoricaTV/videos"
    "podcast-by-niko|https://www.youtube.com/@PodcastbyNiko/videos"
    "eho-projekt|https://www.youtube.com/@ehoprojekt/videos"
    "podcast-cuspajz|https://www.youtube.com/@podcastcuspajz/videos"
    "hercegovina-info|https://www.youtube.com/@HercegovinaInfo2/videos"
    "franjina-ekonomija|https://www.youtube.com/@franjinaekonomijahrvatska8604/videos"
    "marijanski-zavjet|https://www.youtube.com/@marijanskizavjet/videos"
    "glas-poduzetnika|https://www.youtube.com/@glaspoduzetnika8972/videos"
    "duhovnost-hagio|https://www.youtube.com/@duhovnosthagio6031/videos"
    "popcast-pavicic|https://www.youtube.com/playlist?list=PLwkAZA40UDUK4aM2g8ee8qbIQnKY0XboU"

    # veliki kanali s puno video zapisa, njih obraditi jedan po jedan odvojeno
    # potrebno dodati custom MIN_DURATION= jer imaju mnogi izjave i izrezane QA itd., a to su sve varijacije velikih podcast epizoda
    # "projekt-velebit|https://www.youtube.com/@projektvelebit6100/videos" # veliki
    # "podcast-inkubator|https://www.youtube.com/@PodcastInkubator/videos" # veliki
    # "laudato-tv|https://www.youtube.com/@LaudatoTV/videos" #veliki
    # "z1-televizija|https://www.youtube.com/@z1televizija/videos" #veliki
    # "ora-et-labora|https://www.youtube.com/@oraetlabora.cro-medjugorje/videos" #veliki
    # "most-hrvatska|https://www.youtube.com/@MostHrvatska/videos" #veliki
)

# Inicijalizacija polja aktivnih kanala
AKTIVNI_KANALI=("${KANALI[@]}")

COOKIE_ARG=""
[ -f "$COOKIE_FILE" ] && COOKIE_ARG="--cookies $COOKIE_FILE"

echo "Započinjem cikličku obradu (Chunk size: $CHUNK_SIZE)..."

for (( krug=0; krug<$MAX_CHUNKS; krug++ )); do
    START=$(( krug * CHUNK_SIZE + 1 ))
    END=$(( (krug + 1) * CHUNK_SIZE ))
    
    NOVO_AKTIVNI=()
    pronadjeno_u_krugu=false

    echo "------------------------------------------------------------"
    echo ">>> KRUG $((krug+1)): Stavke $START do $END"
    echo "------------------------------------------------------------"

    for stavka in "${AKTIVNI_KANALI[@]}"; do
        IME="${stavka%%|*}"
        URL="${stavka#*|}"
        ARHIVA="$OUTPUT_DIR/${IME}-arhiva.txt"
        LISTA="$OUTPUT_DIR/${IME}-lista.txt"

        echo -n "[$IME] Skeniram... "

        # Privremena datoteka za hvatanje rezultata ovog chunka
        TMP_OUT=$(yt-dlp --no-warnings --ignore-errors --flat-playlist \
               $COOKIE_ARG \
               --playlist-items "$START:$END" \
               --match-filter "duration > $MIN_DURATION" \
               --download-archive "$ARHIVA" \
               --force-write-archive \
               --break-on-existing \
               --print "FILE:%(upload_date)s | %(title)s | https://youtu.be/%(id)s" \
               "$URL" 2>/dev/null)

        if [ -n "$TMP_OUT" ]; then
            # Izdvoji samo linije koje počinju s FILE: i spremi u listu
            echo "$TMP_OUT" | grep "^FILE:" | sed 's/^FILE://' >> "$LISTA"
            echo "OK (Pronađeno novih)."
            NOVO_AKTIVNI+=("$stavka") # Kanal ostaje aktivan za idući krug
            pronadjeno_u_krugu=true
        else
            # Ako nema outputa, provjeravamo je li to zbog kraja ili smo već imali sve
            echo "Nema novih - završen za danas."
            # Kanal se NE dodaje u NOVO_AKTIVNI, dakle preskače se u idućem krugu
        fi
    done

    # Ažuriraj listu kanala za idući chunk (samo oni koji su imali rezultate)
    AKTIVNI_KANALI=("${NOVO_AKTIVNI[@]}")

    # Ako više nema aktivnih kanala, prekini cijelu skriptu
    if [ ${#AKTIVNI_KANALI[@]} -eq 0 ]; then
        echo "Svi kanali su sinkronizirani ili dosegnuti."
        break
    fi
done

# Finalno čišćenje i sortiranje
# Uklonjeno jer je NA kod --flat-playlist ali nemoj brisati jer je vazno da se to zna tako da po defaultutu bude kronoloski sortirano kako naredba vrati
# echo "Sortiranje datoteka..."
# for f in "$OUTPUT_DIR"/*-lista.txt; do
#     [ -e "$f" ] && sort -r -u -o "$f" "$f"
# done

echo "Gotovo! Sve liste su u: $OUTPUT_DIR"