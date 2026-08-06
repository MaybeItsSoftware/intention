#!/usr/bin/env bash
# scripts/setup-gcp-secrets.sh
# Populates backend secrets into GCP Secret Manager from server/.env or interactive prompts,
# and generates a sync output for Railway environment configuration.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ENV="$REPO_ROOT/server/.env"

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || echo "")"
if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: No active GCP project found in gcloud. Run 'gcloud config set project <PROJECT_ID>' first." >&2
  exit 1
fi

echo "============================================================"
echo " Setting up GCP Secret Manager for project: $PROJECT_ID"
echo "============================================================"

# Ensure Secret Manager API is enabled
echo "Ensuring secretmanager.googleapis.com is enabled..."
gcloud services enable secretmanager.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 || true

# Secrets list
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

# Helper function to read value from server/.env
get_env_val() {
  local var_name="$1"
  if [[ -f "$SERVER_ENV" ]]; then
    grep -E "^${var_name}=" "$SERVER_ENV" | cut -d '=' -f 2- | tr -d '"' | tr -d "'" || echo ""
  else
    echo ""
  fi
}

# Function to push secret to GCP Secret Manager
push_secret() {
  local secret_name="$1"
  local secret_val="$2"

  if [[ -z "$secret_val" ]]; then
    echo "  [SKIP] $secret_name is empty."
    return
  fi

  # Check if secret exists
  if gcloud secrets describe "$secret_name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo -n "$secret_val" | gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file=- >/dev/null
    echo "  [UPDATED] $secret_name"
  else
    gcloud secrets create "$secret_name" --project="$PROJECT_ID" --replication-policy="automatic" >/dev/null
    echo -n "$secret_val" | gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file=- >/dev/null
    echo "  [CREATED] $secret_name"
  fi
}

echo ""
echo "Uploading secrets to GCP Secret Manager..."
for sec in "${SECRETS[@]}"; do
  val="$(get_env_val "$sec")"
  if [[ -n "$val" ]]; then
    push_secret "$sec" "$val"
  else
    echo "  [MISSING] $sec not found in $SERVER_ENV. Skipping."
  fi
done

echo ""
echo "============================================================"
echo " GCP Secret Manager setup complete!"
echo " Secrets created/updated in project: $PROJECT_ID"
echo "============================================================"
