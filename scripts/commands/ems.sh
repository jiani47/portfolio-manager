#!/bin/bash
# EMS (Execution Management System) commands: basket creation, order management,
# tranche confirmation, fill tracking, and status reporting.
# Extracted from pm-cli.sh. Requires: schwab_ensure_token, schwab_get_account_hash,
# pre_trade_check, SCHWAB_API, DB, ACCESS_TOKEN, TOKEN_TYPE.

case "$1" in
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
    echo "--- Dynamic Allocation View (derived from target %) ---"
    PTOTAL=$(sqlite3 "$DB" "
      SELECT SUM(p.quantity * COALESCE(
        (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1), 0
      )) FROM positions p JOIN securities s ON p.security_id = s.id WHERE s.type NOT IN ('cash','option') AND p.quantity > 0;
    ")

    python3 - "$DB" "$BASKET_ID" "$PTOTAL" << 'PYEOF'
import sqlite3, sys, math

db_path = sys.argv[1]
basket_id = sys.argv[2]
ptotal = float(sys.argv[3]) if sys.argv[3] else 0

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

# Filled orders (for completeness)
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

  basket-resize)
    # Dynamically resize all pending tranches to match target allocations
    BASKET_NAME="$2"
    if [ -z "$BASKET_NAME" ]; then
      echo "Usage: pm-cli.sh basket-resize <basket_name>"
      echo "  Recalculates all pending tranche quantities from target allocation %"
      exit 1
    fi
    BASKET_ID=$(sqlite3 "$DB" "SELECT id FROM rebalance_baskets WHERE name = '$BASKET_NAME';")
    if [ -z "$BASKET_ID" ]; then
      echo "Error: Basket '$BASKET_NAME' not found"; exit 1
    fi

    PTOTAL=$(sqlite3 "$DB" "
      SELECT SUM(p.quantity * COALESCE(
        (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1), 0
      )) FROM positions p JOIN securities s ON p.security_id = s.id WHERE s.type NOT IN ('cash','option') AND p.quantity > 0;
    ")

    python3 - "$DB" "$BASKET_ID" "$PTOTAL" << 'PYEOF'
import sqlite3, sys, math

db_path = sys.argv[1]
basket_id = sys.argv[2]
ptotal = float(sys.argv[3]) if sys.argv[3] else 0

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Get all active plans with pending tranches
plans = conn.execute("""
    SELECT ep.id as plan_id, ep.side, s.symbol
    FROM entry_plans ep
    JOIN securities s ON ep.security_id = s.id
    WHERE ep.basket_id = ? AND ep.status = 'active'
    GROUP BY ep.id
""", (basket_id,)).fetchall()

print(f"=== Resizing basket to target allocations (portfolio: ${ptotal:,.0f}) ===")
print()

updated = 0
skipped = 0

for plan in plans:
    sym = plan['symbol']
    side = plan['side']

    # Get pending tranches for this plan
    tranches = conn.execute("""
        SELECT id, tranche_number, shares, trigger_type, trigger_price, trigger_date, status
        FROM entry_plan_tranches
        WHERE plan_id = ? AND status IN ('pending', 'triggered')
        ORDER BY tranche_number
    """, (plan['plan_id'],)).fetchall()

    if not tranches:
        continue

    # Get current position
    pos = conn.execute("""
        SELECT SUM(p.quantity) as qty FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.symbol = ? AND s.type NOT IN ('cash','option') AND p.quantity > 0
    """, (sym,)).fetchone()
    cur_qty = int(pos['qty']) if pos and pos['qty'] else 0

    # Get target %
    tgt_row = conn.execute("""
        SELECT pi.target_allocation_pct FROM position_intents pi
        JOIN positions p ON pi.position_id = p.id
        JOIN securities s ON p.security_id = s.id
        WHERE s.symbol = ? AND pi.target_allocation_pct IS NOT NULL LIMIT 1
    """, (sym,)).fetchone()

    if not tgt_row:
        print(f"  {sym}: no target % set — skipping")
        skipped += 1
        continue

    tgt_pct = tgt_row['target_allocation_pct']

    # Get price (use trigger price for price-triggered, MTM for date-triggered)
    price_row = conn.execute("""
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
    """, (sym,)).fetchone()
    mtm = price_row['close_price'] if price_row else 0

    if mtm <= 0:
        print(f"  {sym}: no price data — skipping")
        skipped += 1
        continue

    # Compute total need
    tgt_mv = ptotal * tgt_pct / 100
    tgt_qty = int(tgt_mv / mtm)

    if side == 'sell':
        total_need = max(0, cur_qty - tgt_qty)
    else:
        total_need = max(0, tgt_qty - cur_qty)

    # Get already filled qty for this plan
    filled_row = conn.execute("""
        SELECT SUM(COALESCE(filled_qty, 0)) as filled FROM entry_plan_tranches
        WHERE plan_id = ? AND status = 'filled'
    """, (plan['plan_id'],)).fetchone()
    already_filled = int(filled_row['filled']) if filled_row and filled_row['filled'] else 0

    remaining_need = max(0, total_need - already_filled)
    num_tranches = len(tranches)
    old_total = sum(t['shares'] for t in tranches)

    if remaining_need == 0 and old_total > 0:
        # Need to cancel all pending tranches — position already at/past target
        for t in tranches:
            conn.execute("UPDATE entry_plan_tranches SET status = 'cancelled' WHERE id = ?", (t['id'],))
        print(f"  {sym} {side.upper()}: target reached — cancelled {num_tranches} pending tranches (was {old_total} shares)")
        updated += 1
        continue

    if remaining_need == old_total:
        print(f"  {sym} {side.upper()}: {old_total} shares — already correct")
        continue

    # Distribute remaining_need across tranches
    per_tranche = remaining_need // num_tranches
    remainder = remaining_need % num_tranches

    for i, t in enumerate(tranches):
        new_shares = per_tranche + (1 if i == num_tranches - 1 and remainder > 0 else 0)
        if i < num_tranches - 1:
            actual = per_tranche
        else:
            actual = per_tranche + remainder

        if actual != t['shares']:
            conn.execute("UPDATE entry_plan_tranches SET shares = ? WHERE id = ?", (actual, t['id']))

    print(f"  {sym} {side.upper()}: {old_total} → {remaining_need} shares ({num_tranches} tranches, target {tgt_pct:.1f}% = ${tgt_mv:,.0f}, cur {cur_qty} @ ${mtm:.2f})")
    updated += 1

conn.commit()
conn.close()
print()
print(f"  Resized {updated} orders, skipped {skipped}")
print(f"  Run: pm-cli.sh basket {sys.argv[2] if len(sys.argv) > 2 else ''} to verify")
PYEOF
    ;;

esac
