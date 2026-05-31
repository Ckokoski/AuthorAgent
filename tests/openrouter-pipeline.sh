#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# BookClaw — OpenRouter per-step pipeline verification
# ═══════════════════════════════════════════════════════════
# Drives a full (but bounded) novel pipeline through OpenRouter ONLY and
# reports, per step, whether OpenRouter served it successfully. Proves that
# every pipeline task type — research, general, book_bible, outline,
# creative_writing, revision, consistency (reasoning:high), final_edit
# (reasoning:high), style_analysis, marketing — works against the configured
# OpenRouter model.
#
# This is NOT a hermetic unit test (cf. tests/smoke-test.sh). It:
#   - requires a RUNNING gateway with an OpenRouter API key already in the vault
#     and `ai.preferredProvider` = "openrouter" (so every step routes there);
#   - spends real OpenRouter credit — kept small (default 2 chapters x ~400
#     words; pennies on a cheap model such as google/gemma-3-4b-it);
#   - TEMPORARILY disables the Ollama provider so a failing step surfaces as an
#     error instead of silently falling back to free local AI. An EXIT trap
#     re-enables Ollama no matter how the script ends (including Ctrl-C / error).
#
# Because Ollama is off for the run, OpenRouter is the only provider, so:
#   step completes  => OpenRouter handled that task type
#   step fails      => OpenRouter could not serve that task type (real finding)
#
# Usage:
#   # On the host running the container (auto-reads the generated token):
#   tests/openrouter-pipeline.sh
#
#   # Against a remote/known instance:
#   BASE_URL=http://mercury:3847 BOOKCLAW_AUTH_TOKEN=xxxxxxxx tests/openrouter-pipeline.sh
#
# Optional env knobs:
#   BASE_URL              gateway URL                 (default http://localhost:3847)
#   BOOKCLAW_AUTH_TOKEN   bearer token; if unset, read from the container's /app/.env
#   CONTAINER             docker container for token lookup (default bookclaw)
#   CHAPTERS  / WORDS     pipeline size               (default 2 / 400)
#
# Verbose by design: every step prints PASS/FAIL (with the error) as it runs.
# Exit code: 0 if all phases passed every step, non-zero = count of phases
# that had at least one failing step.
# ═══════════════════════════════════════════════════════════
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3847}"
CONTAINER="${CONTAINER:-bookclaw}"
CHAPTERS="${CHAPTERS:-2}"
WORDS="${WORDS:-400}"

# ── Resolve the bearer token: prefer env, else read it from the container ──
TOKEN="${BOOKCLAW_AUTH_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(docker exec "$CONTAINER" sh -c 'grep "^BOOKCLAW_AUTH_TOKEN=" /app/.env | cut -d= -f2- | tr -d "\r\""' 2>/dev/null || true)
fi
if [ -z "$TOKEN" ]; then
  echo "ERROR: no auth token. Set BOOKCLAW_AUTH_TOKEN, or run where 'docker exec $CONTAINER' works." >&2
  exit 1
fi

H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

provs(){ curl -s --max-time 25 "${H[@]}" -X POST "$BASE_URL/api/providers/refresh" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify((JSON.parse(s).providers||[]).map(p=>p.id+":"+p.model)))}catch(e){console.log("?")}})'; }
daily(){ curl -s --max-time 15 "${H[@]}" "$BASE_URL/api/status" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).costs.daily)}catch(e){console.log("?")}})'; }

# ── EXIT trap: always re-enable Ollama, however we exit ──
restore(){ echo "[restore] re-enabling Ollama"; curl -s --max-time 30 "${H[@]}" -X POST -d '{"path":"ai.ollama.enabled","value":true}' "$BASE_URL/api/config/update" >/dev/null; echo "[restore] providers: $(provs)"; }
trap restore EXIT

echo "### 1. Disable Ollama -> OpenRouter-only"
curl -s --max-time 30 "${H[@]}" -X POST -d '{"path":"ai.ollama.enabled","value":false}' "$BASE_URL/api/config/update" >/dev/null
echo "providers: $(provs)"
C0=$(daily); echo "cost start: \$$C0"

echo "### 2. Create bounded pipeline ($CHAPTERS chapters x ~$WORDS words)"
PAYLOAD=$(printf '{"title":"OR Smoke Test","description":"Throwaway test: a lighthouse keeper befriends a talking gull. Cozy, very short.","config":{"targetChapters":%s,"targetWordsPerChapter":%s,"genre":"cozy","pov":"third limited","tone":"warm"}}' "$CHAPTERS" "$WORDS")
PJSON=$(curl -s --max-time 30 "${H[@]}" -X POST -d "$PAYLOAD" "$BASE_URL/api/pipeline/create")
echo "$PJSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);(j.phases||[]).sort((a,b)=>a.phase-b.phase).forEach(p=>console.log(p.phase+"|"+p.id+"|"+p.type))}catch(e){console.error("CREATE FAILED: "+s.slice(0,300));process.exit(1)}})' > /tmp/or-phases.$$.txt
echo "phases:"; cat /tmp/or-phases.$$.txt

echo "### 3. Drive each phase (Ollama off => any completion was served by OpenRouter)"
FAILS=0
while IFS='|' read -r pn pid ptype; do
  [ -z "${pid:-}" ] && continue
  echo ""; echo "===== PHASE $pn: $ptype ====="
  RJ=$(curl -s --max-time 1800 "${H[@]}" -X POST "$BASE_URL/api/projects/$pid/auto-execute")
  echo "$RJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let j; try{j=JSON.parse(s)}catch(e){console.log("  PHASE PARSE ERR: "+s.slice(0,200));process.exit(2)}
    const r=j.results||[]; let f=0;
    r.forEach(x=>{const ok=x.success?"PASS":"FAIL";if(!x.success)f++;console.log("  ["+ok+"] "+x.step+(x.error?(" :: "+String(x.error).slice(0,140)):""))});
    console.log("  phase summary: "+(r.length-f)+"/"+r.length+" steps passed");
    process.exit(f>0?3:0);
  })' || FAILS=$((FAILS+1))
done < /tmp/or-phases.$$.txt
rm -f /tmp/or-phases.$$.txt

C1=$(daily)
echo ""; echo "### COMPLETE. cost \$$C0 -> \$$C1 ; phases_with_failures=$FAILS"
exit "$FAILS"
