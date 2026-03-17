#!/bin/bash
# CLI helper for portfolio-manager database operations
# Used by Claude Code to read/write position intents and account books

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

# Pre-trade checklist functions
check_regime_read() {
  local today=$(date +%Y-%m-%d)
  local regime=$(sqlite3 "$DB" "SELECT regime_type FROM daily_rituals WHERE date='$today'" 2>/dev/null)
  if [ -n "$regime" ]; then
    echo "  ✓ PASS: Regime read done ($regime day)"
  else
    echo "  ✗ FAIL: No regime read recorded for today"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_sorting_day() {
  local today=$(date +%Y-%m-%d)
  local regime=$(sqlite3 "$DB" "SELECT regime_type FROM daily_rituals WHERE date='$today'" 2>/dev/null)
  if [ "$regime" = "sorting" ]; then
    echo "  ⚠ WARN: Sorting day — adds typically disabled"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: Not a sorting day"
  fi
  return 0
}

check_intent_exists() {
  local symbol="$1"
  local tier=$(sqlite3 "$DB" "SELECT pi.tier FROM position_intents pi JOIN positions p ON pi.position_id=p.id JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol' LIMIT 1" 2>/dev/null)
  if [ -n "$tier" ]; then
    echo "  ✓ PASS: Intent assigned ($tier)"
  else
    echo "  ✗ FAIL: No tier assigned"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_thesis() {
  local symbol="$1"
  local thesis=$(sqlite3 "$DB" "SELECT pi.thesis FROM position_intents pi JOIN positions p ON pi.position_id=p.id JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol' AND pi.thesis IS NOT NULL AND pi.thesis != '' LIMIT 1" 2>/dev/null)
  if [ -n "$thesis" ]; then
    echo "  ✓ PASS: Thesis documented"
  else
    echo "  ✗ FAIL: No thesis in position intent"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_invalidation() {
  local symbol="$1"
  local inv=$(sqlite3 "$DB" "SELECT pi.invalidation FROM position_intents pi JOIN positions p ON pi.position_id=p.id JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol' AND pi.invalidation IS NOT NULL AND pi.invalidation != '' LIMIT 1" 2>/dev/null)
  if [ -n "$inv" ]; then
    echo "  ✓ PASS: Invalidation defined"
  else
    echo "  ✗ FAIL: No invalidation conditions"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_reentry_cooldown() {
  local symbol="$1"
  local last_sell=$(sqlite3 "$DB" "SELECT MAX(t.date) FROM transactions t JOIN securities s ON t.security_id=s.id WHERE s.symbol='$symbol' AND t.type='sell'" 2>/dev/null)
  if [ -n "$last_sell" ] && [ "$last_sell" != "" ]; then
    local days_ago=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$last_sell" +%s 2>/dev/null || echo 0)) / 86400 ))
    if [ "$days_ago" -lt 14 ] 2>/dev/null; then
      local wait_days=$((14 - days_ago))
      echo "  ✗ BLOCKED: Re-entry cooldown — you sold $symbol ${days_ago}d ago (last: $last_sell)"
      echo "             Re-entries within 14d are premature 70% of the time. Wait ${wait_days} more days."
      return 1
    else
      echo "  ✓ PASS: Re-entry cooldown clear (${days_ago}d since last sell)"
    fi
  else
    echo "  ✓ PASS: Re-entry cooldown (no prior sells)"
  fi
  return 0
}

check_rapid_flip() {
  local symbol="$1" side="$2" sell_price="${3:-0}"
  if [ "$side" = "buy" ]; then
    local last_sell=$(sqlite3 "$DB" "SELECT MAX(t.date) FROM transactions t JOIN securities s ON t.security_id=s.id WHERE s.symbol='$symbol' AND t.type='sell'" 2>/dev/null)
    if [ -n "$last_sell" ] && [ "$last_sell" != "" ]; then
      local days_ago=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$last_sell" +%s 2>/dev/null || echo 0)) / 86400 ))
      if [ "$days_ago" -le 5 ] 2>/dev/null; then
        echo "  ⚠ WARN: Rapid flip — sold $symbol ${days_ago}d ago, now buying back"
        echo "          <5d round-trips have 27-31% win rate on conviction names."
        read -p "    Override? (y/n): " ov
        [ "$ov" != "y" ] && return 1
      fi
    fi
  else
    local last_buy=$(sqlite3 "$DB" "SELECT MAX(t.date) FROM transactions t JOIN securities s ON t.security_id=s.id WHERE s.symbol='$symbol' AND t.type='buy'" 2>/dev/null)
    if [ -n "$last_buy" ] && [ "$last_buy" != "" ]; then
      local days_ago=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$last_buy" +%s 2>/dev/null || echo 0)) / 86400 ))
      if [ "$days_ago" -le 5 ] 2>/dev/null; then
        # Only warn if materializing a loss
        local avg_cost=$(sqlite3 "$DB" "SELECT CASE WHEN p.quantity > 0 THEN p.cost_basis / p.quantity ELSE 0 END FROM positions p JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol' LIMIT 1" 2>/dev/null)
        if [ -n "$avg_cost" ] && [ "$sell_price" != "0" ]; then
          local is_loss=$(python3 -c "print(1 if $sell_price < $avg_cost else 0)" 2>/dev/null)
          if [ "$is_loss" = "1" ]; then
            echo "  ⚠ WARN: Rapid flip at a loss — bought $symbol ${days_ago}d ago (avg cost \$$avg_cost, selling at \$$sell_price)"
            echo "          Your 90d+ holds have 57% win rate vs 33% for <30d."
            read -p "    Override? (y/n): " ov
            [ "$ov" != "y" ] && return 1
          fi
        fi
      fi
    fi
  fi
  echo "  ✓ PASS: No rapid flip detected"
  return 0
}

check_sr_levels() {
  local symbol="$1" side="$2" price="${3:-0}"

  # Get current price if not provided
  if [ "$price" = "0" ]; then
    price=$(sqlite3 "$DB" "SELECT ph.close_price FROM price_history ph JOIN securities s ON ph.security_id=s.id WHERE s.symbol='$symbol' ORDER BY ph.date DESC LIMIT 1" 2>/dev/null)
  fi
  [ -z "$price" ] && { echo "  ✓ PASS: S/R check (no price data)"; return 0; }

  # Get levels
  local levels=$(sqlite3 -separator '|' "$DB" "SELECT level_type, price, strength FROM price_levels WHERE symbol='$symbol' ORDER BY price" 2>/dev/null)
  if [ -z "$levels" ]; then
    echo "  ✓ PASS: S/R check (no levels computed)"
    return 0
  fi

  # Display S/R context
  echo "  ── S/R Levels for $symbol (price: \$$price) ──"
  echo "$levels" | while IFS='|' read -r LTYPE LPRICE LSTR; do
    local pct=$(python3 -c "print(f'{abs(($LPRICE - $price) / $price * 100):.1f}')" 2>/dev/null)
    if [ "$LTYPE" = "resistance" ]; then
      echo "    R: \$$LPRICE (strength $LSTR) — ${pct}% away"
    else
      echo "    S: \$$LPRICE (strength $LSTR) — ${pct}% away"
    fi
  done

  # Check proximity warnings
  if [ "$side" = "BUY" ] || [ "$side" = "buy" ]; then
    # Nearest resistance above
    local nearest_r=$(sqlite3 -separator '|' "$DB" "SELECT price, strength FROM price_levels WHERE symbol='$symbol' AND level_type='resistance' AND price > $price ORDER BY price ASC LIMIT 1" 2>/dev/null)
    if [ -n "$nearest_r" ]; then
      local r_price=$(echo "$nearest_r" | cut -d'|' -f1)
      local r_str=$(echo "$nearest_r" | cut -d'|' -f2)
      local pct_away=$(python3 -c "print(f'{($r_price - $price) / $price * 100:.1f}')" 2>/dev/null)
      if python3 -c "exit(0 if float('$pct_away') < 3 else 1)" 2>/dev/null; then
        echo "  ⚠ WARN: Buying within ${pct_away}% of resistance at \$$r_price (strength $r_str)"
        read -p "    Override? (y/n): " ov
        [ "$ov" != "y" ] && return 1
      fi
    fi
  else
    # Nearest support below
    local nearest_s=$(sqlite3 -separator '|' "$DB" "SELECT price, strength FROM price_levels WHERE symbol='$symbol' AND level_type='support' AND price < $price ORDER BY price DESC LIMIT 1" 2>/dev/null)
    if [ -n "$nearest_s" ]; then
      local s_price=$(echo "$nearest_s" | cut -d'|' -f1)
      local s_str=$(echo "$nearest_s" | cut -d'|' -f2)
      local pct_away=$(python3 -c "print(f'{($price - $s_price) / $price * 100:.1f}')" 2>/dev/null)
      if python3 -c "exit(0 if float('$pct_away') < 3 else 1)" 2>/dev/null; then
        echo "  ⚠ WARN: Selling within ${pct_away}% of support at \$$s_price (strength $s_str)"
        read -p "    Override? (y/n): " ov
        [ "$ov" != "y" ] && return 1
      fi
    fi
  fi
  return 0
}

check_gap_up() {
  local symbol="$1"

  # Get last 6 trading days of price history
  local prices=$(sqlite3 -separator '|' "$DB" "
    SELECT date, open_price, close_price FROM price_history ph
    JOIN securities s ON ph.security_id=s.id
    WHERE s.symbol='$symbol' AND ph.open_price IS NOT NULL
    ORDER BY ph.date DESC LIMIT 6
  " 2>/dev/null)

  [ -z "$prices" ] && { echo "  ✓ PASS: Gap-up check (no price data)"; return 0; }

  # Reverse to chronological order and check consecutive days
  local reversed=$(echo "$prices" | tail -r 2>/dev/null || echo "$prices" | tac 2>/dev/null || echo "$prices")
  local prev_close=""
  local gap_found=0
  local gap_date="" gap_pct=""

  while IFS='|' read -r pdate popen pclose; do
    if [ -n "$prev_close" ] && [ -n "$popen" ]; then
      local gpct=$(python3 -c "
pc = float('$prev_close')
if pc > 0:
    print(f'{($popen - pc) / pc * 100:.1f}')
else:
    print('0')
" 2>/dev/null)
      if python3 -c "exit(0 if float('$gpct') > 5 else 1)" 2>/dev/null; then
        gap_found=1
        gap_date="$pdate"
        gap_pct="$gpct"
        break
      fi
    fi
    prev_close="$pclose"
  done <<< "$reversed"

  if [ "$gap_found" = "1" ]; then
    echo "  ⚠ WARN: $symbol gapped up ${gap_pct}% on $gap_date — mean reversion risk elevated"
    # Show nearest resistance
    local latest_close=$(echo "$prices" | head -1 | cut -d'|' -f3)
    if [ -n "$latest_close" ]; then
      local nearest_r=$(sqlite3 -separator '|' "$DB" "SELECT price, strength FROM price_levels WHERE symbol='$symbol' AND level_type='resistance' AND price > $latest_close ORDER BY price ASC LIMIT 1" 2>/dev/null)
      if [ -n "$nearest_r" ]; then
        local r_price=$(echo "$nearest_r" | cut -d'|' -f1)
        local r_str=$(echo "$nearest_r" | cut -d'|' -f2)
        local dist_pct=$(python3 -c "print(f'{($r_price - $latest_close) / $latest_close * 100:.1f}')" 2>/dev/null)
        echo "          Nearest resistance: \$$r_price (strength $r_str, ${dist_pct}% away)"
      fi
    fi
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: No recent gap-up detected"
  fi
  return 0
}

check_thesis_file() {
  local symbol="$1" book="$2"
  local PROJ_ROOT
  PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
  local thesis_path="$PROJ_ROOT/docs/positions/$(echo "$symbol" | tr '[:lower:]' '[:upper:]')/thesis.md"

  if [ -f "$thesis_path" ]; then
    echo "  ✓ PASS: Thesis doc exists"
    return 0
  fi

  if [ "$book" = "investing" ]; then
    echo "  ✗ FAIL: Thesis doc missing — required for investment positions"
    echo "          Create docs/positions/$(echo "$symbol" | tr '[:lower:]' '[:upper:]')/thesis.md first."
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ⚠ WARN: No thesis doc — confirm this is a pure technical/momentum trade"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_panic_sell() {
  local symbol="$1" price="${2:-0}"

  # Get current and previous close
  local prices=$(sqlite3 -separator '|' "$DB" "
    SELECT close_price FROM price_history ph
    JOIN securities s ON ph.security_id=s.id
    WHERE s.symbol='$symbol'
    ORDER BY ph.date DESC LIMIT 2
  " 2>/dev/null)

  local current_close=$(echo "$prices" | head -1)
  local prev_close=$(echo "$prices" | tail -1)

  [ -z "$current_close" ] || [ -z "$prev_close" ] && { echo "  ✓ PASS: Panic sell check (no price data)"; return 0; }

  local is_red=$(python3 -c "print(1 if float('$current_close') < float('$prev_close') else 0)" 2>/dev/null)
  [ "$is_red" != "1" ] && { echo "  ✓ PASS: Not a red day"; return 0; }

  # Check if near support
  local use_price="$price"
  [ "$use_price" = "0" ] && use_price="$current_close"

  local nearest_s=$(sqlite3 -separator '|' "$DB" "SELECT price, strength FROM price_levels WHERE symbol='$symbol' AND level_type='support' AND price < $use_price ORDER BY price DESC LIMIT 1" 2>/dev/null)
  [ -z "$nearest_s" ] && { echo "  ✓ PASS: No support level below"; return 0; }

  local s_price=$(echo "$nearest_s" | cut -d'|' -f1)
  local pct_away=$(python3 -c "print(f'{($use_price - $s_price) / $use_price * 100:.1f}')" 2>/dev/null)

  if python3 -c "exit(0 if float('$pct_away') < 3 else 1)" 2>/dev/null; then
    echo ""
    echo "  🚨 PANIC SELL PATTERN DETECTED"
    echo "     Red day + selling within ${pct_away}% of support at \$$s_price"

    # Surface past panic sell post-mortems
    local past_panics=$(sqlite3 "$DB" "
      SELECT s.symbol || ': ' || pm.lesson_learned
      FROM post_mortems pm
      JOIN securities s ON pm.security_id = s.id
      WHERE pm.execution_quality = 'bad' AND pm.outcome = 'loss'
      ORDER BY pm.close_date DESC LIMIT 3
    " 2>/dev/null)
    if [ -n "$past_panics" ]; then
      echo "     Past lessons from bad-execution losses:"
      echo "$past_panics" | while read -r line; do echo "       • $line"; done
    fi

    echo ""
    read -p "    I acknowledge this may be a panic sell. Proceed? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: Not near support (${pct_away}% away)"
  fi
  return 0
}

recall_symbol() {
  local symbol="$1"
  if [ -z "$symbol" ]; then
    echo "Usage: pm-cli.sh recall <symbol>"
    exit 1
  fi
  symbol=$(echo "$symbol" | tr '[:lower:]' '[:upper:]')

  echo ""
  echo "╔═══════════════════════════════════════╗"
  echo "║       DECISION MEMORY: $symbol"
  echo "╚═══════════════════════════════════════╝"
  echo ""

  # Recent transactions (last 5 buys/sells)
  echo "── Recent Transactions ──"
  local txns
  txns=$(sqlite3 -separator '|' "$DB" "
    SELECT t.date, t.type, t.quantity, printf('%.2f', t.price) as price,
           printf('%.2f', t.amount) as amount, a.name as account
    FROM transactions t
    JOIN securities s ON t.security_id = s.id
    JOIN accounts a ON t.account_id = a.id
    WHERE s.symbol = '$symbol' AND t.type IN ('Buy', 'Sell', 'buy', 'sell')
    ORDER BY t.date DESC LIMIT 5;
  " 2>/dev/null)

  if [ -z "$txns" ]; then
    echo "  (no transactions found)"
  else
    printf "  %-12s %-5s %8s %10s %12s  %s\n" "DATE" "SIDE" "QTY" "PRICE" "AMOUNT" "ACCOUNT"
    printf "  %-12s %-5s %8s %10s %12s  %s\n" "----------" "-----" "--------" "----------" "------------" "-------"
    echo "$txns" | while IFS='|' read -r TDATE TTYPE TQTY TPRICE TAMT TACCT; do
      printf "  %-12s %-5s %8s %10s %12s  %s\n" "$TDATE" "$TTYPE" "$TQTY" "$TPRICE" "$TAMT" "$TACCT"
    done
  fi
  echo ""

  # Post-mortems
  echo "── Post-Mortems ──"
  local pms
  pms=$(sqlite3 -separator '|' "$DB" "
    SELECT pm.close_date, pm.thesis_quality, pm.execution_quality, pm.outcome,
           pm.error_type, printf('%.2f', pm.realized_gain) as realized_gain,
           pm.hold_days, pm.lesson_learned
    FROM post_mortems pm
    JOIN securities s ON pm.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY pm.close_date DESC;
  " 2>/dev/null)

  if [ -z "$pms" ]; then
    echo "  (no post-mortems)"
  else
    echo "$pms" | while IFS='|' read -r CDATE TQ EQ OC ERR GAIN HDAYS LESSON; do
      if [ "$OC" = "loss" ]; then
        COLOR="\033[31m"
      else
        COLOR="\033[32m"
      fi
      RESET="\033[0m"
      printf "  ${COLOR}%s | %s thesis / %s exec / %s | %s | P&L: %s | %s days${RESET}\n" "$CDATE" "$TQ" "$EQ" "$OC" "$ERR" "$GAIN" "$HDAYS"
      echo "    Lesson: $LESSON"
    done
  fi
  echo ""

  # Decision logs
  echo "── Decision Logs ──"
  local dlogs
  dlogs=$(sqlite3 -separator '|' "$DB" "
    SELECT dl.date, dl.decision_type, dl.decision, dl.background
    FROM decision_logs dl
    JOIN securities s ON dl.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY dl.date DESC;
  " 2>/dev/null)

  if [ -z "$dlogs" ]; then
    echo "  (no decision logs)"
  else
    echo "$dlogs" | while IFS='|' read -r DDATE DTYPE DDEC DBKG; do
      echo "  $DDATE [$DTYPE] $DDEC"
      [ -n "$DBKG" ] && echo "    Background: $DBKG"
    done
  fi
  echo ""

  # Observations
  echo "── Observations ──"
  local obs
  obs=$(sqlite3 -separator '|' "$DB" "
    SELECT o.observation_date,
      CASE o.thesis_impact WHEN 'supports' THEN '+' WHEN 'challenges' THEN '-' ELSE '~' END,
      o.note
    FROM observations o
    JOIN securities s ON o.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY o.observation_date DESC
    LIMIT 10;
  " 2>/dev/null)

  if [ -z "$obs" ]; then
    echo "  (no observations)"
  else
    echo "$obs" | while IFS='|' read -r ODATE OIMPACT ONOTE; do
      echo "  $ODATE [$OIMPACT] $ONOTE"
    done
  fi
  echo ""

  # Intent changes
  echo "── Intent Changes ──"
  local intlogs
  intlogs=$(sqlite3 -separator '|' "$DB" "
    SELECT cl.changed_at, cl.field_name, cl.old_value, cl.new_value
    FROM position_intent_change_logs cl
    JOIN positions p ON cl.position_id = p.id
    JOIN securities s ON p.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY cl.changed_at DESC LIMIT 10;
  " 2>/dev/null)

  if [ -z "$intlogs" ]; then
    echo "  (no intent changes)"
  else
    echo "$intlogs" | while IFS='|' read -r IDATE IFIELD IOLD INEW; do
      echo "  $IDATE  $IFIELD: $IOLD → $INEW"
    done
  fi
  echo ""

  # Score changes
  echo "── Score Changes ──"
  sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS thesis_score_changes (id TEXT PRIMARY KEY, security_id TEXT NOT NULL, criteria_number TEXT NOT NULL, old_status TEXT NOT NULL, new_status TEXT NOT NULL, reason TEXT, changed_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (security_id) REFERENCES securities(id));" 2>/dev/null
  local score_changes
  score_changes=$(sqlite3 -separator '|' "$DB" "
    SELECT tsc.changed_at, tsc.criteria_number,
      tsc.old_status || ' -> ' || tsc.new_status as change,
      COALESCE(tsc.reason, '') as reason
    FROM thesis_score_changes tsc
    JOIN securities s ON tsc.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY tsc.changed_at DESC
    LIMIT 10;
  " 2>/dev/null)

  if [ -z "$score_changes" ]; then
    echo "  (no score changes)"
  else
    echo "$score_changes" | while IFS='|' read -r SCDATE SCCRIT SCCHANGE SCREASON; do
      echo "  $SCDATE  $SCCRIT: $SCCHANGE" $([ -n "$SCREASON" ] && echo "— $SCREASON")
    done
  fi
  echo ""
}

check_boundary() {
  local symbol="$1" side="$2" book="$3" qty="${4:-0}" price="${5:-0}"

  if [ "$book" = "investing" ]; then
    # Count sells (proxy for round-trips) in last 90 days
    local sell_count=$(sqlite3 "$DB" "
      SELECT COUNT(*) FROM transactions t
      JOIN securities s ON t.security_id=s.id
      WHERE s.symbol='$symbol' AND t.type IN ('sell','Sell')
      AND t.date >= date('now', '-90 days')
    " 2>/dev/null)
    if [ "$sell_count" -ge 3 ] 2>/dev/null; then
      echo "  ⚠ WARN: Boundary violation — $sell_count sells on $symbol in 90 days"
      echo "          This is an investing position. If you believe the thesis, hold."
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && return 1
    else
      echo "  ✓ PASS: Boundary check (investing, $sell_count sells in 90d)"
    fi
  elif [ "$book" = "trading" ]; then
    # Check if position is investing-sized (>2% of portfolio)
    local portfolio_total=$(sqlite3 "$DB" "
      SELECT COALESCE(SUM(
        CASE WHEN s.type IN ('cash') THEN p.quantity
        ELSE p.quantity * COALESCE((SELECT ph.close_price FROM price_history ph WHERE ph.security_id=p.security_id ORDER BY ph.date DESC LIMIT 1), 0)
        END
      ), 0)
      FROM positions p JOIN securities s ON p.security_id=s.id
    " 2>/dev/null)
    local existing_mv=$(sqlite3 "$DB" "
      SELECT COALESCE(p.quantity * (SELECT ph.close_price FROM price_history ph WHERE ph.security_id=p.security_id ORDER BY ph.date DESC LIMIT 1), 0)
      FROM positions p JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol'
    " 2>/dev/null)
    [ -z "$existing_mv" ] && existing_mv=0
    local order_val=$(python3 -c "print($qty * $price)" 2>/dev/null)
    [ -z "$order_val" ] && order_val=0
    local after_mv=$(python3 -c "print($existing_mv + $order_val)" 2>/dev/null)
    local pct=$(python3 -c "print(f'{$after_mv / $portfolio_total * 100:.1f}' if $portfolio_total > 0 else '0.0')" 2>/dev/null)
    if python3 -c "exit(0 if float('$pct') > 2.0 else 1)" 2>/dev/null; then
      echo "  ⚠ WARN: Position ${pct}% — investing-sized for trading account"
      echo "          Consider moving to investing book or sizing down."
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && return 1
    else
      echo "  ✓ PASS: Trading position size OK (${pct}%)"
    fi
  fi
  return 0
}

check_hold_duration() {
  local symbol="$1"
  local hold_period=$(sqlite3 "$DB" "
    SELECT pi.target_hold_period FROM position_intents pi
    JOIN positions p ON pi.position_id=p.id
    JOIN securities s ON p.security_id=s.id
    WHERE s.symbol='$symbol' LIMIT 1
  " 2>/dev/null)
  [ -z "$hold_period" ] && { echo "  ✓ PASS: Hold duration (no target set)"; return 0; }

  local first_buy=$(sqlite3 "$DB" "
    SELECT MIN(t.date) FROM transactions t
    JOIN securities s ON t.security_id=s.id
    WHERE s.symbol='$symbol' AND t.type IN ('buy','Buy')
  " 2>/dev/null)
  [ -z "$first_buy" ] && { echo "  ✓ PASS: Hold duration (no buy history)"; return 0; }

  local days_held=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$first_buy" +%s 2>/dev/null || echo 0)) / 86400 ))

  # Parse target hold period to days
  local target_days=$(python3 -c "
import re
p = '$hold_period'.lower()
m = re.search(r'(\d+)\s*(month|year|week|day)', p)
if m:
    n, unit = int(m.group(1)), m.group(2)
    if 'year' in unit: print(n * 365)
    elif 'month' in unit: print(n * 30)
    elif 'week' in unit: print(n * 7)
    else: print(n)
else:
    print(0)
" 2>/dev/null)

  [ "$target_days" = "0" ] && { echo "  ✓ PASS: Hold duration (unparseable target: $hold_period)"; return 0; }

  if [ "$days_held" -lt "$target_days" ] 2>/dev/null; then
    local remaining=$((target_days - days_held))
    echo "  ⚠ WARN: Hold duration — target is '$hold_period' but only held ${days_held}d ($remaining days remaining)"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: Hold duration met (${days_held}d, target: $hold_period)"
  fi
  return 0
}

check_churn() {
  local symbol="$1"
  local sell_count=$(sqlite3 "$DB" "
    SELECT COUNT(*) FROM transactions t
    JOIN securities s ON t.security_id=s.id
    WHERE s.symbol='$symbol' AND t.type IN ('sell','Sell')
    AND t.date >= date('now', '-90 days')
  " 2>/dev/null)
  if [ "$sell_count" -ge 3 ] 2>/dev/null; then
    echo "  ⚠ WARN: Churn detected — $sell_count round-trips on $symbol in 90 days"
    echo "          Constant build-trim-rebuild destroys value."
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: No churn ($sell_count sells in 90d)"
  fi
  return 0
}

check_pending_earnings_review() {
  local symbol="$1"
  local pending=$(sqlite3 -separator '|' "$DB" "
    SELECT er.quarter, er.thesis_impact, er.invalidation_triggered, er.decision_deadline
    FROM earnings_reviews er
    JOIN securities s ON er.security_id = s.id
    WHERE s.symbol = '$symbol' AND er.decision IS NULL
    ORDER BY er.earnings_date DESC LIMIT 1;
  " 2>/dev/null)
  if [ -z "$pending" ]; then
    echo "  ✓ PASS: No pending earnings reviews"
    return 0
  fi
  local quarter=$(echo "$pending" | cut -d'|' -f1)
  local impact=$(echo "$pending" | cut -d'|' -f2)
  local invalidation=$(echo "$pending" | cut -d'|' -f3)
  local deadline=$(echo "$pending" | cut -d'|' -f4)
  if [ "$impact" = "challenged" ] || [ "$invalidation" = "1" ]; then
    echo "  ✗ FAIL: Pending earnings review for $symbol — thesis $impact"
    echo "          $quarter review pending${deadline:+ (deadline: $deadline)}. Complete review before trading."
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ⚠ WARN: Pending $quarter earnings review for $symbol ($impact, no decision yet)"
    read -p "    Acknowledged? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_entry_plan() {
  local symbol="$1" qty="$2" price="${3:-0}"
  local plan_id target_pct
  plan_id=$(sqlite3 "$DB" "
    SELECT ep.id FROM entry_plans ep
    JOIN securities s ON ep.security_id = s.id
    WHERE s.symbol = '$symbol' AND ep.status = 'active'
    ORDER BY ep.created_at DESC LIMIT 1
  " 2>/dev/null)

  if [ -z "$plan_id" ]; then
    echo "  ✓ PASS: No active entry plan"
    return 0
  fi

  target_pct=$(sqlite3 "$DB" "SELECT target_allocation_pct FROM entry_plans WHERE id = '$plan_id'" 2>/dev/null)
  local pending_count
  pending_count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches WHERE plan_id = '$plan_id' AND status = 'pending'" 2>/dev/null)
  local target_display="${target_pct:-unset}%"

  # Check if order matches any pending tranche (2% price tolerance)
  local match
  match=$(sqlite3 "$DB" "
    SELECT tranche_number, shares, trigger_price FROM entry_plan_tranches
    WHERE plan_id = '$plan_id' AND status = 'pending'
    AND shares = $qty
    AND ABS(trigger_price - $price) / trigger_price <= 0.02
    LIMIT 1
  " 2>/dev/null)

  if [ -n "$match" ]; then
    local t_num=$(echo "$match" | cut -d'|' -f1)
    echo "  ✓ PASS: Matches tranche $t_num of entry plan (target $target_display, $pending_count pending)"
    return 0
  fi

  # Show plan context
  local tranche_info
  tranche_info=$(sqlite3 "$DB" "
    SELECT 'T' || tranche_number || ': ' || shares || '@$' || printf('%.2f', trigger_price)
    FROM entry_plan_tranches WHERE plan_id = '$plan_id' AND status = 'pending'
  " 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

  echo "  ⚠ WARN: Buy deviates from entry plan (target $target_display)"
  echo "    Pending tranches: $tranche_info"
  read -p "    Override? (y/n): " ov
  [ "$ov" != "y" ] && return 1
  return 0
}

pre_trade_check() {
  local symbol="$1" side="$2" qty="$3" acct="$4" price="${5:-0}"

  # Determine book
  local book=$(sqlite3 "$DB" "SELECT book FROM accounts WHERE account_number LIKE '%$acct'" 2>/dev/null)
  [ -z "$book" ] && book="unassigned"

  echo ""
  echo "╔═══════════════════════════════════════╗"
  echo "║       PRE-TRADE CHECKLIST             ║"
  echo "╚═══════════════════════════════════════╝"
  echo "  $side $qty $symbol ($book book)"
  echo ""

  # Decision memory context
  local dm_pm dm_dl
  dm_pm=$(sqlite3 "$DB" "
    SELECT pm.lesson_learned FROM post_mortems pm
    JOIN securities s ON pm.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY pm.close_date DESC LIMIT 1;
  " 2>/dev/null)
  dm_dl=$(sqlite3 "$DB" "
    SELECT dl.decision FROM decision_logs dl
    JOIN securities s ON dl.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY dl.date DESC LIMIT 1;
  " 2>/dev/null)
  if [ -n "$dm_pm" ] || [ -n "$dm_dl" ]; then
    echo "  ── Decision Memory ──"
    [ -n "$dm_pm" ] && echo "  Last lesson: $dm_pm"
    [ -n "$dm_dl" ] && echo "  Last decision: $dm_dl"
    echo ""
  fi

  # Conflict surfacing (buys only)
  if [ "$side" = "BUY" ]; then
    # Check if today's ritual action conflicts
    local action=$(sqlite3 "$DB" "SELECT action_chosen FROM daily_rituals WHERE date = date('now')" 2>/dev/null)
    if [ "$action" = "reduce" ]; then
      echo "  ⚠ CONFLICT: Today's action is 'reduce' but you're buying."
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    elif [ "$action" = "nothing" ]; then
      echo "  ⚠ CONFLICT: Today's action is 'nothing' but you're trading."
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    fi

    # Check if recently sold same sector
    local sector=$(sqlite3 "$DB" "SELECT sector FROM securities WHERE symbol='$symbol'" 2>/dev/null)
    if [ -n "$sector" ] && [ "$sector" != "" ]; then
      local recent_sector_sells=$(sqlite3 "$DB" "
        SELECT s.symbol || ' on ' || t.date
        FROM transactions t
        JOIN securities s ON t.security_id = s.id
        WHERE s.sector = '$sector' AND t.type = 'sell'
        AND t.date >= date('now', '-7 days')
        AND s.symbol != '$symbol'
        ORDER BY t.date DESC LIMIT 3
      " 2>/dev/null)
      if [ -n "$recent_sector_sells" ]; then
        echo "  ⚠ CONFLICT: You sold other $sector names in the last 7 days:"
        echo "$recent_sector_sells" | while read -r line; do echo "    $line"; done
        echo "    Adding $symbol reintroduces sector exposure you just reduced."
        read -p "    Acknowledged? (y/n): " ack
        [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
      fi
    fi
  fi

  if [ "$side" = "SELL" ]; then
    check_regime_read || return 1
    check_rapid_flip "$symbol" "sell" "$price" || return 1
    check_sr_levels "$symbol" "SELL" "$price" || return 1
    check_panic_sell "$symbol" "$price" || return 1
    check_hold_duration "$symbol" || return 1
    [ "$book" = "investing" ] && { check_boundary "$symbol" "sell" "$book" || return 1; }
    echo ""
    echo "  Manual acknowledgments:"
    read -p "  ☐ I have a clear reason for this sell (y/n): " ack
    [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    echo ""
    echo "  ✓ Checklist complete"
    return 0
  fi

  if [ "$book" = "trading" ]; then
    check_thesis_file "$symbol" "$book" || return 1
    check_regime_read || return 1
    check_sorting_day || return 1
    check_reentry_cooldown "$symbol" || return 1
    check_rapid_flip "$symbol" "buy" || return 1
    check_sr_levels "$symbol" "BUY" "$price" || return 1
    check_gap_up "$symbol" || return 1
    check_boundary "$symbol" "buy" "$book" "$qty" "$price" || return 1
    check_churn "$symbol" || return 1
    check_pending_earnings_review "$symbol" || return 1
    check_entry_plan "$symbol" "$qty" "$price" || return 1
    echo "  ✓ PASS: Position size ≤1% check (manual verification)"
    echo ""
    echo "  Manual acknowledgments:"
    for item in \
      "I have a stop level defined — technical, not emotional" \
      "I will exit if no progress in 20-30 days" \
      "I accept a stop-out as success — not hoping, not averaging down"; do
      read -p "  ☐ $item (y/n): " ack
      [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    done
  else
    # Investing
    check_intent_exists "$symbol" || return 1
    check_thesis_file "$symbol" "$book" || return 1
    check_thesis "$symbol" || return 1
    check_invalidation "$symbol" || return 1
    check_regime_read || return 1
    check_sorting_day || return 1
    check_reentry_cooldown "$symbol" || return 1
    check_rapid_flip "$symbol" "buy" || return 1
    check_sr_levels "$symbol" "BUY" "$price" || return 1
    check_gap_up "$symbol" || return 1
    check_boundary "$symbol" "buy" "$book" "$qty" "$price" || return 1
    check_churn "$symbol" || return 1
    check_pending_earnings_review "$symbol" || return 1
    check_entry_plan "$symbol" "$qty" "$price" || return 1
    echo "  ✓ PASS: Position size check (manual verification)"
    echo ""
    echo "  Manual acknowledgments:"
    for item in \
      "This is an investment — I expect to hold for months+" \
      "I would hold through a 20-30% drawdown"; do
      read -p "  ☐ $item (y/n): " ack
      [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    done
  fi

  echo ""
  echo "  ✓ Checklist complete"
  return 0
}

trade_analytics() {
  local results
  results=$(sqlite3 "$DB" "
    WITH buys AS (
      SELECT t.account_id, t.security_id, s.symbol,
             SUM(t.quantity) as total_qty,
             SUM(ABS(t.amount)) as total_cost
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'buy' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
      GROUP BY t.account_id, t.security_id
    ),
    sells AS (
      SELECT t.account_id, t.security_id, s.symbol,
             t.date as sell_date,
             t.quantity,
             t.price as sell_price,
             ABS(t.amount) as proceeds
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'sell' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
    ),
    matched AS (
      SELECT s.symbol, s.sell_date, s.quantity, s.sell_price, s.proceeds,
             CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END as avg_buy_price,
             s.proceeds - (s.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END) as gain
      FROM sells s
      LEFT JOIN buys b ON s.account_id = b.account_id AND s.security_id = b.security_id
    )
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN gain > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN gain <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(100.0 * SUM(CASE WHEN gain > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
      ROUND(SUM(gain), 2) as total_pnl,
      ROUND(AVG(CASE WHEN gain > 0 THEN gain END), 2) as avg_win,
      ROUND(AVG(CASE WHEN gain <= 0 THEN gain END), 2) as avg_loss
    FROM matched;
  ")

  if [ -z "$results" ] || [ "$results" = "0||||||" ]; then
    echo ""
    echo "=== Trade Performance (avg cost method) ==="
    echo ""
    echo "  No sell transactions found."
    echo ""
    return
  fi

  IFS='|' read -r total wins losses win_rate total_pnl avg_win avg_loss <<< "$results"

  echo ""
  echo "=== Trade Performance (avg cost method) ==="
  echo ""
  printf "  %-20s %s\n" "Total Trades:" "$total"
  printf "  %-20s %s (%s W / %s L)\n" "Win Rate:" "${win_rate}%" "$wins" "$losses"
  printf "  %-20s \$%s\n" "Total P&L:" "$total_pnl"
  printf "  %-20s \$%s\n" "Avg Win:" "$avg_win"
  printf "  %-20s \$%s\n" "Avg Loss:" "$avg_loss"
  echo ""
  echo "(Note: CLI uses avg cost method. App uses precise FIFO matching.)"

  echo ""
  echo "--- Top 5 Winners ---"
  sqlite3 -header -column "$DB" "
    WITH buys AS (
      SELECT t.account_id, t.security_id,
             SUM(t.quantity) as total_qty, SUM(ABS(t.amount)) as total_cost
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'buy' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
      GROUP BY t.account_id, t.security_id
    )
    SELECT s.symbol, se.sell_date as date, se.quantity as qty,
           ROUND(se.sell_price, 2) as sell_px,
           ROUND(CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END, 2) as avg_cost,
           ROUND(ABS(se.proceeds) - (se.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END), 2) as pnl
    FROM (
      SELECT t.account_id, t.security_id, s.symbol, t.date as sell_date,
             t.quantity, t.price as sell_price, ABS(t.amount) as proceeds
      FROM transactions t JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'sell' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
    ) se
    JOIN securities s ON se.security_id = s.id
    LEFT JOIN buys b ON se.account_id = b.account_id AND se.security_id = b.security_id
    ORDER BY pnl DESC LIMIT 5;
  "

  echo ""
  echo "--- Top 5 Losers ---"
  sqlite3 -header -column "$DB" "
    WITH buys AS (
      SELECT t.account_id, t.security_id,
             SUM(t.quantity) as total_qty, SUM(ABS(t.amount)) as total_cost
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'buy' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
      GROUP BY t.account_id, t.security_id
    )
    SELECT s.symbol, se.sell_date as date, se.quantity as qty,
           ROUND(se.sell_price, 2) as sell_px,
           ROUND(CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END, 2) as avg_cost,
           ROUND(ABS(se.proceeds) - (se.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END), 2) as pnl
    FROM (
      SELECT t.account_id, t.security_id, s.symbol, t.date as sell_date,
             t.quantity, t.price as sell_price, ABS(t.amount) as proceeds
      FROM transactions t JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'sell' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
    ) se
    JOIN securities s ON se.security_id = s.id
    LEFT JOIN buys b ON se.account_id = b.account_id AND se.security_id = b.security_id
    ORDER BY pnl ASC LIMIT 5;
  "
}

trade_journal() {
  local symbol="${1:-}"
  local days="${2:-90}"
  local cutoff=$(date -v-${days}d +%Y-%m-%d 2>/dev/null || date -d "$days days ago" +%Y-%m-%d)

  echo ""
  echo "═══════════════════════════════════════"
  echo "  TRADE JOURNAL${symbol:+ — $symbol} (last ${days}d)"
  echo "═══════════════════════════════════════"
  echo ""

  local query="
    SELECT
      s.symbol,
      t.date as sell_date,
      t.quantity as sell_qty,
      t.price as sell_price,
      t.amount as proceeds,
      (SELECT tb.date FROM transactions tb
       WHERE tb.security_id = t.security_id AND tb.account_id = t.account_id
       AND tb.type = 'buy' AND tb.date <= t.date
       ORDER BY tb.date DESC LIMIT 1) as buy_date,
      (SELECT tb.price FROM transactions tb
       WHERE tb.security_id = t.security_id AND tb.account_id = t.account_id
       AND tb.type = 'buy' AND tb.date <= t.date
       ORDER BY tb.date DESC LIMIT 1) as buy_price,
      (SELECT dr.regime_type FROM daily_rituals dr WHERE dr.date = t.date) as regime_at_sell,
      (SELECT dr.action_chosen FROM daily_rituals dr WHERE dr.date = t.date) as action_chosen,
      (SELECT dr.journal FROM daily_rituals dr WHERE dr.date = t.date) as journal,
      (SELECT dl.decision FROM decision_logs dl
       WHERE dl.security_id = t.security_id
       AND dl.decision_date BETWEEN date(t.date, '-3 days') AND t.date
       ORDER BY dl.decision_date DESC LIMIT 1) as decision_note,
      a.account_number
    FROM transactions t
    JOIN securities s ON t.security_id = s.id
    JOIN accounts a ON t.account_id = a.id
    WHERE t.type = 'sell'
      AND t.date >= '$cutoff'
      ${symbol:+AND UPPER(s.symbol) = UPPER('$symbol')}
    ORDER BY t.date DESC
    LIMIT 100
  "

  local results=$(sqlite3 -separator '|' "$DB" "$query" 2>/dev/null)

  if [ -z "$results" ]; then
    echo "  No sell transactions found${symbol:+ for $symbol} in last ${days} days."
    echo ""
    return
  fi

  local prev_date=""
  echo "$results" | while IFS='|' read -r sym sell_date sell_qty sell_price proceeds buy_date buy_price regime_sell action journal decision acct; do
    # Date header
    if [ "$sell_date" != "$prev_date" ]; then
      [ -n "$prev_date" ] && echo ""
      echo "── $sell_date ──────────────────────────"
      [ -n "$regime_sell" ] && echo "  Regime: $regime_sell"
      [ -n "$action" ] && echo "  Action: $action"
      [ -n "$journal" ] && echo "  Journal: $journal"
      echo ""
      prev_date="$sell_date"
    fi

    # P&L calculation
    local pnl_info=""
    if [ -n "$buy_price" ] && [ "$buy_price" != "" ]; then
      pnl_info=$(python3 -c "
bp=float('$buy_price'); sp=float('$sell_price'); q=float('$sell_qty')
gain=(sp-bp)*q; pct=((sp/bp)-1)*100 if bp>0 else 0
print(f'\${gain:+,.0f} ({pct:+.1f}%)')
" 2>/dev/null)
    fi

    # Hold period
    local hold=""
    if [ -n "$buy_date" ] && [ "$buy_date" != "" ]; then
      hold=$(python3 -c "
from datetime import datetime
d1=datetime.strptime('$buy_date','%Y-%m-%d')
d2=datetime.strptime('$sell_date','%Y-%m-%d')
print(f'{(d2-d1).days}d')
" 2>/dev/null)
    fi

    echo "  SELL $sell_qty $sym @ \$$sell_price  $pnl_info"
    [ -n "$buy_date" ] && [ "$buy_date" != "" ] && echo "    Entry: $buy_date @ \$$buy_price (held $hold)"
    [ -n "$decision" ] && [ "$decision" != "" ] && echo "    Decision: $decision"
  done

  echo ""
}

case "$1" in
  morning)
    # Combined: refresh prices + briefing + ritual status
    "$0" refresh
    echo ""
    "$0" briefing
    echo ""
    "$0" ritual-status
    ;;
  portfolio)
    # Combined: positions + summary + today's intent changes
    "$0" positions
    echo ""
    "$0" summary
    echo ""
    echo "=== Intent Changes Today ==="
    "$0" intent-changes-today
    ;;
  briefing)
    # Uses prices from the local database (refreshed via Schwab in the app)
    echo "============================================"
    echo "  MORNING BRIEFING — $(date +%Y-%m-%d)"
    echo "============================================"
    echo ""

    # All data from local DB — run 'Refresh Prices' in the app first
    LATEST_DATE=$(sqlite3 "$DB" "SELECT MAX(date) FROM price_history;")
    echo "  Prices as of: $LATEST_DATE"
    echo ""

    # Show triggered monitors at top of briefing
    TRIGGERED_MONITORS=$(sqlite3 "$DB" "
      SELECT m.symbol, m.direction, printf('%.2f', m.price_level) as level,
             m.label, m.action_type, substr(m.triggered_at, 1, 10) as triggered_date
      FROM monitors m
      WHERE m.status = 'triggered'
      ORDER BY m.action_type DESC, m.triggered_at DESC;
    ")
    if [ -n "$TRIGGERED_MONITORS" ]; then
      echo "🚨 === TRIGGERED MONITORS ==="
      echo "$TRIGGERED_MONITORS" | while IFS='|' read -r sym dir level label atype tdate; do
        ICON="⬇️"
        [ "$dir" = "above" ] && ICON="⬆️"
        TYPE_TAG=""
        [ "$atype" = "action_required" ] && TYPE_TAG=" ⚠️  ACTION REQUIRED"
        echo "  $ICON $sym $dir \$$level — $label$TYPE_TAG (triggered $tdate)"
      done
      echo "=============================="
      echo ""
    fi

    # Market context: FMP for SPY (free tier) + index symbols from DB
    FMP_KEY=$(get_fmp_key)
    echo "=== Market Context ==="
    if [ -n "$FMP_KEY" ]; then
      # Fetch SPY from FMP (works on free tier)
      SPY_DATA=$(curl -s "${FMP_BASE}/quote?symbol=SPY&apikey=${FMP_KEY}" 2>/dev/null)
      echo "$SPY_DATA" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if isinstance(data, list) and len(data) > 0:
        q = data[0]
        price, chg, pct = q.get('price',0), q.get('change',0), q.get('changePercentage',0)
        arrow = '▲' if chg >= 0 else '▼'
        print(f'  SPY    \${price:>10.2f}  {arrow} {chg:>+7.2f} ({pct:>+.2f}%)')
except: pass
" 2>/dev/null
    fi
    # Index-like holdings from DB
    INDEX_SYMS="'SPY','QQQ','IWM','DIA','GLD','TLT','SGOV','EWJ'"
    sqlite3 "$DB" "
      SELECT s.symbol,
             ph.close_price as price,
             COALESCE(prev.close_price, ph.close_price) as prev_price,
             ph.volume
      FROM price_history ph
      JOIN securities s ON ph.security_id = s.id
      LEFT JOIN price_history prev ON prev.security_id = ph.security_id
        AND prev.date = (SELECT MAX(date) FROM price_history p2 WHERE p2.security_id = ph.security_id AND p2.date < ph.date)
      WHERE ph.date = '$LATEST_DATE'
        AND s.symbol IN ($INDEX_SYMS)
      ORDER BY s.symbol;
    " | python3 -c "
import sys
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 4: continue
    sym, price, prev, vol = parts[0], float(parts[1]), float(parts[2]), int(parts[3]) if parts[3] else 0
    chg = price - prev
    pct = (chg / prev * 100) if prev else 0
    arrow = '▲' if chg >= 0 else '▼'
    print(f'  {sym:<6} \${price:>10.2f}  {arrow} {chg:>+7.2f} ({pct:>+.2f}%)')
" 2>/dev/null
    echo ""

    # Portfolio positions (non-cash, non-index) — consolidated across accounts
    echo "=== Portfolio Quotes ==="
    sqlite3 "$DB" "
      SELECT s.symbol,
             ph.close_price as price,
             COALESCE(prev.close_price, ph.close_price) as prev_price,
             ph.volume,
             SUM(p.quantity) as total_qty,
             SUM(p.cost_basis) as total_cost
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN price_history ph ON ph.security_id = s.id AND ph.date = '$LATEST_DATE'
      LEFT JOIN price_history prev ON prev.security_id = ph.security_id
        AND prev.date = (SELECT MAX(date) FROM price_history p2 WHERE p2.security_id = ph.security_id AND p2.date < ph.date)
      WHERE s.type != 'cash'
        AND s.symbol NOT IN ($INDEX_SYMS)
      GROUP BY s.symbol
      ORDER BY (ph.close_price - COALESCE(prev.close_price, ph.close_price)) / COALESCE(prev.close_price, ph.close_price) DESC;
    " | python3 -c "
import sys
quotes = []
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 6: continue
    sym = parts[0]
    price, prev = float(parts[1]), float(parts[2])
    vol = int(parts[3]) if parts[3] else 0
    qty = float(parts[4]) if parts[4] else 0
    cost = float(parts[5]) if parts[5] else 0
    chg = price - prev
    pct = (chg / prev * 100) if prev else 0
    mv = price * qty
    quotes.append((sym, price, chg, pct, vol, mv, cost))

for sym, price, chg, pct, vol, mv, cost in quotes:
    arrow = '▲' if chg >= 0 else '▼'
    vol_str = f'{vol/1e6:.1f}M' if vol >= 1e6 else f'{vol/1e3:.0f}K' if vol >= 1e3 else str(vol)
    print(f'  {sym:<6} \${price:>10.2f}  {arrow} {chg:>+7.2f} ({pct:>+.2f}%)  vol: {vol_str}  mv: \${mv:,.0f}')

print()
gainers = [q for q in quotes if q[3] > 0.5]
losers = [q for q in quotes if q[3] < -0.5]
if gainers or losers:
    print('  --- Movers ---')
    if gainers:
        names = ', '.join(q[0] for q in gainers[:5])
        print(f'  Up:   {names}')
    if losers:
        names = ', '.join(q[0] for q in losers[:5])
        print(f'  Down: {names}')

# Summary
total_mv = sum(q[5] for q in quotes)
total_cost = sum(q[6] for q in quotes)
total_pnl = total_mv - total_cost
day_pnl = sum((q[2] * (q[5]/q[1])) if q[1] else 0 for q in quotes)
print()
print(f'  Total MV: \${total_mv:,.0f}  |  Day P&L: \${day_pnl:>+,.0f}  |  Total P&L: \${total_pnl:>+,.0f}')
" 2>/dev/null
    echo ""

    # Watchlist alerts: items near target entry price
    WL_ALERTS=$(sqlite3 "$DB" "
      SELECT w.name, wi.symbol, wi.target_entry_price, ph.close_price,
             printf('%.1f%%', (ph.close_price - wi.target_entry_price) / wi.target_entry_price * 100) as vs_target
      FROM watchlist_items wi
      JOIN watchlists w ON wi.watchlist_id = w.id
      JOIN securities s ON wi.security_id = s.id
      LEFT JOIN price_history ph ON ph.security_id = s.id AND ph.date = '$LATEST_DATE'
      WHERE wi.target_entry_price IS NOT NULL
        AND ph.close_price IS NOT NULL
        AND ph.close_price <= wi.target_entry_price * 1.05
      ORDER BY (ph.close_price - wi.target_entry_price) / wi.target_entry_price;
    ")
    # Fundamental reminders due today
    FUND_REMINDERS=$(sqlite3 "$DB" "SELECT symbol, label, reminder_date FROM monitors WHERE monitor_type = 'fundamental' AND status = 'active' AND reminder_date IS NOT NULL AND reminder_date <= date('now') ORDER BY symbol;" 2>/dev/null)
    if [ -n "$FUND_REMINDERS" ]; then
      echo "=== Fundamental Reminders ==="
      echo "$FUND_REMINDERS" | while IFS='|' read -r sym label rdate; do
        echo "  $sym — $label (since $rdate)"
      done
      echo ""
    fi

    # === EMS Orders ===
    EMS_TRIGGERED=$(sqlite3 "$DB" "
      SELECT s.symbol, ep.side, ept.shares, ept.trigger_type,
        COALESCE(ept.trigger_date, '\$' || printf('%.2f', ept.trigger_price)) as trigger_val,
        substr(ept.id, 1, 8) as tid, rb.name as basket
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN rebalance_baskets rb ON ep.basket_id = rb.id
      WHERE ept.status = 'triggered' AND ep.status = 'active';
    " 2>/dev/null)
    EMS_SUBMITTED=$(sqlite3 "$DB" "
      SELECT s.symbol, ep.side, ept.shares, '\$' || printf('%.2f', ept.limit_price) as lim,
        ept.brokerage_order_status as bstatus, rb.name as basket
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN rebalance_baskets rb ON ep.basket_id = rb.id
      WHERE ept.status = 'submitted' AND ep.status = 'active';
    " 2>/dev/null)
    EMS_FILLED_TODAY=$(sqlite3 "$DB" "
      SELECT s.symbol, ep.side, ept.filled_qty, '\$' || printf('%.2f', ept.filled_price) as fpx,
        ept.filled_at, rb.name as basket
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN rebalance_baskets rb ON ep.basket_id = rb.id
      WHERE ept.status = 'filled' AND date(ept.filled_at) = date('now');
    " 2>/dev/null)

    if [ -n "$EMS_TRIGGERED" ] || [ -n "$EMS_SUBMITTED" ] || [ -n "$EMS_FILLED_TODAY" ]; then
      echo "=== EMS Orders ==="
      if [ -n "$EMS_TRIGGERED" ]; then
        echo "  --- Awaiting Confirmation ---"
        echo "$EMS_TRIGGERED" | while IFS='|' read -r SYM SIDE SHARES TTYPE TVAL TID BNAME; do
          SIDE_UP=$(echo "$SIDE" | tr '[:lower:]' '[:upper:]')
          echo "  $SIDE_UP $SHARES $SYM | trigger: $TVAL ($TTYPE) | confirm: pm-cli.sh basket-confirm $TID"
        done
        TRIGGERED_COUNT=$(echo "$EMS_TRIGGERED" | wc -l | tr -d ' ')
        pm_notify "EMS: $TRIGGERED_COUNT orders triggered" "Run: pm-cli.sh basket-orders" "high"
      fi
      if [ -n "$EMS_SUBMITTED" ]; then
        echo "  --- Working at Broker ---"
        echo "$EMS_SUBMITTED" | while IFS='|' read -r SYM SIDE SHARES LIM BSTATUS BNAME; do
          SIDE_UP=$(echo "$SIDE" | tr '[:lower:]' '[:upper:]')
          echo "  $SIDE_UP $SHARES $SYM @ $LIM | $BSTATUS"
        done
      fi
      if [ -n "$EMS_FILLED_TODAY" ]; then
        echo "  --- Filled Today ---"
        echo "$EMS_FILLED_TODAY" | while IFS='|' read -r SYM SIDE QTY FPX FAT BNAME; do
          SIDE_UP=$(echo "$SIDE" | tr '[:lower:]' '[:upper:]')
          echo "  $SIDE_UP $QTY $SYM @ $FPX | $FAT"
        done
      fi
      echo ""
    fi

    EMS_PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches ept JOIN entry_plans ep ON ept.plan_id = ep.id WHERE ept.status = 'pending' AND ep.status = 'active';" 2>/dev/null)
    if [ "$EMS_PENDING" -gt 0 ]; then
      echo "=== EMS: $EMS_PENDING orders pending trigger ==="
      echo ""
    fi

    # === Thesis Score Changes (last 7 days) ===
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS thesis_score_changes (id TEXT PRIMARY KEY, security_id TEXT NOT NULL, criteria_number TEXT NOT NULL, old_status TEXT NOT NULL, new_status TEXT NOT NULL, reason TEXT, changed_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (security_id) REFERENCES securities(id));" 2>/dev/null
    SCORE_RECENT=$(sqlite3 "$DB" "
      SELECT s.symbol, tsc.criteria_number, tsc.old_status, tsc.new_status, COALESCE(tsc.reason, '')
      FROM thesis_score_changes tsc
      JOIN securities s ON tsc.security_id = s.id
      WHERE tsc.changed_at >= date('now', '-7 days')
      ORDER BY tsc.changed_at DESC;
    " 2>/dev/null)
    if [ -n "$SCORE_RECENT" ]; then
      echo "=== Thesis Score Changes (last 7 days) ==="
      echo "$SCORE_RECENT" | while IFS='|' read -r SYM CRIT OLD NEW REASON; do
        echo "  $SYM $CRIT: $OLD -> $NEW" $([ -n "$REASON" ] && echo "— $REASON")
      done
      echo ""
    fi

    # Upcoming earnings (next 7 days) from monitors table
    EARN_MONITORS=$(sqlite3 "$DB" "SELECT symbol, label, expires_at FROM monitors WHERE monitor_type = 'earnings' AND status = 'active' ORDER BY expires_at, symbol;" 2>/dev/null)
    if [ -n "$EARN_MONITORS" ]; then
      echo "=== Upcoming Earnings ==="
      echo "$EARN_MONITORS" | while IFS='|' read -r sym label expires; do
        echo "  $label"
      done
      echo ""
    fi

    if [ -n "$WL_ALERTS" ]; then
      echo "=== Watchlist Alerts (within 5% of target) ==="
      echo "$WL_ALERTS" | while IFS='|' read -r wl sym target price vs; do
        echo "  $sym \$$price → target \$$target ($vs) [$wl]"
      done
      echo ""
    fi

    # Overnight news (last 24h) — portfolio holdings only
    NEWS_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM news WHERE published_at >= datetime('now', '-1 day');" 2>/dev/null)
    if [ "$NEWS_COUNT" -gt 0 ] 2>/dev/null; then
      echo "=== Overnight News ==="
      sqlite3 "$DB" "
        SELECT n.symbol, n.published_at, n.title, n.source
        FROM news n
        JOIN (
          SELECT DISTINCT s.symbol FROM positions p
          JOIN securities s ON p.security_id = s.id
          WHERE s.type != 'cash'
        ) portfolio ON n.symbol = portfolio.symbol
        WHERE n.published_at >= datetime('now', '-1 day')
        ORDER BY n.symbol, n.published_at DESC;
      " | python3 -c "
import sys
from collections import defaultdict
by_symbol = defaultdict(list)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 4: continue
    sym, pub, title, source = parts[0], parts[1], parts[2], parts[3]
    by_symbol[sym].append((pub, title, source))

for sym in sorted(by_symbol):
    articles = by_symbol[sym]
    print(f'  {sym} ({len(articles)} articles)')
    for pub, title, source in articles[:3]:
        time_str = pub[11:16] if len(pub) > 16 else pub
        print(f'    {time_str} [{source}] {title}')
    if len(articles) > 3:
        print(f'    ... and {len(articles) - 3} more (run: pm-cli.sh news {sym})')
print()
" 2>/dev/null
    fi

    # Technical signals (notable only)
    FMP_KEY=$(get_fmp_key)
    if [ -n "$FMP_KEY" ]; then
      TECH_SYMBOLS=$(sqlite3 "$DB" "
        SELECT DISTINCT s.symbol FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.type != 'cash' AND s.symbol != ''
        ORDER BY s.symbol;
      ")
      TECH_SIGNALS=$(python3 - "$FMP_KEY" "$TECH_SYMBOLS" <<'PYEOF'
import json, urllib.request, sys

key = sys.argv[1]
symbols = [s.strip() for s in sys.argv[2].strip().split('\n') if s.strip()]
base = 'https://financialmodelingprep.com/stable/technical-indicators'

def fetch(indicator, symbol, period):
    url = f'{base}/{indicator}?symbol={symbol}&periodLength={period}&timeframe=1day&apikey={key}'
    try:
        data = json.loads(urllib.request.urlopen(url).read())
        return data[0] if data else None
    except:
        return None

signals = []
for symbol in symbols:
    sma50 = fetch('sma', symbol, 50)
    sma200 = fetch('sma', symbol, 200)
    rsi = fetch('rsi', symbol, 14)

    if not sma50:
        continue

    price = sma50.get('close', 0)
    s50 = sma50.get('sma', 0)
    s200 = sma200.get('sma', 0) if sma200 else 0
    rsi_val = rsi.get('rsi', 0) if rsi else 0

    notes = []
    if price < s200: notes.append(f'below 200 DMA (${s200:,.0f})')
    elif price < s50: notes.append(f'below 50 DMA (${s50:,.0f})')
    if rsi_val >= 70: notes.append(f'RSI {rsi_val:.0f} OVERBOUGHT')
    elif rsi_val <= 30: notes.append(f'RSI {rsi_val:.0f} OVERSOLD')
    elif rsi_val <= 40: notes.append(f'RSI {rsi_val:.0f}')

    if notes:
        signals.append(f'  {symbol:<6} ${price:>8,.2f}  {", ".join(notes)}')

if signals:
    for s in signals:
        print(s)
PYEOF
)
      if [ -n "$TECH_SIGNALS" ]; then
        echo "=== Technical Signals ==="
        echo "$TECH_SIGNALS"
        echo ""
      fi
    fi

    # S/R Proximity Alerts (within 3% of a key level)
    SR_ALERTS=$(python3 - "$DB" <<'PYEOF'
import sqlite3, sys

db = sys.argv[1]
conn = sqlite3.connect(db)
cur = conn.cursor()

cur.execute('''
    SELECT DISTINCT s.symbol,
           (SELECT ph.close_price FROM price_history ph
            WHERE ph.security_id = s.id ORDER BY ph.date DESC LIMIT 1) as price
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    WHERE s.type != 'cash' AND s.symbol != ''
    ORDER BY s.symbol
''')

alerts = []
for symbol, price in cur.fetchall():
    if not price:
        continue
    cur.execute("SELECT price, strength FROM price_levels WHERE symbol = ? ORDER BY ABS(price - ?) LIMIT 5", (symbol, price))
    for level_price, strength in cur.fetchall():
        pct = abs(price - level_price) / price * 100
        if pct <= 3 and pct > 0.1:
            direction = 'approaching resistance' if level_price > price else 'approaching support'
            label = 'Very Strong' if strength >= 8 else 'Strong' if strength >= 6 else 'Moderate' if strength >= 4 else 'Weak'
            alerts.append(f'  {symbol:<6} ${price:>8,.2f}  {direction} ${level_price:,.2f} ({pct:.1f}% away, {strength}/10 {label})')

if alerts:
    for a in alerts:
        print(a)
conn.close()
PYEOF
)
    if [ -n "$SR_ALERTS" ]; then
      echo "=== S/R Proximity Alerts ==="
      echo "$SR_ALERTS"
      echo ""
    fi

    # Pending earnings reviews
    OVERDUE_REVIEWS=$(sqlite3 -separator '|' "$DB" "
      SELECT s.symbol, er.quarter, er.thesis_impact, er.decision_deadline,
             er.invalidation_triggered
      FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      WHERE er.decision IS NULL
      ORDER BY er.decision_deadline ASC;
    " 2>/dev/null)
    if [ -n "$OVERDUE_REVIEWS" ]; then
      echo "=== Pending Earnings Reviews ==="
      echo "$OVERDUE_REVIEWS" | while IFS='|' read -r SYM QTR IMPACT DEADLINE INV_TRIG; do
        NOW_TS=$(date +%s)
        if [ -n "$DEADLINE" ]; then
          DL_TS=$(python3 -c "from datetime import datetime; print(int(datetime.fromisoformat('$DEADLINE'.replace('Z','+00:00')).timestamp()))" 2>/dev/null || echo "0")
          HOURS_LEFT=$(( (DL_TS - NOW_TS) / 3600 ))
          if [ "$HOURS_LEFT" -lt 0 ]; then
            echo "  ⚠ OVERDUE: $SYM $QTR earnings review — thesis $IMPACT, deadline was ${DEADLINE:0:10}"
          elif [ "$HOURS_LEFT" -lt 24 ]; then
            echo "  ⚠ DUE SOON: $SYM $QTR earnings review — due in ${HOURS_LEFT}h"
          else
            DAYS_LEFT=$(( HOURS_LEFT / 24 ))
            echo "  ⏳ PENDING: $SYM $QTR earnings review — thesis $IMPACT, ${DAYS_LEFT}d remaining"
          fi
        else
          echo "  ⏳ PENDING: $SYM $QTR earnings review — thesis $IMPACT, no deadline"
        fi
      done
      echo ""
    fi

    echo "(Run 'pm-cli.sh refresh' to update prices. Use web search for news.)"
    echo "============================================"
    ;;

  positions)
    sqlite3 -header -column "$DB" "
      SELECT p.id as position_id, s.symbol, s.name as security_name,
             a.name as account, a.book,
             printf('%.2f', p.quantity) as qty,
             printf('%.2f', p.cost_basis) as cost_basis,
             printf('%.2f', COALESCE(p.market_value, 0)) as market_value,
             s.sector, s.type as sec_type,
             pi.tier, pi.thesis, pi.invalidation, pi.target_hold_period
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN accounts a ON p.account_id = a.id
      LEFT JOIN position_intents pi ON pi.position_id = p.id
      WHERE s.type != 'cash'
      ORDER BY COALESCE(p.market_value, 0) DESC;
    "
    ;;
  cash)
    sqlite3 -header -column "$DB" "
      SELECT a.name as account, printf('%.2f', p.quantity) as amount
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN accounts a ON p.account_id = a.id
      WHERE s.type = 'cash';
    "
    ;;
  intents)
    sqlite3 -header -column "$DB" "
      SELECT s.symbol, pi.tier, pi.thesis, pi.invalidation, pi.entry_style, pi.target_hold_period
      FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      JOIN securities s ON p.security_id = s.id
      ORDER BY pi.tier, s.symbol;
    "
    ;;
  set-intent)
    # Usage: pm-cli.sh set-intent <position_id> <tier> <thesis> <invalidation> [entry_style] [hold_period] [target_alloc_pct]
    POS_ID="$2"; TIER="$3"; THESIS="$4"; INVAL="$5"; ENTRY="${6:-}"; HOLD="${7:-}"; TARGET_ALLOC="${8:-}"
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    TODAY=$(date +"%Y-%m-%d")

    # Log changes if intent already exists
    OLD_TIER=$(sqlite3 "$DB" "SELECT tier FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_THESIS=$(sqlite3 "$DB" "SELECT thesis FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_INVAL=$(sqlite3 "$DB" "SELECT invalidation FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_ENTRY=$(sqlite3 "$DB" "SELECT entry_style FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_HOLD=$(sqlite3 "$DB" "SELECT target_hold_period FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_TARGET_ALLOC=$(sqlite3 "$DB" "SELECT target_allocation_pct FROM position_intents WHERE position_id = '$POS_ID';")

    log_change() {
      local FIELD="$1" OLD="$2" NEW="$3"
      if [ "$OLD" != "$NEW" ] && [ -n "$NEW" -o -n "$OLD" ]; then
        local LOG_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
        local RITUAL_DATE=$(sqlite3 "$DB" "SELECT date FROM daily_rituals WHERE date = '$TODAY';")
        sqlite3 "$DB" "INSERT INTO position_intent_change_logs (id, position_id, ritual_date, field_changed, old_value, new_value, created_at) VALUES ('$LOG_ID', '$POS_ID', $([ -n "$RITUAL_DATE" ] && echo "'$RITUAL_DATE'" || echo "NULL"), '$FIELD', $([ -n "$OLD" ] && echo "'$OLD'" || echo "NULL"), $([ -n "$NEW" ] && echo "'$NEW'" || echo "NULL"), '$NOW');"
      fi
    }

    log_change "tier" "$OLD_TIER" "$TIER"
    log_change "thesis" "$OLD_THESIS" "$THESIS"
    log_change "invalidation" "$OLD_INVAL" "$INVAL"
    [ -n "$ENTRY" ] && log_change "entry_style" "$OLD_ENTRY" "$ENTRY"
    [ -n "$HOLD" ] && log_change "target_hold_period" "$OLD_HOLD" "$HOLD"
    [ -n "$TARGET_ALLOC" ] && log_change "target_allocation_pct" "$OLD_TARGET_ALLOC" "$TARGET_ALLOC"

    sqlite3 "$DB" "
      INSERT OR REPLACE INTO position_intents (id, position_id, tier, thesis, invalidation, entry_style, target_hold_period, target_allocation_pct, created_at, updated_at)
      VALUES (
        COALESCE((SELECT id FROM position_intents WHERE position_id = '$POS_ID'), '$ID'),
        '$POS_ID',
        $([ -n "$TIER" ] && echo "'$TIER'" || echo "NULL"),
        $([ -n "$THESIS" ] && echo "'$THESIS'" || echo "NULL"),
        $([ -n "$INVAL" ] && echo "'$INVAL'" || echo "NULL"),
        $([ -n "$ENTRY" ] && echo "'$ENTRY'" || echo "NULL"),
        $([ -n "$HOLD" ] && echo "'$HOLD'" || echo "NULL"),
        $([ -n "$TARGET_ALLOC" ] && echo "$TARGET_ALLOC" || echo "COALESCE((SELECT target_allocation_pct FROM position_intents WHERE position_id = '$POS_ID'), NULL)"),
        COALESCE((SELECT created_at FROM position_intents WHERE position_id = '$POS_ID'), '$NOW'),
        '$NOW'
      );
    "
    echo "Intent set for position $POS_ID"
    ;;
  set-book)
    # Usage: pm-cli.sh set-book <account_id> <investing|trading>
    sqlite3 "$DB" "UPDATE accounts SET book = '$3', updated_at = '$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")' WHERE id = '$2';"
    echo "Book set for account $2"
    ;;
  accounts)
    sqlite3 -header -column "$DB" "SELECT id, name, broker, account_type, book FROM accounts;"
    ;;
  summary)
    echo "=== Portfolio Summary ==="
    sqlite3 -header -column "$DB" "
      SELECT
        a.name as account,
        a.book,
        COUNT(CASE WHEN s.type != 'cash' THEN 1 END) as positions,
        printf('%.2f', SUM(CASE WHEN s.type != 'cash' THEN COALESCE(p.market_value, 0) ELSE 0 END)) as equity_value,
        printf('%.2f', SUM(CASE WHEN s.type = 'cash' THEN p.quantity ELSE 0 END)) as cash
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN accounts a ON p.account_id = a.id
      GROUP BY a.id;
    "
    echo ""
    echo "=== Tier Coverage ==="
    sqlite3 -header -column "$DB" "
      SELECT
        COUNT(*) as total_positions,
        SUM(CASE WHEN pi.tier IS NOT NULL THEN 1 ELSE 0 END) as with_tier,
        SUM(CASE WHEN pi.thesis IS NOT NULL THEN 1 ELSE 0 END) as with_thesis
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN position_intents pi ON pi.position_id = p.id
      WHERE s.type != 'cash';
    "
    ;;
  drift)
    echo "=== Allocation Drift ==="
    echo ""
    sqlite3 "$DB" "
      SELECT s.symbol,
        printf('%.1f', pi.target_allocation_pct) as target_pct,
        printf('%.1f',
          SUM(p.quantity * COALESCE(
            (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1),
            0
          )) * 100.0 /
          NULLIF((SELECT SUM(p2.quantity * COALESCE(
            (SELECT ph2.close_price FROM price_history ph2 WHERE ph2.security_id = p2.security_id ORDER BY ph2.date DESC LIMIT 1),
            0
          )) FROM positions p2 JOIN securities s2 ON p2.security_id = s2.id WHERE s2.type NOT IN ('cash','option') AND p2.quantity > 0), 0)
        ) as current_pct,
        printf('%.1f',
          SUM(p.quantity * COALESCE(
            (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1),
            0
          )) * 100.0 /
          NULLIF((SELECT SUM(p2.quantity * COALESCE(
            (SELECT ph2.close_price FROM price_history ph2 WHERE ph2.security_id = p2.security_id ORDER BY ph2.date DESC LIMIT 1),
            0
          )) FROM positions p2 JOIN securities s2 ON p2.security_id = s2.id WHERE s2.type NOT IN ('cash','option') AND p2.quantity > 0), 0)
          - pi.target_allocation_pct
        ) as drift_pct,
        pi.tier
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN position_intents pi ON pi.position_id = p.id
      WHERE s.type NOT IN ('cash','option') AND p.quantity > 0 AND pi.target_allocation_pct IS NOT NULL
      GROUP BY s.symbol
      ORDER BY ABS(
        SUM(p.quantity * COALESCE(
          (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1),
          0
        )) * 100.0 /
        NULLIF((SELECT SUM(p2.quantity * COALESCE(
          (SELECT ph2.close_price FROM price_history ph2 WHERE ph2.security_id = p2.security_id ORDER BY ph2.date DESC LIMIT 1),
          0
        )) FROM positions p2 JOIN securities s2 ON p2.security_id = s2.id WHERE s2.type NOT IN ('cash','option') AND p2.quantity > 0), 0)
        - pi.target_allocation_pct
      ) DESC;
    " | while IFS='|' read -r SYMBOL TARGET CURRENT DRIFT TIER; do
      if [ -z "$SYMBOL" ]; then continue; fi
      # Color drift
      ABS_DRIFT=$(echo "$DRIFT" | tr -d '-')
      if (( $(echo "$ABS_DRIFT > 3" | bc -l 2>/dev/null || echo 0) )); then
        COLOR="\033[31m"  # red
      elif (( $(echo "$ABS_DRIFT > 1" | bc -l 2>/dev/null || echo 0) )); then
        COLOR="\033[33m"  # amber
      else
        COLOR="\033[32m"  # green
      fi
      RESET="\033[0m"
      SIGN=""
      if (( $(echo "$DRIFT > 0" | bc -l 2>/dev/null || echo 0) )); then SIGN="+"; fi
      printf "  %-6s  %5s%% / %5s%%  ${COLOR}%s%s%%${RESET}  (%s)\n" "$SYMBOL" "$CURRENT" "$TARGET" "$SIGN" "$DRIFT" "$TIER"
    done

    # Show positions WITHOUT a target (for awareness)
    NO_TARGET=$(sqlite3 "$DB" "
      SELECT s.symbol FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN position_intents pi ON pi.position_id = p.id
      WHERE s.type NOT IN ('cash','option') AND p.quantity > 0
        AND (pi.target_allocation_pct IS NULL)
      GROUP BY s.symbol ORDER BY s.symbol;
    ")
    if [ -n "$NO_TARGET" ]; then
      echo ""
      echo "No target set: $(echo $NO_TARGET | tr '\n' ' ')"
    fi
    ;;
  ritual-today)
    TODAY=$(date +"%Y-%m-%d")
    RESULT=$(sqlite3 -header -column "$DB" "SELECT * FROM daily_rituals WHERE date = '$TODAY';")
    if [ -z "$RESULT" ]; then
      echo "No ritual started for today ($TODAY)"
    else
      echo "$RESULT"
    fi
    ;;
  ritual-set)
    # Usage: pm-cli.sh ritual-set <field> <value>
    FIELD="$2"; VALUE="$3"
    TODAY=$(date +"%Y-%m-%d")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

    # Validate field name
    case "$FIELD" in
      regime_rewarding|regime_punishing|regime_type|regime_notes|action_chosen|action_detail|journal) ;;
      *) echo "Invalid field: $FIELD"; echo "Valid fields: regime_rewarding, regime_punishing, regime_type, regime_notes, action_chosen, action_detail, journal"; exit 1 ;;
    esac

    # Escape single quotes for SQL
    SAFE_VALUE=$(echo "$VALUE" | sed "s/'/''/g")

    # Upsert: create if not exists, update if exists
    EXISTING=$(sqlite3 "$DB" "SELECT id FROM daily_rituals WHERE date = '$TODAY';")
    if [ -z "$EXISTING" ]; then
      sqlite3 "$DB" "INSERT INTO daily_rituals (id, date, $FIELD, created_at, updated_at) VALUES ('$ID', '$TODAY', '$SAFE_VALUE', '$NOW', '$NOW');"
    else
      sqlite3 "$DB" "UPDATE daily_rituals SET $FIELD = '$SAFE_VALUE', updated_at = '$NOW' WHERE date = '$TODAY';"
    fi
    echo "Set $FIELD = $VALUE for $TODAY"
    ;;
  ritual-history)
    LIMIT="${2:-5}"
    sqlite3 -header -column "$DB" "
      SELECT date, regime_type, action_chosen, journal
      FROM daily_rituals
      ORDER BY date DESC
      LIMIT $LIMIT;
    "
    ;;
  ritual-status)
    TODAY=$(date +"%Y-%m-%d")
    RESULT=$(sqlite3 "$DB" "SELECT regime_type, action_chosen, journal FROM daily_rituals WHERE date = '$TODAY';")
    if [ -z "$RESULT" ]; then
      echo "Ritual not started for today ($TODAY)"
    else
      REGIME=$(sqlite3 "$DB" "SELECT CASE WHEN regime_type IS NOT NULL THEN 'yes' ELSE 'no' END FROM daily_rituals WHERE date = '$TODAY';")
      ACTION=$(sqlite3 "$DB" "SELECT CASE WHEN action_chosen IS NOT NULL THEN 'yes' ELSE 'no' END FROM daily_rituals WHERE date = '$TODAY';")
      JOURNAL=$(sqlite3 "$DB" "SELECT CASE WHEN journal IS NOT NULL THEN 'yes' ELSE 'no' END FROM daily_rituals WHERE date = '$TODAY';")
      echo "Regime set: $REGIME | Action chosen: $ACTION | Journal written: $JOURNAL"
    fi
    ;;
  intent-history)
    POS_ID="${2:-}"
    if [ -n "$POS_ID" ]; then
      sqlite3 -header -column "$DB" "
        SELECT cl.ritual_date, s.symbol, cl.field_changed, cl.old_value, cl.new_value, cl.reason, cl.created_at
        FROM position_intent_change_logs cl
        JOIN positions p ON cl.position_id = p.id
        JOIN securities s ON p.security_id = s.id
        WHERE cl.position_id = '$POS_ID'
        ORDER BY cl.created_at DESC;
      "
    else
      sqlite3 -header -column "$DB" "
        SELECT cl.ritual_date, s.symbol, cl.field_changed, cl.old_value, cl.new_value, cl.reason, cl.created_at
        FROM position_intent_change_logs cl
        JOIN positions p ON cl.position_id = p.id
        JOIN securities s ON p.security_id = s.id
        ORDER BY cl.created_at DESC
        LIMIT 50;
      "
    fi
    ;;
  intent-changes-today)
    TODAY=$(date +"%Y-%m-%d")
    sqlite3 -header -column "$DB" "
      SELECT s.symbol, cl.field_changed, cl.old_value, cl.new_value, cl.reason
      FROM position_intent_change_logs cl
      JOIN positions p ON cl.position_id = p.id
      JOIN securities s ON p.security_id = s.id
      WHERE cl.ritual_date = '$TODAY'
      ORDER BY cl.created_at DESC;
    "
    ;;
  refresh)
    # Refresh prices via Schwab API using tokens from Electron app config
    schwab_ensure_token

    # Get all non-cash symbols from positions + watchlist items
    SYMBOLS=$(sqlite3 "$DB" "
      SELECT DISTINCT symbol FROM (
        SELECT s.symbol FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.type != 'cash' AND s.symbol != ''
        UNION
        SELECT symbol FROM watchlist_items
      )
      ORDER BY symbol;
    ")

    SYMBOL_COUNT=$(echo "$SYMBOLS" | wc -l | tr -d ' ')
    echo "Fetching quotes for $SYMBOL_COUNT symbols..."

    # Build comma-separated symbol list
    SYMBOL_LIST=$(echo "$SYMBOLS" | tr '\n' ',' | sed 's/,$//')

    # Fetch quotes from Schwab
    QUOTE_RESPONSE=$(curl -s "${SCHWAB_API}/marketdata/v1/quotes?symbols=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SYMBOL_LIST'))")" \
      -H "Authorization: ${TOKEN_TYPE} ${ACCESS_TOKEN}")

    # Parse and save to DB
    TODAY=$(date +"%Y-%m-%d")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    python3 -c "
import json, sys, subprocess, uuid

response = json.loads('''$QUOTE_RESPONSE''')
db = '$DB'
today = '$TODAY'
now = '$NOW'

# Build security_id map
import sqlite3
conn = sqlite3.connect(db)
cur = conn.cursor()
sec_map = {}
cur.execute('SELECT id, symbol FROM securities')
for row in cur.fetchall():
    sec_map[row[1]] = row[0]

updated = 0
errors = 0
for sym, entry in response.items():
    q = entry.get('quote', entry)
    price = q.get('lastPrice') or q.get('mark') or 0
    volume = q.get('totalVolume') or 0
    open_price = q.get('openPrice') or 0
    high_price = q.get('highPrice') or 0
    low_price = q.get('lowPrice') or 0
    if price <= 0:
        errors += 1
        continue
    sec_id = sec_map.get(sym)
    if not sec_id:
        continue
    row_id = str(uuid.uuid4())
    cur.execute('''
        INSERT OR REPLACE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at)
        VALUES (
            COALESCE((SELECT id FROM price_history WHERE security_id = ? AND date = ?), ?),
            ?, ?, ?, ?, ?, ?, ?, ?
        )
    ''', (sec_id, today, row_id, sec_id, today, open_price, high_price, low_price, price, volume, now))
    updated += 1

conn.commit()
conn.close()
print(f'Updated {updated} prices, {errors} errors')
" 2>/dev/null

    echo "Done. Run './scripts/pm-cli.sh briefing' to see the briefing."

    # Check monitors against new prices
    TRIGGERED=$(sqlite3 "$DB" "
      SELECT m.id, m.symbol, m.direction, m.price_level, m.label, m.action_type, ph.close_price
      FROM monitors m
      JOIN securities s ON s.symbol = m.symbol
      JOIN price_history ph ON ph.security_id = s.id AND ph.date = '$TODAY'
      WHERE m.status = 'active'
        AND (
          (m.direction = 'below' AND ph.close_price <= m.price_level)
          OR (m.direction = 'above' AND ph.close_price >= m.price_level)
        );
    ")
    if [ -n "$TRIGGERED" ]; then
      NOW_TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
      echo ""
      echo "🚨 === MONITOR ALERTS ==="
      echo "$TRIGGERED" | while IFS='|' read -r mid sym dir level label atype price; do
        sqlite3 "$DB" "UPDATE monitors SET status = 'triggered', triggered_at = '$NOW_TS', updated_at = '$NOW_TS' WHERE id = '$mid';"
        ICON="⬇️"
        [ "$dir" = "above" ] && ICON="⬆️"
        TYPE_TAG=""
        NTFY_PRI="high"
        [ "$atype" = "action_required" ] && TYPE_TAG=" [ACTION REQUIRED]" && NTFY_PRI="urgent"
        echo "  $ICON $sym \$$price crossed $dir \$$level — $label$TYPE_TAG"
        pm_notify "Monitor Triggered" "$sym $dir \$$level — $label$TYPE_TAG" "$NTFY_PRI"
      done
      echo "========================="
    fi

    # Fetch news from FMP
    FMP_KEY=$(get_fmp_key)
    if [ -n "$FMP_KEY" ]; then
      # Create news table if not exists
      sqlite3 "$DB" "
        CREATE TABLE IF NOT EXISTS news (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          title TEXT NOT NULL,
          snippet TEXT,
          source TEXT,
          url TEXT,
          published_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          UNIQUE(symbol, title)
        );
        CREATE INDEX IF NOT EXISTS idx_news_symbol ON news(symbol);
        CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at);
      "

      echo ""
      echo "Fetching news from FMP..."

      # Fetch latest news firehose (10 pages x 50 = ~500 articles covering ~24h)
      # Store all, filter to portfolio symbols when displaying
      TOTAL_NEW=0
      for PAGE in 0 1 2 3 4 5 6 7 8 9; do
        NEW_COUNT=$(curl -s "${FMP_BASE}/news/stock-latest?page=${PAGE}&limit=50&apikey=${FMP_KEY}" 2>/dev/null | python3 -c "
import json, sys, sqlite3, uuid

db = sys.argv[1]
now = sys.argv[2]

try:
    data = json.load(sys.stdin)
except:
    sys.exit(0)

if not isinstance(data, list) or len(data) == 0:
    sys.exit(0)

conn = sqlite3.connect(db)
cur = conn.cursor()
count = 0
for article in data:
    symbol = article.get('symbol', '')
    title = article.get('title', '')
    if not symbol or not title:
        continue
    snippet = (article.get('text', '') or '')[:500] or None
    source = article.get('site', '')
    url = article.get('url', '')
    published = article.get('publishedDate', now)
    row_id = str(uuid.uuid4())
    try:
        cur.execute('''
            INSERT OR IGNORE INTO news (id, symbol, title, snippet, source, url, published_at, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (row_id, symbol, title, snippet, source, url, published, now))
        count += cur.rowcount
    except:
        pass
conn.commit()
conn.close()
print(count)
" "$DB" "$NOW" 2>/dev/null)
        TOTAL_NEW=$((TOTAL_NEW + ${NEW_COUNT:-0}))
      done
      echo "  Stored $TOTAL_NEW new articles"

      # Archive articles older than 30 days to CSV, then remove from DB
      ARCHIVE_DIR="$HOME/Library/Application Support/portfolio-manager/news-archive"
      mkdir -p "$ARCHIVE_DIR"
      ARCHIVE_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM news WHERE published_at < datetime('now', '-30 days');")
      if [ "$ARCHIVE_COUNT" -gt 0 ]; then
        sqlite3 -header -csv "$DB" "SELECT * FROM news WHERE published_at < datetime('now', '-30 days') ORDER BY published_at;" >> "$ARCHIVE_DIR/news-archive.csv"
        sqlite3 "$DB" "DELETE FROM news WHERE published_at < datetime('now', '-30 days');"
        echo "  Archived $ARCHIVE_COUNT old articles to news-archive/"
      fi
    fi
    ;;
  watchlists)
    sqlite3 -header -column "$DB" "
      SELECT w.id, w.name, w.description,
             COUNT(wi.id) as items
      FROM watchlists w
      LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
      GROUP BY w.id
      ORDER BY w.name;
    "
    ;;
  watchlist)
    WL_NAME="$2"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist <name>"
      "$0" watchlists
      exit 0
    fi
    LATEST_DATE=$(sqlite3 "$DB" "SELECT MAX(date) FROM price_history;")
    sqlite3 "$DB" "
      SELECT wi.symbol,
             printf('%.2f', ph.close_price) as price,
             printf('%.2f', COALESCE(wi.target_entry_price, 0)) as target_entry,
             CASE WHEN wi.target_entry_price IS NOT NULL AND ph.close_price IS NOT NULL
               THEN printf('%.1f%%', (ph.close_price - wi.target_entry_price) / wi.target_entry_price * 100)
               ELSE '' END as vs_target,
             wi.thesis_snippet,
             wi.notes
      FROM watchlist_items wi
      JOIN watchlists w ON wi.watchlist_id = w.id
      LEFT JOIN securities s ON wi.security_id = s.id
      LEFT JOIN price_history ph ON ph.security_id = s.id AND ph.date = '$LATEST_DATE'
      WHERE w.name = '$WL_NAME'
      ORDER BY wi.symbol;
    " | python3 -c "
import sys
print(f'=== Watchlist: $WL_NAME ===')
print(f'{\"Symbol\":<8} {\"Price\":>8} {\"Target\":>8} {\"vs Tgt\":>8}  Thesis')
print('-' * 70)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 6: continue
    sym, price, target, vs_tgt, thesis, notes = parts
    price_str = f'\${float(price):>.2f}' if price and float(price) > 0 else '—'
    target_str = f'\${float(target):>.2f}' if target and float(target) > 0 else '—'
    thesis_str = (thesis[:40] + '..') if len(thesis) > 42 else thesis
    print(f'{sym:<8} {price_str:>8} {target_str:>8} {vs_tgt:>8}  {thesis_str}')
" 2>/dev/null
    ;;
  watchlist-add)
    WL_NAME="$2"; SYMBOL="$3"; TARGET="$4"; THESIS="$5"
    if [ -z "$WL_NAME" ] || [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh watchlist-add <watchlist_name> <symbol> [target_entry] [thesis_snippet]"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:lower:]' '[:upper:]' | tr '[:upper:]' '[:lower:]')

    # Get or create watchlist
    WL_ID=$(sqlite3 "$DB" "SELECT id FROM watchlists WHERE name = '$(echo "$WL_NAME" | sed "s/'/''/g")';")
    if [ -z "$WL_ID" ]; then
      WL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
      sqlite3 "$DB" "INSERT INTO watchlists (id, name, created_at, updated_at) VALUES ('$WL_ID', '$(echo "$WL_NAME" | sed "s/'/''/g")', '$NOW', '$NOW');"
      echo "Created watchlist: $WL_NAME"
    fi

    # Ensure security exists
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL';")
    if [ -z "$SEC_ID" ]; then
      SEC_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
      sqlite3 "$DB" "INSERT INTO securities (id, symbol, name, type, currency, created_at) VALUES ('$SEC_ID', '$SYMBOL', '$SYMBOL', 'stock', 'USD', '$NOW');"
    fi

    # Insert item (upsert)
    sqlite3 "$DB" "
      INSERT OR REPLACE INTO watchlist_items (id, watchlist_id, symbol, security_id, target_entry_price, thesis_snippet, created_at, updated_at)
      VALUES (
        COALESCE((SELECT id FROM watchlist_items WHERE watchlist_id = '$WL_ID' AND symbol = '$SYMBOL'), '$ID'),
        '$WL_ID', '$SYMBOL', '$SEC_ID',
        $([ -n "$TARGET" ] && echo "$TARGET" || echo "NULL"),
        $([ -n "$THESIS" ] && echo "'$(echo "$THESIS" | sed "s/'/''/g")'" || echo "NULL"),
        COALESCE((SELECT created_at FROM watchlist_items WHERE watchlist_id = '$WL_ID' AND symbol = '$SYMBOL'), '$NOW'),
        '$NOW'
      );
    "
    echo "Added $SYMBOL to $WL_NAME$([ -n "$TARGET" ] && echo " (target: \$$TARGET)")"
    ;;
  watchlist-rm)
    WL_NAME="$2"; SYMBOL="$3"
    if [ -z "$WL_NAME" ] || [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh watchlist-rm <watchlist_name> <symbol>"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    sqlite3 "$DB" "
      DELETE FROM watchlist_items WHERE symbol = '$SYMBOL'
      AND watchlist_id = (SELECT id FROM watchlists WHERE name = '$(echo "$WL_NAME" | sed "s/'/''/g")');
    "
    echo "Removed $SYMBOL from $WL_NAME"
    ;;
  watchlist-create)
    WL_NAME="$2"; DESC="$3"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist-create <name> [description]"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    sqlite3 "$DB" "INSERT INTO watchlists (id, name, description, created_at, updated_at) VALUES ('$ID', '$(echo "$WL_NAME" | sed "s/'/''/g")', $([ -n "$DESC" ] && echo "'$(echo "$DESC" | sed "s/'/''/g")'" || echo "NULL"), '$NOW', '$NOW');"
    echo "Created watchlist: $WL_NAME"
    ;;
  watchlist-delete)
    WL_NAME="$2"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist-delete <name>"
      exit 1
    fi
    sqlite3 "$DB" "DELETE FROM watchlists WHERE name = '$(echo "$WL_NAME" | sed "s/'/''/g")';"
    echo "Deleted watchlist: $WL_NAME"
    ;;
  monitors)
    echo "=== Active Monitors ==="
    sqlite3 -header -column "$DB" "
      SELECT id, symbol, direction, printf('%.2f', price_level) as price,
             label, action_type, status,
             CASE WHEN triggered_at IS NOT NULL THEN substr(triggered_at, 1, 10) ELSE '' END as triggered
      FROM monitors
      WHERE status IN ('active', 'triggered')
      ORDER BY status DESC, symbol;
    "
    ;;
  monitor-add)
    SYMBOL="$2"; DIRECTION="$3"; PRICE="$4"; LABEL="$5"; ACTION_TYPE="${6:-informational}"
    if [ -z "$SYMBOL" ] || [ -z "$DIRECTION" ] || [ -z "$PRICE" ] || [ -z "$LABEL" ]; then
      echo "Usage: pm-cli.sh monitor-add <symbol> <above|below> <price> <label> [action_required]"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    if [ "$DIRECTION" != "above" ] && [ "$DIRECTION" != "below" ]; then
      echo "Direction must be 'above' or 'below'"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    sqlite3 "$DB" "INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, status, created_at, updated_at) VALUES ('$ID', '$SYMBOL', '$DIRECTION', $PRICE, '$(echo "$LABEL" | sed "s/'/''/g")', '$ACTION_TYPE', 'active', '$NOW', '$NOW');"
    echo "Monitor added: $SYMBOL $DIRECTION \$$PRICE — $LABEL [$ACTION_TYPE]"
    ;;
  monitor-dismiss)
    MON_ID="$2"
    if [ -z "$MON_ID" ]; then
      echo "Usage: pm-cli.sh monitor-dismiss <id>"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    sqlite3 "$DB" "UPDATE monitors SET status = 'dismissed', updated_at = '$NOW' WHERE id = '$MON_ID';"
    echo "Monitor dismissed: $MON_ID"
    ;;
  monitor-rm)
    MON_ID="$2"
    if [ -z "$MON_ID" ]; then
      echo "Usage: pm-cli.sh monitor-rm <id>"
      exit 1
    fi
    sqlite3 "$DB" "DELETE FROM monitors WHERE id = '$MON_ID';"
    echo "Monitor deleted: $MON_ID"
    ;;
  monitor-reset)
    MON_ID="$2"
    if [ -z "$MON_ID" ]; then
      echo "Usage: pm-cli.sh monitor-reset <id>"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    sqlite3 "$DB" "UPDATE monitors SET status = 'active', triggered_at = NULL, updated_at = '$NOW' WHERE id = '$MON_ID';"
    echo "Monitor re-armed: $MON_ID"
    ;;

  monitor-add-note)
    MON_SYMBOL="$2"
    MON_LABEL="$3"
    MON_REMINDER="$4"
    if [ -z "$MON_SYMBOL" ] || [ -z "$MON_LABEL" ]; then
      echo "Usage: pm-cli.sh monitor-add-note <symbol> <label> [reminder_date]"
      echo "  Creates a fundamental/note monitor (no price trigger)"
      echo "  reminder_date: YYYY-MM-DD (default: today)"
      exit 1
    fi
    MON_SYMBOL=$(echo "$MON_SYMBOL" | tr '[:lower:]' '[:upper:]')
    if [ -z "$MON_REMINDER" ]; then
      MON_REMINDER=$(date +%Y-%m-%d)
    fi
    MON_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    sqlite3 "$DB" "INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, monitor_type, status, reminder_date, created_at, updated_at) VALUES ('$MON_ID', '$MON_SYMBOL', 'below', 0, '$MON_LABEL', 'informational', 'fundamental', 'active', '$MON_REMINDER', '$NOW', '$NOW');"
    echo "Fundamental monitor created: $MON_SYMBOL — $MON_LABEL (reminder: $MON_REMINDER)"
    ;;

  earnings)
    # Show upcoming earnings for portfolio symbols
    DAYS="${2:-14}"
    FROM_DATE=$(date +%Y-%m-%d)
    TO_DATE=$(date -v+${DAYS}d +%Y-%m-%d 2>/dev/null || date -d "+${DAYS} days" +%Y-%m-%d 2>/dev/null)

    # Get FMP API key
    if [ -f "$HOME/.pm-cli.conf" ]; then
      FMP_KEY=$(grep '^FMP_API_KEY=' "$HOME/.pm-cli.conf" | cut -d= -f2)
    fi
    if [ -z "$FMP_KEY" ]; then
      echo "ERROR: FMP_API_KEY not set in ~/.pm-cli.conf"
      exit 1
    fi

    # Get portfolio symbols (comma-separated for safe passing)
    SYMBOLS=$(sqlite3 "$DB" "SELECT GROUP_CONCAT(DISTINCT s.symbol) FROM positions p JOIN securities s ON p.security_id = s.id WHERE s.type != 'cash' AND p.quantity > 0;")

    echo "=== Upcoming Earnings (next ${DAYS} days) ==="
    echo ""

    # Fetch earnings calendar from FMP
    python3 <<PYEOF
import urllib.request, json, sys

fmp_key = "$FMP_KEY"
from_date = "$FROM_DATE"
to_date = "$TO_DATE"
symbols_csv = "$SYMBOLS"
portfolio_symbols = set(symbols_csv.split(',')) if symbols_csv else set()

if not portfolio_symbols:
    print("No portfolio positions found.")
    sys.exit(0)

url = f"https://financialmodelingprep.com/stable/earnings-calendar?from={from_date}&to={to_date}&apikey={fmp_key}"
try:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
except Exception as e:
    print(f"Error fetching earnings: {e}")
    sys.exit(1)

# Filter to portfolio symbols
matches = [e for e in data if e.get('symbol', '').upper() in portfolio_symbols]

if not matches:
    print("No upcoming earnings for portfolio symbols.")
    sys.exit(0)

matches.sort(key=lambda x: x.get('date', ''))
print(f"{'Date':<12} {'Symbol':<8} {'Time':<14} {'EPS Est':>10}")
print("-" * 46)
for e in matches:
    date = e.get('date', 'N/A')
    symbol = e.get('symbol', 'N/A')
    time_raw = e.get('time', '')
    if time_raw == 'bmo':
        time_label = 'Before Open'
    elif time_raw == 'amc':
        time_label = 'After Close'
    else:
        time_label = time_raw or 'TBD'
    eps_est = e.get('epsEstimated')
    eps_str = f"  \${eps_est:.2f}" if eps_est is not None else '       N/A'
    print(f"{date:<12} {symbol:<8} {time_label:<14} {eps_str:>10}")
PYEOF
    ;;

  analytics)
    # Portfolio analytics: beta, sharpe, volatility, drawdown
    DAYS="${2:-90}"
    echo "=== Portfolio Analytics (${DAYS}-day) ==="
    echo ""

    python3 <<PYEOF
import sqlite3, math, sys

db = sqlite3.connect("$DB")

# Get daily portfolio totals from snapshots
rows = db.execute("""
    SELECT date, SUM(market_value) as total_mv
    FROM portfolio_snapshots
    GROUP BY date
    ORDER BY date DESC
    LIMIT ?
""", (int("$DAYS") + 1,)).fetchall()

has_snapshots = len(rows) >= 3
if not has_snapshots:
    print("Not enough snapshot data for portfolio-level analytics.")
    print(f"Currently have {len(rows)} data points (need at least 3).")
    print("Run 'pm-cli.sh snapshot' daily to build history.")
    print()

# SPY daily returns (needed for both portfolio and position betas)
spy_sec = db.execute("SELECT id FROM securities WHERE symbol = 'SPY'").fetchone()
if not spy_sec:
    print("SPY not found in securities. Run 'pm-cli.sh backfill SPY' first.")
    sys.exit(1)

spy_rows = db.execute("""
    SELECT date, close_price FROM price_history
    WHERE security_id = ? ORDER BY date DESC LIMIT ?
""", (spy_sec[0], int("$DAYS") + 1)).fetchall()
spy_rows.reverse()
spy_dates = [r[0] for r in spy_rows]
spy_prices = [r[1] for r in spy_rows]

b_returns = []
for i in range(1, len(spy_prices)):
    if spy_prices[i-1] > 0:
        b_returns.append((spy_dates[i], (spy_prices[i] - spy_prices[i-1]) / spy_prices[i-1]))

b_map = {d: r for d, r in b_returns}

# Portfolio-level analytics (requires snapshots)
if has_snapshots:
    rows.reverse()  # oldest first
    dates = [r[0] for r in rows]
    mvs = [r[1] for r in rows]

    p_returns = []
    for i in range(1, len(mvs)):
        if mvs[i-1] > 0:
            p_returns.append((dates[i], (mvs[i] - mvs[i-1]) / mvs[i-1]))

    aligned_p = []
    aligned_b = []
    for d, r in p_returns:
        if d in b_map:
            aligned_p.append(r)
            aligned_b.append(b_map[d])

    n = len(aligned_p)
    if n >= 3:
        mean_p = sum(aligned_p) / n
        mean_b = sum(aligned_b) / n
        cov = sum((aligned_p[i] - mean_p) * (aligned_b[i] - mean_b) for i in range(n))
        var_b = sum((aligned_b[i] - mean_b) ** 2 for i in range(n))
        beta = cov / var_b if var_b > 0 else 1.0

        var_p = sum((r - mean_p) ** 2 for r in aligned_p) / (n - 1)
        volatility = math.sqrt(var_p) * math.sqrt(252)

        total_return = (mvs[-1] - mvs[0]) / mvs[0] if mvs[0] > 0 else 0
        ann_return = (1 + total_return) ** (252 / len(p_returns)) - 1 if len(p_returns) > 0 else 0
        spy_total = (spy_prices[-1] - spy_prices[0]) / spy_prices[0] if spy_prices[0] > 0 else 0

        rfr = 0.05
        sharpe = (ann_return - rfr) / volatility if volatility > 0 else 0

        peak = float('-inf')
        max_dd = 0
        max_dd_date = ''
        for i, mv in enumerate(mvs):
            if mv > peak:
                peak = mv
            dd = (peak - mv) / peak if peak > 0 else 0
            if dd > max_dd:
                max_dd = dd
                max_dd_date = dates[i]

        current_dd = (peak - mvs[-1]) / peak if peak > 0 else 0

        print(f"  Beta (vs SPY):      {beta:>8.2f}")
        print(f"  Sharpe Ratio:       {sharpe:>8.2f}")
        print(f"  Volatility (ann):   {volatility*100:>7.1f}%")
        print(f"  Max Drawdown:       {-max_dd*100:>7.1f}%  ({max_dd_date})")
        print(f"  Current Drawdown:   {-current_dd*100:>7.1f}%")
        print(f"  Total Return:       {total_return*100:>7.1f}%")
        print(f"  Annualized Return:  {ann_return*100:>7.1f}%")
        print(f"  SPY Return:         {spy_total*100:>7.1f}%")
        print(f"  Data Points:        {n:>8d}")
        print()

# Per-position betas (works with just price history, no snapshots needed)
pos_rows = db.execute("""
    SELECT s.symbol,
      SUM(p.quantity * COALESCE(
        (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = s.id ORDER BY ph.date DESC LIMIT 1),
        p.current_price,
        p.cost_basis / NULLIF(p.quantity, 0)
      )) as mv
    FROM positions p JOIN securities s ON p.security_id = s.id
    WHERE p.quantity > 0 AND s.type != 'cash'
    GROUP BY s.symbol ORDER BY mv DESC
""").fetchall()

total_mv = sum(r[1] or 0 for r in pos_rows) if pos_rows else 0

print(f"{'Symbol':<8} {'Beta':>6} {'Corr':>6} {'Weight':>7} {'Wtd Beta':>9}")
print("-" * 38)
total_wtd_beta = 0
for sym, mv_raw in pos_rows:
    mv = mv_raw or 0
    sec = db.execute("SELECT id FROM securities WHERE symbol = ?", (sym,)).fetchone()
    if not sec:
        continue
    prices = db.execute("""
        SELECT date, close_price FROM price_history
        WHERE security_id = ? ORDER BY date DESC LIMIT ?
    """, (sec[0], int("$DAYS") + 1)).fetchall()
    prices.reverse()
    if len(prices) < 10:
        continue
    s_returns = {}
    for i in range(1, len(prices)):
        if prices[i-1][1] > 0:
            s_returns[prices[i][0]] = (prices[i][1] - prices[i-1][1]) / prices[i-1][1]

    al_s = []
    al_b2 = []
    for d in sorted(s_returns.keys()):
        if d in b_map:
            al_s.append(s_returns[d])
            al_b2.append(b_map[d])

    if len(al_s) < 10:
        continue

    nn = len(al_s)
    ms = sum(al_s) / nn
    mb = sum(al_b2) / nn
    cov_s = sum((al_s[i] - ms) * (al_b2[i] - mb) for i in range(nn))
    var_bs = sum((al_b2[i] - mb) ** 2 for i in range(nn))
    pos_beta = cov_s / var_bs if var_bs > 0 else 1.0

    # correlation
    var_ss = sum((al_s[i] - ms) ** 2 for i in range(nn))
    denom = math.sqrt(var_ss * var_bs)
    corr = cov_s / denom if denom > 0 else 0

    weight = mv / total_mv if total_mv > 0 else 0
    wtd = pos_beta * weight
    total_wtd_beta += wtd
    print(f"{sym:<8} {pos_beta:>6.2f} {corr:>6.2f} {weight*100:>6.1f}% {wtd:>9.3f}")

print("-" * 38)
print(f"{'Total':<8} {'':>6} {'':>6} {'100.0':>6}% {total_wtd_beta:>9.3f}")

db.close()
PYEOF
    ;;

  attribution)
    # Brinson-style factor attribution vs QQQ
    DAYS_ARG="${2:-30}"

    python3 <<PYEOF
import sqlite3, math, sys
from datetime import datetime

db = sqlite3.connect("$DB")

days_arg = "$DAYS_ARG"

# Determine number of days
if days_arg.upper() == "YTD":
    # Find latest price date and compute days from Jan 1
    latest = db.execute("SELECT MAX(date) FROM price_history").fetchone()[0]
    if not latest:
        print("No price history found.")
        sys.exit(1)
    latest_dt = datetime.strptime(latest, "%Y-%m-%d")
    jan1 = datetime(latest_dt.year, 1, 1)
    days = (latest_dt - jan1).days
    if days < 2:
        print("Not enough YTD data.")
        sys.exit(1)
else:
    days = int(days_arg)

# Excluded symbols (non-core / non-investing)
EXCLUDED = {'SGOV', 'USO', 'AMD', 'FCNTX', 'SNOW'}

# Starter tier symbols — shown separately, not benchmarked against QQQ
# Core (A) + Growth (B) are the benchmarkable positions
STARTER_SYMBOLS = set()
for row in db.execute("""
    SELECT DISTINCT s.symbol FROM position_intents pi
    JOIN positions p ON pi.position_id = p.id
    JOIN securities s ON p.security_id = s.id
    WHERE pi.tier = 'Starter'
""").fetchall():
    STARTER_SYMBOLS.add(row[0])
# Also treat Exit tier as excluded
for row in db.execute("""
    SELECT DISTINCT s.symbol FROM position_intents pi
    JOIN positions p ON pi.position_id = p.id
    JOIN securities s ON p.security_id = s.id
    WHERE pi.tier = 'Exit'
""").fetchall():
    EXCLUDED.add(row[0])

# Look up QQQ and SPY security IDs
qqq_row = db.execute("SELECT id FROM securities WHERE symbol = 'QQQ'").fetchone()
spy_row = db.execute("SELECT id FROM securities WHERE symbol = 'SPY'").fetchone()
if not qqq_row:
    print("QQQ not found in securities. Run 'pm-cli.sh backfill QQQ' first.")
    sys.exit(1)
if not spy_row:
    print("SPY not found in securities. Run 'pm-cli.sh backfill SPY' first.")
    sys.exit(1)
qqq_id = qqq_row[0]
spy_id = spy_row[0]

# Get benchmark prices
def get_prices(sec_id, n):
    rows = db.execute("""
        SELECT date, close_price FROM price_history
        WHERE security_id = ? ORDER BY date DESC LIMIT ?
    """, (sec_id, n + 1)).fetchall()
    rows.reverse()
    return rows

qqq_prices = get_prices(qqq_id, days)
spy_prices = get_prices(spy_id, days)

if len(qqq_prices) < 3:
    print("Not enough QQQ price history.")
    sys.exit(1)

# Build return maps
def build_return_map(prices):
    rmap = {}
    for i in range(1, len(prices)):
        if prices[i-1][1] > 0:
            rmap[prices[i][0]] = (prices[i][1] - prices[i-1][1]) / prices[i-1][1]
    return rmap

qqq_rmap = build_return_map(qqq_prices)
spy_rmap = build_return_map(spy_prices)

# QQQ total return over period
qqq_total_ret = (qqq_prices[-1][1] - qqq_prices[0][1]) / qqq_prices[0][1] if qqq_prices[0][1] > 0 else 0

# Get positions (exclude non-core)
positions = db.execute("""
    SELECT s.symbol, s.id, s.sector,
           SUM(p.quantity) as total_qty,
           SUM(p.cost_basis) as total_cost
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    WHERE s.type NOT IN ('cash', 'option') AND p.quantity > 0
    GROUP BY s.symbol
""").fetchall()

# Filter excluded and compute market values using latest price
pos_data = []       # Core + Growth (benchmarked vs QQQ)
starter_data = []   # Starter tier (shown separately, not benchmarked)
for sym, sec_id, sector, qty, cost in positions:
    if sym in EXCLUDED or qty <= 0:
        continue
    latest_price = db.execute("""
        SELECT close_price FROM price_history
        WHERE security_id = ? ORDER BY date DESC LIMIT 1
    """, (sec_id,)).fetchone()
    if not latest_price or latest_price[0] <= 0:
        continue
    mv = qty * latest_price[0]
    entry = {
        'symbol': sym, 'sec_id': sec_id, 'sector': sector or 'Other',
        'qty': qty, 'mv': mv
    }
    if sym in STARTER_SYMBOLS:
        starter_data.append(entry)
    else:
        pos_data.append(entry)

total_mv = sum(p['mv'] for p in pos_data)
if total_mv <= 0:
    print("No positions with market value.")
    sys.exit(1)

# Assign weights
for p in pos_data:
    p['weight'] = p['mv'] / total_mv

# Get per-position returns and compute portfolio return
pos_returns = {}  # symbol -> return_map
for p in pos_data:
    prices = get_prices(p['sec_id'], days)
    if len(prices) < 3:
        p['period_return'] = 0
        continue
    p['period_return'] = (prices[-1][1] - prices[0][1]) / prices[0][1] if prices[0][1] > 0 else 0
    pos_returns[p['symbol']] = build_return_map(prices)

# Portfolio weighted return
port_total_ret = sum(p['weight'] * p['period_return'] for p in pos_data)

# Compute beta vs QQQ and SPY using daily returns
# Build portfolio daily returns (weight * stock daily return)
all_dates = sorted(qqq_rmap.keys())

def compute_port_daily_returns(all_dates):
    port_daily = {}
    for d in all_dates:
        daily_r = 0
        for p in pos_data:
            sym = p['symbol']
            if sym in pos_returns and d in pos_returns[sym]:
                daily_r += p['weight'] * pos_returns[sym][d]
        port_daily[d] = daily_r
    return port_daily

port_daily = compute_port_daily_returns(all_dates)

def compute_beta(port_map, bench_map):
    common = sorted(set(port_map.keys()) & set(bench_map.keys()))
    if len(common) < 10:
        return 1.0
    p_vals = [port_map[d] for d in common]
    b_vals = [bench_map[d] for d in common]
    n = len(p_vals)
    mp = sum(p_vals) / n
    mb = sum(b_vals) / n
    cov = sum((p_vals[i] - mp) * (b_vals[i] - mb) for i in range(n))
    var_b = sum((b_vals[i] - mb) ** 2 for i in range(n))
    return cov / var_b if var_b > 0 else 1.0

beta_qqq = compute_beta(port_daily, qqq_rmap)
beta_spy = compute_beta(port_daily, spy_rmap)

# Per-position beta vs QQQ
for p in pos_data:
    sym = p['symbol']
    if sym in pos_returns:
        p['beta_qqq'] = compute_beta(pos_returns[sym], qqq_rmap)
    else:
        p['beta_qqq'] = 1.0

# Tracking error decomposition
gap = port_total_ret - qqq_total_ret

# Beta effect: (portfolio_beta - 1) * benchmark_return
beta_effect = (beta_qqq - 1) * qqq_total_ret

# Sector allocation
# QQQ approximate sector weights
qqq_sectors = {
    'Technology': 0.50,
    'Communication Services': 0.16,
    'Consumer Cyclical': 0.14,
    'Healthcare': 0.05,
    'Consumer Defensive': 0.04,
    'Industrials': 0.04,
    'Financial Services': 0.01,
}
qqq_other_weight = 1.0 - sum(qqq_sectors.values())  # ~0.06

# Portfolio sector weights
port_sectors = {}
for p in pos_data:
    s = p['sector']
    port_sectors[s] = port_sectors.get(s, 0) + p['weight']

# Compute sector returns from portfolio positions (weighted avg within sector)
sector_returns = {}
for p in pos_data:
    s = p['sector']
    if s not in sector_returns:
        sector_returns[s] = 0
    # Weight within sector
    sec_w = p['weight'] / port_sectors[s] if port_sectors[s] > 0 else 0
    sector_returns[s] += sec_w * p['period_return']

# All sector names from both
all_sectors = sorted(set(list(qqq_sectors.keys()) + list(port_sectors.keys())))

# Group unknowns into Other
def normalize_sector(s):
    if s in qqq_sectors:
        return s
    return 'Other'

# Re-aggregate with normalization
port_sectors_norm = {}
sector_returns_norm = {}
for p in pos_data:
    ns = normalize_sector(p['sector'])
    port_sectors_norm[ns] = port_sectors_norm.get(ns, 0) + p['weight']

for ns in port_sectors_norm:
    total_w = 0
    weighted_ret = 0
    for p in pos_data:
        pns = normalize_sector(p['sector'])
        if pns == ns:
            weighted_ret += p['weight'] * p['period_return']
            total_w += p['weight']
    sector_returns_norm[ns] = weighted_ret / total_w if total_w > 0 else 0

# Compute sector allocation effect
sector_allocation_details = []
total_sector_alloc = 0
display_sectors = sorted(set(list(qqq_sectors.keys()) + list(port_sectors_norm.keys())))

for s in display_sectors:
    pw = port_sectors_norm.get(s, 0)
    bw = qqq_sectors.get(s, 0)
    if s == 'Other':
        bw = qqq_other_weight
    sr = sector_returns_norm.get(s, 0)
    # Brinson allocation effect: (pw - bw) * (sr - qqq_total_ret)
    alloc_eff = (pw - bw) * (sr - qqq_total_ret)
    total_sector_alloc += alloc_eff
    if abs(pw) > 0.001 or abs(bw) > 0.001:
        sector_allocation_details.append((s, pw, bw, alloc_eff))

# Stock selection = residual
stock_selection = gap - beta_effect - total_sector_alloc

# Short sector names for display
short_names = {
    'Technology': 'Technology',
    'Communication Services': 'Comm Svcs',
    'Consumer Cyclical': 'Cons Cyclical',
    'Healthcare': 'Healthcare',
    'Consumer Defensive': 'Cons Defensive',
    'Industrials': 'Industrials',
    'Financial Services': 'Financials',
    'Other': 'Other',
}

# Print output
period_label = "YTD" if days_arg.upper() == "YTD" else f"{days}-day"
W = 55
print()
print("=" * W)
title = f"  FACTOR ATTRIBUTION vs QQQ — {period_label} (Core + Growth only)"
print(title)
print("=" * W)
print()
print(f"  Portfolio: {port_total_ret*100:>7.2f}%    QQQ: {qqq_total_ret*100:>7.2f}%    Gap: {gap*100:>7.2f}%")
print(f"  Beta vs QQQ: {beta_qqq:.2f}     Beta vs SPY: {beta_spy:.2f}")
print()
print("=" * W)
print("  DECOMPOSITION")
print("=" * W)
print()
print(f"  Beta effect:            {beta_effect*100:>7.2f}%")
print(f"  Sector allocation:      {total_sector_alloc*100:>7.2f}%")

# Sort sectors by absolute allocation effect descending
sector_allocation_details.sort(key=lambda x: -abs(x[3]))
for s, pw, bw, eff in sector_allocation_details:
    sn = short_names.get(s, s[:14])
    diff = pw - bw
    diff_sign = f"{diff*100:>+.0f}%" if abs(diff) > 0.005 else " 0%"
    print(f"    {sn:<15} {pw*100:>3.0f}% vs {bw*100:>2.0f}%  ({diff_sign:>5})  →  {eff*100:>+.2f}%")

print(f"  Stock selection:        {stock_selection*100:>7.2f}%")
print(f"  {'─' * 39}")
print(f"  Total tracking error:   {gap*100:>7.2f}%")
print()

# Per-position attribution
print("=" * W)
print("  PER-POSITION ATTRIBUTION")
print("=" * W)
print()
print(f"  {'Symbol':<7} {'Weight':>6}  {'Return':>7}  {'vs QQQ':>7}  {'Beta':>5}  {'Contrib':>8}")

# Sort by contribution (weight * excess return) ascending (worst first)
for p in pos_data:
    p['vs_qqq'] = p['period_return'] - qqq_total_ret
    p['contribution'] = p['weight'] * p['vs_qqq']

pos_sorted = sorted(pos_data, key=lambda x: x['contribution'])

for p in pos_sorted:
    ret_str = f"{p['period_return']*100:>+.1f}%"
    vs_str = f"{p['vs_qqq']*100:>+.1f}%"
    contrib_str = f"{p['contribution']*100:>+.2f}%"
    print(f"  {p['symbol']:<7} {p['weight']*100:>5.1f}%  {ret_str:>7}  {vs_str:>7}  {p['beta_qqq']:>5.2f}  {contrib_str:>8}")

print()

# High-beta names
high_beta = [p for p in pos_data if p['beta_qqq'] > 1.5]
if high_beta:
    print("=" * W)
    print("  HIGH-BETA NAMES (β > 1.5 vs QQQ)")
    print("=" * W)
    print()
    high_beta.sort(key=lambda x: -x['beta_qqq'])
    parts = [f"  {p['symbol']} β={p['beta_qqq']:.2f}" for p in high_beta]
    print("  ".join(parts))
    print()

# Starter positions (not benchmarked — conviction experiments)
if starter_data:
    # Compute returns for starters
    for p in starter_data:
        prices = get_prices(p['sec_id'], days)
        if len(prices) < 3:
            p['period_return'] = 0
            continue
        p['period_return'] = (prices[-1][1] - prices[0][1]) / prices[0][1] if prices[0][1] > 0 else 0

    starter_mv = sum(p['mv'] for p in starter_data)
    starter_ret = sum(p['mv'] * p['period_return'] for p in starter_data) / starter_mv if starter_mv > 0 else 0

    print("=" * W)
    print("  STARTER POSITIONS (not benchmarked)")
    print("=" * W)
    print()
    all_eq_mv = total_mv + starter_mv
    ds = chr(36)  # dollar sign (avoid bash interpolation)
    print(f"  Starter MV: {ds}{starter_mv:>10,.0f}  ({starter_mv/all_eq_mv*100:.0f}% of equity)")
    print(f"  Core+Growth MV: {ds}{total_mv:>7,.0f}  ({total_mv/all_eq_mv*100:.0f}% of equity)")
    print(f"  Starter return: {starter_ret*100:>+.2f}%")
    print()
    print(f"  {'Symbol':<7} {'MV':>10}  {'Return':>7}")
    starter_data.sort(key=lambda x: x['period_return'])
    for p in starter_data:
        print(f"  {p['symbol']:<7} {ds}{p['mv']:>9,.0f}  {p['period_return']*100:>+.1f}%")
    print()

db.close()
PYEOF
    ;;

  correlations)
    # Correlation matrix and concentration analysis
    DAYS="${2:-365}"
    echo "=== Correlation & Concentration Analysis (${DAYS}-day) ==="
    echo ""

    python3 <<PYEOF
import sqlite3, math

db = sqlite3.connect("$DB")
days = int("$DAYS")

# Get position symbols with weights (aggregate across accounts)
positions = db.execute("""
    SELECT s.symbol, s.id, SUM(p.quantity) * COALESCE(
      (SELECT close_price FROM price_history WHERE security_id = s.id ORDER BY date DESC LIMIT 1), 0
    ) as mv
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    WHERE s.type NOT IN ('cash', 'option') AND p.quantity > 0
    GROUP BY s.symbol
""").fetchall()

total_mv = sum(r[2] for r in positions if r[2] > 0)
if total_mv == 0:
    print("No positions with market value found.")
    db.close()
    exit(0)

# Build returns for each symbol
sym_returns = {}
symbols = []
for sym, sec_id, mv in positions:
    if mv <= 0:
        continue
    prices = db.execute("""
        SELECT date, close_price FROM price_history
        WHERE security_id = ? ORDER BY date DESC LIMIT ?
    """, (sec_id, days + 1)).fetchall()
    prices.reverse()
    if len(prices) < 10:
        continue
    rets = {}
    for i in range(1, len(prices)):
        if prices[i-1][1] > 0:
            rets[prices[i][0]] = (prices[i][1] - prices[i-1][1]) / prices[i-1][1]
    if len(rets) < 10:
        continue
    sym_returns[sym] = rets
    symbols.append(sym)

# --- Concentration ---
print("--- Concentration ---")
weights = []
for sym, _, mv in positions:
    if mv > 0:
        weights.append((sym, mv / total_mv))
weights.sort(key=lambda x: -x[1])

top5 = sum(w for _, w in weights[:5]) * 100
hhi = sum((w * 100) ** 2 for _, w in weights)
eff = 10000 / hhi if hhi > 0 else 0

print(f"  Top 5 weight:         {top5:.1f}%")
print(f"  HHI:                  {hhi:.0f} ({'concentrated' if hhi > 1500 else 'moderate' if hhi > 1000 else 'diversified'})")
print(f"  Effective positions:  {eff:.1f}")
print()

# Sector concentration
sectors = db.execute("""
    SELECT s.sector, SUM(p.quantity * COALESCE(
      (SELECT close_price FROM price_history WHERE security_id = s.id ORDER BY date DESC LIMIT 1), 0
    )) as mv
    FROM positions p JOIN securities s ON p.security_id = s.id
    WHERE s.type NOT IN ('cash', 'option') AND p.quantity > 0
    GROUP BY s.sector ORDER BY mv DESC
""").fetchall()

if sectors:
    print("  Sector breakdown:")
    for sector, smv in sectors:
        pct = (smv / total_mv * 100) if total_mv > 0 else 0
        bar = "#" * int(pct / 2)
        print(f"    {(sector or 'Unknown'):<20} {pct:>5.1f}%  {bar}")
    print()

# --- High Correlations ---
print(f"--- High Correlations (|r| >= 0.7, {days}d) ---")

def correlate(a_dict, b_dict):
    common = sorted(set(a_dict.keys()) & set(b_dict.keys()))
    if len(common) < 10:
        return None
    a = [a_dict[d] for d in common]
    b = [b_dict[d] for d in common]
    n = len(a)
    ma = sum(a) / n
    mb = sum(b) / n
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    va = sum((a[i] - ma) ** 2 for i in range(n))
    vb = sum((b[i] - mb) ** 2 for i in range(n))
    denom = math.sqrt(va * vb)
    return cov / denom if denom > 0 else 0

pairs = []
for i in range(len(symbols)):
    for j in range(i + 1, len(symbols)):
        c = correlate(sym_returns[symbols[i]], sym_returns[symbols[j]])
        if c is not None and abs(c) >= 0.7:
            pairs.append((symbols[i], symbols[j], c))

pairs.sort(key=lambda x: -abs(x[2]))

if pairs:
    for a, b, c in pairs:
        level = "!!!" if abs(c) >= 0.9 else "! " if abs(c) >= 0.8 else "  "
        print(f"  {level} {a:<6} / {b:<6}  r = {c:+.2f}")
else:
    print("  No highly correlated pairs found.")

print()
db.close()
PYEOF
    ;;

  backfill)
    # Backfill 3yr daily price history from Schwab API
    # Usage: pm-cli.sh backfill [symbol]
    schwab_ensure_token

    # Get symbols to backfill
    if [ -n "$2" ]; then
      SYMBOLS=$(echo "$2" | tr '[:lower:]' '[:upper:]')
    else
      SYMBOLS=$(sqlite3 "$DB" "
        SELECT DISTINCT symbol FROM (
          SELECT s.symbol FROM positions p JOIN securities s ON p.security_id = s.id
          WHERE s.type != 'cash' AND s.symbol != ''
          UNION
          SELECT symbol FROM watchlist_items
        ) ORDER BY symbol;
      ")
    fi

    SYMBOL_COUNT=$(echo "$SYMBOLS" | wc -l | tr -d ' ')
    echo "Backfilling 3yr price history for $SYMBOL_COUNT symbol(s)..."

    NOW_TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    for SYM in $SYMBOLS; do
      HIST_RESPONSE=$(curl -s "${SCHWAB_API}/marketdata/v1/pricehistory?symbol=${SYM}&periodType=year&period=3&frequencyType=daily" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}")

      CANDLE_COUNT=$(python3 -c "
import json, sys, sqlite3, uuid
from datetime import datetime, timezone

response = json.loads('''${HIST_RESPONSE}''')
candles = response.get('candles', [])
db = '$DB'
now = '$NOW_TS'

conn = sqlite3.connect(db)
cur = conn.cursor()

# Look up security_id
cur.execute('SELECT id FROM securities WHERE symbol = ?', ('${SYM}',))
row = cur.fetchone()
if not row:
    print('0 (security not found)')
    conn.close()
    sys.exit(0)
sec_id = row[0]

count = 0
for c in candles:
    epoch_ms = c.get('datetime', 0)
    date_str = datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
    open_p = c.get('open', 0)
    high_p = c.get('high', 0)
    low_p = c.get('low', 0)
    close_p = c.get('close', 0)
    vol = c.get('volume', 0)
    row_id = str(uuid.uuid4())
    cur.execute('''
        INSERT OR IGNORE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (row_id, sec_id, date_str, open_p, high_p, low_p, close_p, vol, now))
    count += cur.rowcount

conn.commit()
conn.close()
print(f'{len(candles)} candles ({count} new)')
" 2>/dev/null)

      echo "  Backfilling ${SYM}... ${CANDLE_COUNT}"
      sleep 0.5
    done

    echo "Backfill complete."
    ;;
  snapshot)
    # Take end-of-day portfolio snapshot — one per day, aggregated by symbol
    TODAY=$(date +"%Y-%m-%d")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Create table if not exists
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL,
        cost_basis REAL NOT NULL,
        close_price REAL NOT NULL,
        market_value REAL NOT NULL,
        unrealized_gain REAL NOT NULL,
        day_change REAL,
        day_pnl REAL,
        created_at TEXT NOT NULL,
        UNIQUE(date, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_date ON portfolio_snapshots(date);
      CREATE INDEX IF NOT EXISTS idx_snapshots_symbol ON portfolio_snapshots(symbol);
    "

    # Check if snapshot already exists for today
    EXISTING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM portfolio_snapshots WHERE date = '$TODAY';")
    if [ "$EXISTING" -gt 0 ]; then
      echo "Snapshot already exists for $TODAY ($EXISTING rows). Skipping."
      exit 0
    fi

    python3 -c "
import sqlite3, uuid, sys

db = '$DB'
today = '$TODAY'
now = '$NOW'

conn = sqlite3.connect(db)
cur = conn.cursor()

# Get all positions aggregated by symbol, with latest close price
cur.execute('''
    SELECT s.symbol, s.type,
           SUM(p.quantity) as total_qty,
           SUM(p.cost_basis) as total_cost
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    GROUP BY s.symbol, s.type
    HAVING total_qty != 0
''')
positions = cur.fetchall()

count = 0
for symbol, sec_type, qty, cost_basis in positions:
    if sec_type == 'cash':
        close_price = 1.0
        market_value = qty
        unrealized_gain = 0.0
        day_change = None
        day_pnl = None
    else:
        # Get today's close price
        cur.execute('''
            SELECT close_price FROM price_history ph
            JOIN securities s ON ph.security_id = s.id
            WHERE s.symbol = ? AND ph.date = (
                SELECT MAX(date) FROM price_history ph2
                JOIN securities s2 ON ph2.security_id = s2.id
                WHERE s2.symbol = ?
            )
        ''', (symbol, symbol))
        row = cur.fetchone()
        if not row:
            print(f'  WARNING: No price data for {symbol}, skipping')
            continue
        close_price = row[0]
        market_value = qty * close_price
        unrealized_gain = market_value - cost_basis

        # Get previous day's close for day change
        cur.execute('''
            SELECT close_price FROM price_history ph
            JOIN securities s ON ph.security_id = s.id
            WHERE s.symbol = ? AND ph.date = (
                SELECT MAX(date) FROM price_history ph2
                JOIN securities s2 ON ph2.security_id = s2.id
                WHERE s2.symbol = ? AND ph2.date < (
                    SELECT MAX(date) FROM price_history ph3
                    JOIN securities s3 ON ph3.security_id = s3.id
                    WHERE s3.symbol = ?
                )
            )
        ''', (symbol, symbol, symbol))
        prev_row = cur.fetchone()
        if prev_row:
            prev_close = prev_row[0]
            day_change = close_price - prev_close
            day_pnl = day_change * qty
        else:
            day_change = None
            day_pnl = None

    row_id = str(uuid.uuid4())
    cur.execute('''
        INSERT INTO portfolio_snapshots (id, date, symbol, quantity, cost_basis, close_price, market_value, unrealized_gain, day_change, day_pnl, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (row_id, today, symbol, qty, cost_basis, close_price, market_value, unrealized_gain, day_change, day_pnl, now))
    count += 1

conn.commit()
conn.close()
print(f'Snapshot taken for {today}: {count} positions')
# Recalculate from DB to get accurate totals
conn2 = sqlite3.connect(db)
c2 = conn2.cursor()
c2.execute('SELECT SUM(market_value), SUM(unrealized_gain), SUM(COALESCE(day_pnl, 0)) FROM portfolio_snapshots WHERE date = ?', (today,))
row = c2.fetchone()
if row and row[0]:
    print(f'  Total MV: \${row[0]:,.0f}  |  Unrealized P&L: \${row[1]:>+,.0f}  |  Day P&L: \${row[2]:>+,.0f}')
conn2.close()
" 2>/dev/null
    ;;

  snapshot-history)
    # Show portfolio totals for last N days
    DAYS="${2:-30}"

    # Create table if not exists (in case it hasn't been created yet)
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, symbol TEXT NOT NULL,
      quantity REAL NOT NULL, cost_basis REAL NOT NULL, close_price REAL NOT NULL,
      market_value REAL NOT NULL, unrealized_gain REAL NOT NULL,
      day_change REAL, day_pnl REAL, created_at TEXT NOT NULL, UNIQUE(date, symbol)
    );"

    echo "=== Portfolio Snapshot History (last $DAYS days) ==="
    sqlite3 "$DB" "
      SELECT date,
             printf('%.0f', SUM(market_value)) as total_mv,
             printf('%.0f', SUM(cost_basis)) as total_cost,
             printf('%.0f', SUM(unrealized_gain)) as total_pnl,
             printf('%.0f', SUM(COALESCE(day_pnl, 0))) as day_pnl,
             COUNT(*) as positions
      FROM portfolio_snapshots
      GROUP BY date
      ORDER BY date DESC
      LIMIT $DAYS;
    " | python3 -c "
import sys
print(f'{\"Date\":<12} {\"Total MV\":>12} {\"Cost Basis\":>12} {\"Unreal P&L\":>12} {\"Day P&L\":>10} {\"Pos\":>4}')
print('-' * 66)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 6: continue
    date, mv, cost, pnl, dpnl, pos = parts
    mv_f, cost_f, pnl_f, dpnl_f = float(mv), float(cost), float(pnl), float(dpnl)
    pnl_arrow = '+' if pnl_f >= 0 else ''
    dpnl_arrow = '+' if dpnl_f >= 0 else ''
    print(f'{date:<12} \${mv_f:>11,.0f} \${cost_f:>11,.0f} {pnl_arrow}\${pnl_f:>10,.0f} {dpnl_arrow}\${dpnl_f:>8,.0f} {pos:>4}')
" 2>/dev/null
    ;;

  snapshot-position)
    # Show one position's history over time
    SYMBOL="$2"; DAYS="${3:-30}"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh snapshot-position <symbol> [days]"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Create table if not exists
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, symbol TEXT NOT NULL,
      quantity REAL NOT NULL, cost_basis REAL NOT NULL, close_price REAL NOT NULL,
      market_value REAL NOT NULL, unrealized_gain REAL NOT NULL,
      day_change REAL, day_pnl REAL, created_at TEXT NOT NULL, UNIQUE(date, symbol)
    );"

    echo "=== $SYMBOL Snapshot History (last $DAYS days) ==="
    sqlite3 "$DB" "
      SELECT date,
             printf('%.2f', close_price) as price,
             printf('%.2f', quantity) as qty,
             printf('%.0f', market_value) as mv,
             printf('%.0f', cost_basis) as cost,
             printf('%.0f', unrealized_gain) as pnl,
             printf('%.2f', CASE WHEN cost_basis > 0 THEN unrealized_gain / cost_basis * 100 ELSE 0 END) as pnl_pct,
             printf('%.2f', COALESCE(day_change, 0)) as day_chg
      FROM portfolio_snapshots
      WHERE symbol = '$SYMBOL'
      ORDER BY date DESC
      LIMIT $DAYS;
    " | python3 -c "
import sys
print(f'{\"Date\":<12} {\"Price\":>10} {\"Qty\":>10} {\"MV\":>10} {\"Cost\":>10} {\"P&L\":>10} {\"P&L%\":>8} {\"Day Chg\":>8}')
print('-' * 82)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 8: continue
    date, price, qty, mv, cost, pnl, pnl_pct, day_chg = parts
    pnl_f = float(pnl)
    pnl_arrow = '+' if pnl_f >= 0 else ''
    day_f = float(day_chg)
    day_arrow = '+' if day_f >= 0 else ''
    print(f'{date:<12} \${float(price):>9,.2f} {float(qty):>10,.2f} \${float(mv):>9,.0f} \${float(cost):>9,.0f} {pnl_arrow}\${pnl_f:>8,.0f} {pnl_arrow}{float(pnl_pct):>6.1f}% {day_arrow}\${day_f:>.2f}')
" 2>/dev/null
    ;;

  news)
    # Show recent news, optionally filtered by symbol
    SYMBOL="$2"

    # Create table if not exists
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, title TEXT NOT NULL,
      snippet TEXT, source TEXT, url TEXT, published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL, UNIQUE(symbol, title)
    );"

    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      echo "=== News: $SYMBOL (last 7 days) ==="
      sqlite3 "$DB" "
        SELECT published_at, title, source, url
        FROM news
        WHERE symbol = '$SYMBOL'
          AND published_at >= datetime('now', '-7 days')
        ORDER BY published_at DESC
        LIMIT 20;
      " | python3 -c "
import sys
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 4: continue
    pub, title, source, url = parts[0], parts[1], parts[2], parts[3]
    time_str = pub[5:16] if len(pub) > 16 else pub
    print(f'  {time_str}  [{source}] {title}')
    print(f'             {url}')
" 2>/dev/null
    else
      echo "=== Portfolio News (last 24h) ==="
      sqlite3 "$DB" "
        SELECT symbol, published_at, title, source, url
        FROM news
        WHERE published_at >= datetime('now', '-1 day')
        ORDER BY symbol, published_at DESC;
      " | python3 -c "
import sys
from collections import defaultdict
by_symbol = defaultdict(list)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 5: continue
    sym, pub, title, source, url = parts[0], parts[1], parts[2], parts[3], parts[4]
    by_symbol[sym].append((pub, title, source, url))

if not by_symbol:
    print('  No news in the last 24 hours.')
else:
    for sym in sorted(by_symbol):
        print(f'  --- {sym} ---')
        for pub, title, source, url in by_symbol[sym]:
            time_str = pub[11:16] if len(pub) > 16 else pub
            print(f'    {time_str} [{source}] {title}')
        print()
" 2>/dev/null
    fi
    ;;

  technicals)
    # Show technical indicators for portfolio symbols via FMP API
    FMP_KEY=$(get_fmp_key)
    if [ -z "$FMP_KEY" ]; then
      echo "ERROR: FMP API key not configured in ~/.pm-cli.conf"
      exit 1
    fi

    SYMBOL="$2"
    if [ -n "$SYMBOL" ]; then
      # Single symbol detail view
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      echo "=== Technical Indicators: $SYMBOL ==="
      python3 - "$SYMBOL" "$FMP_KEY" <<'PYEOF'
import json, urllib.request, sys

symbol = sys.argv[1]
key = sys.argv[2]
base = 'https://financialmodelingprep.com/stable/technical-indicators'

def fetch(indicator, period):
    url = f'{base}/{indicator}?symbol={symbol}&periodLength={period}&timeframe=1day&apikey={key}'
    try:
        data = json.loads(urllib.request.urlopen(url).read())
        return data[0] if data else None
    except:
        return None

sma20 = fetch('sma', 20)
sma50 = fetch('sma', 50)
sma200 = fetch('sma', 200)
rsi = fetch('rsi', 14)

if not sma20:
    print(f'  No data available for {symbol}')
    sys.exit(0)

price = sma20.get('close', 0)
s20 = sma20.get('sma', 0)
s50 = sma50.get('sma', 0) if sma50 else 0
s200 = sma200.get('sma', 0) if sma200 else 0
rsi_val = rsi.get('rsi', 0) if rsi else 0

print(f'  Price:    ${price:,.2f}')
print(f'  20 DMA:   ${s20:,.2f}  ({"above" if price >= s20 else "BELOW"})')
print(f'  50 DMA:   ${s50:,.2f}  ({"above" if price >= s50 else "BELOW"})')
print(f'  200 DMA:  ${s200:,.2f}  ({"above" if price >= s200 else "BELOW"})')
rsi_label = ''
if rsi_val >= 70: rsi_label = '  ⚠️  OVERBOUGHT'
elif rsi_val <= 30: rsi_label = '  ⚠️  OVERSOLD'
elif rsi_val >= 60: rsi_label = '  (approaching overbought)'
elif rsi_val <= 40: rsi_label = '  (approaching oversold)'
else: rsi_label = '  (neutral)'
print(f'  RSI(14):  {rsi_val:.1f}{rsi_label}')

above_count = sum(1 for s in [s20, s50, s200] if price >= s)
if above_count == 3: print(f'  Trend:    Strong uptrend (above all DMAs)')
elif above_count == 0: print(f'  Trend:    Strong downtrend (below all DMAs)')
elif price >= s200: print(f'  Trend:    Pullback in uptrend')
else: print(f'  Trend:    Weakening / breakdown')
PYEOF
    else
      # All portfolio symbols table
      echo "=== Portfolio Technical Indicators ==="
      SYMBOLS=$(sqlite3 "$DB" "
        SELECT DISTINCT s.symbol FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.type != 'cash' AND s.symbol != ''
        ORDER BY s.symbol;
      ")
      python3 - "$FMP_KEY" "$SYMBOLS" <<'PYEOF'
import json, urllib.request, sys

key = sys.argv[1]
symbols = [s.strip() for s in sys.argv[2].strip().split('\n') if s.strip()]
base = 'https://financialmodelingprep.com/stable/technical-indicators'

def fetch(indicator, symbol, period):
    url = f'{base}/{indicator}?symbol={symbol}&periodLength={period}&timeframe=1day&apikey={key}'
    try:
        data = json.loads(urllib.request.urlopen(url).read())
        return data[0] if data else None
    except:
        return None

print(f'{"Symbol":<8} {"Price":>8} {"20 DMA":>8} {"50 DMA":>8} {"200 DMA":>9} {"RSI":>6}  Signal')
print('-' * 72)

for symbol in symbols:
    sma20 = fetch('sma', symbol, 20)
    sma50 = fetch('sma', symbol, 50)
    sma200 = fetch('sma', symbol, 200)
    rsi = fetch('rsi', symbol, 14)

    if not sma20:
        print(f'{symbol:<8} No data')
        continue

    price = sma20.get('close', 0)
    s20 = sma20.get('sma', 0)
    s50 = sma50.get('sma', 0) if sma50 else 0
    s200 = sma200.get('sma', 0) if sma200 else 0
    rsi_val = rsi.get('rsi', 0) if rsi else 0

    signals = []
    if price < s50: signals.append('< 50DMA')
    if price < s200: signals.append('< 200DMA')
    if rsi_val >= 70: signals.append('OB')
    elif rsi_val <= 30: signals.append('OS')
    signal_str = ', '.join(signals) if signals else ''

    print(f'{symbol:<8} ${price:>7,.2f} ${s20:>7,.2f} ${s50:>7,.2f} ${s200:>8,.2f} {rsi_val:>5.1f}  {signal_str}')
PYEOF
    fi
    ;;

  sectors)
    # Show sector performance heatmap via FMP API
    FMP_KEY=$(get_fmp_key)
    if [ -z "$FMP_KEY" ]; then
      echo "ERROR: FMP API key not configured in ~/.pm-cli.conf"
      exit 1
    fi

    DATE="${2:-$(date +%Y-%m-%d)}"
    echo "=== Sector Performance: $DATE ==="

    python3 - "$FMP_KEY" "$DATE" <<'PYEOF'
import json, urllib.request, sys

key, date = sys.argv[1], sys.argv[2]

from datetime import datetime, timedelta

def fetch_sectors(date_str, api_key):
    """Fetch both NYSE and NASDAQ sector data for a given date."""
    all_data = []
    for exchange in ['NYSE', 'NASDAQ']:
        url = f'https://financialmodelingprep.com/stable/sector-performance-snapshot?date={date_str}&exchange={exchange}&apikey={api_key}'
        try:
            result = json.loads(urllib.request.urlopen(url).read())
            if isinstance(result, list):
                all_data.extend(result)
        except:
            pass
    return all_data

data = fetch_sectors(date, key)

if not data:
    # Try previous trading days
    dt = datetime.strptime(date, '%Y-%m-%d')
    for i in range(1, 4):
        prev = (dt - timedelta(days=i)).strftime('%Y-%m-%d')
        data = fetch_sectors(prev, key)
        if data:
            print(f'  (Using {prev} — today not yet available)')
            break

if not data:
    print("  No sector data available")
    sys.exit(0)

# Aggregate across exchanges (NYSE + NASDAQ)
sectors = {}
for row in data:
    sector = row['sector']
    chg = row['averageChange']
    if sector not in sectors:
        sectors[sector] = []
    sectors[sector].append(chg)

# Average across exchanges
sector_avg = {s: sum(v)/len(v) for s, v in sectors.items()}

# Sort by performance (best to worst)
ranked = sorted(sector_avg.items(), key=lambda x: -x[1])

print(f'  {"Sector":<25} {"Change":>8}')
print(f'  {"-"*25} {"-"*8}')
for sector, chg in ranked:
    bar = '█' * int(abs(chg) * 2)
    if chg >= 0:
        print(f'  {sector:<25} {chg:>+7.2f}%  \033[32m{bar}\033[0m')
    else:
        print(f'  {sector:<25} {chg:>+7.2f}%  \033[31m{bar}\033[0m')

print()
top = ranked[:3]
bottom = ranked[-3:]
print(f'  Rewarded: {", ".join(s for s,_ in top)}')
print(f'  Punished: {", ".join(s for s,_ in bottom)}')
PYEOF
    ;;

  levels-refresh)
    # Recompute support/resistance levels from price_history swing highs/lows
    SYMBOL="$2"
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Create table if not exists
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS price_levels (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        level_type TEXT NOT NULL,
        price REAL NOT NULL,
        strength INTEGER DEFAULT 1,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(symbol, level_type, price)
      );
      CREATE INDEX IF NOT EXISTS idx_price_levels_symbol ON price_levels(symbol);
    "

    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      SYMBOLS="$SYMBOL"
    else
      SYMBOLS=$(sqlite3 "$DB" "
        SELECT DISTINCT symbol FROM (
          SELECT s.symbol FROM positions p
          JOIN securities s ON p.security_id = s.id
          WHERE s.type != 'cash' AND s.symbol != ''
          UNION
          SELECT wi.symbol FROM watchlist_items wi
          WHERE wi.symbol != ''
        )
        ORDER BY symbol;
      ")
    fi

    echo "=== Refreshing Support/Resistance Levels ==="
    python3 - "$DB" "$NOW" "$SYMBOLS" <<'PYEOF'
import sqlite3, uuid, sys, math

db = sys.argv[1]
now = sys.argv[2]
symbols = [s.strip() for s in sys.argv[3].strip().split('\n') if s.strip()]

conn = sqlite3.connect(db)
cur = conn.cursor()

for symbol in symbols:
    # Get 6 months of OHLCV data
    cur.execute('''
        SELECT ph.date, ph.open_price, ph.high_price, ph.low_price, ph.close_price, ph.volume
        FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? AND ph.date >= date('now', '-6 months')
        ORDER BY ph.date ASC
    ''', (symbol,))
    rows = cur.fetchall()

    if len(rows) < 15:
        print(f'  {symbol}: insufficient data ({len(rows)} days)')
        continue

    dates = [r[0] for r in rows]
    opens = [r[1] for r in rows]
    highs = [r[2] for r in rows]
    lows = [r[3] for r in rows]
    closes = [r[4] for r in rows]
    volumes = [r[5] or 0 for r in rows]
    current_price = closes[-1]
    if current_price is None:
        print(f'  {symbol}: no current price')
        continue

    total_days = len(rows)
    avg_volume = sum(v for v in volumes if v > 0) / max(1, sum(1 for v in volumes if v > 0))

    # Find swing highs/lows with metadata: (index, price, volume, rejection_pct)
    swing_highs = []
    swing_lows = []
    window = 5

    for i in range(window, len(rows) - window):
        h = highs[i]
        if h is None:
            continue
        neighborhood_h = [highs[j] for j in range(i - window, i + window + 1) if j != i]
        if any(v is None for v in neighborhood_h):
            continue
        if all(h >= v for v in neighborhood_h):
            # Rejection: upper wick as % of high (how far price rejected from level)
            c, o = closes[i], opens[i]
            if c is not None and o is not None and h > 0:
                body_top = max(c, o)
                rejection = (h - body_top) / h
            else:
                rejection = 0
            swing_highs.append((i, h, volumes[i], rejection))

        l = lows[i]
        if l is None:
            continue
        neighborhood_l = [lows[j] for j in range(i - window, i + window + 1) if j != i]
        if any(v is None for v in neighborhood_l):
            continue
        if all(l <= v for v in neighborhood_l):
            # Rejection: lower wick as % of low (how far price bounced off level)
            c, o = closes[i], opens[i]
            if c is not None and o is not None and l > 0:
                body_bottom = min(c, o)
                rejection = (body_bottom - l) / l
            else:
                rejection = 0
            swing_lows.append((i, l, volumes[i], rejection))

    # Cluster nearby swing points within 2%, preserving metadata
    def cluster_with_meta(points, threshold=0.02):
        if not points:
            return []
        points = sorted(points, key=lambda p: p[1])
        clusters = []
        current = [points[0]]
        for pt in points[1:]:
            if (pt[1] - current[0][1]) / current[0][1] <= threshold:
                current.append(pt)
            else:
                avg_price = sum(p[1] for p in current) / len(current)
                clusters.append((round(avg_price, 2), current))
                current = [pt]
        avg_price = sum(p[1] for p in current) / len(current)
        clusters.append((round(avg_price, 2), current))
        return clusters

    def score_cluster(points):
        """
        Composite strength score (1-10):
          - Touches (30%): more swing points clustered here = stronger
          - Volume (25%): high volume at reversal vs symbol avg = stronger
          - Recency (25%): recent tests weighted more (60-day half-life)
          - Rejection (20%): clean bounces with long wicks = stronger
        """
        n = len(points)

        # Touches: 1→0.2, 2→0.5, 3→0.75, 4+→1.0
        touch_score = min(1.0, 0.2 + (n - 1) * 0.27) if n >= 1 else 0

        # Volume: ratio of avg volume at swing points vs symbol avg
        vol_vals = [p[2] for p in points if p[2] > 0]
        if vol_vals and avg_volume > 0:
            vol_ratio = (sum(vol_vals) / len(vol_vals)) / avg_volume
            vol_score = min(1.0, vol_ratio / 2.0)
        else:
            vol_score = 0.3

        # Recency: exponential decay, half-life 60 trading days, take best
        half_life = 60
        recency_vals = []
        for p in points:
            days_ago = total_days - 1 - p[0]
            recency_vals.append(math.exp(-0.693 * days_ago / half_life))
        recency_score = max(recency_vals)

        # Rejection: avg wick size (3%+ wick = max score)
        rej_vals = [p[3] for p in points]
        avg_rej = sum(rej_vals) / len(rej_vals) if rej_vals else 0
        rej_score = min(1.0, avg_rej / 0.03) if avg_rej > 0 else 0.1

        composite = (
            touch_score * 0.30 +
            vol_score * 0.25 +
            recency_score * 0.25 +
            rej_score * 0.20
        )
        return max(1, min(10, round(composite * 10)))

    resistance_clusters = cluster_with_meta(swing_highs)
    support_clusters = cluster_with_meta(swing_lows)

    resistance = [(p, score_cluster(pts), len(pts)) for p, pts in resistance_clusters if p > current_price]
    support = [(p, score_cluster(pts), len(pts)) for p, pts in support_clusters if p < current_price]

    resistance.sort(key=lambda x: x[0])
    support.sort(key=lambda x: -x[0])

    resistance = resistance[:5]
    support = support[:5]

    cur.execute("DELETE FROM price_levels WHERE symbol = ? AND source = 'swing'", (symbol,))

    for price, strength, touches in resistance:
        row_id = str(uuid.uuid4())
        cur.execute('''
            INSERT OR REPLACE INTO price_levels (id, symbol, level_type, price, strength, source, created_at, updated_at)
            VALUES (?, ?, 'resistance', ?, ?, 'swing', ?, ?)
        ''', (row_id, symbol, price, strength, now, now))

    for price, strength, touches in support:
        row_id = str(uuid.uuid4())
        cur.execute('''
            INSERT OR REPLACE INTO price_levels (id, symbol, level_type, price, strength, source, created_at, updated_at)
            VALUES (?, ?, 'support', ?, ?, 'swing', ?, ?)
        ''', (row_id, symbol, price, strength, now, now))

    print(f'  {symbol:<6} ${current_price:>8,.2f}  {len(support)}S / {len(resistance)}R levels')

conn.commit()
conn.close()
print('Done.')
PYEOF
    ;;

  levels)
    # Show support/resistance levels with risk/reward
    SYMBOL="$2"

    # Create table if not exists
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS price_levels (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, level_type TEXT NOT NULL,
      price REAL NOT NULL, strength INTEGER DEFAULT 1, source TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(symbol, level_type, price)
    );"

    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      # Detailed single-symbol view
      echo "=== Support/Resistance: $SYMBOL ==="
      LATEST_PRICE=$(sqlite3 "$DB" "
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = '$SYMBOL'
        ORDER BY ph.date DESC LIMIT 1;
      ")
      echo "  Current Price: \$$LATEST_PRICE"
      echo ""
      echo "  Resistance (above):"
      sqlite3 "$DB" "
        SELECT printf('%.2f', price), strength FROM price_levels
        WHERE symbol = '$SYMBOL' AND level_type = 'resistance'
        ORDER BY price ASC;
      " | while IFS='|' read -r price str; do
        if [ "$str" -ge 8 ]; then label="Very Strong";
        elif [ "$str" -ge 6 ]; then label="Strong";
        elif [ "$str" -ge 4 ]; then label="Moderate";
        else label="Weak"; fi
        echo "    R  \$$price  ${str}/10  ${label}"
      done
      echo ""
      echo "  Support (below):"
      sqlite3 "$DB" "
        SELECT printf('%.2f', price), strength FROM price_levels
        WHERE symbol = '$SYMBOL' AND level_type = 'support'
        ORDER BY price DESC;
      " | while IFS='|' read -r price str; do
        if [ "$str" -ge 8 ]; then label="Very Strong";
        elif [ "$str" -ge 6 ]; then label="Strong";
        elif [ "$str" -ge 4 ]; then label="Moderate";
        else label="Weak"; fi
        echo "    S  \$$price  ${str}/10  ${label}"
      done
      echo ""
      # Risk/reward
      python3 - "$DB" "$SYMBOL" "$LATEST_PRICE" <<'PYEOF'
import sqlite3, sys

db, symbol, price = sys.argv[1], sys.argv[2], float(sys.argv[3])
conn = sqlite3.connect(db)
cur = conn.cursor()

cur.execute("SELECT price FROM price_levels WHERE symbol = ? AND level_type = 'support' ORDER BY price DESC LIMIT 1", (symbol,))
s = cur.fetchone()
cur.execute("SELECT price FROM price_levels WHERE symbol = ? AND level_type = 'resistance' ORDER BY price ASC LIMIT 1", (symbol,))
r = cur.fetchone()

if s and r:
    support, resist = s[0], r[0]
    downside = price - support
    upside = resist - price
    rr = upside / downside if downside > 0 else float('inf')
    print(f'  Risk/Reward:')
    print(f'    Upside to R1:   ${upside:>8,.2f}  ({upside/price*100:>+.1f}%)')
    print(f'    Downside to S1: ${downside:>8,.2f}  ({-downside/price*100:>+.1f}%)')
    print(f'    R:R Ratio:      {rr:.2f}x', end='')
    if rr < 1: print('  ⚠️  Unfavorable')
    elif rr >= 2: print('  ✓ Favorable')
    else: print('')
elif s:
    print(f'  Nearest support: ${s[0]:,.2f} (no resistance levels found)')
elif r:
    print(f'  Nearest resistance: ${r[0]:,.2f} (no support levels found)')
else:
    print(f'  No levels computed. Run: pm-cli.sh levels-refresh {symbol}')
conn.close()
PYEOF
    else
      # All portfolio symbols summary
      echo "=== Portfolio Support/Resistance & Risk/Reward ==="
      python3 - "$DB" <<'PYEOF'
import sqlite3, sys

db = sys.argv[1]
conn = sqlite3.connect(db)
cur = conn.cursor()

# Get portfolio symbols with latest price
cur.execute('''
    SELECT DISTINCT s.symbol,
           (SELECT ph.close_price FROM price_history ph
            WHERE ph.security_id = s.id ORDER BY ph.date DESC LIMIT 1) as price
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    WHERE s.type != 'cash' AND s.symbol != ''
    ORDER BY s.symbol
''')
positions = cur.fetchall()

print(f'{"Symbol":<8} {"Price":>8} {"S1":>8} {"R1":>8} {"Downside":>9} {"Upside":>8} {"R:R":>5}  Flag')
print('-' * 72)

for symbol, price in positions:
    if not price:
        continue

    cur.execute("SELECT price FROM price_levels WHERE symbol = ? AND level_type = 'support' ORDER BY price DESC LIMIT 1", (symbol,))
    s = cur.fetchone()
    cur.execute("SELECT price FROM price_levels WHERE symbol = ? AND level_type = 'resistance' ORDER BY price ASC LIMIT 1", (symbol,))
    r = cur.fetchone()

    s1 = f'${s[0]:>7,.2f}' if s else '     —'
    r1 = f'${r[0]:>7,.2f}' if r else '     —'

    if s and r:
        downside = price - s[0]
        upside = r[0] - price
        rr = upside / downside if downside > 0 else 99
        ds_pct = f'{-downside/price*100:.1f}%'
        us_pct = f'{upside/price*100:.1f}%'
        rr_str = f'{rr:.1f}x'
        flag = '⚠️ R:R<1' if rr < 1 else ''
    else:
        ds_pct, us_pct, rr_str, flag = '—', '—', '—', 'no levels'

    print(f'{symbol:<8} ${price:>7,.2f} {s1} {r1} {ds_pct:>9} {us_pct:>8} {rr_str:>5}  {flag}')

conn.close()
PYEOF
    fi
    ;;

  sync-transactions)
    # Sync transactions from Schwab API
    # Usage: sync-transactions [days] [end-date]
    # Example: sync-transactions 180 2025-09-15
    DAYS=${2:-30}
    END_DATE=${3:-}
    schwab_ensure_token

    # Get account hashes
    echo "Fetching account numbers..."
    ACCOUNTS_RESPONSE=$(curl -s "${SCHWAB_API}/trader/v1/accounts/accountNumbers" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}")

    # Fetch and import transactions for each account
    python3 << PYEOF
import json, sys, sqlite3, uuid, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

db_path = "$DB"
access_token = "$ACCESS_TOKEN"
schwab_api = "$SCHWAB_API"
days = $DAYS

accounts = json.loads('''$ACCOUNTS_RESPONSE''')
if not isinstance(accounts, list):
    print(f"ERROR: Failed to fetch accounts: {accounts}")
    sys.exit(1)

conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Build security map
sec_map = {}
cur.execute('SELECT id, symbol FROM securities')
for row in cur.fetchall():
    sec_map[row[1]] = row[0]

# Build account map (account_number -> account_id in our DB)
acct_map = {}
cur.execute('SELECT id, account_number FROM accounts')
for row in cur.fetchall():
    acct_map[row[1]] = row[0]

end_date_str = "$END_DATE" if "$END_DATE" else ""
if end_date_str:
    end_date = datetime.strptime(end_date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
else:
    end_date = datetime.now(timezone.utc)
start_date = end_date - timedelta(days=days)
start_str = start_date.strftime('%Y-%m-%dT00:00:00.000Z')
end_str = end_date.strftime('%Y-%m-%dT23:59:59.000Z')

total_synced = 0
total_skipped = 0

for acct in accounts:
    acct_num = acct['accountNumber']
    acct_hash = acct['hashValue']
    acct_id = acct_map.get(acct_num)
    if not acct_id:
        print(f"  Skipping account {acct_num} (not in DB)")
        continue

    params = urllib.parse.urlencode({
        'startDate': start_str,
        'endDate': end_str,
        'types': 'TRADE,DIVIDEND_OR_INTEREST,RECEIVE_AND_DELIVER',
    })
    url = f"{schwab_api}/trader/v1/accounts/{acct_hash}/transactions?{params}"
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {access_token}'})
    resp = urllib.request.urlopen(req)
    txns = json.loads(resp.read())

    print(f"  Account {acct_num}: {len(txns)} transactions from Schwab")

    for txn in txns:
        items = txn.get('transferItems', [])
        if not items:
            continue

        for item in items:
            instrument = item.get('instrument', {})
            symbol = instrument.get('symbol')
            if not symbol:
                continue

            # Map transaction type
            txn_type_raw = txn.get('type', '')
            net_amount = txn.get('netAmount', 0)
            if txn_type_raw == 'TRADE':
                txn_type = 'buy' if net_amount < 0 else 'sell'
            elif txn_type_raw == 'DIVIDEND_OR_INTEREST':
                txn_type = 'dividend' if net_amount > 0 else 'interest'
            elif txn_type_raw == 'RECEIVE_AND_DELIVER':
                txn_type = 'transfer_in' if net_amount >= 0 else 'transfer_out'
            else:
                txn_type = 'transfer_in' if net_amount >= 0 else 'transfer_out'

            date_str = (txn.get('tradeDate') or txn.get('time', '')).split('T')[0]

            # Find or create security
            sec_id = sec_map.get(symbol)
            if not sec_id:
                asset_type = instrument.get('assetType', 'EQUITY')
                type_map = {'EQUITY': 'stock', 'MUTUAL_FUND': 'mutual_fund', 'ETF': 'etf',
                            'OPTION': 'option', 'FIXED_INCOME': 'bond', 'CASH_EQUIVALENT': 'cash'}
                sec_type = type_map.get(asset_type, 'other')
                sec_id = str(uuid.uuid4())
                cur.execute('INSERT INTO securities (id, symbol, name, type, currency, created_at) VALUES (?,?,?,?,?,datetime("now"))',
                    (sec_id, symbol, instrument.get('description', symbol), sec_type, 'USD'))
                sec_map[symbol] = sec_id

            # Dedup check
            cur.execute('''SELECT amount FROM transactions
                WHERE account_id = ? AND security_id = ? AND type = ? AND date = ?''',
                (acct_id, sec_id, txn_type, date_str))
            existing_amounts = [r[0] for r in cur.fetchall()]
            if any(abs(a - net_amount) < 0.01 for a in existing_amounts):
                total_skipped += 1
                continue

            qty = abs(item.get('amount', 0))
            price = item.get('price', 0)

            cur.execute('''INSERT INTO transactions (id, account_id, security_id, type, date, quantity, price, amount, fees, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,0,datetime("now"),datetime("now"))''',
                (str(uuid.uuid4()), acct_id, sec_id, txn_type, date_str, qty, price, net_amount))
            total_synced += 1

conn.commit()
conn.close()
print(f"\nSynced {total_synced} new transactions ({total_skipped} duplicates skipped)")
PYEOF
    ;;

  buy|sell)
    ACTION=$(echo "$1" | tr '[:lower:]' '[:upper:]')
    INSTRUCTION="$ACTION"
    QTY="$2"
    SYMBOL=$(echo "$3" | tr '[:lower:]' '[:upper:]')
    ORDER_TYPE_IND="$4"

    if [ -z "$QTY" ] || [ -z "$SYMBOL" ] || [ -z "$ORDER_TYPE_IND" ]; then
      echo "Usage: pm-cli.sh buy|sell <qty> <symbol> at <price> <DAY|GTC> [account]"
      echo "       pm-cli.sh buy|sell <qty> <symbol> market <DAY|GTC> [account]"
      echo "       pm-cli.sh buy|sell <qty> <symbol> stop <price> <DAY|GTC> [account]"
      exit 1
    fi

    # Parse based on order type indicator
    case "$ORDER_TYPE_IND" in
      at)
        ORDER_TYPE="LIMIT"
        PRICE="$5"
        DURATION=$(echo "$6" | tr '[:lower:]' '[:upper:]')
        ACCT_HINT="$7"
        if [ -z "$PRICE" ] || [ -z "$DURATION" ]; then
          echo "Usage: pm-cli.sh $1 <qty> <symbol> at <price> <DAY|GTC> [account]"
          exit 1
        fi
        ;;
      market)
        ORDER_TYPE="MARKET"
        PRICE=""
        DURATION=$(echo "$5" | tr '[:lower:]' '[:upper:]')
        ACCT_HINT="$6"
        if [ -z "$DURATION" ]; then
          echo "Usage: pm-cli.sh $1 <qty> <symbol> market <DAY|GTC> [account]"
          exit 1
        fi
        ;;
      stop)
        ORDER_TYPE="STOP"
        PRICE="$5"
        DURATION=$(echo "$6" | tr '[:lower:]' '[:upper:]')
        ACCT_HINT="$7"
        if [ -z "$PRICE" ] || [ -z "$DURATION" ]; then
          echo "Usage: pm-cli.sh $1 <qty> <symbol> stop <price> <DAY|GTC> [account]"
          exit 1
        fi
        ;;
      *)
        echo "ERROR: Unknown order type '$ORDER_TYPE_IND'. Use: at, market, or stop"
        exit 1
        ;;
    esac

    # Validate duration
    if [ "$DURATION" != "DAY" ] && [ "$DURATION" != "GTC" ]; then
      echo "ERROR: Duration must be DAY or GTC (got '$DURATION')"
      exit 1
    fi

    # Resolve account
    resolve_account "$INSTRUCTION" "$SYMBOL" "$ACCT_HINT"
    if [ $? -ne 0 ]; then
      exit 1
    fi

    ACCT_NAME=$(sqlite3 "$DB" "SELECT name FROM accounts WHERE account_number LIKE '%$RESOLVED_ACCOUNT' LIMIT 1")

    # Pre-trade checklist
    pre_trade_check "$SYMBOL" "$INSTRUCTION" "$QTY" "$RESOLVED_ACCOUNT" "$PRICE" || exit 1

    # Print order summary
    echo "==============================="
    echo "  ORDER SUMMARY"
    echo "==============================="
    echo "  Action:   $INSTRUCTION"
    echo "  Symbol:   $SYMBOL"
    echo "  Quantity: $QTY"
    echo "  Type:     $ORDER_TYPE"
    if [ "$ORDER_TYPE" = "LIMIT" ]; then
      echo "  Price:    \$$PRICE"
    elif [ "$ORDER_TYPE" = "STOP" ]; then
      echo "  Stop:     \$$PRICE"
    fi
    echo "  Duration: $DURATION"
    echo "  Account:  $ACCT_NAME ($RESOLVED_ACCOUNT)"
    echo "==============================="

    # Check for --confirm flag
    CONFIRMED=0
    for arg in "$@"; do
      if [ "$arg" = "--confirm" ]; then
        CONFIRMED=1
        break
      fi
    done

    if [ "$CONFIRMED" -eq 0 ]; then
      printf "Place order? [y/N] "
      read -r REPLY
      if [ "$REPLY" != "y" ] && [ "$REPLY" != "Y" ]; then
        echo "Order cancelled."
        exit 0
      fi
    fi

    # Authenticate and get account hash
    schwab_ensure_token
    schwab_get_account_hash "$RESOLVED_ACCOUNT"
    if [ -z "$ACCOUNT_HASH" ]; then
      exit 1
    fi

    # Build order JSON
    ORDER_JSON=$(python3 -c "
import json
order = {
    'orderType': '$ORDER_TYPE',
    'session': 'NORMAL',
    'duration': '$DURATION',
    'orderStrategyType': 'SINGLE',
    'orderLegCollection': [{
        'instruction': '$INSTRUCTION',
        'quantity': $QTY,
        'instrument': {
            'symbol': '$SYMBOL',
            'assetType': 'EQUITY'
        }
    }]
}
if '$ORDER_TYPE' == 'LIMIT':
    order['price'] = '$PRICE'
elif '$ORDER_TYPE' == 'STOP':
    order['stopPrice'] = '$PRICE'
print(json.dumps(order))
")

    # Place order
    HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
      "${SCHWAB_API}/trader/v1/accounts/${ACCOUNT_HASH}/orders" \
      -H "Authorization: ${TOKEN_TYPE} ${ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$ORDER_JSON")

    HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
    HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -1)

    if [ "$HTTP_STATUS" = "201" ]; then
      echo "Order placed successfully."
    else
      echo "ERROR: Order failed (HTTP $HTTP_STATUS)"
      if [ -n "$HTTP_BODY" ]; then
        echo "$HTTP_BODY" | python3 -m json.tool 2>/dev/null || echo "$HTTP_BODY"
      fi
      exit 1
    fi
    ;;

  orders)
    schwab_ensure_token

    SHOW_ALL=0
    if [ "${2:-}" = "all" ]; then
      SHOW_ALL=1
    fi

    # Fetch account numbers
    ACCTS_JSON=$(curl -s "${SCHWAB_API}/trader/v1/accounts/accountNumbers" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}")

    python3 - "$ACCESS_TOKEN" "$SCHWAB_API" "$SHOW_ALL" "$ACCTS_JSON" <<'PYEOF'
import sys, json, urllib.request, datetime

token = sys.argv[1]
api = sys.argv[2]
show_all = sys.argv[3] == "1"
accts = json.loads(sys.argv[4])

now = datetime.datetime.now(datetime.timezone.utc)
from_date = (now - datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
to_date = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")

all_orders = []

for acct in accts:
    acct_num = acct.get("accountNumber", "")
    acct_hash = acct.get("hashValue", "")
    if not acct_hash:
        continue

    url = f"{api}/trader/v1/accounts/{acct_hash}/orders?fromEnteredTime={from_date}&toEnteredTime={to_date}"
    if not show_all:
        url += "&status=WORKING"

    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        resp = urllib.request.urlopen(req)
        orders = json.loads(resp.read())
    except Exception as e:
        print(f"Warning: failed to fetch orders for ...{acct_num[-4:]}: {e}", file=sys.stderr)
        continue

    for o in orders:
        legs = o.get("orderLegCollection", [])
        symbol = legs[0]["instrument"]["symbol"] if legs else "?"
        side = legs[0].get("instruction", "?") if legs else "?"
        qty = int(legs[0].get("quantity", 0)) if legs else 0
        filled = int(o.get("filledQuantity", 0))
        order_type = o.get("orderType", "?")
        price = o.get("price") or o.get("stopPrice") or ""
        if price:
            price = f"${float(price):.2f}"
        duration = o.get("duration", "?")
        status = o.get("status", "?")
        entered = o.get("enteredTime", "")[:19].replace("T", " ")
        order_id = str(o.get("orderId", "?"))
        all_orders.append((entered, order_id, acct_num[-4:], symbol, side, qty, filled, order_type, price, duration, status))

# Sort by entered time descending
all_orders.sort(key=lambda x: x[0], reverse=True)

if not all_orders:
    label = "open" if not show_all else ""
    print(f"No {label} orders found.")
    sys.exit(0)

# Print table
hdr = f"{'ORDER_ID':>12}  {'ACCT':>4}  {'SYMBOL':<6}  {'SIDE':<5}  {'QTY':>5}  {'FILL':>4}  {'TYPE':<6}  {'PRICE':>10}  {'DUR':<3}  {'STATUS':<12}  {'ENTERED':<19}"
print(hdr)
print("-" * len(hdr))
for row in all_orders:
    entered, oid, acct4, sym, side, qty, filled, otype, price, dur, status = row
    # Shorten side
    side_short = {"BUY": "BUY", "SELL": "SELL", "BUY_TO_COVER": "BTC", "SELL_SHORT": "SS"}.get(side, side)
    print(f"{oid:>12}  {acct4:>4}  {sym:<6}  {side_short:<5}  {qty:>5}  {filled:>4}  {otype:<6}  {price:>10}  {dur:<3}  {status:<12}  {entered:<19}")
PYEOF
    ;;

  trade-analytics)
    trade_analytics
    ;;

  trade-journal)
    trade_journal "$2" "$3"
    ;;

  cancel-order)
    ORDER_ID="${2:-}"
    if [ -z "$ORDER_ID" ]; then
      echo "Usage: pm-cli.sh cancel-order <orderId>"
      exit 1
    fi

    schwab_ensure_token

    # Fetch account numbers
    ACCTS_JSON=$(curl -s "${SCHWAB_API}/trader/v1/accounts/accountNumbers" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}")

    # Try DELETE on each account until one succeeds
    FOUND=0
    for ACCT_HASH in $(echo "$ACCTS_JSON" | python3 -c "import json,sys; [print(a['hashValue']) for a in json.load(sys.stdin)]" 2>/dev/null); do
      HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "${SCHWAB_API}/trader/v1/accounts/${ACCT_HASH}/orders/${ORDER_ID}" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}")
      if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "204" ]; then
        echo "Order $ORDER_ID cancelled successfully."
        FOUND=1
        break
      fi
    done

    if [ "$FOUND" -eq 0 ]; then
      echo "ERROR: Order $ORDER_ID not found or could not be cancelled."
      exit 1
    fi
    ;;

  recall)
    recall_symbol "$2"
    ;;

  observe)
    SYMBOL="$2"
    NOTE="$3"
    IMPACT="${4:-neutral}"
    if [ -z "$SYMBOL" ] || [ -z "$NOTE" ]; then
      echo "Usage: pm-cli.sh observe <symbol> \"<note>\" [supports|challenges|neutral]"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Validate thesis_impact
    case "$IMPACT" in
      supports|challenges|neutral) ;;
      *) echo "ERROR: thesis_impact must be supports, challenges, or neutral"; exit 1 ;;
    esac

    # Look up security_id
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "ERROR: Security '$SYMBOL' not found in database."
      exit 1
    fi

    OBS_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    OBS_DATE=$(date +%Y-%m-%d)
    OBS_NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

    sqlite3 "$DB" "
      INSERT INTO observations (id, security_id, observation_date, note, source, thesis_impact, created_at)
      VALUES ('$OBS_ID', '$SEC_ID', '$OBS_DATE', '$(echo "$NOTE" | sed "s/'/''/g")', NULL, '$IMPACT', '$OBS_NOW');
    "

    case "$IMPACT" in
      supports) IND="+" ;;
      challenges) IND="-" ;;
      *) IND="~" ;;
    esac
    echo "Observation recorded for $SYMBOL [$IND]: $NOTE"
    ;;

  observations)
    SYMBOL="$2"
    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      ROWS=$(sqlite3 -separator '|' "$DB" "
        SELECT o.observation_date, s.symbol,
          CASE o.thesis_impact WHEN 'supports' THEN '+' WHEN 'challenges' THEN '-' ELSE '~' END,
          o.note
        FROM observations o
        JOIN securities s ON o.security_id = s.id
        WHERE s.symbol = '$SYMBOL'
        ORDER BY o.observation_date DESC
        LIMIT 20;
      ")
    else
      ROWS=$(sqlite3 -separator '|' "$DB" "
        SELECT o.observation_date, s.symbol,
          CASE o.thesis_impact WHEN 'supports' THEN '+' WHEN 'challenges' THEN '-' ELSE '~' END,
          o.note
        FROM observations o
        JOIN securities s ON o.security_id = s.id
        ORDER BY o.observation_date DESC
        LIMIT 20;
      ")
    fi

    if [ -z "$ROWS" ]; then
      echo "(no observations found)"
    else
      printf "%-12s %-6s %s  %s\n" "DATE" "SYMBOL" "I" "NOTE"
      printf "%-12s %-6s %s  %s\n" "----------" "------" "-" "----"
      echo "$ROWS" | while IFS='|' read -r ODATE OSYM OIMPACT ONOTE; do
        printf "%-12s %-6s %s  %s\n" "$ODATE" "$OSYM" "$OIMPACT" "$ONOTE"
      done
    fi
    ;;

  post-mortem)
    # Interactive post-mortem creation
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh post-mortem <symbol>"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Look up security_id
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "ERROR: Security '$SYMBOL' not found in database."
      exit 1
    fi

    echo "=== Post-Mortem: $SYMBOL ==="
    echo ""

    # Show recent sell transactions for context
    echo "--- Recent Sell Transactions ---"
    sqlite3 -header -column "$DB" "
      SELECT t.date, t.quantity, printf('%.2f', t.price) as price,
             printf('%.2f', t.amount) as amount, a.name as account
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE t.security_id = '$SEC_ID' AND t.type = 'Sell'
      ORDER BY t.date DESC LIMIT 5;
    "
    echo ""

    # Show current position intent if exists
    INTENT_ROW=$(sqlite3 -header -column "$DB" "
      SELECT pi.tag as tier, pi.thesis, pi.invalidation
      FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      WHERE p.security_id = '$SEC_ID' LIMIT 1;
    " 2>/dev/null)
    if [ -n "$INTENT_ROW" ]; then
      echo "--- Current Position Intent ---"
      echo "$INTENT_ROW"
      echo ""
    fi

    # Prompt for fields
    read -p "Original intent (investment/trade): " PM_INTENT
    read -p "Close date (YYYY-MM-DD): " PM_CLOSE_DATE
    read -p "Tier at entry: " PM_TIER
    echo "Entry thesis (what was the original idea?):"
    read -p "> " PM_ENTRY_THESIS
    echo "What happened (how did the position play out?):"
    read -p "> " PM_WHAT_HAPPENED
    echo "Rule adherence (did you follow your rules?):"
    read -p "> " PM_RULE_ADHERENCE

    # Error type menu
    ERROR_TYPES=("entry-timing" "sizing" "stop-discipline" "thesis-quality" "regime-misread" "overtrading" "none")
    echo "Error type:"
    echo "  1) entry-timing"
    echo "  2) sizing"
    echo "  3) stop-discipline"
    echo "  4) thesis-quality"
    echo "  5) regime-misread"
    echo "  6) overtrading"
    echo "  7) none"
    read -p "Select (1-7): " PM_ERROR_NUM
    if [ "$PM_ERROR_NUM" -ge 1 ] && [ "$PM_ERROR_NUM" -le 7 ] 2>/dev/null; then
      PM_ERROR_TYPE="${ERROR_TYPES[$((PM_ERROR_NUM - 1))]}"
    else
      echo "Invalid selection, defaulting to 'none'"
      PM_ERROR_TYPE="none"
    fi

    # Thesis quality
    echo "Thesis quality:"
    echo "  1) good  (thesis was sound, based on real insight)"
    echo "  2) bad   (thesis was flawed from the start)"
    read -p "Select (1-2): " PM_TQ_NUM
    if [ "$PM_TQ_NUM" = "2" ]; then PM_THESIS_QUALITY="bad"; else PM_THESIS_QUALITY="good"; fi

    # Execution quality
    echo "Execution quality:"
    echo "  1) good  (followed process, acted on signals)"
    echo "  2) bad   (broke rules, ignored invalidation, averaged down)"
    read -p "Select (1-2): " PM_EQ_NUM
    if [ "$PM_EQ_NUM" = "2" ]; then PM_EXECUTION_QUALITY="bad"; else PM_EXECUTION_QUALITY="good"; fi

    # Outcome
    echo "Outcome:"
    echo "  1) win"
    echo "  2) loss"
    read -p "Select (1-2): " PM_OC_NUM
    if [ "$PM_OC_NUM" = "2" ]; then PM_OUTCOME="loss"; else PM_OUTCOME="win"; fi

    echo "Lesson learned:"
    read -p "> " PM_LESSON
    read -p "Realized P&L ($): " PM_REALIZED
    read -p "Hold days: " PM_HOLD_DAYS

    # Escape single quotes for SQL
    PM_INTENT_ESC=$(echo "$PM_INTENT" | sed "s/'/''/g")
    PM_TIER_ESC=$(echo "$PM_TIER" | sed "s/'/''/g")
    PM_ENTRY_THESIS_ESC=$(echo "$PM_ENTRY_THESIS" | sed "s/'/''/g")
    PM_WHAT_HAPPENED_ESC=$(echo "$PM_WHAT_HAPPENED" | sed "s/'/''/g")
    PM_RULE_ADHERENCE_ESC=$(echo "$PM_RULE_ADHERENCE" | sed "s/'/''/g")
    PM_LESSON_ESC=$(echo "$PM_LESSON" | sed "s/'/''/g")

    # Generate UUID and timestamp
    PM_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Default numeric fields
    if [ -z "$PM_REALIZED" ]; then PM_REALIZED="0"; fi
    if [ -z "$PM_HOLD_DAYS" ]; then PM_HOLD_DAYS="0"; fi

    sqlite3 "$DB" "INSERT INTO post_mortems (id, security_id, close_date, original_intent, tier, entry_thesis, what_happened, rule_adherence, error_type, thesis_quality, execution_quality, outcome, lesson_learned, realized_gain, hold_days, created_at, updated_at) VALUES ('$PM_ID', '$SEC_ID', '$PM_CLOSE_DATE', '$PM_INTENT_ESC', '$PM_TIER_ESC', '$PM_ENTRY_THESIS_ESC', '$PM_WHAT_HAPPENED_ESC', '$PM_RULE_ADHERENCE_ESC', '$PM_ERROR_TYPE', '$PM_THESIS_QUALITY', '$PM_EXECUTION_QUALITY', '$PM_OUTCOME', '$PM_LESSON_ESC', $PM_REALIZED, $PM_HOLD_DAYS, '$NOW', '$NOW');"

    echo ""
    echo "Post-mortem created for $SYMBOL ($PM_THESIS_QUALITY thesis / $PM_EXECUTION_QUALITY execution / $PM_OUTCOME, error: $PM_ERROR_TYPE)"
    echo "ID: $PM_ID"
    ;;

  post-mortems)
    # List post-mortems, optionally filtered by symbol
    PM_FILTER="$2"
    if [ -n "$PM_FILTER" ]; then
      PM_FILTER=$(echo "$PM_FILTER" | tr '[:lower:]' '[:upper:]')
      PM_WHERE="WHERE s.symbol = '$PM_FILTER'"
      echo "=== Post-Mortems: $PM_FILTER ==="
    else
      PM_WHERE=""
      echo "=== All Post-Mortems ==="
    fi

    # Use raw mode to colorize output
    PM_ROWS=$(sqlite3 -separator '|' "$DB" "
      SELECT s.symbol, pm.close_date, pm.thesis_quality, pm.execution_quality, pm.outcome,
             pm.error_type, pm.hold_days, printf('%.2f', pm.realized_gain) as realized_gain,
             pm.lesson_learned
      FROM post_mortems pm
      JOIN securities s ON pm.security_id = s.id
      $PM_WHERE
      ORDER BY pm.close_date DESC;
    ")

    if [ -z "$PM_ROWS" ]; then
      echo "(none)"
    else
      printf "%-6s %-12s %-7s %-7s %-7s %-16s %5s %12s  %s\n" "SYMBOL" "CLOSE DATE" "THESIS" "EXEC" "RESULT" "ERROR" "DAYS" "P&L" "LESSON"
      printf "%-6s %-12s %-7s %-7s %-7s %-16s %5s %12s  %s\n" "------" "----------" "-------" "-------" "-------" "----------------" "-----" "------------" "------"
      echo "$PM_ROWS" | while IFS='|' read -r SYM CDATE TQ EQ OC ERR HDAYS GAIN LESSON; do
        # Color: green for wins, red for losses
        if [ "$OC" = "loss" ]; then
          COLOR="\033[31m"  # red
        else
          COLOR="\033[32m"  # green
        fi
        RESET="\033[0m"
        printf "${COLOR}%-6s %-12s %-7s %-7s %-7s %-16s %5s %12s${RESET}  %s\n" "$SYM" "$CDATE" "$TQ" "$EQ" "$OC" "$ERR" "$HDAYS" "$GAIN" "$LESSON"
      done
    fi
    ;;

  earnings-review)
    # Interactive post-earnings review
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh earnings-review <symbol>"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Look up security_id
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "ERROR: Security '$SYMBOL' not found in database."
      exit 1
    fi

    echo "=== Earnings Review: $SYMBOL ==="
    echo ""

    # Show current position info
    INTENT_INFO=$(sqlite3 -separator '|' "$DB" "
      SELECT pi.tier, pi.thesis, pi.invalidation
      FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      WHERE p.security_id = '$SEC_ID' LIMIT 1;
    " 2>/dev/null)
    if [ -n "$INTENT_INFO" ]; then
      ER_TIER=$(echo "$INTENT_INFO" | cut -d'|' -f1)
      ER_THESIS=$(echo "$INTENT_INFO" | cut -d'|' -f2)
      ER_INV=$(echo "$INTENT_INFO" | cut -d'|' -f3)
      echo "--- Current Position ---"
      echo "  Tier:           $ER_TIER"
      echo "  Thesis:         $ER_THESIS"
      echo "  Invalidation:   $ER_INV"
      echo ""
    fi

    # Show previous review if exists (for growth trajectory suggestion)
    PREV_REVIEW=$(sqlite3 -separator '|' "$DB" "
      SELECT quarter, revenue_growth_pct, eps_growth_pct, growth_trajectory, thesis_impact
      FROM earnings_reviews
      WHERE security_id = '$SEC_ID'
      ORDER BY earnings_date DESC LIMIT 1;
    " 2>/dev/null)
    if [ -n "$PREV_REVIEW" ]; then
      PR_QTR=$(echo "$PREV_REVIEW" | cut -d'|' -f1)
      PR_REV_G=$(echo "$PREV_REVIEW" | cut -d'|' -f2)
      PR_EPS_G=$(echo "$PREV_REVIEW" | cut -d'|' -f3)
      PR_TRAJ=$(echo "$PREV_REVIEW" | cut -d'|' -f4)
      PR_IMPACT=$(echo "$PREV_REVIEW" | cut -d'|' -f5)
      echo "--- Previous Review ($PR_QTR) ---"
      [ -n "$PR_REV_G" ] && echo "  Revenue growth: ${PR_REV_G}%"
      [ -n "$PR_EPS_G" ] && echo "  EPS growth:     ${PR_EPS_G}%"
      [ -n "$PR_TRAJ" ] && echo "  Trajectory:     $PR_TRAJ"
      echo "  Thesis impact:  $PR_IMPACT"
      echo ""
    fi

    # Prompt for data
    read -p "Quarter (e.g. Q4 2025): " ER_QUARTER
    read -p "Earnings date (YYYY-MM-DD): " ER_DATE
    read -p "Revenue expected ($M): " ER_REV_EXP
    read -p "Revenue actual ($M): " ER_REV_ACT
    read -p "EPS expected ($): " ER_EPS_EXP
    read -p "EPS actual ($): " ER_EPS_ACT

    # Compute beat/miss
    echo ""
    if [ -n "$ER_REV_EXP" ] && [ -n "$ER_REV_ACT" ]; then
      REV_RESULT=$(python3 -c "
exp, act = float('$ER_REV_EXP'), float('$ER_REV_ACT')
diff_pct = (act - exp) / exp * 100 if exp else 0
label = 'Beat' if act > exp else 'Miss' if act < exp else 'Inline'
print(f'  Revenue: {label} ({diff_pct:+.1f}%) — \${exp:.2f}M est vs \${act:.2f}M actual')
" 2>/dev/null)
      echo "$REV_RESULT"
    fi
    if [ -n "$ER_EPS_EXP" ] && [ -n "$ER_EPS_ACT" ]; then
      EPS_RESULT=$(python3 -c "
exp, act = float('$ER_EPS_EXP'), float('$ER_EPS_ACT')
diff_pct = (act - exp) / exp * 100 if exp else 0
label = 'Beat' if act > exp else 'Miss' if act < exp else 'Inline'
print(f'  EPS:     {label} ({diff_pct:+.1f}%) — \${exp:.2f} est vs \${act:.2f} actual')
" 2>/dev/null)
      echo "$EPS_RESULT"
    fi
    echo ""

    read -p "Revenue YoY growth % (e.g. 15.3): " ER_REV_GROWTH
    read -p "EPS YoY growth % (e.g. 22.1): " ER_EPS_GROWTH

    # Suggest trajectory if previous review exists
    if [ -n "$PR_TRAJ" ] && [ -n "$PR_REV_G" ] && [ -n "$ER_REV_GROWTH" ]; then
      TRAJ_SUGGEST=$(python3 -c "
prev, curr = float('$PR_REV_G'), float('$ER_REV_GROWTH')
if curr > prev + 2: print('accelerating')
elif curr < prev - 2: print('decelerating')
else: print('stable')
" 2>/dev/null)
      echo "  (Suggested trajectory based on prior: $TRAJ_SUGGEST)"
    fi

    echo "Growth trajectory:"
    echo "  1) accelerating"
    echo "  2) stable"
    echo "  3) decelerating"
    read -p "Select (1-3): " ER_TRAJ_NUM
    case "$ER_TRAJ_NUM" in
      1) ER_TRAJECTORY="accelerating" ;;
      3) ER_TRAJECTORY="decelerating" ;;
      *) ER_TRAJECTORY="stable" ;;
    esac

    echo "Thesis impact:"
    echo "  1) confirmed  (earnings support the thesis)"
    echo "  2) neutral    (no change to thesis)"
    echo "  3) challenged (earnings challenge the thesis)"
    read -p "Select (1-3): " ER_IMPACT_NUM
    case "$ER_IMPACT_NUM" in
      1) ER_IMPACT="confirmed" ;;
      3) ER_IMPACT="challenged" ;;
      *) ER_IMPACT="neutral" ;;
    esac

    read -p "Invalidation triggered? (y/n): " ER_INV_TRIG
    if [ "$ER_INV_TRIG" = "y" ]; then
      ER_INV_TRIGGERED=1
    else
      ER_INV_TRIGGERED=0
    fi

    # Set deadline if challenged or invalidation triggered
    ER_DEADLINE=""
    if [ "$ER_IMPACT" = "challenged" ] || [ "$ER_INV_TRIGGERED" = "1" ]; then
      ER_DEADLINE=$(python3 -c "
from datetime import datetime, timedelta
deadline = datetime.now() + timedelta(hours=48)
print(deadline.strftime('%Y-%m-%dT%H:%M:%S.000Z'))
" 2>/dev/null)
      echo ""
      echo "  ⚠ DECISION REQUIRED within 48 hours: hold, retier, or exit"
      echo "  Deadline: $ER_DEADLINE"
    fi

    # Decision
    echo ""
    echo "Decision:"
    echo "  1) hold"
    echo "  2) retier"
    echo "  3) exit"
    echo "  4) defer (decide within 48h)"
    read -p "Select (1-4): " ER_DEC_NUM
    case "$ER_DEC_NUM" in
      1) ER_DECISION="hold" ;;
      2) ER_DECISION="retier" ;;
      3) ER_DECISION="exit" ;;
      *) ER_DECISION="" ;;
    esac

    ER_NOTES=""
    if [ -n "$ER_DECISION" ]; then
      echo "Decision notes:"
      read -p "> " ER_NOTES
    fi

    # Generate UUID and timestamp
    ER_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Escape single quotes
    ER_QUARTER_ESC=$(echo "$ER_QUARTER" | sed "s/'/''/g")
    ER_NOTES_ESC=$(echo "$ER_NOTES" | sed "s/'/''/g")

    # Default numeric fields
    [ -z "$ER_REV_EXP" ] && ER_REV_EXP="NULL" || ER_REV_EXP="$ER_REV_EXP"
    [ -z "$ER_REV_ACT" ] && ER_REV_ACT="NULL" || ER_REV_ACT="$ER_REV_ACT"
    [ -z "$ER_EPS_EXP" ] && ER_EPS_EXP="NULL" || ER_EPS_EXP="$ER_EPS_EXP"
    [ -z "$ER_EPS_ACT" ] && ER_EPS_ACT="NULL" || ER_EPS_ACT="$ER_EPS_ACT"
    [ -z "$ER_REV_GROWTH" ] && ER_REV_GROWTH="NULL" || ER_REV_GROWTH="$ER_REV_GROWTH"
    [ -z "$ER_EPS_GROWTH" ] && ER_EPS_GROWTH="NULL" || ER_EPS_GROWTH="$ER_EPS_GROWTH"

    # Build decision/deadline SQL values
    [ -z "$ER_DECISION" ] && ER_DEC_SQL="NULL" || ER_DEC_SQL="'$ER_DECISION'"
    [ -z "$ER_DEADLINE" ] && ER_DL_SQL="NULL" || ER_DL_SQL="'$ER_DEADLINE'"
    [ -z "$ER_NOTES" ] && ER_NOTES_SQL="NULL" || ER_NOTES_SQL="'$ER_NOTES_ESC'"

    sqlite3 "$DB" "INSERT INTO earnings_reviews (id, security_id, quarter, earnings_date, revenue_expected, revenue_actual, eps_expected, eps_actual, revenue_growth_pct, eps_growth_pct, growth_trajectory, thesis_impact, invalidation_triggered, decision, decision_deadline, decision_notes, created_at, updated_at) VALUES ('$ER_ID', '$SEC_ID', '$ER_QUARTER_ESC', '$ER_DATE', $ER_REV_EXP, $ER_REV_ACT, $ER_EPS_EXP, $ER_EPS_ACT, $ER_REV_GROWTH, $ER_EPS_GROWTH, '$ER_TRAJECTORY', '$ER_IMPACT', $ER_INV_TRIGGERED, $ER_DEC_SQL, $ER_DL_SQL, $ER_NOTES_SQL, '$NOW', '$NOW');"

    echo ""
    echo "=== Review Summary ==="
    echo "  $SYMBOL $ER_QUARTER ($ER_DATE)"
    echo "  Trajectory: $ER_TRAJECTORY | Impact: $ER_IMPACT"
    [ "$ER_INV_TRIGGERED" = "1" ] && echo "  ⚠ Invalidation triggered"
    if [ -n "$ER_DECISION" ]; then
      echo "  Decision: $ER_DECISION"
      [ -n "$ER_NOTES" ] && echo "  Notes: $ER_NOTES"
    else
      echo "  Decision: DEFERRED (deadline: $ER_DEADLINE)"
    fi
    echo "  ID: $ER_ID"
    ;;

  earnings-reviews)
    # List earnings reviews, optionally filtered by symbol
    ER_FILTER="$2"
    if [ -n "$ER_FILTER" ]; then
      ER_FILTER=$(echo "$ER_FILTER" | tr '[:lower:]' '[:upper:]')
      ER_WHERE="WHERE s.symbol = '$ER_FILTER'"
      echo "=== Earnings Reviews: $ER_FILTER ==="
    else
      ER_WHERE=""
      echo "=== All Earnings Reviews ==="
    fi

    ER_ROWS=$(sqlite3 -separator '|' "$DB" "
      SELECT s.symbol, er.quarter, substr(er.earnings_date, 1, 10) as edate,
             CASE
               WHEN er.revenue_actual IS NOT NULL AND er.revenue_expected IS NOT NULL
                 THEN CASE WHEN er.revenue_actual > er.revenue_expected THEN 'Beat' WHEN er.revenue_actual < er.revenue_expected THEN 'Miss' ELSE 'Inline' END
               ELSE 'N/A'
             END as rev_result,
             CASE
               WHEN er.eps_actual IS NOT NULL AND er.eps_expected IS NOT NULL
                 THEN CASE WHEN er.eps_actual > er.eps_expected THEN 'Beat' WHEN er.eps_actual < er.eps_expected THEN 'Miss' ELSE 'Inline' END
               ELSE 'N/A'
             END as eps_result,
             COALESCE(er.growth_trajectory, 'N/A') as trajectory,
             er.thesis_impact,
             COALESCE(er.decision, 'pending') as decision
      FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      $ER_WHERE
      ORDER BY er.earnings_date DESC;
    ")

    if [ -z "$ER_ROWS" ]; then
      echo "(none)"
    else
      printf "%-6s %-10s %-12s %-8s %-8s %-14s %-12s %-8s\n" "SYMBOL" "QUARTER" "DATE" "REV" "EPS" "TRAJECTORY" "IMPACT" "DECISION"
      printf "%-6s %-10s %-12s %-8s %-8s %-14s %-12s %-8s\n" "------" "----------" "----------" "--------" "--------" "--------------" "----------" "--------"
      echo "$ER_ROWS" | while IFS='|' read -r SYM QTR EDATE REV_R EPS_R TRAJ IMPACT DEC; do
        # Color: green for confirmed, red for challenged, yellow for pending
        if [ "$IMPACT" = "challenged" ]; then
          COLOR="\033[31m"  # red
        elif [ "$IMPACT" = "confirmed" ]; then
          COLOR="\033[32m"  # green
        else
          COLOR="\033[33m"  # yellow
        fi
        RESET="\033[0m"
        printf "${COLOR}%-6s %-10s %-12s %-8s %-8s %-14s %-12s %-8s${RESET}\n" "$SYM" "$QTR" "$EDATE" "$REV_R" "$EPS_R" "$TRAJ" "$IMPACT" "$DEC"
      done
    fi
    ;;

  earnings-review-decide)
    # Update decision on a pending earnings review
    ER_DEC_ID="$2"
    if [ -z "$ER_DEC_ID" ]; then
      echo "Usage: pm-cli.sh earnings-review-decide <review-id>"
      echo ""
      echo "Pending reviews:"
      sqlite3 -separator '|' "$DB" "
        SELECT er.id, s.symbol, er.quarter, er.thesis_impact, er.decision_deadline
        FROM earnings_reviews er
        JOIN securities s ON er.security_id = s.id
        WHERE er.decision IS NULL
        ORDER BY er.decision_deadline ASC;
      " 2>/dev/null | while IFS='|' read -r RID RSYM RQTR RIMP RDL; do
        echo "  $RID  $RSYM $RQTR ($RIMP) deadline: ${RDL:-none}"
      done
      exit 1
    fi

    # Verify review exists and is pending
    ER_CHECK=$(sqlite3 -separator '|' "$DB" "
      SELECT s.symbol, er.quarter, er.thesis_impact
      FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      WHERE er.id = '$ER_DEC_ID' AND er.decision IS NULL;
    " 2>/dev/null)
    if [ -z "$ER_CHECK" ]; then
      echo "ERROR: Review not found or already has a decision."
      exit 1
    fi
    ER_DEC_SYM=$(echo "$ER_CHECK" | cut -d'|' -f1)
    ER_DEC_QTR=$(echo "$ER_CHECK" | cut -d'|' -f2)
    ER_DEC_IMP=$(echo "$ER_CHECK" | cut -d'|' -f3)

    echo "=== Decide: $ER_DEC_SYM $ER_DEC_QTR (thesis: $ER_DEC_IMP) ==="
    echo ""
    echo "Decision:"
    echo "  1) hold"
    echo "  2) retier"
    echo "  3) exit"
    read -p "Select (1-3): " ER_DECIDE_NUM
    case "$ER_DECIDE_NUM" in
      1) ER_FINAL_DEC="hold" ;;
      2) ER_FINAL_DEC="retier" ;;
      3) ER_FINAL_DEC="exit" ;;
      *) echo "Invalid selection."; exit 1 ;;
    esac
    echo "Decision notes:"
    read -p "> " ER_FINAL_NOTES
    ER_FINAL_NOTES_ESC=$(echo "$ER_FINAL_NOTES" | sed "s/'/''/g")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    sqlite3 "$DB" "UPDATE earnings_reviews SET decision = '$ER_FINAL_DEC', decision_notes = '$ER_FINAL_NOTES_ESC', updated_at = '$NOW' WHERE id = '$ER_DEC_ID';"
    echo ""
    echo "Decision recorded: $ER_FINAL_DEC for $ER_DEC_SYM $ER_DEC_QTR"
    ;;

  reconcile)
    csv_path="$2"
    [ -z "$csv_path" ] && { echo "Usage: pm-cli.sh reconcile <csv_path>"; exit 1; }
    [ ! -f "$csv_path" ] && { echo "File not found: $csv_path"; exit 1; }

    CSV_PATH="$csv_path" DB_PATH="$DB" python3 << 'PYEOF'
import csv, sqlite3, uuid, sys, os, io, re
from datetime import datetime

csv_path = os.environ.get('CSV_PATH', '')
db_path = os.environ.get('DB_PATH', '')

if not csv_path or not os.path.isfile(csv_path):
    print(f"File not found: {csv_path}")
    sys.exit(1)

basename = os.path.basename(csv_path)

def parse_money(val):
    if not val or val == '--' or val.strip() == '':
        return None
    return float(val.replace('$', '').replace(',', ''))

def parse_pct(val):
    if not val or val == '--' or val.strip() == '':
        return None
    return float(val.replace('%', '').replace(',', ''))

# Read all lines (handle BOM)
with open(csv_path, 'r', encoding='utf-8-sig') as f:
    lines = f.readlines()

# Multi-section parser: Schwab "All Accounts" CSVs have repeated headers per account
# Format: title row, account header, CSV header, data rows, empty row, next account header, ...
records = []
current_account = None
i = 0
while i < len(lines):
    line = lines[i].strip().strip('"').strip(',').strip('"')

    # Skip empty lines
    if not line or all(c in ',"' for c in lines[i].strip()):
        i += 1
        continue

    # Detect account header lines (e.g. "Trading Book ...005", "Monica ...819", "Jia ...196")
    if '"Symbol"' not in lines[i] and 'Symbol' not in lines[i].split(',')[0]:
        # Not a CSV header or data — likely account name or title
        if re.search(r'\.\.\.\d{3}', line):
            # Account section header like "Trading Book ...005" or "Monica ...819"
            # Clean: take just the meaningful part before any empty CSV fields
            current_account = re.split(r'[",]+\s*$', line)[0].strip().strip('"')
        # else: title row or other non-data line
        i += 1
        continue

    # This is a CSV header row — collect data rows until next section
    header_line = lines[i]
    data_lines = [header_line]
    i += 1
    while i < len(lines):
        stripped = lines[i].strip()
        # Skip empty lines (all commas/quotes)
        if not stripped or all(c in ',"' for c in stripped):
            i += 1
            continue
        # Extract first field
        first_field = stripped.split(',')[0].strip('"')
        # Stop at header rows
        if first_field == 'Symbol':
            break
        # Stop at account header rows (e.g. "Monica ...819")
        if re.search(r'\.\.\.\d{3}', first_field):
            break
        if not first_field:
            i += 1
            continue
        data_lines.append(lines[i])
        i += 1

    # Parse this section
    reader = csv.DictReader(io.StringIO(''.join(data_lines)))
    for row in reader:
        symbol = row.get('Symbol', '').strip()
        if not symbol or symbol == '--' or symbol == 'Symbol':
            continue
        # Skip account header rows that leaked through (e.g. "Jia ...196")
        if re.search(r'\.\.\.\d{3}', symbol):
            continue

        records.append({
            'id': str(uuid.uuid4()),
            'symbol': symbol,
            'account_name': current_account,
            'open_date': row.get('Opened Date', row.get('Date Acquired', '')).strip() or None,
            'close_date': row.get('Closed Date', row.get('Date Sold', '')).strip() or None,
            'quantity': parse_money(row.get('Quantity', row.get('Qty', ''))),
            'cost_basis': parse_money(row.get('Cost Basis (CB)', row.get('Cost', ''))),
            'proceeds': parse_money(row.get('Proceeds', '')),
            'gain_loss': parse_money(row.get('Gain/Loss ($)', row.get('Gain/loss ($)', ''))),
            'gain_loss_pct': parse_pct(row.get('Gain/Loss (%)', row.get('Gain/loss (%)', ''))),
            'term': row.get('Term', '').strip() or None,
            'source_file': basename,
            'imported_at': datetime.now().isoformat()
        })

if not records:
    print("No records found in CSV")
    sys.exit(1)

# Import to DB
conn = sqlite3.connect(db_path)
conn.execute("""CREATE TABLE IF NOT EXISTS realized_pl_broker (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, account_name TEXT,
    open_date TEXT, close_date TEXT, quantity REAL, cost_basis REAL,
    proceeds REAL, gain_loss REAL, gain_loss_pct REAL, term TEXT,
    source_file TEXT, imported_at TEXT NOT NULL
)""")
conn.execute("CREATE INDEX IF NOT EXISTS idx_rpl_symbol ON realized_pl_broker(symbol)")
conn.execute("CREATE INDEX IF NOT EXISTS idx_rpl_close_date ON realized_pl_broker(close_date)")
# Add unique constraint on content to prevent re-import duplicates
try:
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_rpl_dedup ON realized_pl_broker(symbol, open_date, close_date, quantity, cost_basis, proceeds, account_name)")
except:
    pass

imported = 0
skipped = 0
for r in records:
    try:
        conn.execute("""INSERT INTO realized_pl_broker
            (id, symbol, account_name, open_date, close_date, quantity, cost_basis,
             proceeds, gain_loss, gain_loss_pct, term, source_file, imported_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r['id'], r['symbol'], r['account_name'], r['open_date'], r['close_date'],
             r['quantity'], r['cost_basis'], r['proceeds'], r['gain_loss'],
             r['gain_loss_pct'], r['term'], r['source_file'], r['imported_at']))
        imported += 1
    except sqlite3.IntegrityError:
        skipped += 1
conn.commit()
print(f"Imported {imported} lots from {basename}" + (f" (skipped {skipped} duplicates)" if skipped else ""))

# Show summary
cursor = conn.execute("""
    SELECT symbol, COUNT(*) as lots, printf('%.2f', SUM(gain_loss)) as total_pl,
           MIN(close_date) as first_close, MAX(close_date) as last_close
    FROM realized_pl_broker
    WHERE source_file = ?
    GROUP BY symbol ORDER BY SUM(gain_loss)
""", (basename,))
print(f"\n{'SYMBOL':<8} {'LOTS':>5} {'TOTAL P&L':>12} {'FIRST CLOSE':>12} {'LAST CLOSE':>12}")
print(f"{'------':<8} {'----':>5} {'---------':>12} {'-----------':>12} {'----------':>12}")
for row in cursor:
    print(f"{row[0]:<8} {row[1]:>5} {'$'+row[2]:>12} {row[3] or '':>12} {row[4] or '':>12}")

total = conn.execute("SELECT printf('%.2f', SUM(gain_loss)) FROM realized_pl_broker WHERE source_file = ?",
    (basename,)).fetchone()[0]
lot_count = conn.execute("SELECT COUNT(*) FROM realized_pl_broker WHERE source_file = ?",
    (basename,)).fetchone()[0]
print(f"\nTotal realized P&L: ${total}  ({lot_count} lots)")
conn.close()
PYEOF
    ;;

  broker-pl)
    symbol="$2"
    if [ -n "$symbol" ]; then
      symbol=$(echo "$symbol" | tr '[:lower:]' '[:upper:]')
      echo "=== Broker P&L: $symbol ==="
      sqlite3 -header -column "$DB" "
        SELECT open_date as 'Opened', close_date as 'Closed', quantity as 'Qty',
               printf('$%.2f', cost_basis) as 'Cost Basis',
               printf('$%.2f', proceeds) as 'Proceeds',
               printf('$%.2f', gain_loss) as 'P&L',
               term as 'Term', account_name as 'Account'
        FROM realized_pl_broker WHERE symbol='$symbol' ORDER BY close_date
      "
      echo ""
      sqlite3 -column "$DB" "
        SELECT printf('$%.2f', SUM(gain_loss)) as 'Total P&L',
               COUNT(*) as 'Lots',
               printf('$%.2f', SUM(cost_basis)) as 'Total Cost',
               printf('$%.2f', SUM(proceeds)) as 'Total Proceeds'
        FROM realized_pl_broker WHERE symbol='$symbol'
      "
    else
      echo "=== Broker Realized P&L Summary ==="
      sqlite3 -header -column "$DB" "
        SELECT symbol as Symbol, COUNT(*) as Lots,
               printf('$%.2f', SUM(gain_loss)) as 'Total P&L',
               MAX(close_date) as 'Last Close',
               account_name as Account
        FROM realized_pl_broker GROUP BY symbol, account_name ORDER BY SUM(gain_loss)
      "
      echo ""
      sqlite3 -column "$DB" "
        SELECT printf('$%.2f', SUM(gain_loss)) as 'Grand Total',
               COUNT(*) as 'Total Lots',
               COUNT(DISTINCT symbol) as Symbols
        FROM realized_pl_broker
      "
    fi
    ;;

  size)
    # Position sizing: target allocation, current vs target, entry plan with S/R tranches
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh size <symbol> [target_shares]"
      echo "  Shows current vs target sizing and suggests entry plan using S/R levels."
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    TARGET_SHARES="${3:-}"

    python3 - "$SYMBOL" "$TARGET_SHARES" "$DB" << 'PYEOF'
import sqlite3, sys

symbol = sys.argv[1]
target_shares_arg = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
db_path = sys.argv[3]

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Tier limits
TIER_LIMITS = {'Core': 25, 'Growth': 10, 'Starter': 5, 'Watchlist': 2}

# Get position info
pos = conn.execute("""
    SELECT p.id, p.quantity, p.cost_basis, s.id as sec_id, s.symbol, s.name,
           pi.tier, pi.thesis, pi.target_hold_period
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    LEFT JOIN position_intents pi ON pi.position_id = p.id
    WHERE s.symbol = ? AND s.type NOT IN ('cash', 'option')
""", (symbol,)).fetchall()

if not pos:
    print(f"  No position found for {symbol}")
    sys.exit(1)

# Aggregate across accounts
total_qty = sum(r['quantity'] or 0 for r in pos)
total_cost = sum(r['cost_basis'] or 0 for r in pos)
tier = pos[0]['tier'] or 'Starter'
tier_limit = TIER_LIMITS.get(tier, 5)

# Get current price
price_row = conn.execute("""
    SELECT ph.close_price, ph.date FROM price_history ph
    JOIN securities s ON ph.security_id = s.id
    WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
""", (symbol,)).fetchone()

if not price_row:
    print(f"  No price data for {symbol}")
    sys.exit(1)

current_price = price_row['close_price']
price_date = price_row['date']

# Compute portfolio total (all positions + cash)
portfolio_rows = conn.execute("""
    SELECT p.quantity, s.type, s.symbol,
           (SELECT ph2.close_price FROM price_history ph2
            WHERE ph2.security_id = p.security_id ORDER BY ph2.date DESC LIMIT 1) as last_price
    FROM positions p JOIN securities s ON p.security_id = s.id
""").fetchall()

portfolio_total = 0
for r in portfolio_rows:
    if r['type'] == 'cash':
        portfolio_total += r['quantity'] or 0
    elif r['last_price']:
        portfolio_total += (r['quantity'] or 0) * r['last_price']

if portfolio_total <= 0:
    print("  Cannot compute — portfolio total is 0")
    sys.exit(1)

# Current position sizing
current_mv = total_qty * current_price
current_pct = (current_mv / portfolio_total) * 100
avg_cost = total_cost / total_qty if total_qty > 0 else 0
unrealized_pct = ((current_price - avg_cost) / avg_cost * 100) if avg_cost > 0 else 0

# Target sizing
target_mv = portfolio_total * tier_limit / 100
target_shares_computed = int(target_mv / current_price)
room_mv = target_mv - current_mv
room_shares = int(room_mv / current_price) if room_mv > 0 else 0
room_pct = (room_mv / portfolio_total) * 100

# User override
if target_shares_arg:
    target_shares_final = int(target_shares_arg)
    target_mv_final = target_shares_final * current_price
    target_pct_final = (target_mv_final / portfolio_total) * 100
else:
    target_shares_final = target_shares_computed
    target_mv_final = target_mv
    target_pct_final = tier_limit

# Get S/R levels
levels = conn.execute("""
    SELECT level_type, price, strength FROM price_levels
    WHERE symbol = ? ORDER BY price
""", (symbol,)).fetchall()

supports = [r for r in levels if r['level_type'] == 'support' and r['price'] < current_price]
resistances = [r for r in levels if r['level_type'] == 'resistance' and r['price'] > current_price]
supports.sort(key=lambda r: r['price'], reverse=True)  # nearest first
resistances.sort(key=lambda r: r['price'])  # nearest first

# Print report
print()
print(f"╔═══════════════════════════════════════════════╗")
print(f"║  POSITION SIZING: {symbol:<28}║")
print(f"╚═══════════════════════════════════════════════╝")
print()
print(f"  Tier: {tier} (limit: {tier_limit}% of portfolio)")
print(f"  Price: ${current_price:.2f} (as of {price_date})")
print(f"  Portfolio total: ${portfolio_total:,.0f}")
print()

print(f"  ── Current Position ──")
print(f"  Shares: {total_qty:,.0f}")
print(f"  Avg cost: ${avg_cost:.2f}  ({unrealized_pct:+.1f}%)")
print(f"  Market value: ${current_mv:,.0f}")
print(f"  Weight: {current_pct:.1f}%")
print()

print(f"  ── Target ({tier} tier max: {tier_limit}%) ──")
if target_shares_arg:
    print(f"  Target (user): {target_shares_final:,} shares (${target_mv_final:,.0f}, {target_pct_final:.1f}%)")
else:
    print(f"  Target (max): {target_shares_final:,} shares (${target_mv_final:,.0f})")

if room_mv > 0:
    print(f"  Room to add: {room_shares:,} shares (${room_mv:,.0f}, {room_pct:.1f}% of portfolio)")
elif room_mv < 0:
    over_pct = current_pct - tier_limit
    print(f"  ⚠ OVER-ALLOCATED by {over_pct:.1f}% (${-room_mv:,.0f})")
else:
    print(f"  At target allocation")
print()

# Entry plan using S/R levels
if room_mv > 0 and (supports or current_price):
    print(f"  ── Entry Plan (suggested tranches) ──")

    add_shares = room_shares if not target_shares_arg else max(0, target_shares_final - int(total_qty))

    if add_shares <= 0:
        print(f"  Already at or above target. No adds suggested.")
    else:
        tranches = []
        remaining = add_shares

        if supports:
            # Tranche 1: 25% at S1 (nearest support)
            s1 = supports[0]
            t1_shares = max(1, int(add_shares * 0.25))
            t1_pct = (current_price - s1['price']) / current_price * 100
            tranches.append((f"S1 ${s1['price']:.2f}", t1_shares, s1['price'], s1['strength'], t1_pct))
            remaining -= t1_shares

            if len(supports) >= 2:
                # Tranche 2: 25% at S2
                s2 = supports[1]
                t2_shares = max(1, int(add_shares * 0.25))
                t2_pct = (current_price - s2['price']) / current_price * 100
                tranches.append((f"S2 ${s2['price']:.2f}", t2_shares, s2['price'], s2['strength'], t2_pct))
                remaining -= t2_shares

            # Tranche 3: remaining on thesis confirmation (at current price)
            if remaining > 0:
                tranches.append((f"Thesis confirm", remaining, current_price, None, 0))
        else:
            # No S/R levels — split into 3 equal tranches by dollar amount
            t_size = max(1, add_shares // 3)
            tranches.append(("Now (1/3)", t_size, current_price, None, 0))
            tranches.append(("Dip -3%", t_size, current_price * 0.97, None, 3.0))
            if add_shares - 2 * t_size > 0:
                tranches.append(("Dip -5%", add_shares - 2 * t_size, current_price * 0.95, None, 5.0))

        print(f"  {'TRANCHE':<22} {'SHARES':>7} {'PRICE':>10} {'VALUE':>12} {'FROM HERE':>10} {'STR':>4}")
        print(f"  {'─'*22} {'─'*7} {'─'*10} {'─'*12} {'─'*10} {'─'*4}")
        total_cost_plan = 0
        for label, shares, price, strength, pct_from in tranches:
            value = shares * price
            total_cost_plan += value
            str_label = str(strength) if strength else "—"
            pct_label = f"-{pct_from:.1f}%" if pct_from > 0 else "at mkt"
            print(f"  {label:<22} {shares:>7,} {price:>10.2f} {value:>11,.0f} {pct_label:>10} {str_label:>4}")

        print(f"  {'─'*22} {'─'*7} {'─'*10} {'─'*12}")
        print(f"  {'TOTAL':<22} {add_shares:>7,} {'':>10} {total_cost_plan:>11,.0f}")

        # After-add weight
        after_mv = current_mv + total_cost_plan
        after_pct = (after_mv / portfolio_total) * 100
        print(f"\n  After adds: {total_qty + add_shares:,.0f} shares, ${after_mv:,.0f} ({after_pct:.1f}%)")

elif room_mv < 0:
    print(f"  ── Trim Suggestion ──")
    trim_shares = int(-room_mv / current_price)
    print(f"  Trim {trim_shares:,} shares (${-room_mv:,.0f}) to reach {tier_limit}% target")
    if resistances:
        r1 = resistances[0]
        r1_pct = (r1['price'] - current_price) / current_price * 100
        print(f"  Consider trimming at R1 ${r1['price']:.2f} ({r1_pct:+.1f}%, strength {r1['strength']})")

# S/R context
if supports or resistances:
    print(f"\n  ── S/R Context ──")
    for s in supports[:3]:
        pct = (current_price - s['price']) / current_price * 100
        print(f"  S: ${s['price']:.2f} ({pct:.1f}% below, str {s['strength']})")
    for r in resistances[:3]:
        pct = (r['price'] - current_price) / current_price * 100
        print(f"  R: ${r['price']:.2f} ({pct:.1f}% above, str {r['strength']})")

print()
conn.close()
PYEOF
    ;;

  plan)
    # Entry plan: create/view/manage entry plans for a symbol
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh plan <symbol>"
      echo "  View or create an entry plan with tranches and auto-monitors."
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Ensure tables exist
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS entry_plans (
        id TEXT PRIMARY KEY, security_id TEXT NOT NULL, target_allocation_pct REAL,
        status TEXT NOT NULL DEFAULT 'active', notes TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (security_id) REFERENCES securities(id)
      );
      CREATE TABLE IF NOT EXISTS entry_plan_tranches (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, tranche_number INTEGER NOT NULL,
        trigger_price REAL NOT NULL, shares INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', monitor_id TEXT,
        filled_at TEXT, filled_price REAL, notes TEXT,
        FOREIGN KEY (plan_id) REFERENCES entry_plans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ep_security ON entry_plans(security_id);
      CREATE INDEX IF NOT EXISTS idx_ept_plan ON entry_plan_tranches(plan_id);
    "

    python3 - "$SYMBOL" "$DB" << 'PYEOF'
import sqlite3, sys, uuid
from datetime import datetime

symbol = sys.argv[1]
db_path = sys.argv[2]

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Check for active plan
plan = conn.execute("""
    SELECT ep.*, s.symbol FROM entry_plans ep
    JOIN securities s ON ep.security_id = s.id
    WHERE s.symbol = ? AND ep.status = 'active'
    ORDER BY ep.created_at DESC LIMIT 1
""", (symbol,)).fetchone()

if plan:
    # Display existing plan
    print()
    print(f"╔═══════════════════════════════════════════════╗")
    print(f"║  ENTRY PLAN: {symbol:<33}║")
    print(f"╚═══════════════════════════════════════════════╝")
    print()
    target = f"{plan['target_allocation_pct']:.1f}%" if plan['target_allocation_pct'] else "not set"
    print(f"  Target allocation: {target}")
    print(f"  Status: {plan['status']}")
    if plan['notes']:
        print(f"  Notes: {plan['notes']}")
    print(f"  Created: {plan['created_at'][:10]}")
    print()

    tranches = conn.execute("""
        SELECT * FROM entry_plan_tranches WHERE plan_id = ? ORDER BY tranche_number
    """, (plan['id'],)).fetchall()

    print(f"  {'#':<4} {'STATUS':<12} {'TRIGGER':>10} {'SHARES':>8} {'VALUE':>12} {'FILLED':>12} {'MONITOR'}")
    print(f"  {'─'*4} {'─'*12} {'─'*10} {'─'*8} {'─'*12} {'─'*12} {'─'*10}")
    for t in tranches:
        value = t['trigger_price'] * t['shares']
        filled_info = ""
        if t['filled_price']:
            filled_info = f"${t['filled_price']:.2f}"
        elif t['filled_at']:
            filled_info = t['filled_at'][:10]
        monitor_status = ""
        if t['monitor_id']:
            mon = conn.execute("SELECT status FROM monitors WHERE id = ?", (t['monitor_id'],)).fetchone()
            monitor_status = mon['status'] if mon else "?"
        print(f"  {t['tranche_number']:<4} {t['status']:<12} ${t['trigger_price']:>9.2f} {t['shares']:>8,} ${value:>11,.0f} {filled_info:>12} {monitor_status}")

    print()
    print(f"  Use 'plan-fill <tranche_id> [price]' to mark a tranche as filled.")
    print(f"  Use 'plan-cancel {symbol}' to cancel this plan.")
    print()
else:
    # Create new plan
    sec = conn.execute("SELECT id FROM securities WHERE symbol = ?", (symbol,)).fetchone()
    if not sec:
        print(f"  Security not found: {symbol}")
        sys.exit(1)

    # Get position info
    TIER_LIMITS = {'Core': 25, 'Growth': 10, 'Starter': 5, 'Watchlist': 2}
    pos = conn.execute("""
        SELECT p.quantity, p.cost_basis, pi.tier, pi.target_allocation_pct
        FROM positions p
        JOIN securities s ON p.security_id = s.id
        LEFT JOIN position_intents pi ON pi.position_id = p.id
        WHERE s.symbol = ? AND s.type NOT IN ('cash', 'option')
    """, (symbol,)).fetchall()

    total_qty = sum(r['quantity'] or 0 for r in pos) if pos else 0
    tier = pos[0]['tier'] if pos and pos[0]['tier'] else 'Starter'
    existing_target_pct = pos[0]['target_allocation_pct'] if pos and pos[0]['target_allocation_pct'] else None
    tier_limit = TIER_LIMITS.get(tier, 5)

    # Get current price
    price_row = conn.execute("""
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
    """, (symbol,)).fetchone()
    if not price_row:
        print(f"  No price data for {symbol}")
        sys.exit(1)
    current_price = price_row['close_price']

    # Portfolio total
    portfolio_rows = conn.execute("""
        SELECT p.quantity, s.type,
               (SELECT ph2.close_price FROM price_history ph2
                WHERE ph2.security_id = p.security_id ORDER BY ph2.date DESC LIMIT 1) as last_price
        FROM positions p JOIN securities s ON p.security_id = s.id
    """).fetchall()
    portfolio_total = sum(
        (r['quantity'] or 0) if r['type'] == 'cash'
        else (r['quantity'] or 0) * (r['last_price'] or 0)
        for r in portfolio_rows
    )

    current_mv = total_qty * current_price
    current_pct = (current_mv / portfolio_total * 100) if portfolio_total > 0 else 0

    # Get S/R levels
    levels = conn.execute("SELECT level_type, price, strength FROM price_levels WHERE symbol = ? ORDER BY price", (symbol,)).fetchall()
    supports = sorted([r for r in levels if r['level_type'] == 'support' and r['price'] < current_price], key=lambda r: r['price'], reverse=True)

    print()
    print(f"╔═══════════════════════════════════════════════╗")
    print(f"║  CREATE ENTRY PLAN: {symbol:<26}║")
    print(f"╚═══════════════════════════════════════════════╝")
    print()
    print(f"  Current: {total_qty:,.0f} shares, ${current_mv:,.0f} ({current_pct:.1f}%)")
    print(f"  Tier: {tier} (max: {tier_limit}%)")
    print(f"  Price: ${current_price:.2f}")
    if existing_target_pct:
        print(f"  Intent target: {existing_target_pct:.1f}%")
    print()

    # Prompt for target
    default_target = existing_target_pct or tier_limit
    target_input = input(f"  Target allocation % (default {default_target:.1f}%): ").strip()
    target_pct = float(target_input) if target_input else default_target

    # Compute shares to add
    target_mv = portfolio_total * target_pct / 100
    room_mv = target_mv - current_mv
    if room_mv <= 0:
        print(f"  Already at or above target ({current_pct:.1f}% >= {target_pct:.1f}%). No plan needed.")
        sys.exit(0)
    add_shares = int(room_mv / current_price)

    print(f"  Room to add: {add_shares:,} shares (${room_mv:,.0f})")
    print()

    # Prompt for tranches
    num_input = input(f"  How many tranches? (default 2): ").strip()
    num_tranches = int(num_input) if num_input else 2

    tranches = []
    remaining = add_shares

    for i in range(num_tranches):
        is_last = (i == num_tranches - 1)
        default_shares = remaining if is_last else max(1, add_shares // num_tranches)

        # Suggest price from S/R levels
        if i < len(supports):
            suggested_price = supports[i]['price']
            suggested_str = f"S{i+1} ${suggested_price:.2f}, str {supports[i]['strength']}"
        elif i == 0:
            suggested_price = current_price
            suggested_str = f"at market ${suggested_price:.2f}"
        else:
            pct_drop = 3 * (i + 1)
            suggested_price = round(current_price * (1 - pct_drop / 100), 2)
            suggested_str = f"-{pct_drop}% = ${suggested_price:.2f}"

        price_input = input(f"  Tranche {i+1} trigger price ({suggested_str}): ").strip()
        tranche_price = float(price_input) if price_input else suggested_price

        shares_input = input(f"  Tranche {i+1} shares (default {default_shares:,}): ").strip()
        tranche_shares = int(shares_input) if shares_input else default_shares

        tranches.append({
            'tranche_number': i + 1,
            'trigger_price': tranche_price,
            'shares': tranche_shares,
        })
        remaining -= tranche_shares

    # Confirm
    print()
    print(f"  ── Plan Summary ──")
    total_plan_cost = 0
    for t in tranches:
        v = t['trigger_price'] * t['shares']
        total_plan_cost += v
        print(f"  T{t['tranche_number']}: {t['shares']:,} shares at ${t['trigger_price']:.2f} (${v:,.0f})")
    print(f"  Total: ${total_plan_cost:,.0f}")
    after_pct = ((current_mv + total_plan_cost) / portfolio_total * 100) if portfolio_total > 0 else 0
    print(f"  After fills: {after_pct:.1f}% of portfolio")
    print()

    confirm = input("  Create plan and monitors? (y/n): ").strip().lower()
    if confirm != 'y':
        print("  Cancelled.")
        sys.exit(0)

    # Create plan
    now = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')
    plan_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO entry_plans (id, security_id, target_allocation_pct, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
    """, (plan_id, sec['id'], target_pct, now, now))

    for t in tranches:
        tranche_id = str(uuid.uuid4())
        monitor_id = str(uuid.uuid4())

        # Create monitor
        conn.execute("""
            INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, monitor_type, status, created_at, updated_at)
            VALUES (?, ?, 'below', ?, ?, 'action_required', 'price', 'active', ?, ?)
        """, (monitor_id, symbol, t['trigger_price'],
              f"Entry plan tranche {t['tranche_number']}: buy {t['shares']} shares at ${t['trigger_price']:.2f}",
              now, now))

        # Create tranche
        conn.execute("""
            INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status, monitor_id)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
        """, (tranche_id, plan_id, t['tranche_number'], t['trigger_price'], t['shares'], monitor_id))

    conn.commit()
    print(f"  ✓ Entry plan created with {len(tranches)} tranches and monitors.")
    print()

conn.close()
PYEOF
    ;;

  plans)
    # List all active entry plans
    echo ""
    echo "=== Active Entry Plans ==="
    sqlite3 -header -column "$DB" "
      SELECT s.symbol, ep.target_allocation_pct as target_pct, ep.status,
             (SELECT COUNT(*) FROM entry_plan_tranches t WHERE t.plan_id = ep.id AND t.status = 'pending') as pending,
             (SELECT COUNT(*) FROM entry_plan_tranches t WHERE t.plan_id = ep.id AND t.status = 'filled') as filled,
             (SELECT COUNT(*) FROM entry_plan_tranches t WHERE t.plan_id = ep.id) as total,
             ep.created_at
      FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      WHERE ep.status = 'active'
      ORDER BY ep.created_at DESC;
    "
    echo ""
    # Also show completed/cancelled plans
    INACTIVE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plans WHERE status != 'active'")
    if [ "$INACTIVE" -gt 0 ]; then
      echo "  ($INACTIVE inactive plans — use 'plans all' to see)"
    fi
    if [ "${2:-}" = "all" ]; then
      echo ""
      echo "=== All Entry Plans ==="
      sqlite3 -header -column "$DB" "
        SELECT s.symbol, ep.target_allocation_pct as target_pct, ep.status,
               (SELECT COUNT(*) FROM entry_plan_tranches t WHERE t.plan_id = ep.id AND t.status = 'filled') as filled,
               (SELECT COUNT(*) FROM entry_plan_tranches t WHERE t.plan_id = ep.id) as total,
               ep.created_at
        FROM entry_plans ep
        JOIN securities s ON ep.security_id = s.id
        ORDER BY ep.created_at DESC;
      "
    fi
    ;;

  plan-fill)
    # Mark a tranche as filled
    TRANCHE_ID="$2"
    FILL_PRICE="${3:-}"
    if [ -z "$TRANCHE_ID" ]; then
      echo "Usage: pm-cli.sh plan-fill <tranche_id> [price]"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Get tranche info
    TRANCHE_EXISTS=$(sqlite3 "$DB" "SELECT id FROM entry_plan_tranches WHERE id = '$TRANCHE_ID'")
    if [ -z "$TRANCHE_EXISTS" ]; then
      echo "  Tranche not found: $TRANCHE_ID"
      exit 1
    fi

    PLAN_ID=$(sqlite3 "$DB" "SELECT plan_id FROM entry_plan_tranches WHERE id = '$TRANCHE_ID'")
    TRIGGER_PRICE=$(sqlite3 "$DB" "SELECT trigger_price FROM entry_plan_tranches WHERE id = '$TRANCHE_ID'")
    MONITOR_ID=$(sqlite3 "$DB" "SELECT monitor_id FROM entry_plan_tranches WHERE id = '$TRANCHE_ID'")

    # Use fill price or trigger price
    ACTUAL_PRICE="${FILL_PRICE:-$TRIGGER_PRICE}"

    sqlite3 "$DB" "UPDATE entry_plan_tranches SET status = 'filled', filled_at = '$NOW', filled_price = $ACTUAL_PRICE WHERE id = '$TRANCHE_ID'"

    # Dismiss the linked monitor
    if [ -n "$MONITOR_ID" ]; then
      sqlite3 "$DB" "UPDATE monitors SET status = 'dismissed', updated_at = '$NOW' WHERE id = '$MONITOR_ID'"
    fi

    # Check if all tranches are filled — if so, mark plan as completed
    PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches WHERE plan_id = '$PLAN_ID' AND status = 'pending'")
    if [ "$PENDING" = "0" ]; then
      sqlite3 "$DB" "UPDATE entry_plans SET status = 'completed', updated_at = '$NOW' WHERE id = '$PLAN_ID'"
      echo "  ✓ Tranche filled at \$$ACTUAL_PRICE. All tranches filled — plan completed!"
    else
      echo "  ✓ Tranche filled at \$$ACTUAL_PRICE. $PENDING tranches remaining."
    fi
    ;;

  plan-cancel)
    # Cancel active plan for a symbol
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh plan-cancel <symbol>"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    PLAN_ID=$(sqlite3 "$DB" "
      SELECT ep.id FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      WHERE s.symbol = '$SYMBOL' AND ep.status = 'active'
      ORDER BY ep.created_at DESC LIMIT 1
    ")

    if [ -z "$PLAN_ID" ]; then
      echo "  No active entry plan for $SYMBOL"
      exit 1
    fi

    # Dismiss monitors for pending tranches
    sqlite3 "$DB" "
      UPDATE monitors SET status = 'dismissed', updated_at = '$NOW'
      WHERE id IN (
        SELECT monitor_id FROM entry_plan_tranches
        WHERE plan_id = '$PLAN_ID' AND status = 'pending' AND monitor_id IS NOT NULL
      );
    "

    # Cancel pending tranches
    sqlite3 "$DB" "UPDATE entry_plan_tranches SET status = 'cancelled' WHERE plan_id = '$PLAN_ID' AND status = 'pending'"

    # Cancel plan
    sqlite3 "$DB" "UPDATE entry_plans SET status = 'cancelled', updated_at = '$NOW' WHERE id = '$PLAN_ID'"

    echo "  ✓ Entry plan for $SYMBOL cancelled."
    ;;

  basket-create)
    BASKET_NAME="$2"
    if [ -z "$BASKET_NAME" ]; then
      echo "Usage: pm-cli.sh basket-create <name>"
      exit 1
    fi
    EXISTING=$(sqlite3 "$DB" "SELECT id FROM rebalance_baskets WHERE name = '$BASKET_NAME';")
    if [ -n "$EXISTING" ]; then
      echo "Error: Basket '$BASKET_NAME' already exists (id: $EXISTING)"
      exit 1
    fi
    BASKET_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    sqlite3 "$DB" "INSERT INTO rebalance_baskets (id, name, status, created_at, updated_at) VALUES ('$BASKET_ID', '$BASKET_NAME', 'active', '$NOW', '$NOW');"
    echo "Basket created: $BASKET_NAME (id: $BASKET_ID)"
    ;;

  basket-add)
    # Add an entry plan with tranches to a basket
    # Usage: basket-add <basket> <buy|sell> <symbol> <total_shares> <num_tranches> <date|price> <trigger_values> [options]
    # Options: --invalidation <text> --invalidation-price <sym> <dir> <price> --account <acct_suffix>
    shift # consume 'basket-add'
    if [ $# -lt 7 ]; then
      echo "Usage: pm-cli.sh basket-add <basket> <buy|sell> <symbol> <total_shares> <num_tranches> <date|price> <trigger_values> [--invalidation <text>] [--invalidation-price <sym> <dir> <price>] [--account <acct>]"
      echo ""
      echo "Examples:"
      echo "  basket-add rebal sell AAPL 80 1 date 2026-03-17 --account 8819"
      echo "  basket-add rebal buy AMZN 241 6 date 2026-03-31,2026-04-07,2026-04-14,2026-04-21,2026-04-28,2026-05-05 --account 6196"
      echo "  basket-add rebal buy AMZN 40 1 price 190 --account 6196 --invalidation \"AWS growth single digits\""
      exit 1
    fi

    BASKET_NAME="$1"; shift
    SIDE=$(echo "$1" | tr '[:upper:]' '[:lower:]'); shift
    SYMBOL=$(echo "$1" | tr '[:lower:]' '[:upper:]'); shift
    TOTAL_SHARES="$1"; shift
    NUM_TRANCHES="$1"; shift
    TRIGGER_TYPE=$(echo "$1" | tr '[:upper:]' '[:lower:]'); shift
    TRIGGER_VALUES="$1"; shift

    # Parse optional flags
    INVALIDATION_TEXT=""
    INVAL_SYMBOL=""
    INVAL_DIR=""
    INVAL_PRICE=""
    ACCOUNT_SUFFIX=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --invalidation)
          shift; INVALIDATION_TEXT="$1"; shift ;;
        --invalidation-price)
          shift; INVAL_SYMBOL=$(echo "$1" | tr '[:lower:]' '[:upper:]'); shift
          INVAL_DIR="$1"; shift
          INVAL_PRICE="$1"; shift ;;
        --account)
          shift; ACCOUNT_SUFFIX="$1"; shift ;;
        *)
          echo "Unknown option: $1"; exit 1 ;;
      esac
    done

    # Ensure schema columns exist (migrations may not have run from Electron app)
    sqlite3 "$DB" "ALTER TABLE entry_plans ADD COLUMN basket_id TEXT REFERENCES rebalance_baskets(id);" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plans ADD COLUMN side TEXT;" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plans ADD COLUMN invalidation_condition TEXT;" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plans ADD COLUMN invalidation_monitor_id TEXT;" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plan_tranches ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'price';" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plan_tranches ADD COLUMN trigger_date TEXT;" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plan_tranches ADD COLUMN limit_price REAL;" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plan_tranches ADD COLUMN brokerage_order_id TEXT;" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plan_tranches ADD COLUMN brokerage_order_status TEXT;" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plan_tranches ADD COLUMN filled_qty REAL DEFAULT 0;" 2>/dev/null || true
    sqlite3 "$DB" "ALTER TABLE entry_plan_tranches ADD COLUMN account_id TEXT;" 2>/dev/null || true

    # Validate side
    if [ "$SIDE" != "buy" ] && [ "$SIDE" != "sell" ]; then
      echo "Error: side must be 'buy' or 'sell', got '$SIDE'"
      exit 1
    fi

    # Validate trigger type
    if [ "$TRIGGER_TYPE" != "date" ] && [ "$TRIGGER_TYPE" != "price" ]; then
      echo "Error: trigger type must be 'date' or 'price', got '$TRIGGER_TYPE'"
      exit 1
    fi

    # Validate basket exists and is active
    BASKET_ID=$(sqlite3 "$DB" "SELECT id FROM rebalance_baskets WHERE name = '$BASKET_NAME' AND status = 'active';")
    if [ -z "$BASKET_ID" ]; then
      echo "Error: Active basket '$BASKET_NAME' not found"
      exit 1
    fi

    # Look up security
    SECURITY_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL';")
    if [ -z "$SECURITY_ID" ]; then
      echo "Error: Security '$SYMBOL' not found"
      exit 1
    fi

    # Resolve account if provided
    ACCOUNT_ID=""
    if [ -n "$ACCOUNT_SUFFIX" ]; then
      ACCOUNT_ID=$(sqlite3 "$DB" "SELECT id FROM accounts WHERE account_number LIKE '%$ACCOUNT_SUFFIX';")
      if [ -z "$ACCOUNT_ID" ]; then
        echo "Error: No account ending in '$ACCOUNT_SUFFIX'"
        exit 1
      fi
    fi

    # Parse trigger values into array
    IFS=',' read -ra TRIGGERS <<< "$TRIGGER_VALUES"

    # Validate trigger count matches num_tranches
    if [ "${#TRIGGERS[@]}" -ne 1 ] && [ "${#TRIGGERS[@]}" -ne "$NUM_TRANCHES" ]; then
      echo "Error: Number of trigger values (${#TRIGGERS[@]}) must be 1 or match num_tranches ($NUM_TRANCHES)"
      exit 1
    fi

    # Calculate shares per tranche
    SHARES_PER=$(( TOTAL_SHARES / NUM_TRANCHES ))
    REMAINDER=$(( TOTAL_SHARES % NUM_TRANCHES ))

    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    PLAN_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

    # Create invalidation monitor if --invalidation-price provided
    INVAL_MONITOR_ID=""
    if [ -n "$INVAL_SYMBOL" ] && [ -n "$INVAL_DIR" ] && [ -n "$INVAL_PRICE" ]; then
      INVAL_MONITOR_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
      sqlite3 "$DB" "INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, monitor_type, status, created_at, updated_at) VALUES ('$INVAL_MONITOR_ID', '$INVAL_SYMBOL', '$INVAL_DIR', $INVAL_PRICE, 'EMS invalidation: $SYMBOL $SIDE plan', 'action_required', 'price', 'active', '$NOW', '$NOW');"
    fi

    # Escape invalidation text for SQL
    INVAL_SQL="NULL"
    if [ -n "$INVALIDATION_TEXT" ]; then
      ESCAPED_INVAL=$(echo "$INVALIDATION_TEXT" | sed "s/'/''/g")
      INVAL_SQL="'$ESCAPED_INVAL'"
    fi

    INVAL_MON_SQL="NULL"
    if [ -n "$INVAL_MONITOR_ID" ]; then
      INVAL_MON_SQL="'$INVAL_MONITOR_ID'"
    fi

    # Insert entry plan
    sqlite3 "$DB" "INSERT INTO entry_plans (id, security_id, basket_id, side, invalidation_condition, invalidation_monitor_id, status, notes, created_at, updated_at) VALUES ('$PLAN_ID', '$SECURITY_ID', '$BASKET_ID', '$SIDE', $INVAL_SQL, $INVAL_MON_SQL, 'active', NULL, '$NOW', '$NOW');"

    echo ""
    echo "=== Basket Add: $SYMBOL $SIDE ==="
    echo "  Basket: $BASKET_NAME"
    echo "  Side: $SIDE"
    echo "  Total shares: $TOTAL_SHARES across $NUM_TRANCHES tranche(s)"
    if [ -n "$INVALIDATION_TEXT" ]; then
      echo "  Invalidation: $INVALIDATION_TEXT"
    fi
    echo ""

    # Create tranches
    for (( i=1; i<=NUM_TRANCHES; i++ )); do
      TRANCHE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

      # Shares: last tranche gets remainder
      if [ "$i" -eq "$NUM_TRANCHES" ]; then
        T_SHARES=$(( SHARES_PER + REMAINDER ))
      else
        T_SHARES=$SHARES_PER
      fi

      # Resolve trigger value: use single value if only one provided, otherwise index
      if [ "${#TRIGGERS[@]}" -eq 1 ]; then
        TRIG_VAL="${TRIGGERS[0]}"
      else
        TRIG_VAL="${TRIGGERS[$((i-1))]}"
      fi

      ACCT_SQL="NULL"
      if [ -n "$ACCOUNT_ID" ]; then
        ACCT_SQL="'$ACCOUNT_ID'"
      fi

      if [ "$TRIGGER_TYPE" = "date" ]; then
        # Date-triggered tranche: no monitor, trigger_price=0 (NOT NULL constraint)
        sqlite3 "$DB" "INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_type, trigger_date, trigger_price, shares, status, account_id) VALUES ('$TRANCHE_ID', '$PLAN_ID', $i, 'date', '$TRIG_VAL', 0, $T_SHARES, 'pending', $ACCT_SQL);"
        echo "  Tranche $i: $T_SHARES shares, date trigger $TRIG_VAL"
      else
        # Price-triggered tranche: create monitor
        MONITOR_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
        if [ "$SIDE" = "buy" ]; then
          DIRECTION="below"
        else
          DIRECTION="above"
        fi
        sqlite3 "$DB" "INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, monitor_type, status, created_at, updated_at) VALUES ('$MONITOR_ID', '$SYMBOL', '$DIRECTION', $TRIG_VAL, 'EMS $SIDE $SYMBOL T$i: $T_SHARES shares @ \$$TRIG_VAL', 'action_required', 'price', 'active', '$NOW', '$NOW');"
        sqlite3 "$DB" "INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_type, trigger_price, shares, status, monitor_id, account_id) VALUES ('$TRANCHE_ID', '$PLAN_ID', $i, 'price', $TRIG_VAL, $T_SHARES, 'pending', '$MONITOR_ID', $ACCT_SQL);"
        echo "  Tranche $i: $T_SHARES shares, price trigger \$$TRIG_VAL ($DIRECTION), monitor created"
      fi
    done

    echo ""
    echo "  Plan ID: $PLAN_ID"
    echo "  Done. Use 'pm-cli.sh basket $BASKET_NAME' to view."
    ;;

  baskets)
    echo "=== Rebalance Baskets ==="
    sqlite3 -header -column "$DB" "
      SELECT rb.name, rb.status,
        COUNT(DISTINCT ep.id) as plans,
        SUM(CASE WHEN ept.status = 'filled' THEN 1 ELSE 0 END) as filled,
        SUM(CASE WHEN ept.status = 'submitted' THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN ept.status = 'triggered' THEN 1 ELSE 0 END) as triggered,
        SUM(CASE WHEN ept.status = 'pending' THEN 1 ELSE 0 END) as pending,
        rb.created_at
      FROM rebalance_baskets rb
      LEFT JOIN entry_plans ep ON ep.basket_id = rb.id
      LEFT JOIN entry_plan_tranches ept ON ept.plan_id = ep.id
      GROUP BY rb.id
      ORDER BY rb.created_at DESC;
    "
    ;;

  basket)
    BASKET_NAME="$2"
    if [ -z "$BASKET_NAME" ]; then
      echo "Usage: pm-cli.sh basket <name>"
      exit 1
    fi
    BASKET_ID=$(sqlite3 "$DB" "SELECT id FROM rebalance_baskets WHERE name = '$BASKET_NAME';")
    if [ -z "$BASKET_ID" ]; then
      echo "Error: Basket '$BASKET_NAME' not found"
      exit 1
    fi
    BASKET_STATUS=$(sqlite3 "$DB" "SELECT status FROM rebalance_baskets WHERE id = '$BASKET_ID';")
    echo "=== Basket: $BASKET_NAME ($BASKET_STATUS) ==="
    echo ""
    echo "--- Orders by Symbol ---"
    sqlite3 -header -column "$DB" "
      SELECT s.symbol, ep.side,
        SUM(ept.shares) as total_shares,
        SUM(CASE WHEN ept.status = 'filled' THEN ept.filled_qty ELSE 0 END) as filled_shares,
        SUM(CASE WHEN ept.status IN ('pending','triggered') THEN ept.shares ELSE 0 END) as remaining_shares,
        COUNT(ept.id) as tranches,
        SUM(CASE WHEN ept.status = 'filled' THEN 1 ELSE 0 END) as filled_ct,
        SUM(CASE WHEN ept.status = 'submitted' THEN 1 ELSE 0 END) as submitted_ct,
        SUM(CASE WHEN ept.status = 'triggered' THEN 1 ELSE 0 END) as triggered_ct,
        SUM(CASE WHEN ept.status = 'pending' THEN 1 ELSE 0 END) as pending_ct
      FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      JOIN entry_plan_tranches ept ON ept.plan_id = ep.id
      WHERE ep.basket_id = '$BASKET_ID'
      GROUP BY ep.id
      ORDER BY ep.side, s.symbol;
    "
    echo ""
    echo "--- Tranche Detail ---"
    sqlite3 -header -column "$DB" "
      SELECT s.symbol, ep.side, ept.tranche_number as '#',
        ept.trigger_type as trig_type,
        COALESCE(ept.trigger_date, '\$' || printf('%.2f', ept.trigger_price)) as trigger,
        ept.shares as qty,
        ept.status,
        CASE WHEN ept.limit_price IS NOT NULL THEN '\$' || printf('%.2f', ept.limit_price) ELSE '' END as limit_px,
        CASE WHEN ept.filled_price IS NOT NULL THEN '\$' || printf('%.2f', ept.filled_price) ELSE '' END as fill_px,
        COALESCE(ept.filled_qty, 0) as fill_qty,
        COALESCE(ept.brokerage_order_status, '') as broker_status,
        substr(ept.id, 1, 8) as tranche_id
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      WHERE ep.basket_id = '$BASKET_ID'
      ORDER BY ep.side DESC, s.symbol, ept.tranche_number;
    "
    ;;

  basket-orders)
    BASKET_NAME="$2"
    BASKET_FILTER=""
    if [ -n "$BASKET_NAME" ]; then
      BASKET_ID=$(sqlite3 "$DB" "SELECT id FROM rebalance_baskets WHERE name = '$BASKET_NAME';")
      if [ -z "$BASKET_ID" ]; then
        echo "Error: Basket '$BASKET_NAME' not found"; exit 1
      fi
      BASKET_FILTER="AND ep.basket_id = '$BASKET_ID'"
    fi

    echo "=== Triggered Orders Awaiting Confirmation ==="
    sqlite3 -header -column "$DB" "
      SELECT substr(ept.id, 1, 8) as tranche_id,
        rb.name as basket,
        ep.side,
        s.symbol,
        ept.tranche_number as '#',
        ept.shares as qty,
        ept.trigger_type as trig,
        COALESCE(ept.trigger_date, '\$' || printf('%.2f', ept.trigger_price)) as trigger,
        COALESCE('\$' || printf('%.2f', (SELECT ph.close_price FROM price_history ph JOIN securities s2 ON ph.security_id = s2.id WHERE s2.symbol = s.symbol ORDER BY ph.date DESC LIMIT 1)), '?') as last_price,
        COALESCE(a.account_number, 'unset') as account
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN rebalance_baskets rb ON ep.basket_id = rb.id
      LEFT JOIN accounts a ON ept.account_id = a.id
      WHERE ept.status = 'triggered' $BASKET_FILTER
      ORDER BY s.symbol, ept.tranche_number;
    "
    TRIGGERED_COUNT=$(sqlite3 "$DB" "
      SELECT COUNT(*) FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      WHERE ept.status = 'triggered' $BASKET_FILTER;
    ")
    echo ""
    if [ "$TRIGGERED_COUNT" -gt 0 ]; then
      echo "$TRIGGERED_COUNT order(s) awaiting confirmation."
      echo "Confirm: pm-cli.sh basket-confirm <tranche_id> [limit_price]"
    else
      echo "No triggered orders awaiting confirmation."
    fi
    ;;

  basket-confirm)
    TRANCHE_PREFIX="$2"
    USER_LIMIT_PRICE="$3"
    if [ -z "$TRANCHE_PREFIX" ]; then
      echo "Usage: pm-cli.sh basket-confirm <tranche_id_prefix> [limit_price]"
      echo "  Use 'basket-orders' to see triggered tranches and their IDs."
      exit 1
    fi

    # Look up tranche by ID prefix
    TRANCHE_ROW=$(sqlite3 -separator '|' "$DB" "
      SELECT ept.id, ep.side, s.symbol, ept.shares, ept.trigger_price,
        ept.trigger_type, ept.trigger_date, ept.status,
        COALESCE(a.account_number, ''), ept.plan_id
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN accounts a ON ept.account_id = a.id
      WHERE ept.id LIKE '${TRANCHE_PREFIX}%';
    ")

    if [ -z "$TRANCHE_ROW" ]; then
      echo "ERROR: No tranche found matching prefix '$TRANCHE_PREFIX'"
      exit 1
    fi

    # Check for ambiguous match
    MATCH_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches WHERE id LIKE '${TRANCHE_PREFIX}%';")
    if [ "$MATCH_COUNT" -gt 1 ]; then
      echo "ERROR: Prefix '$TRANCHE_PREFIX' matches $MATCH_COUNT tranches. Use a longer prefix."
      exit 1
    fi

    # Parse fields
    TRANCHE_ID=$(echo "$TRANCHE_ROW" | cut -d'|' -f1)
    SIDE=$(echo "$TRANCHE_ROW" | cut -d'|' -f2)
    SYMBOL=$(echo "$TRANCHE_ROW" | cut -d'|' -f3)
    QTY=$(echo "$TRANCHE_ROW" | cut -d'|' -f4)
    TRIGGER_PRICE=$(echo "$TRANCHE_ROW" | cut -d'|' -f5)
    TRIGGER_TYPE=$(echo "$TRANCHE_ROW" | cut -d'|' -f6)
    TRIGGER_DATE=$(echo "$TRANCHE_ROW" | cut -d'|' -f7)
    TRANCHE_STATUS=$(echo "$TRANCHE_ROW" | cut -d'|' -f8)
    ACCT_NUM=$(echo "$TRANCHE_ROW" | cut -d'|' -f9)
    PLAN_ID=$(echo "$TRANCHE_ROW" | cut -d'|' -f10)

    # Validate status
    if [ "$TRANCHE_STATUS" != "triggered" ]; then
      echo "ERROR: Tranche status is '$TRANCHE_STATUS', expected 'triggered'."
      echo "Only triggered tranches can be confirmed."
      exit 1
    fi

    # Determine instruction
    INSTRUCTION=$(echo "$SIDE" | tr '[:lower:]' '[:upper:]')

    # Determine limit price: user override > trigger_price (for price-triggered) > prompt
    if [ -n "$USER_LIMIT_PRICE" ]; then
      LIMIT_PRICE="$USER_LIMIT_PRICE"
    elif [ "$TRIGGER_TYPE" = "price" ] && [ -n "$TRIGGER_PRICE" ] && [ "$TRIGGER_PRICE" != "0" ]; then
      LIMIT_PRICE="$TRIGGER_PRICE"
    else
      # Date-triggered: need a limit price
      LAST_PRICE=$(sqlite3 "$DB" "
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = '$SYMBOL'
        ORDER BY ph.date DESC LIMIT 1;
      ")
      echo "Date-triggered tranche for $SYMBOL (last price: \$${LAST_PRICE:-unknown})"
      printf "Enter limit price: \$"
      read -r LIMIT_PRICE
      if [ -z "$LIMIT_PRICE" ]; then
        echo "ERROR: Limit price required for date-triggered tranches."
        exit 1
      fi
    fi

    # Validate account
    if [ -z "$ACCT_NUM" ]; then
      echo "ERROR: No account assigned to this tranche. Use basket-add with --account."
      exit 1
    fi

    # Resolve account for pre-trade check
    RESOLVED_ACCOUNT="$ACCT_NUM"
    ACCT_NAME=$(sqlite3 "$DB" "SELECT name FROM accounts WHERE account_number LIKE '%$ACCT_NUM' LIMIT 1")

    # Pre-trade checklist
    pre_trade_check "$SYMBOL" "$INSTRUCTION" "$QTY" "$RESOLVED_ACCOUNT" "$LIMIT_PRICE" || exit 1

    # Print order summary
    echo "==============================="
    echo "  BASKET ORDER CONFIRMATION"
    echo "==============================="
    echo "  Action:   $INSTRUCTION"
    echo "  Symbol:   $SYMBOL"
    echo "  Quantity: $QTY"
    echo "  Type:     LIMIT"
    echo "  Price:    \$$LIMIT_PRICE"
    echo "  Duration: DAY"
    echo "  Account:  $ACCT_NAME ($ACCT_NUM)"
    echo "  Tranche:  ${TRANCHE_PREFIX}..."
    echo "==============================="

    printf "Place order? [y/N] "
    read -r REPLY
    if [ "$REPLY" != "y" ] && [ "$REPLY" != "Y" ]; then
      echo "Order cancelled."
      exit 0
    fi

    # Update tranche to confirmed with limit price
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    sqlite3 "$DB" "UPDATE entry_plan_tranches SET status = 'confirmed', limit_price = $LIMIT_PRICE WHERE id = '$TRANCHE_ID';"

    # Authenticate and get account hash
    schwab_ensure_token
    schwab_get_account_hash "$ACCT_NUM"
    if [ -z "$ACCOUNT_HASH" ]; then
      echo "ERROR: Could not resolve account hash. Reverting to triggered."
      sqlite3 "$DB" "UPDATE entry_plan_tranches SET status = 'triggered', limit_price = NULL WHERE id = '$TRANCHE_ID';"
      exit 1
    fi

    # Build order JSON
    ORDER_JSON=$(python3 -c "
import json
order = {
    'orderType': 'LIMIT',
    'session': 'NORMAL',
    'duration': 'DAY',
    'price': '$LIMIT_PRICE',
    'orderStrategyType': 'SINGLE',
    'orderLegCollection': [{
        'instruction': '$INSTRUCTION',
        'quantity': $QTY,
        'instrument': {
            'symbol': '$SYMBOL',
            'assetType': 'EQUITY'
        }
    }]
}
print(json.dumps(order))
")

    # Place order
    HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
      "${SCHWAB_API}/trader/v1/accounts/${ACCOUNT_HASH}/orders" \
      -H "Authorization: ${TOKEN_TYPE} ${ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$ORDER_JSON")

    HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
    HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -1)

    if [ "$HTTP_STATUS" = "201" ]; then
      echo "Order placed successfully."

      # Update tranche to submitted
      sqlite3 "$DB" "UPDATE entry_plan_tranches SET status = 'submitted', limit_price = $LIMIT_PRICE WHERE id = '$TRANCHE_ID';"

      # Try to fetch order ID from recent orders
      ORDER_ID=$(python3 - "$ACCESS_TOKEN" "$SCHWAB_API" "$ACCOUNT_HASH" "$SYMBOL" "$INSTRUCTION" "$QTY" <<'PYEOF'
import sys, json, urllib.request, datetime

token = sys.argv[1]
api = sys.argv[2]
acct_hash = sys.argv[3]
symbol = sys.argv[4]
instruction = sys.argv[5]
qty = int(sys.argv[6])

now = datetime.datetime.now(datetime.timezone.utc)
from_date = (now - datetime.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
to_date = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")

url = f"{api}/trader/v1/accounts/{acct_hash}/orders?fromEnteredTime={from_date}&toEnteredTime={to_date}"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
try:
    resp = urllib.request.urlopen(req)
    orders = json.loads(resp.read())
    # Find matching order (most recent first)
    for order in sorted(orders, key=lambda o: o.get('enteredTime', ''), reverse=True):
        legs = order.get('orderLegCollection', [])
        if legs:
            leg = legs[0]
            if (leg.get('instrument', {}).get('symbol') == symbol and
                leg.get('instruction') == instruction and
                int(leg.get('quantity', 0)) == qty):
                print(order.get('orderId', ''))
                sys.exit(0)
    print('')
except Exception as e:
    print('', file=sys.stderr)
    print('')
PYEOF
)

      if [ -n "$ORDER_ID" ]; then
        sqlite3 "$DB" "UPDATE entry_plan_tranches SET brokerage_order_id = '$ORDER_ID', brokerage_order_status = 'WORKING' WHERE id = '$TRANCHE_ID';"
        echo "Brokerage order ID: $ORDER_ID"
      else
        echo "Warning: Could not retrieve order ID. Order was placed but ID not captured."
      fi

      echo "Tranche $(echo $TRANCHE_ID | cut -c1-8) status: submitted"
    else
      echo "ERROR: Order failed (HTTP $HTTP_STATUS)"
      if [ -n "$HTTP_BODY" ]; then
        echo "$HTTP_BODY" | python3 -m json.tool 2>/dev/null || echo "$HTTP_BODY"
      fi
      # Revert tranche to triggered
      sqlite3 "$DB" "UPDATE entry_plan_tranches SET status = 'triggered', limit_price = NULL WHERE id = '$TRANCHE_ID';"
      echo "Tranche reverted to triggered."
      exit 1
    fi
    ;;

  basket-cancel)
    TRANCHE_PREFIX="$2"
    if [ -z "$TRANCHE_PREFIX" ]; then
      echo "Usage: pm-cli.sh basket-cancel <tranche_id_prefix>"; exit 1
    fi

    # Look up tranche by prefix — must be in cancellable status (not filled, not already cancelled)
    TRANCHE_ROW=$(sqlite3 "$DB" "
      SELECT ept.id, ept.status, ept.brokerage_order_id, s.symbol, ept.shares, ept.monitor_id, ept.account_id, a.account_number
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN accounts a ON ept.account_id = a.id
      WHERE ept.id LIKE '$TRANCHE_PREFIX%' AND ept.status NOT IN ('filled', 'cancelled');
    ")
    if [ -z "$TRANCHE_ROW" ]; then
      echo "Error: No cancellable tranche found matching '$TRANCHE_PREFIX'"; exit 1
    fi

    IFS='|' read -r TRANCHE_ID STATUS BROKERAGE_ORDER_ID SYMBOL SHARES MONITOR_ID ACCOUNT_ID ACCOUNT_NUMBER <<< "$TRANCHE_ROW"
    echo "Cancel: $SYMBOL $SHARES shares (status: $STATUS)"

    # If submitted, cancel brokerage order first
    if [ "$STATUS" = "submitted" ] && [ -n "$BROKERAGE_ORDER_ID" ]; then
      echo "Cancelling brokerage order $BROKERAGE_ORDER_ID..."
      schwab_ensure_token
      schwab_get_account_hash "$ACCOUNT_NUMBER"
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${SCHWAB_API}/trader/v1/accounts/${ACCOUNT_HASH}/orders/${BROKERAGE_ORDER_ID}" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}")
      if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
        echo "Brokerage order cancelled."
      else
        echo "Warning: Brokerage cancel returned HTTP $HTTP_CODE — verify manually."
      fi
    fi

    # Cancel tranche
    sqlite3 "$DB" "UPDATE entry_plan_tranches SET status = 'cancelled', brokerage_order_status = 'CANCELLED' WHERE id = '$TRANCHE_ID';"

    # Dismiss linked monitor
    if [ -n "$MONITOR_ID" ]; then
      sqlite3 "$DB" "UPDATE monitors SET status = 'dismissed' WHERE id = '$MONITOR_ID' AND status IN ('active', 'triggered');" 2>/dev/null
    fi

    echo "Tranche cancelled: $SYMBOL $SHARES shares"
    ;;

  basket-fill)
    TRANCHE_PREFIX="$2"
    FILL_QTY="$3"
    FILL_PRICE="$4"
    if [ -z "$TRANCHE_PREFIX" ] || [ -z "$FILL_QTY" ] || [ -z "$FILL_PRICE" ]; then
      echo "Usage: pm-cli.sh basket-fill <tranche_id_prefix> <qty> <price>"
      echo "  Record a fill (partial or full) for a tranche."
      echo "  Use 'basket-orders' or 'basket <name>' to find tranche IDs."
      exit 1
    fi

    # Look up tranche by ID prefix
    TRANCHE_ROW=$(sqlite3 -separator '|' "$DB" "
      SELECT ept.id, s.symbol, ept.shares, COALESCE(ept.filled_qty, 0),
        COALESCE(ept.filled_price, 0), ept.status, ept.brokerage_order_status
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      WHERE ept.id LIKE '${TRANCHE_PREFIX}%';
    ")

    if [ -z "$TRANCHE_ROW" ]; then
      echo "ERROR: No tranche found matching prefix '$TRANCHE_PREFIX'"
      exit 1
    fi

    # Check for ambiguous match
    MATCH_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches WHERE id LIKE '${TRANCHE_PREFIX}%';")
    if [ "$MATCH_COUNT" -gt 1 ]; then
      echo "ERROR: Prefix '$TRANCHE_PREFIX' matches $MATCH_COUNT tranches. Use a longer prefix."
      exit 1
    fi

    # Parse fields
    TRANCHE_ID=$(echo "$TRANCHE_ROW" | cut -d'|' -f1)
    SYMBOL=$(echo "$TRANCHE_ROW" | cut -d'|' -f2)
    TOTAL_SHARES=$(echo "$TRANCHE_ROW" | cut -d'|' -f3)
    OLD_FILLED_QTY=$(echo "$TRANCHE_ROW" | cut -d'|' -f4)
    OLD_FILLED_PRICE=$(echo "$TRANCHE_ROW" | cut -d'|' -f5)
    TRANCHE_STATUS=$(echo "$TRANCHE_ROW" | cut -d'|' -f6)
    BROKER_STATUS=$(echo "$TRANCHE_ROW" | cut -d'|' -f7)

    # Validate fillable status
    case "$TRANCHE_STATUS" in
      triggered|confirmed|submitted) ;; # always fillable
      pending)
        if [ "$BROKER_STATUS" = "PARTIAL" ]; then
          : # partial pending is fillable
        else
          echo "ERROR: Tranche status is 'pending' — must be triggered, confirmed, submitted, or partially filled."
          exit 1
        fi
        ;;
      filled)
        echo "ERROR: Tranche is already fully filled."
        exit 1
        ;;
      cancelled)
        echo "ERROR: Tranche is cancelled."
        exit 1
        ;;
      *)
        echo "ERROR: Tranche status '$TRANCHE_STATUS' is not fillable."
        exit 1
        ;;
    esac

    # Calculate new filled qty and weighted average price
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    NEW_FILLED_QTY=$(echo "$OLD_FILLED_QTY + $FILL_QTY" | bc)

    if [ "$(echo "$OLD_FILLED_QTY == 0" | bc)" -eq 1 ]; then
      # First fill — price is just the fill price
      NEW_FILLED_PRICE="$FILL_PRICE"
    else
      # Weighted average
      NEW_FILLED_PRICE=$(echo "scale=4; ($OLD_FILLED_QTY * $OLD_FILLED_PRICE + $FILL_QTY * $FILL_PRICE) / $NEW_FILLED_QTY" | bc)
    fi

    # Determine new status
    if [ "$(echo "$NEW_FILLED_QTY >= $TOTAL_SHARES" | bc)" -eq 1 ]; then
      # Fully filled — cap at total shares
      NEW_FILLED_QTY="$TOTAL_SHARES"
      NEW_STATUS="filled"
      NEW_BROKER_STATUS="FILLED"
    else
      # Partial fill
      NEW_STATUS="$TRANCHE_STATUS"
      if [ "$TRANCHE_STATUS" = "pending" ]; then
        NEW_STATUS="triggered"
      fi
      NEW_BROKER_STATUS="PARTIAL"
    fi

    # Update tranche
    sqlite3 "$DB" "
      UPDATE entry_plan_tranches
      SET filled_qty = $NEW_FILLED_QTY,
          filled_price = $NEW_FILLED_PRICE,
          filled_at = '$NOW',
          status = '$NEW_STATUS',
          brokerage_order_status = '$NEW_BROKER_STATUS'
      WHERE id = '$TRANCHE_ID';
    "

    echo "$SYMBOL: filled $FILL_QTY @ \$$FILL_PRICE ($NEW_FILLED_QTY/$TOTAL_SHARES, $NEW_STATUS)"
    ;;

  basket-fills)
    BASKET_NAME="$2"
    BASKET_FILTER=""
    if [ -n "$BASKET_NAME" ]; then
      BASKET_ID=$(sqlite3 "$DB" "SELECT id FROM rebalance_baskets WHERE name = '$BASKET_NAME';")
      if [ -z "$BASKET_ID" ]; then
        echo "Error: Basket '$BASKET_NAME' not found"; exit 1
      fi
      BASKET_FILTER="AND ep.basket_id = '$BASKET_ID'"
    fi

    echo "=== Fill History ==="
    sqlite3 -header -column "$DB" "
      SELECT s.symbol, ep.side,
        ept.shares as ordered,
        ept.filled_qty as filled,
        '\$' || printf('%.2f', ept.limit_price) as limit_px,
        '\$' || printf('%.2f', ept.filled_price) as fill_px,
        ept.filled_at,
        rb.name as basket
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN rebalance_baskets rb ON ep.basket_id = rb.id
      WHERE ept.status = 'filled' $BASKET_FILTER
      ORDER BY ept.filled_at DESC;
    "
    ;;

  basket-status)
    echo "=== EMS Status ==="
    ACTIVE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM rebalance_baskets WHERE status = 'active';")
    echo "Active baskets: $ACTIVE"
    echo ""

    TRIGGERED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches ept JOIN entry_plans ep ON ept.plan_id = ep.id WHERE ept.status = 'triggered' AND ep.status = 'active';")
    echo "Triggered (awaiting confirmation): $TRIGGERED"

    SUBMITTED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches ept JOIN entry_plans ep ON ept.plan_id = ep.id WHERE ept.status = 'submitted' AND ep.status = 'active';")
    echo "Submitted (working): $SUBMITTED"

    PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches ept JOIN entry_plans ep ON ept.plan_id = ep.id WHERE ept.status = 'pending' AND ep.status = 'active';")
    echo "Pending (awaiting trigger): $PENDING"

    FILLED_TODAY=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches WHERE status = 'filled' AND date(filled_at) = date('now');")
    echo "Filled today: $FILLED_TODAY"

    echo ""
    if [ "$TRIGGERED" -gt 0 ]; then
      echo "Run: pm-cli.sh basket-orders to review triggered orders"
    fi
    ;;

  scorecard)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh scorecard <symbol>"
      exit 1
    fi
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"
    if [ ! -f "$THESIS_PATH" ]; then
      echo "ERROR: No thesis doc found at $THESIS_PATH"
      exit 1
    fi

    python3 <<PYEOF
import re, sys

thesis_path = "$THESIS_PATH"
symbol = "$SYMBOL"

with open(thesis_path, "r") as f:
    content = f.read()

# Extract header fields
tier_match = re.search(r'\*\*Tier:\*\*\s*(.+)', content)
tier = tier_match.group(1).strip() if tier_match else "Unknown"

last_updated_match = re.search(r'\*\*Last Updated:\*\*\s*(.+)', content)
last_updated = last_updated_match.group(1).strip() if last_updated_match else "—"

# Parse a criteria table section
def parse_table(section_header, text):
    """Parse a markdown table under a ## header. Returns list of dicts."""
    pattern = r'## ' + re.escape(section_header) + r'\s*\n\s*\n?\s*\|[^\n]+\|\s*\n\s*\|[-| ]+\|\s*\n((?:\s*\|[^\n]+\|\s*\n?)*)'
    match = re.search(pattern, text)
    if not match:
        return []
    rows = []
    for line in match.group(1).strip().split('\n'):
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 6:
            rows.append({
                'id': cells[0],
                'criterion': cells[1],
                'metric': cells[2],
                'threshold': cells[3],
                'status': cells[4].lower().strip(),
                'last_checked': cells[5],
            })
    return rows

bulls = parse_table("Bull Criteria", content)
bears = parse_table("Bear Criteria", content)

if not bulls and not bears:
    print(f"=== {symbol} Scorecard ===")
    print(f"  Tier: {tier}")
    print(f"  Status: UNSCORED — no Bull/Bear criteria tables found")
    print(f"  Add ## Bull Criteria and ## Bear Criteria tables to thesis.md")
    sys.exit(0)

# Count statuses
bull_confirmed = sum(1 for b in bulls if b['status'] == 'confirmed')
bull_pending = sum(1 for b in bulls if b['status'] == 'pending')
bull_challenged = sum(1 for b in bulls if b['status'] == 'challenged')
bear_triggered = sum(1 for b in bears if b['status'] == 'triggered')
bear_watching = sum(1 for b in bears if b['status'] == 'watching')
bear_not_triggered = sum(1 for b in bears if b['status'] == 'not_triggered')

total_bulls = len(bulls)
total_bears = len(bears)
bull_pct = (bull_confirmed / total_bulls * 100) if total_bulls > 0 else 0

# Suggested conviction
# Watching bears and challenged bulls count as half-signals
effective_bear = bear_triggered + bear_watching * 0.5
effective_bull_pct = ((bull_confirmed - bull_challenged * 0.5) / total_bulls * 100) if total_bulls > 0 else 0
if effective_bull_pct > 75 and effective_bear == 0:
    suggested = "A"
elif effective_bull_pct > 50 and effective_bear <= 1:
    suggested = "B"
elif effective_bull_pct >= 25 and effective_bear <= 1.5:
    suggested = "C"
else:
    suggested = "D"

# Display
print(f"=== {symbol} Scorecard ===")
print(f"  Tier: {tier}")
print(f"  Last Updated: {last_updated}")
print()

# Bull criteria
print(f"  Bull Criteria ({bull_confirmed}/{total_bulls} confirmed)")
print(f"  {'─' * 70}")
for b in bulls:
    status_icon = {'confirmed': '✓', 'pending': '?', 'challenged': '✗'}.get(b['status'], ' ')
    status_color = {'confirmed': 'confirmed', 'pending': 'pending', 'challenged': 'CHALLENGED'}.get(b['status'], b['status'])
    print(f"  {status_icon} {b['id']}  {b['criterion']:<30s} {b['metric']:<25s} {status_color:<12s} {b['last_checked']}")
print()

# Bear criteria
bear_label = f"{bear_triggered}/{total_bears} triggered"
if bear_triggered > 0:
    bear_label += " ⚠" * bear_triggered
print(f"  Bear Criteria ({bear_label})")
print(f"  {'─' * 70}")
for b in bears:
    status_icon = {'triggered': '⚠', 'watching': '◉', 'not_triggered': '·'}.get(b['status'], ' ')
    status_display = {'triggered': 'TRIGGERED', 'watching': 'watching', 'not_triggered': 'clear'}.get(b['status'], b['status'])
    print(f"  {status_icon} {b['id']}  {b['criterion']:<30s} {b['metric']:<25s} {status_display:<12s} {b['last_checked']}")
print()

# Score summary
print(f"  Score Summary")
print(f"  {'─' * 40}")
print(f"  Bull: {bull_confirmed} confirmed, {bull_pending} pending, {bull_challenged} challenged")
print(f"  Bear: {bear_triggered} triggered, {bear_watching} watching, {bear_not_triggered} clear")
print(f"  Bull %: {bull_pct:.0f}%")
print(f"  Suggested conviction: {suggested}")
PYEOF
    ;;

  scorecards)
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    POSITIONS_DIR="$PROJ_ROOT/docs/positions"

    python3 <<PYEOF
import re, os, sys

positions_dir = "$POSITIONS_DIR"

# Parse a criteria table section
def parse_table(section_header, text):
    pattern = r'## ' + re.escape(section_header) + r'\s*\n\s*\n?\s*\|[^\n]+\|\s*\n\s*\|[-| ]+\|\s*\n((?:\s*\|[^\n]+\|\s*\n?)*)'
    match = re.search(pattern, text)
    if not match:
        return []
    rows = []
    for line in match.group(1).strip().split('\n'):
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 6:
            rows.append({
                'id': cells[0],
                'criterion': cells[1],
                'status': cells[4].lower().strip(),
            })
    return rows

tier_priority = {'Core': 0, 'Growth': 1, 'Starter': 2, 'Watchlist': 3, 'Exit': 4}

def extract_tier_base(tier_str):
    """Extract base tier name from string like 'Growth (B- conviction, lower end)'"""
    for t in tier_priority:
        if t.lower() in tier_str.lower():
            return t
    return tier_str.split('(')[0].strip() if '(' in tier_str else tier_str.strip()

results = []
unscored = []

if not os.path.isdir(positions_dir):
    print(f"ERROR: Positions directory not found at {positions_dir}")
    sys.exit(1)

for symbol_dir in sorted(os.listdir(positions_dir)):
    thesis_path = os.path.join(positions_dir, symbol_dir, "thesis.md")
    if not os.path.isfile(thesis_path):
        continue

    with open(thesis_path, "r") as f:
        content = f.read()

    # Extract fields
    tier_match = re.search(r'\*\*Tier:\*\*\s*(.+)', content)
    tier_raw = tier_match.group(1).strip() if tier_match else "Unknown"
    tier_base = extract_tier_base(tier_raw)

    last_updated_match = re.search(r'\*\*Last Updated:\*\*\s*(.+)', content)
    last_updated = last_updated_match.group(1).strip() if last_updated_match else "—"

    bulls = parse_table("Bull Criteria", content)
    bears = parse_table("Bear Criteria", content)

    if not bulls and not bears:
        unscored.append((symbol_dir, tier_base))
        continue

    bull_confirmed = sum(1 for b in bulls if b['status'] == 'confirmed')
    bull_challenged = sum(1 for b in bulls if b['status'] == 'challenged')
    bear_triggered = sum(1 for b in bears if b['status'] == 'triggered')
    bear_watching = sum(1 for b in bears if b['status'] == 'watching')
    total_bulls = len(bulls)
    total_bears = len(bears)
    effective_bear = bear_triggered + bear_watching * 0.5
    effective_bull_pct = ((bull_confirmed - bull_challenged * 0.5) / total_bulls * 100) if total_bulls > 0 else 0

    if effective_bull_pct > 75 and effective_bear == 0:
        conv = "A"
    elif effective_bull_pct > 50 and effective_bear <= 1:
        conv = "B"
    elif effective_bull_pct >= 25 and effective_bear <= 1.5:
        conv = "C"
    else:
        conv = "D"

    bear_display = f"{bear_triggered}/{total_bears}"
    if bear_triggered > 0:
        bear_display += "  " + "⚠" * bear_triggered

    results.append({
        'symbol': symbol_dir,
        'tier': tier_base,
        'bull': f"{bull_confirmed}/{total_bulls}",
        'bear': bear_display,
        'conv': conv,
        'last_scored': last_updated,
        'bear_triggered': bear_triggered,
        'tier_priority': tier_priority.get(tier_base, 99),
    })

# Sort by tier priority, then symbol
results.sort(key=lambda r: (r['tier_priority'], r['symbol']))

print("=== Thesis Scorecards ===")
print()
print(f"  {'Symbol':<8s} {'Tier':<10s} {'Bull':<10s} {'Bear':<13s} {'Conv':<7s} {'Last Scored'}")
print(f"  {'───────':<8s} {'─────────':<10s} {'─────────':<10s} {'────────────':<13s} {'──────':<7s} {'───────────'}")

for r in results:
    print(f"  {r['symbol']:<8s} {r['tier']:<10s} {r['bull']:<10s} {r['bear']:<13s} {r['conv']:<7s} {r['last_scored']}")

total_triggers = sum(r['bear_triggered'] for r in results)
print()
print(f"  Total bear triggers: {total_triggers}")

if unscored:
    print()
    print(f"  Unscored ({len(unscored)} positions with thesis but no criteria tables):")
    for sym, tier in sorted(unscored, key=lambda x: (tier_priority.get(x[1], 99), x[0])):
        print(f"    {sym:<8s} ({tier})")
PYEOF
    ;;

  scorecard-update)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    CRITERIA_NUM="${3:-}"
    NEW_STATUS="${4:-}"
    REASON="${5:-}"
    if [ -z "$SYMBOL" ] || [ -z "$CRITERIA_NUM" ] || [ -z "$NEW_STATUS" ]; then
      echo "Usage: pm-cli.sh scorecard-update <symbol> <criteria#> <status> \"<reason>\""
      echo "  status: confirmed, pending, challenged (bull) or triggered, watching, not_triggered (bear)"
      exit 1
    fi
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"
    if [ ! -f "$THESIS_PATH" ]; then
      echo "ERROR: No thesis doc found at $THESIS_PATH"
      exit 1
    fi

    # Parse current status from thesis doc
    OLD_STATUS=$(python3 -c "
import sys
criteria_num = '$CRITERIA_NUM'
with open('$THESIS_PATH', 'r') as f:
    for line in f:
        if '|' in line:
            cols = [c.strip() for c in line.split('|')[1:-1]]
            if len(cols) >= 5 and cols[0].strip() == criteria_num:
                print(cols[4].strip().lower())
                sys.exit(0)
print('NOT_FOUND')
")

    if [ "$OLD_STATUS" = "NOT_FOUND" ]; then
      echo "ERROR: Criterion $CRITERIA_NUM not found in $THESIS_PATH"
      exit 1
    fi

    NEW_STATUS_LOWER=$(echo "$NEW_STATUS" | tr '[:upper:]' '[:lower:]')
    if [ "$OLD_STATUS" = "$NEW_STATUS_LOWER" ]; then
      echo "$SYMBOL $CRITERIA_NUM: already $OLD_STATUS — no change"
      exit 0
    fi

    # Look up security_id
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "ERROR: Symbol $SYMBOL not found in securities table"
      exit 1
    fi

    # Ensure thesis_score_changes table exists
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS thesis_score_changes (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        criteria_number TEXT NOT NULL,
        old_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        reason TEXT,
        changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (security_id) REFERENCES securities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_thesis_score_security ON thesis_score_changes(security_id);
      CREATE INDEX IF NOT EXISTS idx_thesis_score_date ON thesis_score_changes(changed_at);
    "

    # Insert change record
    CHANGE_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    TODAY=$(date +%Y-%m-%d)
    sqlite3 "$DB" "INSERT INTO thesis_score_changes (id, security_id, criteria_number, old_status, new_status, reason, changed_at) VALUES ('$CHANGE_ID', '$SEC_ID', '$CRITERIA_NUM', '$OLD_STATUS', '$NEW_STATUS_LOWER', '$(echo "$REASON" | sed "s/'/''/g")', '$TODAY');"

    echo "$SYMBOL $CRITERIA_NUM: $OLD_STATUS → $NEW_STATUS_LOWER ($REASON)"
    echo "Remember to update the thesis doc: docs/positions/$SYMBOL/thesis.md"
    ;;

  scorecard-history)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')

    # Ensure thesis_score_changes table exists
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS thesis_score_changes (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        criteria_number TEXT NOT NULL,
        old_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        reason TEXT,
        changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (security_id) REFERENCES securities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_thesis_score_security ON thesis_score_changes(security_id);
      CREATE INDEX IF NOT EXISTS idx_thesis_score_date ON thesis_score_changes(changed_at);
    "

    if [ -n "$SYMBOL" ]; then
      echo "=== $SYMBOL Scorecard History ==="
      echo ""
      sqlite3 -separator '|' "$DB" "
        SELECT tsc.changed_at, tsc.criteria_number, tsc.old_status, tsc.new_status, COALESCE(tsc.reason, '')
        FROM thesis_score_changes tsc
        JOIN securities s ON tsc.security_id = s.id
        WHERE s.symbol = '$SYMBOL'
        ORDER BY tsc.changed_at DESC
        LIMIT 20;
      " | while IFS='|' read -r dt crit old_s new_s reason; do
        if [ -n "$reason" ]; then
          printf "  %s  %-5s  %s → %s  (%s)\n" "$dt" "$crit" "$old_s" "$new_s" "$reason"
        else
          printf "  %s  %-5s  %s → %s\n" "$dt" "$crit" "$old_s" "$new_s"
        fi
      done
    else
      echo "=== All Scorecard Changes ==="
      echo ""
      sqlite3 -separator '|' "$DB" "
        SELECT tsc.changed_at, s.symbol, tsc.criteria_number, tsc.old_status, tsc.new_status, COALESCE(tsc.reason, '')
        FROM thesis_score_changes tsc
        JOIN securities s ON tsc.security_id = s.id
        ORDER BY tsc.changed_at DESC
        LIMIT 30;
      " | while IFS='|' read -r dt sym crit old_s new_s reason; do
        if [ -n "$reason" ]; then
          printf "  %s  %-6s %-5s  %s → %s  (%s)\n" "$dt" "$sym" "$crit" "$old_s" "$new_s" "$reason"
        else
          printf "  %s  %-6s %-5s  %s → %s\n" "$dt" "$sym" "$crit" "$old_s" "$new_s"
        fi
      done
    fi

    COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM thesis_score_changes tsc JOIN securities s ON tsc.security_id = s.id $([ -n "$SYMBOL" ] && echo "WHERE s.symbol = '$SYMBOL'");")
    if [ "$COUNT" -eq 0 ]; then
      echo "  (no changes recorded)"
    fi
    ;;

  scorecard-add)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    TYPE="${3:-}"
    LABEL="${4:-}"
    METRIC="${5:-}"
    THRESHOLD="${6:-}"
    if [ -z "$SYMBOL" ] || [ -z "$TYPE" ] || [ -z "$LABEL" ] || [ -z "$METRIC" ] || [ -z "$THRESHOLD" ]; then
      echo "Usage: pm-cli.sh scorecard-add <symbol> <bull|bear> \"<label>\" \"<metric>\" \"<threshold>\""
      exit 1
    fi
    if [ "$TYPE" != "bull" ] && [ "$TYPE" != "bear" ]; then
      echo "ERROR: type must be 'bull' or 'bear'"
      exit 1
    fi
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"
    if [ ! -f "$THESIS_PATH" ]; then
      echo "ERROR: No thesis doc found at $THESIS_PATH"
      exit 1
    fi

    python3 <<PYEOF
import re, sys
from datetime import date

thesis_path = "$THESIS_PATH"
criteria_type = "$TYPE"
label = """$LABEL"""
metric = """$METRIC"""
threshold = """$THRESHOLD"""
today = date.today().isoformat()

with open(thesis_path, "r") as f:
    content = f.read()

if criteria_type == "bull":
    section_header = "Bull Criteria"
    prefix = "B"
    default_status = "pending"
else:
    section_header = "Bear Criteria"
    prefix = None  # auto-detect from existing rows
    default_status = "not_triggered"

# Find the section
pattern = r'(## ' + re.escape(section_header) + r'\s*\n\s*\n?\s*\|[^\n]+\|\s*\n\s*\|[-| ]+\|\s*\n)((?:\s*\|[^\n]+\|\s*\n?)*)'
match = re.search(pattern, content)

if not match:
    print(f"ERROR: ## {section_header} table not found in thesis doc")
    sys.exit(1)

header_part = match.group(1)
rows_part = match.group(2)

# Find existing row IDs to determine next number and prefix
existing_ids = []
for line in rows_part.strip().split('\n'):
    if '|' in line:
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if cells:
            existing_ids.append(cells[0])

if existing_ids:
    last_id = existing_ids[-1]
    # Extract prefix letters and number
    id_match = re.match(r'([A-Za-z]+)(\d+)', last_id)
    if id_match:
        prefix = id_match.group(1)
        next_num = int(id_match.group(2)) + 1
    else:
        prefix = prefix or "X"
        next_num = 1
else:
    if criteria_type == "bull":
        prefix = "B"
    else:
        prefix = "X"
    next_num = 1

new_id = f"{prefix}{next_num}"
new_row = f"| {new_id} | {label} | {metric} | {threshold} | {default_status} | {today} |\n"

# Insert the new row at the end of the table rows
insert_pos = match.start(2) + len(rows_part.rstrip('\n'))
# If rows_part doesn't end with newline, add one
if rows_part and not rows_part.rstrip('\n').endswith('\n'):
    new_row = '\n' + new_row

new_content = content[:insert_pos] + new_row + content[insert_pos + len(rows_part) - len(rows_part.rstrip('\n')):]

with open(thesis_path, "w") as f:
    f.write(new_content)

print(f"Added {new_id} to {section_header}: {label} ({default_status})")
PYEOF
    ;;

  scorecard-rm)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    CRITERIA_NUM="${3:-}"
    if [ -z "$SYMBOL" ] || [ -z "$CRITERIA_NUM" ]; then
      echo "Usage: pm-cli.sh scorecard-rm <symbol> <criteria#>"
      exit 1
    fi
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"
    if [ ! -f "$THESIS_PATH" ]; then
      echo "ERROR: No thesis doc found at $THESIS_PATH"
      exit 1
    fi

    python3 <<PYEOF
import sys

thesis_path = "$THESIS_PATH"
criteria_num = "$CRITERIA_NUM"

with open(thesis_path, "r") as f:
    lines = f.readlines()

found = False
new_lines = []
for line in lines:
    if '|' in line:
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 1 and cells[0] == criteria_num:
            found = True
            # Extract label for confirmation message
            label = cells[1] if len(cells) >= 2 else ""
            print(f"Removed {criteria_num} from thesis: {label}")
            continue
    new_lines.append(line)

if not found:
    print(f"ERROR: Criterion {criteria_num} not found in {thesis_path}")
    sys.exit(1)

with open(thesis_path, "w") as f:
    f.writelines(new_lines)
PYEOF
    ;;

  *)
    echo "Usage: pm-cli.sh <command>"
    echo "  morning            - Full morning: refresh + briefing + ritual status"
    echo "  portfolio          - Full view: positions + summary + intent changes"
    echo "  refresh            - Refresh prices via Schwab API (no app needed)"
    echo "  briefing           - Morning briefing: indices, portfolio quotes"
    echo "  positions          - List all non-cash positions with intents"
    echo "  cash               - List cash positions"
    echo "  intents            - List all position intents"
    echo "  accounts           - List accounts with book designation"
    echo "  summary            - Portfolio summary with tier coverage"
    echo "  drift              - Allocation drift: current vs target per position"
    echo "  set-intent         - Set intent: <pos_id> <tier> <thesis> <invalidation> [entry_style] [hold_period] [target_alloc_pct]"
    echo "  set-book           - Set book: <account_id> <investing|trading>"
    echo "  ritual-today       - Show today's ritual (or 'not started')"
    echo "  ritual-set         - Set a ritual field: <field> <value>"
    echo "  ritual-history [n] - Last n rituals (default 5)"
    echo "  ritual-status      - Quick status: regime/action/journal set?"
    echo "  intent-history [id]- Show change log for a position (or all)"
    echo "  intent-changes-today - Show all intent changes made today"
    echo "  watchlists          - List all watchlists"
    echo "  watchlist <name>    - Show watchlist items with prices vs targets"
    echo "  watchlist-add       - Add item: <list> <symbol> [target_price] [thesis]"
    echo "  watchlist-rm        - Remove item: <list> <symbol>"
    echo "  watchlist-create    - Create watchlist: <name> [description]"
    echo "  watchlist-delete    - Delete watchlist: <name>"
    echo "  monitors            - List active and triggered monitors"
    echo "  monitor-add         - Add monitor: <symbol> <above|below> <price> <label> [action_required]"
    echo "  monitor-dismiss     - Dismiss triggered monitor: <id>"
    echo "  monitor-rm          - Delete monitor: <id>"
    echo "  monitor-reset       - Re-arm monitor: <id>"
    echo "  monitor-add-note    - Add fundamental monitor: <symbol> <label> [reminder_date]"
    echo "  earnings [days]     - Upcoming earnings for portfolio symbols (default 14 days)"
    echo "  analytics [days]    - Portfolio analytics: beta, sharpe, volatility, drawdown (default 90)"
    echo "  attribution [days]  - Factor attribution vs QQQ: beta, sector, selection (default 30, or YTD)"
    echo "  correlations [days] - Correlation matrix & concentration analysis (default 365)"
    echo "  backfill [symbol]   - Backfill 3yr price history from Schwab (all symbols if no arg)"
    echo "  snapshot            - Take EOD portfolio snapshot (one per day)"
    echo "  snapshot-history [n]- Portfolio totals for last n days (default 30)"
    echo "  snapshot-position   - Position history: <symbol> [days]"
    echo "  news [symbol]       - Recent news (last 24h, or 7 days for specific symbol)"
    echo "  technicals [symbol] - Technical indicators: SMA 20/50/200, RSI (via FMP)"
    echo "  levels [symbol]     - Support/resistance levels with risk/reward"
    echo "  levels-refresh [sym]- Recompute S/R from price history (all if no arg)"
    echo "  sectors [date]      - Sector performance heatmap (via FMP)"
    echo "  sync-transactions [days] - Sync transactions from Schwab (default 30 days)"
    echo "  buy                - Buy: <qty> <symbol> at|market|stop <price> <DAY|GTC> [account]"
    echo "  sell               - Sell: <qty> <symbol> at|market|stop <price> <DAY|GTC> [account]"
    echo "  orders [all]       - List open/working orders (or all orders in last 7 days)"
    echo "  cancel-order <id>  - Cancel an open order by order ID"
    echo "  trade-analytics    - Trade performance: win rate, P&L, top winners/losers"
    echo "  trade-journal [sym] [days] - Sell log with entry, P&L, regime, decisions (default 90d)"
    echo "  post-mortem <symbol> - Create a post-mortem for a closed position"
    echo "  post-mortems [symbol]- List post-mortems (optionally filtered by symbol)"
    echo "  earnings-review <sym>- Interactive post-earnings review checklist"
    echo "  earnings-reviews [sym]- List earnings reviews (optionally filtered by symbol)"
    echo "  earnings-review-decide <id> - Update decision on a pending earnings review"
    echo "  recall <symbol>     - Decision memory: trades, post-mortems, decisions, observations, intents"
    echo "  observe <sym> \"note\" [supports|challenges|neutral] - Record thesis observation"
    echo "  observations [sym]  - List recent observations (optionally filtered by symbol)"
    echo "  size <sym> [target] - Position sizing: current vs target, entry plan with S/R tranches"
    echo "  plan <symbol>       - Create/view entry plan with tranches and auto-monitors"
    echo "  plans [all]         - List active entry plans (or all)"
    echo "  plan-fill <id> [p]  - Mark tranche as filled (optionally with price)"
    echo "  plan-cancel <sym>   - Cancel active entry plan for symbol"
    echo "  basket-create <name> - Create a rebalance basket"
    echo "  basket-add          - Add order to basket: <basket> <buy|sell> <sym> <shares> <tranches> <date|price> <values> [opts]"
    echo "  baskets             - List all rebalance baskets with summary"
    echo "  basket <name>       - Detail view: orders and tranches for a basket"
    echo "  basket-orders [name]- List triggered tranches awaiting confirmation"
    echo "  basket-confirm <id> [price] - Confirm triggered tranche and place Schwab order"
    echo "  basket-cancel <id> - Cancel a tranche (and its brokerage order if submitted)"
    echo "  basket-fill <id> <qty> <price> - Record fill (partial or full) for a tranche"
    echo "  basket-fills [name]- Fill history (optionally filtered by basket)"
    echo "  basket-status      - EMS summary: active baskets, triggered/submitted/pending counts"
    echo "  reconcile <csv>    - Import Schwab realized P&L CSV"
    echo "  broker-pl [symbol] - Broker P&L summary (or per-lot detail for symbol)"
    echo "  scorecard <symbol> - Thesis scorecard: bull/bear criteria status and suggested conviction"
    echo "  scorecards         - Portfolio thesis health: all scorecards summary table"
    echo "  scorecard-update   - Record score change: <symbol> <criteria#> <status> \"<reason>\""
    echo "  scorecard-history [sym] - Score change log (last 20 per symbol, or 30 all)"
    echo "  scorecard-add      - Add criterion: <symbol> <bull|bear> \"<label>\" \"<metric>\" \"<threshold>\""
    echo "  scorecard-rm       - Remove criterion: <symbol> <criteria#>"
    ;;
esac
