#!/bin/bash
# Trading commands: buy/sell order placement, order listing, order cancellation.
# Extracted from pm-cli.sh. Requires: schwab_ensure_token, schwab_get_account_hash,
# resolve_account, pre_trade_check, SCHWAB_API, DB, ACCESS_TOKEN, TOKEN_TYPE.

case "$1" in
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

  trade-enter)
    # Composite: pre-trade check → buy order → log trade → prompt for stop
    # Usage: pm-cli.sh trade-enter <symbol> <shares> <price> <stop> "<thesis>" [days] [acct]
    TE_SYM=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    TE_SHARES="${3:-}"
    TE_PRICE="${4:-}"
    TE_STOP="${5:-}"
    TE_THESIS="${6:-}"
    TE_DAYS="${7:-20}"
    TE_ACCT="${8:-4005}"
    if [ -z "$TE_SYM" ] || [ -z "$TE_SHARES" ] || [ -z "$TE_PRICE" ] || [ -z "$TE_STOP" ] || [ -z "$TE_THESIS" ]; then
      echo "Usage: pm-cli.sh trade-enter <symbol> <shares> <price> <stop> \"<thesis>\" [days] [acct]"
      echo "  Chains: pre-trade check → buy order → log trade → prompt for stop"
      echo "  Default: 20 day time limit, account 4005"
      exit 1
    fi

    echo ""
    echo "╔═══════════════════════════════════════════════╗"
    echo "║  TRADE ENTRY: $TE_SYM"
    echo "╚═══════════════════════════════════════════════╝"
    echo ""

    # Show risk summary first
    RISK_AMT=$(python3 -c "print(f'\${abs($TE_SHARES * ($TE_PRICE - $TE_STOP)):.0f}')")
    RISK_PCT=$(python3 -c "print(f'{abs(($TE_PRICE - $TE_STOP) / $TE_PRICE * 100):.1f}%')")
    EXPIRY=$(python3 -c "from datetime import datetime, timedelta; print((datetime.now() + timedelta(days=$TE_DAYS)).strftime('%Y-%m-%d'))")
    echo "  Plan: BUY $TE_SHARES $TE_SYM @ \$$TE_PRICE LIMIT DAY"
    echo "  Stop: \$$TE_STOP ($RISK_PCT risk, $RISK_AMT at stake)"
    echo "  Thesis: $TE_THESIS"
    echo "  Expires: $EXPIRY ($TE_DAYS days)"
    echo ""

    # Step 1: Pre-trade check
    pre_trade_check "$TE_SYM" "BUY" "$TE_SHARES" "$TE_ACCT" "$TE_PRICE" || { echo "  Pre-trade check failed. Trade cancelled."; exit 1; }

    echo ""
    printf "  Proceed with order? (y/n): "
    read -r CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      echo "  Trade cancelled."
      exit 0
    fi

    # Step 2: Place buy order
    echo ""
    echo "  Placing order..."
    schwab_ensure_token

    ACCT_HASH=$(schwab_get_account_hash "$TE_ACCT")
    if [ -z "$ACCT_HASH" ]; then
      echo "  ERROR: Could not resolve account $TE_ACCT"
      exit 1
    fi

    ORDER_JSON=$(python3 -c "
import json
order = {
    'orderType': 'LIMIT',
    'session': 'NORMAL',
    'price': str($TE_PRICE),
    'duration': 'DAY',
    'orderStrategyType': 'SINGLE',
    'orderLegCollection': [{
        'instruction': 'BUY',
        'quantity': $TE_SHARES,
        'instrument': {'symbol': '$TE_SYM', 'assetType': 'EQUITY'}
    }]
}
print(json.dumps(order))
")

    ACCESS_TOKEN=$(sqlite3 "$DB" "SELECT json_extract(value, '$.schwabTokens.accessToken') FROM settings WHERE key = 'settings';" 2>/dev/null)
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "https://api.schwabapi.com/trader/v1/accounts/${ACCT_HASH}/orders" \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$ORDER_JSON")

    if [ "$HTTP_CODE" = "201" ]; then
      echo "  ✓ Order placed: BUY $TE_SHARES $TE_SYM @ \$$TE_PRICE LIMIT DAY ($TE_ACCT)"
    else
      echo "  ✗ Order FAILED (HTTP $HTTP_CODE). Trade not logged."
      exit 1
    fi

    # Step 3: Log trade
    echo ""
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$TE_SYM' LIMIT 1;")
    TE_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    TODAY=$(date +%Y-%m-%d)
    TE_THESIS_ESC=$(echo "$TE_THESIS" | sed "s/'/''/g")

    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS trading_positions (id TEXT PRIMARY KEY, security_id TEXT NOT NULL, symbol TEXT NOT NULL, entry_date TEXT NOT NULL, entry_price REAL NOT NULL, shares INTEGER NOT NULL, thesis TEXT NOT NULL, stop_price REAL, stop_order_id TEXT, time_limit_days INTEGER NOT NULL DEFAULT 20, status TEXT NOT NULL DEFAULT 'open', exit_date TEXT, exit_price REAL, exit_reason TEXT, pnl REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"

    sqlite3 "$DB" "INSERT INTO trading_positions (id, security_id, symbol, entry_date, entry_price, shares, thesis, stop_price, time_limit_days, status, created_at, updated_at) VALUES ('$TE_ID', '$SEC_ID', '$TE_SYM', '$TODAY', $TE_PRICE, $TE_SHARES, '$TE_THESIS_ESC', $TE_STOP, $TE_DAYS, 'open', '$NOW', '$NOW');"
    echo "  ✓ Trade logged: $TE_SYM $TE_SHARES shares, stop \$$TE_STOP, ${TE_DAYS}d limit"

    # Step 4: Prompt for stop order
    echo ""
    echo "  ⚠ GTC stop order needed:"
    echo "    pm-cli.sh sell $TE_SHARES $TE_SYM stop $TE_STOP GTC $TE_ACCT"
    echo ""
    printf "  Place stop order now? (y/n): "
    read -r STOP_CONFIRM
    if [ "$STOP_CONFIRM" = "y" ] || [ "$STOP_CONFIRM" = "Y" ]; then
      "$0" sell "$TE_SHARES" "$TE_SYM" stop "$TE_STOP" GTC "$TE_ACCT"
    else
      echo "  ⚠ Remember to place the stop manually!"
    fi
    ;;

  trade-setup)
    # Guided trade setup: valuation + technicals + S/R + sizing + commands
    TS_SYM=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    if [ -z "$TS_SYM" ]; then
      echo "Usage: pm-cli.sh trade-setup <symbol>"
      echo "  Guided flow: analysis → sizing → ready-to-run commands"
      exit 1
    fi

    python3 - "$TS_SYM" "$DB" << 'PYEOF'
import sqlite3, sys, datetime

symbol = sys.argv[1]
db_path = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

sec = conn.execute("SELECT id FROM securities WHERE symbol = ?", (symbol,)).fetchone()
if not sec:
    print(f"  Error: {symbol} not found")
    sys.exit(1)

# Current price
price_row = conn.execute("""
    SELECT ph.close_price, ph.date FROM price_history ph
    JOIN securities s ON ph.security_id = s.id
    WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
""", (symbol,)).fetchone()
if not price_row:
    print(f"  No price data for {symbol}")
    sys.exit(1)
price = price_row['close_price']
price_date = price_row['date']

# Portfolio total for sizing
ptotal = conn.execute("""
    SELECT SUM(p.quantity * COALESCE(
        (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1), 0
    )) FROM positions p JOIN securities s ON p.security_id = s.id WHERE s.type NOT IN ('cash','option') AND p.quantity > 0
""").fetchone()[0] or 0

# Valuation
val = conn.execute("SELECT * FROM valuation_metrics WHERE symbol = ? ORDER BY date DESC LIMIT 1", (symbol,)).fetchone()

# S/R levels
supports = conn.execute("""
    SELECT price, strength FROM price_levels WHERE symbol = ? AND level_type = 'support' AND price < ?
    ORDER BY price DESC LIMIT 3
""", (symbol, price)).fetchall()
resistances = conn.execute("""
    SELECT price, strength FROM price_levels WHERE symbol = ? AND level_type = 'resistance' AND price > ?
    ORDER BY price ASC LIMIT 3
""", (symbol, price)).fetchall()

# ATR
atr_row = conn.execute("""
    SELECT AVG(high_price - low_price) as atr FROM (
        SELECT high_price, low_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? AND high_price > 0 AND low_price > 0
        ORDER BY ph.date DESC LIMIT 14
    )
""", (symbol,)).fetchone()
atr = atr_row['atr'] if atr_row and atr_row['atr'] else 0
atr_pct = (atr / price * 100) if atr else 0

# Watchlist info
wl = conn.execute("""
    SELECT w.name, wi.thesis_snippet FROM watchlist_items wi
    JOIN watchlists w ON wi.watchlist_id = w.id WHERE wi.symbol = ?
""", (symbol,)).fetchone()

# Existing position
pos = conn.execute("""
    SELECT SUM(p.quantity) as qty FROM positions p
    JOIN securities s ON p.security_id = s.id
    WHERE s.symbol = ? AND s.type NOT IN ('cash','option') AND p.quantity > 0
""", (symbol,)).fetchone()
cur_qty = int(pos['qty']) if pos and pos['qty'] else 0

# === Display ===
print()
print(f"╔═══════════════════════════════════════════════╗")
print(f"║  TRADE SETUP: {symbol:<31}║")
print(f"╚═══════════════════════════════════════════════╝")
print()

# Context
if wl:
    print(f"  Watchlist: {wl['name']}" + (f" — {wl['thesis_snippet']}" if wl['thesis_snippet'] else ""))
if cur_qty > 0:
    print(f"  ⚠ Already hold {cur_qty} shares")
print(f"  Price: ${price:.2f} (as of {price_date})")
print(f"  ATR(14): ${atr:.2f} ({atr_pct:.1f}% daily range)")
print()

# Valuation
print(f"  ── Valuation ──")
if val:
    t12 = f"{val['trailing_pe']:.1f}x" if val['trailing_pe'] else "N/A"
    fwd = f"{val['forward_pe']:.1f}x" if val['forward_pe'] else "N/A"
    peg = f"{val['forward_peg']:.2f}" if val['forward_peg'] else "N/A"
    rating = val['peg_rating'] or '—'
    growth = f"{val['eps_growth_pct']:+.0f}%" if val['eps_growth_pct'] else "—"
    print(f"  T12 PE: {t12}  |  Fwd PE: {fwd}  |  PEG: {peg}  |  Rating: {rating}  |  Growth: {growth}")
else:
    print(f"  No valuation data (run refresh)")
print()

# S/R Levels
print(f"  ── Support / Resistance ──")
for s in supports:
    dist = (price - s['price']) / price * 100
    print(f"  S  ${s['price']:<8.2f}  str {s['strength']}/10  ({dist:.1f}% below)")
print(f"  ●  ${price:<8.2f}  ← current")
for r in resistances:
    dist = (r['price'] - price) / price * 100
    print(f"  R  ${r['price']:<8.2f}  str {r['strength']}/10  ({dist:.1f}% above)")

# R/R
if supports and resistances:
    down = price - supports[0]['price']
    up = resistances[0]['price'] - price
    rr = up / down if down > 0 else 999
    print(f"  R:R to R1/S1: {rr:.1f}x {'✓' if rr >= 2 else '⚠ < 2x'}")
print()

# Sizing (1% max for trading)
max_alloc = 0.01
max_mv = ptotal * max_alloc
max_shares = int(max_mv / price) if price > 0 else 0
print(f"  ── Sizing (1% max = ${max_mv:,.0f}) ──")
print(f"  Max shares: {max_shares} @ ${price:.2f}")

# Suggest stop at S1 or ATR-based
if supports:
    stop_s1 = supports[0]['price']
    stop_risk_pct = (price - stop_s1) / price * 100
    stop_risk_amt = max_shares * (price - stop_s1)
    print(f"  Stop at S1: ${stop_s1:.2f} ({stop_risk_pct:.1f}% risk, ${stop_risk_amt:,.0f} at stake)")
if atr:
    stop_atr = price - 2 * atr
    atr_risk_pct = 2 * atr_pct
    atr_risk_amt = max_shares * 2 * atr
    print(f"  Stop at 2×ATR: ${stop_atr:.2f} ({atr_risk_pct:.1f}% risk, ${atr_risk_amt:,.0f} at stake)")

# Target at R1
if resistances:
    target = resistances[0]['price']
    target_gain_pct = (target - price) / price * 100
    target_gain_amt = max_shares * (target - price)
    print(f"  Target at R1: ${target:.2f} ({target_gain_pct:+.1f}%, ${target_gain_amt:,.0f} potential)")
print()

# Ready-to-run commands
stop_price = supports[0]['price'] if supports else (price - 2 * atr if atr else price * 0.95)
print(f"  ── Commands ──")
print(f"  1. Buy:        pm-cli.sh buy {max_shares} {symbol} at {price:.2f} DAY 4005")
print(f"  2. Log trade:  pm-cli.sh trade-open {symbol} {max_shares} {price:.2f} {stop_price:.2f} \"<thesis>\" 20")
print(f"  3. Place stop: pm-cli.sh sell {max_shares} {symbol} stop {stop_price:.2f} GTC 4005")
print()

conn.close()
PYEOF
    ;;

  trade-open)
    # Log a new trading position: pm-cli.sh trade-open <symbol> <shares> <entry_price> <stop_price> "<thesis>" [time_limit_days]
    TO_SYM=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    TO_SHARES="${3:-}"
    TO_ENTRY="${4:-}"
    TO_STOP="${5:-}"
    TO_THESIS="${6:-}"
    TO_DAYS="${7:-20}"
    if [ -z "$TO_SYM" ] || [ -z "$TO_SHARES" ] || [ -z "$TO_ENTRY" ] || [ -z "$TO_STOP" ] || [ -z "$TO_THESIS" ]; then
      echo "Usage: pm-cli.sh trade-open <symbol> <shares> <entry_price> <stop_price> \"<thesis>\" [time_limit_days]"
      echo "  Default time limit: 20 days"
      exit 1
    fi

    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$TO_SYM' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "Error: Security '$TO_SYM' not found"
      exit 1
    fi

    TO_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    TODAY=$(date +%Y-%m-%d)
    TO_THESIS_ESC=$(echo "$TO_THESIS" | sed "s/'/''/g")

    # Create table if not exists
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS trading_positions (id TEXT PRIMARY KEY, security_id TEXT NOT NULL, symbol TEXT NOT NULL, entry_date TEXT NOT NULL, entry_price REAL NOT NULL, shares INTEGER NOT NULL, thesis TEXT NOT NULL, stop_price REAL, stop_order_id TEXT, time_limit_days INTEGER NOT NULL DEFAULT 20, status TEXT NOT NULL DEFAULT 'open', exit_date TEXT, exit_price REAL, exit_reason TEXT, pnl REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"

    sqlite3 "$DB" "INSERT INTO trading_positions (id, security_id, symbol, entry_date, entry_price, shares, thesis, stop_price, time_limit_days, status, created_at, updated_at) VALUES ('$TO_ID', '$SEC_ID', '$TO_SYM', '$TODAY', $TO_ENTRY, $TO_SHARES, '$TO_THESIS_ESC', $TO_STOP, $TO_DAYS, 'open', '$NOW', '$NOW');"

    RISK=$(python3 -c "print(f'\${abs($TO_SHARES * ($TO_ENTRY - $TO_STOP)):.0f}')")
    RISK_PCT=$(python3 -c "print(f'{abs(($TO_ENTRY - $TO_STOP) / $TO_ENTRY * 100):.1f}%')")
    EXPIRY=$(python3 -c "from datetime import datetime, timedelta; print((datetime.now() + timedelta(days=$TO_DAYS)).strftime('%Y-%m-%d'))")

    echo "=== Trade Opened ==="
    echo "  $TO_SYM  $TO_SHARES shares @ \$$TO_ENTRY"
    echo "  Stop: \$$TO_STOP ($RISK_PCT, $RISK risk)"
    echo "  Thesis: $TO_THESIS"
    echo "  Time limit: $TO_DAYS days (expires $EXPIRY)"
    echo ""
    echo "  ⚠ IMPORTANT: Place GTC stop order now:"
    echo "  pm-cli.sh sell $TO_SHARES $TO_SYM stop $TO_STOP GTC"
    ;;

  trade-close)
    # Close a trading position: pm-cli.sh trade-close <symbol> <exit_price> "<reason>"
    TC_SYM=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    TC_EXIT="${3:-}"
    TC_REASON="${4:-}"
    if [ -z "$TC_SYM" ] || [ -z "$TC_EXIT" ]; then
      echo "Usage: pm-cli.sh trade-close <symbol> <exit_price> \"<reason>\""
      exit 1
    fi

    TC_TRADE=$(sqlite3 -separator '|' "$DB" "SELECT id, entry_price, shares, entry_date FROM trading_positions WHERE symbol = '$TC_SYM' AND status = 'open' ORDER BY entry_date DESC LIMIT 1;" 2>/dev/null)
    if [ -z "$TC_TRADE" ]; then
      echo "Error: No open trade found for $TC_SYM"
      exit 1
    fi

    TC_ID=$(echo "$TC_TRADE" | cut -d'|' -f1)
    TC_ENTRY=$(echo "$TC_TRADE" | cut -d'|' -f2)
    TC_SHARES=$(echo "$TC_TRADE" | cut -d'|' -f3)
    TC_DATE=$(echo "$TC_TRADE" | cut -d'|' -f4)
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    TODAY=$(date +%Y-%m-%d)
    TC_REASON_ESC=$(echo "$TC_REASON" | sed "s/'/''/g")

    PNL=$(python3 -c "print(f'{$TC_SHARES * ($TC_EXIT - $TC_ENTRY):.2f}')")
    PNL_PCT=$(python3 -c "print(f'{($TC_EXIT - $TC_ENTRY) / $TC_ENTRY * 100:.1f}')")
    HOLD_DAYS=$(python3 -c "from datetime import datetime; print((datetime.now() - datetime.strptime('$TC_DATE', '%Y-%m-%d')).days)")

    sqlite3 "$DB" "UPDATE trading_positions SET status = 'closed', exit_date = '$TODAY', exit_price = $TC_EXIT, exit_reason = '$TC_REASON_ESC', pnl = $PNL, updated_at = '$NOW' WHERE id = '$TC_ID';"

    echo "=== Trade Closed ==="
    echo "  $TC_SYM  $TC_SHARES shares"
    echo "  Entry: \$$TC_ENTRY on $TC_DATE → Exit: \$$TC_EXIT ($HOLD_DAYS days)"
    echo "  P&L: \$$PNL (${PNL_PCT}%)"
    echo "  Reason: ${TC_REASON:-none}"
    ;;

  trades)
    # List trading positions: pm-cli.sh trades [all]
    TRADE_FILTER="AND tp.status = 'open'"
    TRADE_LABEL="Open"
    if [ "$2" = "all" ]; then
      TRADE_FILTER=""
      TRADE_LABEL="All"
    fi

    echo "=== $TRADE_LABEL Trading Positions ==="
    sqlite3 "$DB" "
      SELECT tp.symbol, tp.shares, tp.entry_price, tp.entry_date, tp.stop_price, tp.time_limit_days,
        tp.thesis, tp.status, tp.exit_price, tp.pnl,
        (SELECT ph.close_price FROM price_history ph JOIN securities s ON ph.security_id = s.id
         WHERE s.symbol = tp.symbol ORDER BY ph.date DESC LIMIT 1) as mtm
      FROM trading_positions tp
      WHERE 1=1 $TRADE_FILTER
      ORDER BY tp.entry_date DESC;
    " 2>/dev/null | while IFS='|' read -r SYM SHARES ENTRY EDATE STOP DAYS THESIS STATUS EXIT_PX PNL MTM; do
      if [ "$STATUS" = "open" ]; then
        # Compute unrealized P&L
        UPNL=$(python3 -c "print(f'\${$SHARES * ($MTM - $ENTRY):.0f}')" 2>/dev/null)
        UPNL_PCT=$(python3 -c "print(f'{($MTM - $ENTRY) / $ENTRY * 100:.1f}%')" 2>/dev/null)
        # Check time remaining
        DAYS_HELD=$(python3 -c "from datetime import datetime; print((datetime.now() - datetime.strptime('$EDATE', '%Y-%m-%d')).days)" 2>/dev/null)
        DAYS_LEFT=$((DAYS - DAYS_HELD))
        TIME_WARN=""
        [ "$DAYS_LEFT" -le 5 ] 2>/dev/null && TIME_WARN=" ⚠ EXPIRING"
        [ "$DAYS_LEFT" -le 0 ] 2>/dev/null && TIME_WARN=" ⛔ EXPIRED"

        echo "  $SYM  ${SHARES}sh @ \$$ENTRY → \$$MTM (${UPNL_PCT}, $UPNL) | stop \$$STOP | ${DAYS_HELD}d/${DAYS}d${TIME_WARN}"
        echo "    Thesis: $THESIS"
      else
        echo "  $SYM  ${SHARES}sh @ \$$ENTRY → \$$EXIT_PX (P&L: \$$PNL) [$STATUS] — entered $EDATE"
      fi
    done
    ;;

  trade-stats)
    RESULT=$("$SCRIPT_DIR/run-ts.sh" trade-stats 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
      echo "Error computing trade stats." >&2
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json

d = json.load(sys.stdin)
s = d['stats']

print()
print('╔═══════════════════════════════════════════════╗')
print('║  TRADING DASHBOARD                            ║')
print('╚═══════════════════════════════════════════════╝')
print()

# Open positions
opens = d.get('openTrades', [])
if opens:
    print('  ── Open Positions ──')
    total_open_pnl = 0
    for t in opens:
        mtm = t['currentPrice'] or t['entryPrice']
        upnl = t['unrealizedGain']
        upnl_pct = t['unrealizedGainPct']
        days_held = t['daysHeld']
        days_left = t['timeLimitDays'] - days_held

        time_warn = ''
        if days_left <= 0: time_warn = ' ⛔'
        elif days_left <= 5: time_warn = f' ⚠{days_left}d'

        stop_str = f\"\${t['stopPrice']}\" if t['stopPrice'] else '—'
        total_open_pnl += upnl
        print(f'  {t[\"symbol\"]:<6} {t[\"shares\"]:>4}sh  \${t[\"entryPrice\"]:.2f}→\${mtm:.2f}  {upnl_pct:>+6.1f}% (\${upnl:>+8,.0f})  stop {stop_str}  {days_held}d/{t[\"timeLimitDays\"]}d{time_warn}')
    print(f'  {\"─\"*70}')
    print(f'  Open P&L: \${total_open_pnl:>+,.0f}')
    print()

# Closed stats
if s['totalTrades'] == 0:
    print('  No closed trades yet.')
    print()
else:
    print(f'  ── Performance Summary ──')
    print(f'  Total Trades: {s[\"totalTrades\"]}  |  Wins: {s[\"wins\"]}  |  Losses: {s[\"losses\"]}  |  Win Rate: {s[\"winRate\"]:.0f}%')
    print(f'  Total P&L: \${s[\"totalRealizedGain\"]:>+,.0f}')
    print(f'  Avg Win:  \${s[\"avgWin\"]:>+,.0f}  |  Avg Loss: \${s[\"avgLoss\"]:>+,.0f}  |  Risk/Reward: {s[\"avgRiskReward\"]:.1f}x')
    print()

    # Recent trades
    closed = d.get('closedTrades', [])
    if closed:
        print(f'  ── Recent Closed Trades ──')
        print(f'  {\"Symbol\":<6} {\"Shares\":>6} {\"Entry\":>8} {\"Exit\":>8} {\"P&L\":>10} {\"P&L%\":>7} {\"Hold\":>5} {\"Reason\"}')
        print(f'  {\"─\"*6} {\"─\"*6} {\"─\"*8} {\"─\"*8} {\"─\"*10} {\"─\"*7} {\"─\"*5} {\"─\"*15}')
        for t in closed[:15]:
            reason = (t['exitReason'] or '')[:15]
            print(f'  {t[\"symbol\"]:<6} {t[\"shares\"]:>6} \${t[\"entryPrice\"]:>7.2f} \${t[\"exitPrice\"]:>7.2f} \${t[\"pnl\"]:>+9,.0f} {t[\"pnlPct\"]:>+6.1f}% {t[\"holdDays\"]:>4}d {reason}')
        print()

    # Best and worst
    wins = [t for t in closed if t['pnl'] > 0]
    losses = [t for t in closed if t['pnl'] <= 0]
    if wins:
        best = max(wins, key=lambda t: t['pnl'])
        print(f'  Best:  {best[\"symbol\"]} \${best[\"pnl\"]:>+,.0f} ({best[\"pnlPct\"]:+.1f}%)')
    if losses:
        worst = min(losses, key=lambda t: t['pnl'])
        print(f'  Worst: {worst[\"symbol\"]} \${worst[\"pnl\"]:>+,.0f} ({worst[\"pnlPct\"]:+.1f}%)')

print()
"
    ;;

esac
