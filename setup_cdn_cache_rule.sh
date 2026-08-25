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
# NAMJERNO se NE dira `channels/` — ti fajlovi rastu kako stižu novi videi i
# imaju `max-age=60, must-revalidate` + frontend cache-buster (`?v=…`).
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
# Alternativa bez tokena (2 minute, isti učinak) — Dashboard:
#   domovina.ai → Caching → Cache Rules → Create rule
#     Ime:    "CDN data JSON cacheable"
#     Ako:    Custom filter expression
#             (http.host eq "cdn.domovina.ai") and
#             (http.request.uri.path matches "^/data/.*\.(json|md|srt)$")
#     Onda:   Cache eligibility        → Eligible for cache
#             Edge TTL                 → Use cache-control header from origin
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
RULE_DESCRIPTION="CDN data JSON cacheable"
EXPRESSION='(http.host eq "cdn.domovina.ai") and (http.request.uri.path matches "^/data/.*\\.(json|md|srt)$")'

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

echo "🔎 Tražim zonu $ZONE_NAME…"
ZONE_ID=$(api GET "/zones?name=$ZONE_NAME" | die_on_error \
          | python3 -c "import sys,json; r=json.load(sys.stdin); print(r[0]['id'] if r else '')")

if [ -z "$ZONE_ID" ]; then
    echo "❌ Zona $ZONE_NAME nije nađena (ili token nema pristup)."
    exit 1
fi
echo "   zone_id: $ZONE_ID"

# ── RULESET (http_request_cache_settings, entrypoint) ────────────

echo "🔎 Dohvaćam cache ruleset…"
RULESET_ID=$(api GET "/zones/$ZONE_ID/rulesets" | die_on_error | python3 -c "
import sys, json
rs = json.load(sys.stdin)
for r in rs:
    if r.get('phase') == 'http_request_cache_settings':
        print(r['id']); break
")

RULE_JSON=$(python3 -c "
import json
print(json.dumps({
    'action': 'set_cache_settings',
    'description': '''$RULE_DESCRIPTION''',
    'enabled': True,
    'expression': '''$EXPRESSION''',
    'action_parameters': {
        'cache': True,
        # Poštuj Cache-Control s originea — uploader već šalje
        # 'public, max-age=31536000, immutable' na data/ artefakte.
        'edge_ttl': {'mode': 'respect_origin'},
        'browser_ttl': {'mode': 'respect_origin'},
    },
}))
")

if [ "$DRY_RUN" = true ]; then
    echo ""
    echo "🧪 DRY RUN — pravilo koje bi bilo poslano:"
    echo "$RULE_JSON" | python3 -m json.tool
    echo ""
    echo "   ruleset_id: ${RULESET_ID:-<novi entrypoint ruleset>}"
    exit 0
fi

if [ -z "$RULESET_ID" ]; then
    echo "   Nema postojećeg cache ruleseta — kreiram entrypoint…"
    BODY=$(python3 -c "
import json,sys
print(json.dumps({
    'name': 'default',
    'kind': 'zone',
    'phase': 'http_request_cache_settings',
    'rules': [json.loads(sys.argv[1])],
}))
" "$RULE_JSON")
    api POST "/zones/$ZONE_ID/rulesets" "$BODY" | die_on_error > /dev/null
    echo "✅ Ruleset + pravilo kreirani."
else
    echo "   ruleset_id: $RULESET_ID"
    EXISTING=$(api GET "/zones/$ZONE_ID/rulesets/$RULESET_ID" | die_on_error | python3 -c "
import sys, json
r = json.load(sys.stdin)
for rule in r.get('rules', []):
    if rule.get('description') == '''$RULE_DESCRIPTION''':
        print(rule['id']); break
")
    if [ -n "$EXISTING" ]; then
        echo "   Pravilo već postoji ($EXISTING) — ažuriram…"
        api PATCH "/zones/$ZONE_ID/rulesets/$RULESET_ID/rules/$EXISTING" "$RULE_JSON" \
            | die_on_error > /dev/null
        echo "✅ Pravilo ažurirano."
    else
        api POST "/zones/$ZONE_ID/rulesets/$RULESET_ID/rules" "$RULE_JSON" \
            | die_on_error > /dev/null
        echo "✅ Pravilo dodano."
    fi
fi

echo ""
echo "⏳ Propagacija je nekoliko sekundi. Provjera:"
echo "   ./setup_cdn_cache_rule.sh --verify"
echo ""
echo "   Napomena: prvi hit nakon promjene je MISS (edge tek puni cache),"
echo "   drugi bi trebao biti HIT. Ako i dalje piše DYNAMIC — pravilo se ne"
echo "   matcha; provjeri expression u dashboardu."
