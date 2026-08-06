#!/usr/bin/env bash
# scripts/sync-secrets-to-railway.sh
# Fetches secrets stored in GCP Secret Manager and prints/syncs them for Railway.

set -euo pipefail

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || echo "")"
if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: No active GCP project found in gcloud." >&2
  exit 1
fi

SECRETS=(
  "INTENTION_TOKEN_SECRET"
  "INTENTION_LLM_API_KEY"
  "APPLE_ISSUER_ID"
  "APPLE_KEY_ID"
  "APPLE_PRIVATE_KEY"
  "GOOGLE_CLIENT_EMAIL"
  "GOOGLE_PRIVATE_KEY"
  "INTENTION_WEBHOOK_SECRET"
)

OUT_FILE=".env.railway.tmp"
rm -f "$OUT_FILE"

echo "# Railway Variables (Fetched from GCP Secret Manager - Project: $PROJECT_ID)" > "$OUT_FILE"
echo "# Generated on $(date -u)" >> "$OUT_FILE"
echo "" >> "$OUT_FILE"

for sec in "${SECRETS[@]}"; do
  if gcloud secrets describe "$sec" --project="$PROJECT_ID" >/dev/null 2>&1; then
    VAL="$(gcloud secrets versions access latest --secret="$sec" --project="$PROJECT_ID" 2>/dev/null || echo "")"
    if [[ -n "$VAL" ]]; then
      # Handle multiline keys (like private keys) cleanly
      SINGLE_LINE_VAL="$(echo "$VAL" | awk 'BEGIN{RS="";FS="\n"}{for(i=1;i<=NF;i++)printf "%s\\n", $i}' | sed 's/\\n$//')"
      echo "${sec}=\"${SINGLE_LINE_VAL}\"" >> "$OUT_FILE"
      echo "  [LOADED] $sec"
    fi
  else
    echo "  [NOT FOUND] $sec"
  fi
done

echo ""
echo "============================================================"
echo " Railway variables formatted in: $OUT_FILE"
echo " You can copy contents of $OUT_FILE directly into Railway Dashboard,"
echo " or run 'railway variables set < .env.railway.tmp' if Railway CLI is installed."
echo "============================================================"
