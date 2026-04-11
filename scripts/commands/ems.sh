#!/bin/bash
# EMS (Execution Management System) commands: basket creation, order management,
# tranche confirmation, fill tracking, and status reporting.
# Extracted from pm-cli.sh. Requires: schwab_ensure_token, schwab_get_account_hash,
# pre_trade_check, SCHWAB_API, DB, ACCESS_TOKEN, TOKEN_TYPE.

# TypeScript CLI delegation
TSX="npx tsx"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TS_CLI="$REPO_ROOT/src/cli/index.ts"

case "$1" in
  basket-create)
    shift # consume 'basket-create'
    $TSX "$TS_CLI" --rw ems basket-create "$@" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
result = data.get('data', {})
print(result.get('message', 'Basket created'))
" || {
      echo "Error: Failed to create basket"
      exit 1
    }
    ;;

  basket-add)
    shift # consume 'basket-add'
    RESULT=$($TSX "$TS_CLI" --rw ems basket-add "$@" 2>/dev/null)
    if echo "$RESULT" | python3 -c "import sys, json; data = json.load(sys.stdin); sys.exit(1 if data.get('error') else 0)" 2>/dev/null; then
      echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
error = data.get('error', '')
print(f'Error: {error}')
" >&2
      exit 1
    fi

    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', {})

print()
print(f\"=== Basket Add: {data['symbol']} {data['side'].upper()} ===\")
print(f\"  Basket: {data.get('message', '').split('to basket ')[-1]}\")
print(f\"  Side: {data['side']}\")
print(f\"  Total shares: {data['totalShares']} across {len(data.get('tranches', []))} tranche(s)\")
if data.get('invalidation'):
    print(f\"  Invalidation: {data['invalidation']}\")
print()

for t in data.get('tranches', []):
    trig = t['trigger']
    if trig['type'] == 'date':
        print(f\"  Tranche {t['number']}: {t['shares']} shares, date trigger {trig['value']}\")
    else:
        print(f\"  Tranche {t['number']}: {t['shares']} shares, price trigger \${trig['value']:.2f} ({trig['direction']}), monitor created\")

print()
print(f\"  Plan ID: {data['planId']}\")
print(\"  Done. Use 'pm-cli.sh basket {data.get('message', '').split('to basket ')[-1]}' to view.\")
"
    ;;
  baskets)
    $TSX "$TS_CLI" --rw ems baskets 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
baskets = data.get('data', [])

if not baskets:
    print('No baskets found')
    sys.exit(0)

print('=== Rebalance Baskets ===')
print()
print(f\"{'Name':<20} {'Status':<10} {'Plans':>6} {'Pending':>7} {'Triggered':>9} {'Submitted':>9} {'Filled':>7} {'Created':<20}\")
print(f\"{'-'*20} {'-'*10} {'-'*6} {'-'*7} {'-'*9} {'-'*9} {'-'*7} {'-'*20}\")

for b in baskets:
    name = b['name'][:20]
    status = b['status']
    plans = b['planCount']
    pending = b['pendingTranches']
    triggered = b['triggeredTranches']
    submitted = b['submittedTranches']
    filled = b['filledTranches']
    created = b['createdAt'][:19]

    print(f\"{name:<20} {status:<10} {plans:>6} {pending:>7} {triggered:>9} {submitted:>9} {filled:>7} {created:<20}\")
"
    ;;

  basket)
    BASKET_NAME="$2"
    BASKET_SHOW_ALL="$3"  # pass "all" to show filled/cancelled tranches
    if [ -z "$BASKET_NAME" ]; then
      echo "Usage: pm-cli.sh basket <name> [all]"
      echo "  Default: shows only active tranches. Pass 'all' to include filled/cancelled."
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
    echo "--- Dynamic Allocation View (derived from target %) ---"
    PTOTAL=$(sqlite3 "$DB" "
      SELECT
        COALESCE((SELECT SUM(p.quantity * COALESCE(
          (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1), 0
        )) FROM positions p JOIN securities s ON p.security_id = s.id WHERE s.type NOT IN ('cash','option') AND p.quantity > 0), 0) +
        COALESCE((SELECT SUM(p.quantity) FROM positions p JOIN securities s ON p.security_id = s.id WHERE s.type = 'cash' AND p.quantity > 0), 0)
    ")

    python3 - "$DB" "$BASKET_ID" "$PTOTAL" "$BASKET_SHOW_ALL" << 'PYEOF'
import sqlite3, sys, math

db_path = sys.argv[1]
basket_id = sys.argv[2]
ptotal = float(sys.argv[3]) if sys.argv[3] else 0
show_all = sys.argv[4] == 'all' if len(sys.argv) > 4 and sys.argv[4] else False

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

def get_price(sym):
    row = conn.execute("""
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
    """, (sym,)).fetchone()
    return row['close_price'] if row else 0

def get_position_qty(sym):
    row = conn.execute("""
        SELECT SUM(p.quantity) as qty FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.symbol = ? AND s.type NOT IN ('cash','option') AND p.quantity > 0
    """, (sym,)).fetchone()
    return row['qty'] if row and row['qty'] else 0

def get_target_pct(sym):
    row = conn.execute("""
        SELECT pi.target_allocation_pct FROM position_intents pi
        JOIN positions p ON pi.position_id = p.id
        JOIN securities s ON p.security_id = s.id
        WHERE s.symbol = ? AND pi.target_allocation_pct IS NOT NULL LIMIT 1
    """, (sym,)).fetchone()
    return row['target_allocation_pct'] if row else None

# Get active (non-cancelled, non-filled-complete) symbols in basket
basket_symbols = conn.execute("""
    SELECT DISTINCT s.symbol, ep.side
    FROM entry_plans ep
    JOIN securities s ON ep.security_id = s.id
    JOIN entry_plan_tranches ept ON ept.plan_id = ep.id
    WHERE ep.basket_id = ? AND ept.status IN ('pending', 'triggered', 'submitted')
    ORDER BY ep.side, s.symbol
""", (basket_id,)).fetchall()

# Also get filled symbols for display
filled_symbols = conn.execute("""
    SELECT DISTINCT s.symbol, ep.side,
      SUM(ept.filled_qty) as filled_qty
    FROM entry_plans ep
    JOIN securities s ON ep.security_id = s.id
    JOIN entry_plan_tranches ept ON ept.plan_id = ep.id
    WHERE ep.basket_id = ? AND ept.status = 'filled'
    GROUP BY s.symbol, ep.side
""", (basket_id,)).fetchall()

print(f"  {'Symbol':<6} {'Side':<5} {'Cur%':>6} {'Tgt%':>6} {'Cur MV':>10} {'Tgt MV':>10} {'MTM':>8} {'Need Qty':>8} {'Basket':>7} {'Status':>10}")
print(f"  {'─'*6} {'─'*5} {'─'*6} {'─'*6} {'─'*10} {'─'*10} {'─'*8} {'─'*8} {'─'*7} {'─'*10}")

# Active orders
for row in basket_symbols:
    sym = row['symbol']
    side = row['side'].upper()
    price = get_price(sym)
    cur_qty = get_position_qty(sym)
    cur_mv = cur_qty * price
    cur_pct = (cur_mv / ptotal * 100) if ptotal > 0 else 0
    tgt_pct = get_target_pct(sym)
    tgt_mv = ptotal * tgt_pct / 100 if tgt_pct is not None else None

    # Dynamic qty: derived from target
    if tgt_pct is not None and price > 0:
        tgt_qty = int(tgt_mv / price) if tgt_mv else 0
        delta_qty = tgt_qty - int(cur_qty)
        if side == 'SELL':
            need_qty = max(0, int(cur_qty) - tgt_qty)
        else:
            need_qty = max(0, tgt_qty - int(cur_qty))
    else:
        need_qty = None

    # Basket qty (what's currently in the basket)
    bkt = conn.execute("""
        SELECT SUM(ept.shares) as total,
          SUM(CASE WHEN ept.status IN ('pending','triggered') THEN ept.shares ELSE 0 END) as remaining
        FROM entry_plan_tranches ept
        JOIN entry_plans ep ON ept.plan_id = ep.id
        JOIN securities s ON ep.security_id = s.id
        WHERE ep.basket_id = ? AND s.symbol = ? AND ep.side = ?
          AND ept.status IN ('pending', 'triggered', 'submitted')
    """, (basket_id, sym, row['side'])).fetchone()
    basket_qty = bkt['remaining'] if bkt and bkt['remaining'] else 0

    # Status: match / over / under
    if need_qty is not None:
        if basket_qty == need_qty or abs(basket_qty - need_qty) <= 1:
            status = "OK"
        elif basket_qty > need_qty:
            status = f"OVER +{basket_qty - need_qty}"
        else:
            status = f"UNDER -{need_qty - basket_qty}"
    else:
        status = "no target"

    tgt_pct_str = f"{tgt_pct:.1f}%" if tgt_pct is not None else "  —"
    tgt_mv_str = f"${tgt_mv:>9,.0f}" if tgt_mv is not None else "        —"
    need_str = f"{need_qty:>8}" if need_qty is not None else "     —"

    print(f"  {sym:<6} {side:<5} {cur_pct:>5.1f}% {tgt_pct_str:>6} ${cur_mv:>9,.0f} {tgt_mv_str:>10} ${price:>7.2f} {need_str} {basket_qty:>7} {status:>10}")

# Filled orders (only if show_all)
if show_all:
    for row in filled_symbols:
        sym = row['symbol']
        side = row['side'].upper()
        filled = int(row['filled_qty'] or 0)
        print(f"  {sym:<6} {side:<5}                                                    {filled:>7} FILLED")

# --- Portfolio Summary (Post-Rebalance) ---
print()
print("--- Post-Rebalance Projection (at current prices) ---")
print(f"  Portfolio MV: ${ptotal:>12,.0f}")
print()

# Get ALL positions
all_pos = conn.execute("""
    SELECT agg.symbol, agg.qty,
        (SELECT pi.target_allocation_pct FROM position_intents pi
         JOIN positions p2 ON pi.position_id = p2.id
         JOIN securities s2 ON p2.security_id = s2.id
         WHERE s2.symbol = agg.symbol AND pi.target_allocation_pct IS NOT NULL
         LIMIT 1) as tgt_pct,
        (SELECT ph.close_price FROM price_history ph
         JOIN securities s3 ON ph.security_id = s3.id
         WHERE s3.symbol = agg.symbol ORDER BY ph.date DESC LIMIT 1) as mtm
    FROM (
        SELECT s.symbol, SUM(p.quantity) as qty
        FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.type NOT IN ('cash','option') AND p.quantity > 0
        GROUP BY s.symbol
    ) agg
    ORDER BY agg.symbol
""").fetchall()

print(f"  {'Symbol':<6} {'Cur Qty':>8} {'Tgt Qty':>8} {'Delta':>7} {'Cur MV':>10} {'Tgt MV':>10} {'Cur%':>6} {'Tgt%':>6}")
print(f"  {'─'*6} {'─'*8} {'─'*8} {'─'*7} {'─'*10} {'─'*10} {'─'*6} {'─'*6}")

total_sell = 0
total_buy = 0

for pos in all_pos:
    sym = pos['symbol']
    qty = int(pos['qty'] or 0)
    price = pos['mtm'] or 0
    cur_mv = qty * price
    cur_pct = (cur_mv / ptotal * 100) if ptotal > 0 else 0
    tgt_pct = pos['tgt_pct']

    if tgt_pct is not None and price > 0:
        tgt_mv = ptotal * tgt_pct / 100
        tgt_qty = int(tgt_mv / price)
        delta = tgt_qty - qty
        delta_mv = delta * price
        if delta_mv > 0:
            total_buy += delta_mv
        else:
            total_sell += abs(delta_mv)
        delta_str = f"{delta:>+7}" if delta != 0 else "      0"
        tgt_pct_str = f"{tgt_pct:.1f}%"
        print(f"  {sym:<6} {qty:>8} {tgt_qty:>8} {delta_str} ${cur_mv:>9,.0f} ${tgt_mv:>9,.0f} {cur_pct:>5.1f}% {tgt_pct_str:>6}")
    else:
        print(f"  {sym:<6} {qty:>8}        —       — ${cur_mv:>9,.0f}          — {cur_pct:>5.1f}%     —")

net = total_buy - total_sell
sign = "+" if net >= 0 else ""
print()
print(f"  Total sells:  ${total_sell:>10,.0f}")
print(f"  Total buys:   ${total_buy:>10,.0f}")
print(f"  Net capital:  ${sign}{net:>9,.0f}  ({'needed from cash' if net > 0 else 'freed to cash'})")

conn.close()
PYEOF
    echo ""
    if [ "$BASKET_SHOW_ALL" = "all" ]; then
      TRANCHE_FILTER=""
      echo "--- Tranche Detail (all) ---"
    else
      TRANCHE_FILTER="AND ept.status NOT IN ('filled', 'cancelled')"
      echo "--- Tranche Detail (active only — pass 'all' to show filled/cancelled) ---"
    fi
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
      WHERE ep.basket_id = '$BASKET_ID' $TRANCHE_FILTER
      ORDER BY ep.side DESC, s.symbol, ept.tranche_number;
    "
    ;;

  basket-orders)
    shift # consume 'basket-orders'
    $TSX "$TS_CLI" --rw ems basket-orders "$@" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
orders = data.get('data', [])

print('=== Triggered Orders Awaiting Confirmation ===')
if not orders:
    print()
    print('No triggered orders awaiting confirmation.')
    sys.exit(0)

print()
print(f\"{'Tranche':<10} {'Basket':<15} {'Side':<5} {'Symbol':<6} {'#':>2} {'Qty':>5} {'Trigger':<12} {'Status':<10}\")
print(f\"{'-'*10} {'-'*15} {'-'*5} {'-'*6} {'-'*2} {'-'*5} {'-'*12} {'-'*10}\")

for o in orders:
    tranche_id = o['trancheId'][:8]
    basket = o['basketName'][:15]
    side = o['side'].upper()
    symbol = o['symbol']
    tranche_num = o.get('trancheNumber', 0)
    qty = o['shares']

    # Format trigger
    if o.get('triggerType') == 'date':
        trigger = o.get('triggerDate', '')[:10]
    else:
        trigger = f\"\${o.get('triggerPrice', 0):.2f}\"

    status = o['status']

    print(f\"{tranche_id:<10} {basket:<15} {side:<5} {symbol:<6} {tranche_num:>2} {qty:>5} {trigger:<12} {status:<10}\")

print()
print(f\"{len(orders)} order(s) awaiting confirmation.\")
print('Confirm: pm-cli.sh basket-confirm <tranche_id> [limit_price]')
"
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

    # Pre-trade checklist (EMS basket orders bypass sorting-day block)
    EMS_BASKET_ORDER=1 pre_trade_check "$SYMBOL" "$INSTRUCTION" "$QTY" "$RESOLVED_ACCOUNT" "$LIMIT_PRICE" || exit 1

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
    shift # consume 'basket-cancel'
    RESULT=$($TSX "$TS_CLI" --rw ems basket-cancel "$@" 2>/dev/null)

    if echo "$RESULT" | python3 -c "import sys, json; data = json.load(sys.stdin); sys.exit(1 if data.get('error') else 0)" 2>/dev/null; then
      echo "$RESULT" | python3 -c "import sys, json; print('Error:', json.load(sys.stdin).get('error', ''))" >&2
      exit 1
    fi

    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', {})
print(data.get('message', 'Tranche cancelled'))
if data.get('note'):
    print(data['note'])
"
    ;;

  basket-fill)
    shift # consume 'basket-fill'
    RESULT=$($TSX "$TS_CLI" --rw ems basket-fill "$@" 2>/dev/null)

    if echo "$RESULT" | python3 -c "import sys, json; data = json.load(sys.stdin); sys.exit(1 if data.get('error') else 0)" 2>/dev/null; then
      echo "$RESULT" | python3 -c "import sys, json; print('Error:', json.load(sys.stdin).get('error', ''))" >&2
      exit 1
    fi

    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', {})
print(data.get('message', 'Fill recorded'))
"
    ;;

  basket-fills)
    shift # consume 'basket-fills'
    $TSX "$TS_CLI" --rw ems basket-fills "$@" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
fills = data.get('data', [])

print('=== Fill History ===')
if not fills:
    print()
    print('No fills found.')
    sys.exit(0)

print()
print(f\"{'Symbol':<6} {'Side':<5} {'Ordered':>7} {'Filled':>7} {'Fill Px':>9} {'Filled At':<20} {'Basket':<15}\")
print(f\"{'-'*6} {'-'*5} {'-'*7} {'-'*7} {'-'*9} {'-'*20} {'-'*15}\")

for f in fills:
    symbol = f['symbol']
    side = f['side'].upper()
    ordered = f['shares']
    filled = f['filledQty']
    fill_px = f\"\${f['filledPrice']:.2f}\"
    filled_at = f['filledAt'][:19].replace('T', ' ')
    basket = f['basketName'][:15]

    print(f\"{symbol:<6} {side:<5} {ordered:>7} {filled:>7} {fill_px:>9} {filled_at:<20} {basket:<15}\")
"
    ;;

  basket-status)
    $TSX "$TS_CLI" --rw ems basket-status 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
summary = data.get('data', {})

print('=== EMS Status ===')
print(f\"Active baskets: {summary.get('activeBaskets', 0)}\")
print()
print(f\"Triggered (awaiting confirmation): {summary.get('triggered', 0)}\")
print(f\"Submitted (working): {summary.get('submitted', 0)}\")
print(f\"Pending (awaiting trigger): {summary.get('pending', 0)}\")
print(f\"Filled: {summary.get('filled', 0)}\")
print()

if summary.get('triggered', 0) > 0:
    print('Run: pm-cli.sh basket-orders to review triggered orders')
"
    ;;

  basket-resize)
    # Dynamically resize all pending tranches to match target allocations
    BASKET_NAME="$2"
    if [ -z "$BASKET_NAME" ]; then
      echo "Usage: pm-cli.sh basket-resize <basket_name>"
      echo "  Recalculates all pending tranche quantities from target allocation %"
      exit 1
    fi

    RESULT=$("$SCRIPT_DIR/run-ts.sh" basket-resize --rw "$BASKET_NAME" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
      echo "Error resizing basket '$BASKET_NAME'." >&2
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json

data = json.load(sys.stdin)
ptotal = data['portfolioTotal']
print(f'=== Resizing basket to target allocations (portfolio: \${ptotal:,.0f}) ===')
print()

resized_count = 0
skipped_count = len(data.get('skipped', []))

for s in data.get('skipped', []):
    print(f\"  {s['symbol']}: {s['reason']} — skipping\")

for r in data.get('resized', []):
    sym = r['symbol']
    side = r['side'].upper()
    if r['action'] == 'cancelled':
        n = len(r['tranches'])
        print(f\"  {sym} {side}: target reached — cancelled {n} pending tranches (was {r['oldTotal']} shares)\")
        resized_count += 1
    elif r['action'] == 'unchanged':
        print(f\"  {sym} {side}: {r['oldTotal']} shares — already correct\")
    else:
        n = len(r['tranches'])
        print(f\"  {sym} {side}: {r['oldTotal']} → {r['newTotal']} shares ({n} tranches, target {r['targetPct']:.1f}% = \${r['targetMv']:,.0f}, cur {r['currentQty']} @ \${r['price']:.2f})\")
        resized_count += 1

print()
print(f'  Resized {resized_count} orders, skipped {skipped_count}')
print(f\"  Run: pm-cli.sh basket {data['basketName']} to verify\")
"
    ;;

esac
