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

  if [ "$side" = "SELL" ]; then
    check_regime_read || return 1
    echo ""
    echo "  Manual acknowledgments:"
    read -p "  ☐ I have a clear reason for this sell (y/n): " ack
    [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    echo ""
    echo "  ✓ Checklist complete"
    return 0
  fi

  if [ "$book" = "trading" ]; then
    check_regime_read || return 1
    check_sorting_day || return 1
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
    check_thesis "$symbol" || return 1
    check_invalidation "$symbol" || return 1
    check_regime_read || return 1
    check_sorting_day || return 1
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
    # Usage: pm-cli.sh set-intent <position_id> <tier> <thesis> <invalidation> [entry_style] [hold_period]
    POS_ID="$2"; TIER="$3"; THESIS="$4"; INVAL="$5"; ENTRY="${6:-}"; HOLD="${7:-}"
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    TODAY=$(date +"%Y-%m-%d")

    # Log changes if intent already exists
    OLD_TIER=$(sqlite3 "$DB" "SELECT tier FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_THESIS=$(sqlite3 "$DB" "SELECT thesis FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_INVAL=$(sqlite3 "$DB" "SELECT invalidation FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_ENTRY=$(sqlite3 "$DB" "SELECT entry_style FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_HOLD=$(sqlite3 "$DB" "SELECT target_hold_period FROM position_intents WHERE position_id = '$POS_ID';")

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

    sqlite3 "$DB" "
      INSERT OR REPLACE INTO position_intents (id, position_id, tier, thesis, invalidation, entry_style, target_hold_period, created_at, updated_at)
      VALUES (
        COALESCE((SELECT id FROM position_intents WHERE position_id = '$POS_ID'), '$ID'),
        '$POS_ID',
        $([ -n "$TIER" ] && echo "'$TIER'" || echo "NULL"),
        $([ -n "$THESIS" ] && echo "'$THESIS'" || echo "NULL"),
        $([ -n "$INVAL" ] && echo "'$INVAL'" || echo "NULL"),
        $([ -n "$ENTRY" ] && echo "'$ENTRY'" || echo "NULL"),
        $([ -n "$HOLD" ] && echo "'$HOLD'" || echo "NULL"),
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
        [ "$atype" = "action_required" ] && TYPE_TAG=" [ACTION REQUIRED]"
        echo "  $ICON $sym \$$price crossed $dir \$$level — $label$TYPE_TAG"
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
    echo "  set-intent         - Set intent: <position_id> <tier> <thesis> <invalidation> [entry_style] [hold_period]"
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
    ;;
esac
