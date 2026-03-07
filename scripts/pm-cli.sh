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
    if [ -n "$WL_ALERTS" ]; then
      echo "=== Watchlist Alerts (within 5% of target) ==="
      echo "$WL_ALERTS" | while IFS='|' read -r wl sym target price vs; do
        echo "  $sym \$$price → target \$$target ($vs) [$wl]"
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
    if price <= 0:
        errors += 1
        continue
    sec_id = sec_map.get(sym)
    if not sec_id:
        continue
    row_id = str(uuid.uuid4())
    cur.execute('''
        INSERT OR REPLACE INTO price_history (id, security_id, date, close_price, volume, fetched_at)
        VALUES (
            COALESCE((SELECT id FROM price_history WHERE security_id = ? AND date = ?), ?),
            ?, ?, ?, ?, ?
        )
    ''', (sec_id, today, row_id, sec_id, today, price, volume, now))
    updated += 1

conn.commit()
conn.close()
print(f'Updated {updated} prices, {errors} errors')
" 2>/dev/null

    echo "Done. Run './scripts/pm-cli.sh briefing' to see the briefing."
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
    ;;
esac
