#!/bin/bash
# Common variables and helpers for pm-cli commands

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DB="$HOME/Library/Application Support/portfolio-manager/portfolio.db"
APP_CONFIG="$HOME/Library/Application Support/portfolio-manager/config.json"
CLI_CONFIG="$HOME/.pm-cli.conf"
FMP_BASE="https://financialmodelingprep.com/stable"
SCHWAB_API="https://api.schwabapi.com"
SCHWAB_TOKEN_URL="https://api.schwabapi.com/v1/oauth/token"

# Read a key from ~/.pm-cli.conf (KEY=value format)
get_config() {
  local KEY="$1"
  if [ -f "$CLI_CONFIG" ]; then
    grep "^${KEY}=" "$CLI_CONFIG" 2>/dev/null | head -1 | cut -d'=' -f2-
  fi
}

get_fmp_key() {
  get_config "FMP_API_KEY"
}

# Push notification via ntfy.sh (non-blocking)
NTFY_TOPIC=$(get_config "NTFY_TOPIC")
pm_notify() {
  local title="$1"
  local message="$2"
  local priority="${3:-default}"
  [ -z "$NTFY_TOPIC" ] && return
  curl -s -H "Title: $title" -H "Priority: $priority" -d "$message" "ntfy.sh/$NTFY_TOPIC" > /dev/null 2>&1 &
}

# Ensure we have a valid Schwab access token.
# Sets global vars: ACCESS_TOKEN, TOKEN_TYPE
schwab_ensure_token() {
  if [ ! -f "$APP_CONFIG" ]; then
    echo "ERROR: App config not found at $APP_CONFIG"
    echo "Run the Electron app at least once first."
    exit 1
  fi

  # Extract Schwab credentials and tokens from config.json
  SCHWAB_CLIENT_ID=$(python3 -c "import json; cfg=json.load(open('$APP_CONFIG')); print(cfg.get('settings',{}).get('schwabClientId',''))" 2>/dev/null)
  SCHWAB_CLIENT_SECRET=$(python3 -c "import json; cfg=json.load(open('$APP_CONFIG')); print(cfg.get('settings',{}).get('schwabClientSecret',''))" 2>/dev/null)
  REFRESH_TOKEN=$(python3 -c "import json; cfg=json.load(open('$APP_CONFIG')); print(cfg.get('settings',{}).get('schwabTokens',{}).get('refreshToken',''))" 2>/dev/null)
  REFRESH_EXPIRES=$(python3 -c "import json; cfg=json.load(open('$APP_CONFIG')); print(cfg.get('settings',{}).get('schwabTokens',{}).get('refreshTokenExpiresAt',0))" 2>/dev/null)

  if [ -z "$SCHWAB_CLIENT_ID" ] || [ -z "$REFRESH_TOKEN" ]; then
    echo "ERROR: Schwab not configured or not connected in the app."
    echo "Open the app and connect to Schwab first."
    exit 1
  fi

  # Check refresh token expiry
  NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  if [ "$REFRESH_EXPIRES" -le "$NOW_MS" ] 2>/dev/null; then
    echo "ERROR: Schwab refresh token expired. Reconnect in the app."
    exit 1
  fi

  # Get new access token
  echo "Refreshing Schwab access token..."
  BASIC_AUTH=$(printf "%s:%s" "$SCHWAB_CLIENT_ID" "$SCHWAB_CLIENT_SECRET" | base64)
  TOKEN_RESPONSE=$(curl -s -X POST "$SCHWAB_TOKEN_URL" \
    -H "Authorization: Basic $BASIC_AUTH" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=refresh_token&refresh_token=$REFRESH_TOKEN")

  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('access_token',''))" 2>/dev/null)
  TOKEN_TYPE=$(echo "$TOKEN_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token_type','Bearer'))" 2>/dev/null)

  if [ -z "$ACCESS_TOKEN" ]; then
    echo "ERROR: Failed to refresh access token."
    echo "$TOKEN_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error_description', d.get('error', 'Unknown error')))" 2>/dev/null
    exit 1
  fi

  # Save new tokens back to config.json so the app picks them up too
  python3 -c "
import json, time
with open('$APP_CONFIG') as f:
    cfg = json.load(f)
resp = json.loads('''$TOKEN_RESPONSE''')
now = int(time.time() * 1000)
tokens = cfg.get('settings', {}).get('schwabTokens', {})
tokens['accessToken'] = resp['access_token']
tokens['refreshToken'] = resp.get('refresh_token', tokens.get('refreshToken', ''))
tokens['accessTokenExpiresAt'] = now + (resp.get('expires_in', 1800) * 1000)
tokens['refreshTokenExpiresAt'] = now + (7 * 24 * 60 * 60 * 1000)
tokens['tokenType'] = resp.get('token_type', 'Bearer')
tokens['scope'] = resp.get('scope', tokens.get('scope'))
cfg['settings']['schwabTokens'] = tokens
with open('$APP_CONFIG', 'w') as f:
    json.dump(cfg, f, indent=2)
" 2>/dev/null
  echo "Access token refreshed."
}

# Get account hash for a Schwab account number
# Usage: schwab_get_account_hash <account_number_suffix>
# Sets global var: ACCOUNT_HASH
schwab_get_account_hash() {
  local ACCT_NUM="$1"
  local ACCTS_JSON
  ACCTS_JSON=$(curl -s "${SCHWAB_API}/trader/v1/accounts/accountNumbers" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}")

  ACCOUNT_HASH=$(echo "$ACCTS_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for acct in data:
    if acct.get('accountNumber','').endswith('$ACCT_NUM'):
        print(acct['hashValue'])
        sys.exit(0)
print('')
" 2>/dev/null)

  if [ -z "$ACCOUNT_HASH" ]; then
    echo "ERROR: Could not find account hash for account ending in $ACCT_NUM"
    return 1
  fi
}

# Resolve which account to use for a trade
# Usage: resolve_account <BUY|SELL> <symbol> [account_hint]
# Sets global var: RESOLVED_ACCOUNT (account number)
resolve_account() {
  local INSTRUCTION="$1"
  local SYMBOL="$2"
  local HINT="$3"

  if [ -n "$HINT" ]; then
    # Try to match by name (case-insensitive) or account_number suffix
    RESOLVED_ACCOUNT=$(sqlite3 "$DB" "
      SELECT account_number FROM accounts
      WHERE LOWER(name) LIKE LOWER('%${HINT}%')
         OR account_number LIKE '%${HINT}'
      LIMIT 1;
    ")
    if [ -z "$RESOLVED_ACCOUNT" ]; then
      echo "ERROR: No account found matching '$HINT'"
      return 1
    fi
  elif [ "$INSTRUCTION" = "SELL" ]; then
    # Find which account holds the symbol
    RESOLVED_ACCOUNT=$(sqlite3 "$DB" "
      SELECT a.account_number FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN accounts a ON p.account_id = a.id
      WHERE UPPER(s.symbol) = UPPER('$SYMBOL')
        AND p.quantity > 0;
    ")
    local ACCT_COUNT
    ACCT_COUNT=$(echo "$RESOLVED_ACCOUNT" | grep -c .)
    if [ "$ACCT_COUNT" -gt 1 ]; then
      echo "ERROR: Multiple accounts hold $SYMBOL. Specify account with hint."
      echo "Accounts: $RESOLVED_ACCOUNT"
      return 1
    fi
    if [ -z "$RESOLVED_ACCOUNT" ]; then
      echo "ERROR: No account holds $SYMBOL"
      return 1
    fi
  else
    # BUY with no hint: default to 8819
    RESOLVED_ACCOUNT="8819"
  fi
}
