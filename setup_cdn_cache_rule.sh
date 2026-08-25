#!/bin/bash
#
# setup_cdn_cache_rule.sh
#
# Uključuje Cloudflare edge caching za JSON/MD/SRT artefakte na cdn.domovina.ai.
#
# ── PROBLEM ──────────────────────────────────────────────────────
#
# Izmjereno 2026-08-25:
#
#   https://cdn.domovina.ai/data/{id}/info.json
#     cache-control: public, max-age=31536000, immutable
#     cf-cache-status: DYNAMIC          ← Cloudflare ga NE cachira
#
#   https://cdn.domovina.ai/images/{id}/thumbnail.png
#     cf-cache-status: MISS → HIT       ← slike se cachiraju normalno
#
# Cloudflare po defaultu cachira po EKSTENZIJI fajla, iz fiksne liste
# (.png, .jpg, .webp, .mp4, .css, .js …). `.json` na toj listi NIJE, i
# `Cache-Control` s originea to sam od sebe ne mijenja. Posljedica: svako
# otvaranje appa udara u R2 za svaki JSON — čisto trošenje R2 Class B
# operacija bez ikakve koristi, i sporije jer ide do origina umjesto s edgea.
#
# Fajlovi pod `data/` su write-once i uploader im već postavlja
# `immutable` (vidi CACHE_CONTROL_IMMUTABLE u upload_to_r2.js), pa je
# cachiranje bezopasno.
#
# ── ZASTO OGRANICEN TTL, A NE `respect_origin` ────────────────────
#
# `/data/*` nosi `immutable` (1 godina). Kad bi edge to postovao doslovno, a
# neki artefakt se ipak regenerira, edge bi servirao stari sadrzaj GODINU DANA.
# Purge to ne bi spasio: `purgeCloudflareCache()` u upload_to_r2.js se poziva
# SAMO za `.mp4` kljuceve (vidi `purgeCloudflareCache(mp4Urls)`), JSON nikad.
# Upravo zbog te kombinacije je JSON i bio izvan cachea.
#
# Zato: EDGE TTL 1 DAN za `/data/*`. Zastarjelost se sama izlijeci u 24 h bez
# ijednog purge poziva, a R2 citanja svejedno padnu za ~99 % (jedno citanje po
# fajlu po POP-u po danu umjesto jedno po korisniku).
# Kad se pokaze da se nista ne mijenja, TTL se moze dici na 7 dana (604800).
#
# `/channels/*` ide `respect_origin` — uploader mu vec postavlja
# `max-age=60, must-revalidate`, sto je tocno zeljeno ponasanje; falilo je samo
# to da uopce bude cacheable.
#
# ── OVLASTI ──────────────────────────────────────────────────────
#
# Postojeći DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE je purge-only i za
# ovo NE VRIJEDI (provjereno: `/zones/{id}/rulesets` vraća 10000 Authentication
# error). Treba token s:
#
#   Zone → Cache Rules → Edit     (na zoni domovina.ai)
#
# Napravi ga na https://dash.cloudflare.com/profile/api-tokens i stavi u .env:
#
#   DOMOVINA_AI_CLOUDFLARE_API_TOKEN_CACHE_RULES=...
#
# Alternativa bez tokena — Dashboard (domovina.ai → Caching → Cache Rules),
# DVA pravila:
#
#   1) "CDN /data tekst"
#      Ako:  (http.host eq "cdn.domovina.ai") and
#            starts_with(http.request.uri.path, "/data/") and
#            (ends_with(http.request.uri.path, ".json") or
#             ends_with(http.request.uri.path, ".md") or
#             ends_with(http.request.uri.path, ".srt"))
#      Onda: Cache eligibility → Eligible for cache
#            Edge TTL         → Ignore cache-control, TTL 1 dan
#            Browser TTL      → 1 sat
#
#   2) "CDN /channels tekst"
#      Ako:  (http.host eq "cdn.domovina.ai") and
#            starts_with(http.request.uri.path, "/channels/") and
#            ends_with(http.request.uri.path, ".json")
#      Onda: Cache eligibility → Eligible for cache
#            Edge TTL         → Use cache-control header from origin
#
# ── UPOTREBA ─────────────────────────────────────────────────────
#
#   ./setup_cdn_cache_rule.sh              # kreira/ažurira pravilo
#   ./setup_cdn_cache_rule.sh --dry-run    # samo ispiši što bi poslao
#   ./setup_cdn_cache_rule.sh --verify     # provjeri cf-cache-status uživo
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZONE_NAME="domovina.ai"
# Dva pravila: /data/ (ogranicen TTL) i /channels/ (respect origin).
RULE_DATA_DESC="CDN /data tekst — cacheable, edge TTL 1 dan"
# starts_with/ends_with umjesto `matches`: regex operator ovisi o planu, a i
# escaping backslasha kroz bash -> JSON -> CF parser je nepotrebno krhak.
RULE_DATA_EXPR='(http.host eq "cdn.domovina.ai") and starts_with(http.request.uri.path, "/data/") and (ends_with(http.request.uri.path, ".json") or ends_with(http.request.uri.path, ".md") or ends_with(http.request.uri.path, ".srt"))'
RULE_DATA_EDGE_TTL=86400      # 1 dan — vidi obrazlozenje u headeru
# POZOR: browser_ttl override je postavljen u pravilu i CF ga prihvaca, ali
# NE prepisuje Cache-Control u odgovoru — provjereno 2026-08-25, tri svjeza
# MISS-a i dalje vracaju origin `max-age=31536000, immutable`. Vjerojatno
# ogranicenje plana. Ostavljeno jer je bezopasno i proradit ce ako se plan
# promijeni, ali NE oslanjaj se na njega: jedini pouzdan nacin da klijent ne
# drzi /data/ godinu dana je promijeniti CACHE_CONTROL_IMMUTABLE u
# upload_to_r2.js (i re-uploadati da se metapodaci osvjeze).
# Flutter app to ne pogadja — `package:http` nema HTTP cache. Pogadja web build.
RULE_DATA_BROWSER_TTL=3600

RULE_CHAN_DESC="CDN /channels tekst — cacheable, respect origin (60s)"
RULE_CHAN_EXPR='(http.host eq "cdn.domovina.ai") and starts_with(http.request.uri.path, "/channels/") and ends_with(http.request.uri.path, ".json")'

DRY_RUN=false
VERIFY_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --verify)  VERIFY_ONLY=true ;;
        *) echo "Nepoznat argument: $arg"; exit 1 ;;
    esac
done

# ── VERIFY ───────────────────────────────────────────────────────

verify_live() {
    echo "🔍 Provjera cf-cache-status uživo:"
    echo ""
    for path in "data/KvJlt9ewgTQ/info.json" "images/KvJlt9ewgTQ/thumb-320.webp"; do
        url="https://cdn.domovina.ai/$path"
        # dva hita: prvi može biti MISS, drugi bi trebao biti HIT
        curl -s -o /dev/null "$url" || true
        status=$(curl -s -D- -o /dev/null --max-time 15 "$url" \
                 | grep -i '^cf-cache-status' | tr -d '\r' | awk '{print $2}')
        printf "   %-46s %s\n" "$path" "${status:-?}"
    done
    echo ""
    echo "   HIT/MISS = cachira se.  DYNAMIC = NE cachira se."
}

if [ "$VERIFY_ONLY" = true ]; then
    verify_live
    exit 0
fi

# ── TOKEN ────────────────────────────────────────────────────────

if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a; source "$SCRIPT_DIR/.env"; set +a
fi

TOKEN="${DOMOVINA_AI_CLOUDFLARE_API_TOKEN_CACHE_RULES:-}"
if [ -z "$TOKEN" ]; then
    echo "❌ DOMOVINA_AI_CLOUDFLARE_API_TOKEN_CACHE_RULES nije postavljen u .env"
    echo ""
    echo "   Treba token s ovlašću: Zone → Cache Rules → Edit (zona $ZONE_NAME)"
    echo "   Napravi ga na: https://dash.cloudflare.com/profile/api-tokens"
    echo ""
    echo "   Postojeći ..._PURGE_CACHE token je purge-only i NE vrijedi za ovo."
    echo "   Ručna alternativa kroz dashboard je opisana u headeru ove skripte."
    exit 1
fi

api() {
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        curl -s -X "$method" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            --data "$body" \
            "https://api.cloudflare.com/client/v4$path"
    else
        curl -s -X "$method" \
            -H "Authorization: Bearer $TOKEN" \
            "https://api.cloudflare.com/client/v4$path"
    fi
}

die_on_error() {
    python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('success'):
    print('❌ Cloudflare API greška:', file=sys.stderr)
    for e in d.get('errors', []):
        print('   ', e.get('code'), e.get('message'), file=sys.stderr)
    sys.exit(1)
print(json.dumps(d['result']))
"
}

# ── ZONE ─────────────────────────────────────────────────────────

# Zone ID je HARDKODIRAN namjerno. Token skopiran samo na
# "Zone → Cache Rules → Edit" NEMA Zone:Read, pa `/zones?name=…` vrati 0
# rezultata (success:true, prazna lista), a `/zones/{id}` vrati 9109
# Unauthorized — dok `/zones/{id}/rulesets` uredno radi. Lookup po imenu bi
# dakle trazio siri token nego sto posao zahtijeva.
ZONE_ID="${CF_ZONE_ID_DOMOVINA_AI:-2eaa51e7e6896da6e92bde2ddd879cd8}"
echo "🔎 Zona $ZONE_NAME → $ZONE_ID"

# ── RULESET (http_request_cache_settings, entrypoint) ────────────

echo "🔎 Dohvaćam cache ruleset…"
RULESET_ID=$(api GET "/zones/$ZONE_ID/rulesets" | die_on_error | python3 -c "
import sys, json
rs = json.load(sys.stdin)
for r in rs:
    if r.get('phase') == 'http_request_cache_settings':
        print(r['id']); break
")

# Gradi JSON za jedno pravilo. $1=opis $2=expression $3=edge mode/ttl $4=browser mode/ttl
build_rule() {
    python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sys
desc, expr, edge, browser = sys.argv[1:5]

def ttl(spec):
    # "respect_origin" ili "override:<sekunde>"
    if spec == "respect_origin":
        return {"mode": "respect_origin"}
    return {"mode": "override_origin", "default": int(spec.split(":", 1)[1])}

print(json.dumps({
    "action": "set_cache_settings",
    "description": desc,
    "enabled": True,
    "expression": expr,
    "action_parameters": {
        "cache": True,
        "edge_ttl": ttl(edge),
        "browser_ttl": ttl(browser),
    },
}))
PY
}

DATA_RULE=$(build_rule "$RULE_DATA_DESC" "$RULE_DATA_EXPR" \
                       "override:$RULE_DATA_EDGE_TTL" "override:$RULE_DATA_BROWSER_TTL")
CHAN_RULE=$(build_rule "$RULE_CHAN_DESC" "$RULE_CHAN_EXPR" \
                       "respect_origin" "respect_origin")

if [ "$DRY_RUN" = true ]; then
    echo ""
    echo "🧪 DRY RUN — pravila koja bi bila poslana:"
    echo ""
    echo "$DATA_RULE" | python3 -m json.tool
    echo ""
    echo "$CHAN_RULE" | python3 -m json.tool
    echo ""
    echo "   ruleset_id: ${RULESET_ID:-<novi entrypoint ruleset>}"
    exit 0
fi

# Upsert jednog pravila u postojeci ruleset (po description).
upsert_rule() {
    local rule_json="$1" desc="$2"
    local existing
    existing=$(api GET "/zones/$ZONE_ID/rulesets/$RULESET_ID" | die_on_error | python3 -c "
import sys, json
r = json.load(sys.stdin)
target = sys.argv[1]
for rule in r.get('rules', []):
    if rule.get('description') == target:
        print(rule['id']); break
" "$desc")
    if [ -n "$existing" ]; then
        api PATCH "/zones/$ZONE_ID/rulesets/$RULESET_ID/rules/$existing" "$rule_json" \
            | die_on_error > /dev/null
        echo "   ♻️  azurirano: $desc"
    else
        api POST "/zones/$ZONE_ID/rulesets/$RULESET_ID/rules" "$rule_json" \
            | die_on_error > /dev/null
        echo "   ➕ dodano:    $desc"
    fi
}

if [ -z "$RULESET_ID" ]; then
    echo "   Nema postojeceg cache ruleseta — kreiram entrypoint s oba pravila…"
    BODY=$(python3 - "$DATA_RULE" "$CHAN_RULE" <<'PY'
import json, sys
print(json.dumps({
    "name": "default",
    "kind": "zone",
    "phase": "http_request_cache_settings",
    "rules": [json.loads(sys.argv[1]), json.loads(sys.argv[2])],
}))
PY
)
    api POST "/zones/$ZONE_ID/rulesets" "$BODY" | die_on_error > /dev/null
    echo "✅ Ruleset + oba pravila kreirani."
else
    echo "   ruleset_id: $RULESET_ID"
    upsert_rule "$DATA_RULE" "$RULE_DATA_DESC"
    upsert_rule "$CHAN_RULE" "$RULE_CHAN_DESC"
    echo "✅ Pravila na mjestu."
fi

echo ""
echo "⏳ Propagacija je nekoliko sekundi. Provjera:"
echo "   ./setup_cdn_cache_rule.sh --verify"
echo ""
echo "   Prvi hit nakon promjene je MISS (edge tek puni cache), drugi bi trebao"
echo "   biti HIT. Ako i dalje pise DYNAMIC — pravilo se ne matcha; provjeri"
echo "   expression u dashboardu."
