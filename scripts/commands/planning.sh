#!/bin/bash
# Planning commands: position sizing, entry plans with tranches and auto-monitors.
# Extracted from pm-cli.sh. Requires: DB variable.

case "$1" in
  size)
    # Position sizing: target allocation, current vs target, entry plan with S/R tranches
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh size <symbol> [target]"
      echo "  target: share count (e.g. 100) or allocation % (e.g. 3%)"
      echo "  Shows current vs target sizing, entry plan using S/R levels + ATR."
      echo "  Works for existing positions and watchlist symbols."
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    TARGET_SHARES="${3:-}"

    python3 - "$SYMBOL" "$TARGET_SHARES" "$DB" << 'PYEOF'
import sqlite3, sys

symbol = sys.argv[1]
target_arg = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
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

# Support new positions (not yet held)
is_new = False
if not pos:
    is_new = True
    total_qty = 0
    total_cost = 0
    tier = 'Starter'  # default for new positions
    # Check if it's on a watchlist for context
    wl = conn.execute("SELECT wi.*, w.name as wl_name FROM watchlist_items wi JOIN watchlists w ON wi.watchlist_id = w.id WHERE wi.symbol = ?", (symbol,)).fetchone()
    if wl:
        print(f"  (Watchlist: {wl['wl_name']}" + (f" — {wl['thesis_snippet']}" if wl['thesis_snippet'] else "") + ")")
else:
    total_qty = sum(r['quantity'] or 0 for r in pos)
    total_cost = sum(r['cost_basis'] or 0 for r in pos)
    tier = pos[0]['tier'] or 'Starter'

tier_limit = TIER_LIMITS.get(tier, 5)

# Parse target arg: can be shares (e.g. "100") or percentage (e.g. "3%")
target_shares_arg = None
target_pct_arg = None
if target_arg:
    if target_arg.endswith('%'):
        target_pct_arg = float(target_arg[:-1])
    else:
        target_shares_arg = target_arg

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

# User override (shares or percentage)
if target_pct_arg:
    target_pct_final = target_pct_arg
    target_mv_final = portfolio_total * target_pct_final / 100
    target_shares_final = int(target_mv_final / current_price)
    room_mv = target_mv_final - current_mv
    room_shares = max(0, target_shares_final - int(total_qty))
    room_pct = (room_mv / portfolio_total) * 100
elif target_shares_arg:
    target_shares_final = int(target_shares_arg)
    target_mv_final = target_shares_final * current_price
    target_pct_final = (target_mv_final / portfolio_total) * 100
    room_mv = target_mv_final - current_mv
    room_shares = max(0, target_shares_final - int(total_qty))
    room_pct = (room_mv / portfolio_total) * 100
else:
    target_shares_final = target_shares_computed
    target_mv_final = target_mv
    target_pct_final = tier_limit

# Compute ATR for volatility-adjusted tranches
atr_row = conn.execute("""
    SELECT AVG(high_price - low_price) as atr FROM (
        SELECT high_price, low_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? AND high_price > 0 AND low_price > 0
        ORDER BY ph.date DESC LIMIT 14
    )
""", (symbol,)).fetchone()
atr = atr_row['atr'] if atr_row and atr_row['atr'] else None
atr_pct = (atr / current_price * 100) if atr else None

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
if atr:
    print(f"  ATR(14): ${atr:.2f} ({atr_pct:.1f}% daily range)")
print()

if is_new:
    print(f"  ── New Position (not yet held) ──")
else:
    print(f"  ── Current Position ──")
    print(f"  Shares: {total_qty:,.0f}")
    print(f"  Avg cost: ${avg_cost:.2f}  ({unrealized_pct:+.1f}%)")
    print(f"  Market value: ${current_mv:,.0f}")
    print(f"  Weight: {current_pct:.1f}%")
print()

print(f"  ── Target ({tier} tier max: {tier_limit}%) ──")
if target_pct_arg:
    print(f"  Target (user): {target_shares_final:,} shares (${target_mv_final:,.0f}, {target_pct_final:.1f}%)")
elif target_shares_arg:
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

        # Volatility-adjusted sizing: high-ATR stocks get more weight on lower tranches
        # Low vol (<2% ATR): 25/25/50 split (standard)
        # Med vol (2-4% ATR): 20/30/50 (more at support)
        # High vol (>4% ATR): 15/35/50 (much more at support)
        if atr_pct and atr_pct > 4:
            w1, w2 = 0.15, 0.35
        elif atr_pct and atr_pct > 2:
            w1, w2 = 0.20, 0.30
        else:
            w1, w2 = 0.25, 0.25

        if supports:
            s1 = supports[0]
            t1_shares = max(1, int(add_shares * w1))
            t1_pct = (current_price - s1['price']) / current_price * 100
            tranches.append((f"S1 ${s1['price']:.2f}", t1_shares, s1['price'], s1['strength'], t1_pct))
            remaining -= t1_shares

            if len(supports) >= 2:
                s2 = supports[1]
                t2_shares = max(1, int(add_shares * w2))
                t2_pct = (current_price - s2['price']) / current_price * 100
                tranches.append((f"S2 ${s2['price']:.2f}", t2_shares, s2['price'], s2['strength'], t2_pct))
                remaining -= t2_shares

            if remaining > 0:
                tranches.append((f"Thesis confirm", remaining, current_price, None, 0))
        else:
            # No S/R levels — use ATR-based dip levels
            dip1 = atr_pct if atr_pct else 3.0
            dip2 = dip1 * 2
            t_size = max(1, add_shares // 3)
            tranches.append(("Now (1/3)", t_size, current_price, None, 0))
            tranches.append((f"Dip -{dip1:.0f}%", t_size, current_price * (1 - dip1/100), None, dip1))
            if add_shares - 2 * t_size > 0:
                tranches.append((f"Dip -{dip2:.0f}%", add_shares - 2 * t_size, current_price * (1 - dip2/100), None, dip2))

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
esac
