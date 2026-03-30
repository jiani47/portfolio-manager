#!/bin/bash
# Planning commands: position sizing, entry plans with tranches and auto-monitors.
# Extracted from pm-cli.sh. Requires: DB variable.

case "$1" in
  size)
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh size <symbol> [target]"
      echo "  target: allocation % (e.g. 3)"
      echo "  Shows current vs target sizing, entry plan using S/R levels + ATR."
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    TARGET="${3:-}"

    ARGS="$SYMBOL"
    if [ -n "$TARGET" ]; then
      ARGS="$SYMBOL $TARGET"
    fi

    RESULT=$("$SCRIPT_DIR/run-ts.sh" size $ARGS 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
      echo "Error computing size for $SYMBOL." >&2
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json

d = json.load(sys.stdin)
s = d['sizing']
symbol = d['symbol']
price = d['currentPrice']
atr_pct = d['atrPct']

print()
print('╔═══════════════════════════════════════════════╗')
print(f'║  POSITION SIZING: {symbol:<28}║')
print('╚═══════════════════════════════════════════════╝')
print()
print(f'  Tier limit: {s[\"tierLimitPct\"]}% of portfolio')
print(f'  Price: \${price:.2f}')
if atr_pct:
    print(f'  ATR(14): {atr_pct:.1f}% daily range')
print()

if s['currentMarketValue'] > 0:
    print(f'  ── Current Position ──')
    print(f'  Market value: \${s[\"currentMarketValue\"]:,.0f}')
    print(f'  Weight: {s[\"currentPct\"]:.1f}%')
    print()

print(f'  ── Target ({s[\"tierLimitPct\"]}%) ──')
print(f'  Target: {s[\"targetShares\"]:,} shares (\${s[\"targetMarketValue\"]:,.0f})')

if s['roomMarketValue'] > 0:
    print(f'  Room to add: {s[\"roomShares\"]:,} shares (\${s[\"roomMarketValue\"]:,.0f})')
elif s['roomMarketValue'] == 0 and s['currentMarketValue'] > 0:
    print(f'  At target allocation')
print()

# Tranches
tranches = d.get('tranches', [])
if tranches:
    print(f'  ── Entry Plan (suggested tranches) ──')
    print(f'  {\"TRANCHE\":<22} {\"SHARES\":>7} {\"PRICE\":>10} {\"VALUE\":>12} {\"FROM HERE\":>10}')
    print(f'  {\"─\"*22} {\"─\"*7} {\"─\"*10} {\"─\"*12} {\"─\"*10}')
    total_cost = 0
    total_shares = 0
    for t in tranches:
        value = t['shares'] * t['entryPrice']
        total_cost += value
        total_shares += t['shares']
        pct_label = f'-{t.get(\"dipPct\", 0):.1f}%' if t.get('dipPct', 0) > 0 else 'at mkt'
        print(f'  {t[\"label\"]:<22} {t[\"shares\"]:>7,} {t[\"entryPrice\"]:>10.2f} {value:>11,.0f} {pct_label:>10}')
    print(f'  {\"─\"*22} {\"─\"*7} {\"─\"*10} {\"─\"*12}')
    print(f'  {\"TOTAL\":<22} {total_shares:>7,} {\"\":>10} {total_cost:>11,.0f}')
    print()

# S/R context
supports = d.get('supportLevels', [])
if supports:
    print(f'  ── S/R Context ──')
    for sp in supports[:3]:
        pct = (price - sp) / price * 100
        print(f'  S: \${sp:.2f} ({pct:.1f}% below)')
    print()
"
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

  valuation)
    # Valuation for a single symbol: PE, PEG, forward PE, fair price range
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh valuation <symbol>"
      echo "  Shows trailing/forward PE, PEG, EPS growth, fair price range."
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    FMP_KEY=$(get_fmp_key)
    if [ -z "$FMP_KEY" ]; then
      echo "Error: FMP API key not configured in ~/.pm-cli.conf"
      exit 1
    fi

    python3 - "$SYMBOL" "$FMP_KEY" "$DB" << 'PYEOF'
import json, urllib.request, sqlite3, sys

symbol = sys.argv[1]
fmp_key = sys.argv[2]
db_path = sys.argv[3]
BASE = "https://financialmodelingprep.com/stable"

def fetch(endpoint, params=""):
    url = f"{BASE}/{endpoint}?symbol={symbol}&apikey={fmp_key}{params}"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return None

# Get current price from DB
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
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

# Fetch ratios TTM
ratios = fetch("ratios-ttm")
if not ratios or not isinstance(ratios, list) or len(ratios) == 0:
    print(f"  No ratio data for {symbol}")
    sys.exit(1)
r = ratios[0]

t12_pe = r.get('priceToEarningsRatioTTM', 0)
peg = r.get('priceToEarningsGrowthRatioTTM', 0)
fwd_peg = r.get('forwardPriceToEarningsGrowthRatioTTM', 0)
ps = r.get('priceToSalesRatioTTM', 0)

# Fetch analyst estimates
import datetime
estimates = fetch("analyst-estimates", "&period=annual&limit=8")
if not estimates or not isinstance(estimates, list):
    estimates = []

# Sort by date ascending
estimates.sort(key=lambda x: x.get('date', ''))

# Find next two fiscal years that haven't ended yet
today = datetime.date.today().isoformat()
current_year = datetime.date.today().year
future_estimates = [e for e in estimates if e.get('date', '') > today and e.get('epsAvg', 0) and e.get('epsAvg', 0) > 0]

fy_current = future_estimates[0] if len(future_estimates) >= 1 else None
fy_next = future_estimates[1] if len(future_estimates) >= 2 else None

# Compute forward PE
fwd_pe = None
fwd_eps = None
if fy_current and fy_current.get('epsAvg', 0) > 0:
    fwd_eps = fy_current['epsAvg']
    fwd_pe = price / fwd_eps

# EPS growth rate (current FY to next FY)
eps_growth = None
if fy_current and fy_next and fy_current.get('epsAvg', 0) > 0 and fy_next.get('epsAvg', 0) > 0:
    eps_growth = (fy_next['epsAvg'] - fy_current['epsAvg']) / fy_current['epsAvg'] * 100

# Trailing EPS
t12_eps = price / t12_pe if t12_pe and t12_pe > 0 else None

# Fair price range using PE-based valuation
# Low: 0.8x forward PE (discount)
# Mid: 1.0x forward PE (consensus)
# High: 1.2x forward PE (premium) or PEG=1 justified
fair_low = fair_mid = fair_high = None
if fwd_eps and fwd_pe:
    # Use sector-appropriate PE multiples
    # For growth (fwd PE > 30): use growth-adjusted range
    # For value (fwd PE < 20): tighter range
    if fwd_pe > 30:
        fair_low = fwd_eps * fwd_pe * 0.75
        fair_mid = fwd_eps * fwd_pe * 0.90
        fair_high = fwd_eps * fwd_pe * 1.10
    else:
        fair_low = fwd_eps * fwd_pe * 0.85
        fair_mid = fwd_eps * fwd_pe * 1.0
        fair_high = fwd_eps * fwd_pe * 1.15

    # Also compute PEG=1 fair value if we have growth
    if eps_growth and eps_growth > 0:
        peg1_pe = eps_growth  # PEG=1 means PE = growth rate
        peg1_price = fwd_eps * peg1_pe
        # Use PEG=1 as alternative high anchor if it's higher
        if peg1_price > fair_high:
            fair_high = peg1_price

# Display
print()
print(f"╔═══════════════════════════════════════════════╗")
print(f"║  VALUATION: {symbol:<33}║")
print(f"╚═══════════════════════════════════════════════╝")
print()
print(f"  Price: ${price:.2f} (as of {price_date})")
print()

print(f"  ── Earnings ──")
if t12_eps:
    print(f"  Trailing EPS (T12): ${t12_eps:.2f}")
if fy_current:
    n = fy_current.get('numAnalystsEps', 0)
    fy_label = fy_current['date'][:7]
    print(f"  Next FY ({fy_label}) EPS est: ${fy_current['epsAvg']:.2f}  ({n} analysts)")
if fy_next:
    n = fy_next.get('numAnalystsEps', 0)
    fy_label = fy_next['date'][:7]
    print(f"  FY+1   ({fy_label}) EPS est: ${fy_next['epsAvg']:.2f}  ({n} analysts)")
if eps_growth is not None:
    print(f"  EPS growth (next→+1): {eps_growth:+.1f}%")
print()

print(f"  ── Multiples ──")
print(f"  Trailing PE (T12):  {t12_pe:.1f}x" if t12_pe else "  Trailing PE (T12):  N/A")
print(f"  Forward PE (FY{current_year}): {fwd_pe:.1f}x" if fwd_pe else f"  Forward PE (FY{current_year}): N/A")
print(f"  PEG (trailing):    {peg:.2f}" if peg else "  PEG (trailing):    N/A")
print(f"  PEG (forward):     {fwd_peg:.2f}" if fwd_peg else "  PEG (forward):     N/A")
print(f"  P/S (T12):         {ps:.1f}x" if ps else "  P/S (T12):         N/A")
print()

if fair_low and fair_mid and fair_high:
    print(f"  ── Fair Price Range ──")
    vs_low = (price - fair_low) / fair_low * 100
    vs_mid = (price - fair_mid) / fair_mid * 100
    vs_high = (price - fair_high) / fair_high * 100

    def bar(price_val, low, high, width=30):
        if high <= low: return ""
        pos = (price_val - low) / (high - low)
        pos = max(0, min(1, pos))
        idx = int(pos * width)
        return "─" * idx + "●" + "─" * (width - idx - 1)

    range_low = min(fair_low * 0.9, price * 0.9)
    range_high = max(fair_high * 1.1, price * 1.1)

    print(f"  Low  (discount):  ${fair_low:>8.2f}  ({vs_low:+.1f}% from current)")
    print(f"  Mid  (consensus): ${fair_mid:>8.2f}  ({vs_mid:+.1f}% from current)")
    print(f"  High (premium):   ${fair_high:>8.2f}  ({vs_high:+.1f}% from current)")
    print()

    # Summary verdict
    if price < fair_low:
        print(f"  → UNDERVALUED ({abs(vs_low):.0f}% below fair range)")
    elif price > fair_high:
        print(f"  → OVERVALUED ({vs_high:.0f}% above fair range)")
    elif price < fair_mid:
        print(f"  → BELOW CONSENSUS (in lower half of fair range)")
    else:
        print(f"  → ABOVE CONSENSUS (in upper half of fair range)")

# EPS trajectory
if len(estimates) >= 2:
    print()
    print(f"  ── EPS Trajectory ──")
    print(f"  {'Year':<6} {'EPS Est':>8} {'YoY':>8} {'Implied PE':>10}  Analysts")
    print(f"  {'─'*6} {'─'*8} {'─'*8} {'─'*10}  {'─'*8}")
    prev_eps = None
    for est in estimates:
        yr = est['date'][:4]
        eps = est.get('epsAvg', 0)
        n = est.get('numAnalystsEps', 0)
        yoy = ""
        if prev_eps and prev_eps > 0 and eps > 0:
            yoy = f"{((eps - prev_eps) / prev_eps * 100):+.0f}%"
        imp_pe = f"{price / eps:.1f}x" if eps > 0 else "N/A"
        print(f"  {yr:<6} ${eps:>7.2f} {yoy:>8} {imp_pe:>10}  {n:>3}")
        prev_eps = eps

print()
conn.close()
PYEOF
    ;;

  screen)
    RESULT=$("$SCRIPT_DIR/run-ts.sh" screen 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
      echo "Error computing screen." >&2
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json

results = json.load(sys.stdin)
if not results:
    print('  No watchlist items found.')
    sys.exit(0)

print()
print('=== Watchlist Screening ===')
print()
print(f'  {\"Symbol\":<7} {\"Price\":>8} {\"Rating\":>8} {\"PEG\":>6} {\"Fwd PE\":>8} {\"Growth\":>8} {\"Score\":>6}  Watchlist')
print(f'  {\"─\"*7} {\"─\"*8} {\"─\"*8} {\"─\"*6} {\"─\"*8} {\"─\"*8} {\"─\"*6}  {\"─\"*12}')

for r in results:
    rating = r['pegRating'] or '—'
    peg = f\"{r['forwardPeg']:.2f}\" if r['forwardPeg'] and r['forwardPeg'] > 0 else '—'
    fwd_pe = f\"{r['forwardPe']:.1f}x\" if r['forwardPe'] and r['forwardPe'] > 0 else '—'
    growth = f\"{r['epsGrowthPct']:+.0f}%\" if r['epsGrowthPct'] else '—'
    wl = r['watchlist'] or '—'
    print(f'  {r[\"symbol\"]:<7} \${r[\"price\"]:>7.2f} {rating:>8} {peg:>6} {fwd_pe:>8} {growth:>8} {r[\"compositeScore\"]:>6}  {wl}')

print()
print('  Scoring: Valuation (CHEAP=3,FAIR=2,RICH=1,PRICEY=0) + Technical (support=+1,resistance=-1) + Growth (>50%=+2,>30%=+1)')
print()
"
    ;;

  scan-trades)
    # Two-step trade scanner: confluence signals → trend filter → R:R analysis
    FMP_KEY=$(get_fmp_key)
    if [ -z "$FMP_KEY" ]; then
      echo "ERROR: FMP API key not configured in ~/.pm-cli.conf"
      exit 1
    fi

    python3 - "$DB" "$FMP_KEY" << 'PYEOF'
import sqlite3, sys, json, urllib.request, time

db_path = sys.argv[1]
fmp_key = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# --- Regime filter: parse punished sectors from today's ritual ---
SECTOR_ALIASES = {
    'tech': 'Technology', 'technology': 'Technology',
    'comms': 'Communication Services', 'comm services': 'Communication Services',
    'communication': 'Communication Services', 'communication services': 'Communication Services',
    'consumer cyclical': 'Consumer Cyclical', 'cyclical': 'Consumer Cyclical',
    'consumer defensive': 'Consumer Defensive', 'defensive': 'Consumer Defensive',
    'defensives': 'Consumer Defensive',
    'financial': 'Financial Services', 'financial services': 'Financial Services',
    'financials': 'Financial Services',
    'healthcare': 'Healthcare', 'health': 'Healthcare',
    'industrials': 'Industrials', 'industrial': 'Industrials',
    'energy': 'Energy', 'oil': 'Energy',
    'utilities': 'Utilities', 'utility': 'Utilities',
    'basic materials': 'Basic Materials', 'materials': 'Basic Materials',
    'real estate': 'Real Estate',
}

def get_punished_sectors(conn):
    """Parse regime_punishing free-text into a set of canonical sector names."""
    from datetime import date
    today = date.today().isoformat()
    ritual = conn.execute(
        "SELECT regime_punishing, regime_type FROM daily_rituals WHERE date = ?", (today,)
    ).fetchone()
    if not ritual or not ritual['regime_punishing']:
        return set(), None
    text = ritual['regime_punishing'].lower()
    punished = set()
    for alias, canonical in SECTOR_ALIASES.items():
        if alias in text:
            punished.add(canonical)
    return punished, ritual['regime_type']

def get_symbol_sector(conn, symbol):
    """Get the sector for a symbol from the securities table."""
    row = conn.execute("SELECT sector FROM securities WHERE symbol = ?", (symbol,)).fetchone()
    return row['sector'] if row and row['sector'] else None

punished_sectors, regime_type = get_punished_sectors(conn)

# --- Step 0: Gather confluence symbols (same as confluence command) ---
symbols_data = conn.execute("""
    SELECT DISTINCT symbol FROM (
        SELECT wi.symbol FROM watchlist_items wi
        UNION
        SELECT s.symbol FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.type = 'stock' AND p.quantity > 0
    )
""").fetchall()

confluence = []
for sd in symbols_data:
    symbol = sd['symbol']
    signals = []

    vm = conn.execute("""
        SELECT peg_rating, forward_peg, forward_pe, eps_growth_pct,
               fair_low, fair_mid, fair_high
        FROM valuation_metrics WHERE symbol = ?
        ORDER BY date DESC LIMIT 1
    """, (symbol,)).fetchone()

    price_row = conn.execute("""
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
    """, (symbol,)).fetchone()
    price = price_row['close_price'] if price_row else 0
    if not price or price <= 0:
        continue

    # Signal 1: Valuation
    fwd_peg = None
    rating = None
    eps_growth = None
    fwd_pe = None
    if vm:
        fwd_peg = vm['forward_peg']
        rating = vm['peg_rating']
        eps_growth = vm['eps_growth_pct']
        fwd_pe = vm['forward_pe']
        if rating in ('CHEAP', 'FAIR') and fwd_peg and fwd_peg > 0 and fwd_peg < 1.2:
            signals.append(f"{rating} PEG:{fwd_peg:.2f}")

    # Signal 2: Near support (must be meaningfully below price, not just barely)
    nearest_s = conn.execute("""
        SELECT price, strength FROM price_levels
        WHERE symbol = ? AND level_type = 'support' AND price < ? * 0.99
        ORDER BY price DESC LIMIT 1
    """, (symbol, price)).fetchone()
    if nearest_s:
        pct_from_s = (price - nearest_s['price']) / price * 100
        if pct_from_s <= 5:
            signals.append(f"S${nearest_s['price']:.0f} {pct_from_s:.1f}%")

    # Signal 3: EPS growth
    if vm and vm['eps_growth_pct'] and vm['eps_growth_pct'] > 20:
        signals.append(f"EPS+{vm['eps_growth_pct']:.0f}%")

    if len(signals) < 2:
        continue

    # Get S/R levels for R:R (support must be at least 1% below price to be meaningful)
    supports = conn.execute("""
        SELECT price, strength FROM price_levels
        WHERE symbol = ? AND level_type = 'support' AND price < ? * 0.99
        ORDER BY price DESC LIMIT 3
    """, (symbol, price)).fetchall()
    resistances = conn.execute("""
        SELECT price, strength FROM price_levels
        WHERE symbol = ? AND level_type = 'resistance' AND price > ?
        ORDER BY price ASC LIMIT 3
    """, (symbol, price)).fetchall()

    s1 = supports[0] if supports else None
    r1 = resistances[0] if resistances else None
    rr = None
    if s1 and r1:
        downside = price - s1['price']
        upside = r1['price'] - price
        # Require at least 2% downside to compute meaningful R:R
        if downside > price * 0.02:
            rr = upside / downside
        else:
            rr = None  # too close to call

    confluence.append({
        'symbol': symbol, 'price': price, 'signals': signals,
        'signal_count': len(signals), 'fwd_peg': fwd_peg, 'rating': rating,
        'eps_growth': eps_growth, 'fwd_pe': fwd_pe,
        's1': s1, 'r1': r1, 'rr': rr,
        'supports': supports, 'resistances': resistances,
        'fair_low': vm['fair_low'] if vm else None,
        'fair_mid': vm['fair_mid'] if vm else None,
        'fair_high': vm['fair_high'] if vm else None,
    })

if not confluence:
    print("\n  No confluence symbols found.\n")
    conn.close()
    sys.exit(0)

# --- Step 1: Fetch technicals from FMP for confluence symbols ---
base = 'https://financialmodelingprep.com/stable/technical-indicators'

def fetch_tech(indicator, symbol, period):
    url = f'{base}/{indicator}?symbol={symbol}&periodLength={period}&timeframe=1day&apikey={fmp_key}'
    try:
        data = json.loads(urllib.request.urlopen(url).read())
        return data[0] if data else None
    except:
        return None

print()
print("=" * 80)
print("  TRADE SCANNER — Confluence + Trend + R:R")
print("=" * 80)

tradeable = []
not_tradeable = []

for c in confluence:
    sym = c['symbol']
    sma20 = fetch_tech('sma', sym, 20)
    sma50 = fetch_tech('sma', sym, 50)
    sma200 = fetch_tech('sma', sym, 200)
    rsi_data = fetch_tech('rsi', sym, 14)

    p = sma20.get('close', c['price']) if sma20 else c['price']
    s20 = sma20.get('sma', 0) if sma20 else 0
    s50 = sma50.get('sma', 0) if sma50 else 0
    s200 = sma200.get('sma', 0) if sma200 else 0
    rsi_val = rsi_data.get('rsi', 0) if rsi_data else 0

    above_count = sum(1 for s in [s20, s50, s200] if s > 0 and p >= s)
    if above_count == 3:
        trend = 'UPTREND'
    elif above_count == 0:
        trend = 'DOWNTREND'
    elif p >= s200:
        trend = 'PULLBACK'
    else:
        trend = 'BREAKDOWN'

    c['trend'] = trend
    c['rsi'] = rsi_val
    c['above_dmas'] = above_count
    c['sma20'] = s20
    c['sma50'] = s50
    c['sma200'] = s200
    c['live_price'] = p

    # Tradeable = uptrend or pullback (above 200 DMA)
    if trend in ('UPTREND', 'PULLBACK'):
        tradeable.append(c)
    else:
        not_tradeable.append(c)

    time.sleep(0.15)  # rate limit

# --- Step 1.5: Regime filter — separate punished-sector names ---
regime_blocked = []
if punished_sectors:
    filtered_tradeable = []
    for c in tradeable:
        sector = get_symbol_sector(conn, c['symbol'])
        if sector and sector in punished_sectors:
            c['block_reason'] = f"regime punishing {sector}"
            regime_blocked.append(c)
        else:
            filtered_tradeable.append(c)
    tradeable = filtered_tradeable

    filtered_not_tradeable = []
    for c in not_tradeable:
        sector = get_symbol_sector(conn, c['symbol'])
        if sector and sector in punished_sectors:
            c['block_reason'] = f"regime punishing {sector}"
            regime_blocked.append(c)
        else:
            filtered_not_tradeable.append(c)
    not_tradeable = filtered_not_tradeable

# --- Step 2: Display results ---

# Sort tradeable by R:R descending
tradeable.sort(key=lambda x: x.get('rr') or 0, reverse=True)

if tradeable:
    print()
    print("  TRADEABLE (trend supports entry)")
    print("  " + "-" * 76)
    print(f"  {'Symbol':<8} {'Price':>8} {'Trend':<10} {'RSI':>5} {'R:R':>6} {'Signals':<28} {'Entry Level'}")
    print("  " + "-" * 76)
    for c in tradeable:
        rr_str = f"{c['rr']:.1f}x" if c['rr'] else '—'
        rr_flag = ' ✓' if c['rr'] and c['rr'] >= 2.0 else ' ⚠' if c['rr'] else ''
        sigs = ', '.join(c['signals'])

        # Determine suggested entry
        if c['rr'] and c['rr'] >= 2.0:
            entry = f"NOW (R:R {rr_str})"
        elif c['sma50'] and c['live_price'] > c['sma50']:
            # Above 50 DMA — pullback to 50 DMA is entry
            entry = f"50 DMA ${c['sma50']:.0f}"
        elif c['sma20'] and c['live_price'] > c['sma20']:
            entry = f"20 DMA ${c['sma20']:.0f}"
        else:
            s1p = c['s1']['price'] if c['s1'] else 0
            entry = f"S1 ${s1p:.0f}" if s1p else '—'

        print(f"  {c['symbol']:<8} ${c['live_price']:>7.2f} {c['trend']:<10} {c['rsi']:>5.1f} {rr_str:>5}{rr_flag} {sigs:<28} {entry}")

    # Detail section for tradeable
    print()
    for c in tradeable:
        print(f"  --- {c['symbol']} ---")
        rr_str = f"{c['rr']:.1f}x" if c['rr'] else '—'
        print(f"  Price: ${c['live_price']:.2f} | Fwd PE: {c['fwd_pe']:.1f}x | PEG: {c['fwd_peg']:.2f} ({c['rating']})" if c['fwd_pe'] and c['fwd_peg'] else f"  Price: ${c['live_price']:.2f}")
        print(f"  DMAs: 20=${c['sma20']:.0f} 50=${c['sma50']:.0f} 200=${c['sma200']:.0f} | RSI: {c['rsi']:.0f} | R:R: {rr_str}")
        if c['supports']:
            s_str = '  '.join(f"${s['price']:.0f}({s['strength']}/10)" for s in c['supports'])
            print(f"  S: {s_str}")
        if c['resistances']:
            r_str = '  '.join(f"${r['price']:.0f}({r['strength']}/10)" for r in c['resistances'])
            print(f"  R: {r_str}")
        if c['fair_low'] and c['fair_high']:
            print(f"  Fair: ${c['fair_low']:.0f} – ${c['fair_mid']:.0f} – ${c['fair_high']:.0f}")

        # Suggest entry
        if c['rr'] and c['rr'] >= 2.0:
            print(f"  → ENTRY NOW: R:R {rr_str} is favorable at current price")
        else:
            levels = []
            if c['sma50'] and c['live_price'] > c['sma50']:
                levels.append(f"50 DMA pullback ${c['sma50']:.0f}")
            if c['s1']:
                levels.append(f"S1 ${c['s1']['price']:.0f} ({c['s1']['strength']}/10)")
            if levels:
                print(f"  → WAIT: R:R {rr_str} insufficient. Better entry at: {', '.join(levels)}")
            else:
                print(f"  → WAIT: No clear entry level with favorable R:R")
        print()

if not_tradeable:
    print()
    print("  NOT TRADEABLE (trend does not support entry)")
    print("  " + "-" * 76)
    print(f"  {'Symbol':<8} {'Price':>8} {'Trend':<12} {'RSI':>5} {'Signals':<32} {'Wait For'}")
    print("  " + "-" * 76)
    for c in not_tradeable:
        sigs = ', '.join(c['signals'])
        if c['trend'] == 'DOWNTREND':
            wait = f"Reclaim 20 DMA ${c['sma20']:.0f}" if c['sma20'] else 'trend reversal'
        else:
            wait = f"Reclaim 200 DMA ${c['sma200']:.0f}" if c['sma200'] else 'trend reversal'
        print(f"  {c['symbol']:<8} ${c['live_price']:>7.2f} {c['trend']:<12} {c['rsi']:>5.1f} {sigs:<32} {wait}")

if regime_blocked:
    print()
    print(f"  REGIME-BLOCKED ({len(regime_blocked)} names in punished sectors)")
    print("  " + "-" * 76)
    print(f"  {'Symbol':<8} {'Price':>8} {'Sector':<24} {'Signals':<28} {'Reason'}")
    print("  " + "-" * 76)
    for c in regime_blocked:
        sector = get_symbol_sector(conn, c['symbol']) or '?'
        sigs = ', '.join(c['signals'])
        print(f"  {c['symbol']:<8} ${c.get('live_price', c['price']):>7.2f} {sector:<24} {sigs:<28} {c['block_reason']}")

print()
regime_str = f", {len(regime_blocked)} regime-blocked" if regime_blocked else ""
regime_note = f"  Regime: {regime_type or 'none'}"
if punished_sectors:
    regime_note += f" — punishing: {', '.join(sorted(punished_sectors))}"
print(regime_note)
print(f"  Summary: {len(tradeable)} tradeable, {len(not_tradeable)} waiting for trend{regime_str}")
print()

conn.close()
PYEOF
    ;;

  confluence)
    RESULT=$("$SCRIPT_DIR/run-ts.sh" confluence 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
      echo "Error computing confluence." >&2
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json, sqlite3, os
from datetime import date

results = json.load(sys.stdin)

# Regime filter (safety mechanism — sorting day gate)
SECTOR_ALIASES = {
    'tech': 'Technology', 'technology': 'Technology',
    'comms': 'Communication Services', 'communication services': 'Communication Services',
    'consumer cyclical': 'Consumer Cyclical', 'cyclical': 'Consumer Cyclical',
    'financial': 'Financial Services', 'financials': 'Financial Services',
    'healthcare': 'Healthcare', 'industrials': 'Industrials',
    'energy': 'Energy', 'utilities': 'Utilities',
    'basic materials': 'Basic Materials', 'real estate': 'Real Estate',
}

db_path = os.path.expanduser('~/Library/Application Support/portfolio-manager/portfolio.db')
punished_sectors = set()
regime_type = None
try:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    today = date.today().isoformat()
    ritual = conn.execute('SELECT regime_punishing, regime_type FROM daily_rituals WHERE date = ?', (today,)).fetchone()
    if ritual and ritual['regime_punishing']:
        text = ritual['regime_punishing'].lower()
        for alias, canonical in SECTOR_ALIASES.items():
            if alias in text:
                punished_sectors.add(canonical)
        regime_type = ritual['regime_type']

    # Look up sectors for each symbol
    for r in results:
        row = conn.execute('SELECT sector FROM securities WHERE symbol = ?', (r['symbol'],)).fetchone()
        r['sector'] = row['sector'] if row and row['sector'] else None
        r['regime_blocked'] = r['sector'] in punished_sectors if r['sector'] else False

        # Look up watchlist
        wl = conn.execute('SELECT w.name FROM watchlist_items wi JOIN watchlists w ON wi.watchlist_id = w.id WHERE wi.symbol = ?', (r['symbol'],)).fetchone()
        r['watchlist'] = wl['name'] if wl else '—'
    conn.close()
except:
    for r in results:
        r['regime_blocked'] = False
        r['watchlist'] = '—'

if not results:
    print()
    print('=== Entry Confluence Detection ===')
    print('  No symbols with 2+ aligned signals found.')
    print()
    sys.exit(0)

print()
print('=== Entry Confluence Detection ===')
if punished_sectors:
    print(f'  Regime: {regime_type} — caution: {\", \".join(sorted(punished_sectors))}')
print(f'  Found {len(results)} symbols with entry confluence:')
print()

for r in results:
    sym = r['symbol']
    count = r['signalCount']
    marker = ' ⊘ REGIME-BLOCKED' if r.get('regime_blocked') else ''
    print(f'  {sym} — {count} signals ({r[\"watchlist\"]}){marker}:')
    for s in r['signals']:
        print(f'    • {s[\"label\"]}')
    print()
"
    ;;

  valuations)
    # Portfolio-wide valuation table (reads from DB — run refresh first)
    SCOPE="${2:-portfolio}"

    python3 - "$DB" "$SCOPE" << 'PYEOF'
import sqlite3, sys

db_path = sys.argv[1]
scope = sys.argv[2]

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Get symbols based on scope
if scope == "all":
    symbols = [r['symbol'] for r in conn.execute("""
        SELECT DISTINCT symbol FROM valuation_metrics ORDER BY symbol
    """).fetchall()]
elif scope == "watchlist":
    symbols = [r['symbol'] for r in conn.execute("""
        SELECT DISTINCT wi.symbol FROM watchlist_items wi ORDER BY wi.symbol
    """).fetchall()]
else:
    symbols = [r['symbol'] for r in conn.execute("""
        SELECT DISTINCT s.symbol FROM positions p JOIN securities s ON p.security_id = s.id
        WHERE s.type = 'stock' AND p.quantity > 0 ORDER BY s.symbol
    """).fetchall()]

print()
print(f"=== {'Portfolio' if scope == 'portfolio' else scope.title()} Valuations ===")

# Check if we have data
has_data = conn.execute("SELECT COUNT(*) as c FROM valuation_metrics").fetchone()
if not has_data or has_data['c'] == 0:
    print("  No valuation data. Run: pm-cli.sh refresh")
    sys.exit(0)

print()
print(f"  {'Symbol':<7} {'Price':>8} {'T12 PE':>8} {'Fwd PE':>8} {'PEG':>6} {'FY EPS':>8} {'Growth':>8} {'Rating':>8}")
print(f"  {'─'*7} {'─'*8} {'─'*8} {'─'*8} {'─'*6} {'─'*8} {'─'*8} {'─'*8}")

for symbol in symbols:
    # Latest valuation row
    v = conn.execute("""
        SELECT * FROM valuation_metrics WHERE symbol = ? ORDER BY date DESC LIMIT 1
    """, (symbol,)).fetchone()
    if not v:
        continue

    # Current price
    price_row = conn.execute("""
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
    """, (symbol,)).fetchone()
    price = price_row['close_price'] if price_row else 0

    t12_pe = v['trailing_pe']
    fwd_pe = v['forward_pe']
    fwd_peg = v['forward_peg']
    fwd_eps = v['forward_eps']
    eps_g = v['eps_growth_pct']
    rating = v['peg_rating'] or ''

    t12_str = f"{t12_pe:.1f}x" if t12_pe and t12_pe > 0 else "N/A"
    fwd_str = f"{fwd_pe:.1f}x" if fwd_pe and fwd_pe > 0 else "N/A"
    peg_str = f"{fwd_peg:.2f}" if fwd_peg and fwd_peg > 0 else "N/A"
    eps_str = f"${fwd_eps:.2f}" if fwd_eps else "N/A"
    growth_str = f"{eps_g:+.0f}%" if eps_g else ""

    print(f"  {symbol:<7} ${price:>7.2f} {t12_str:>8} {fwd_str:>8} {peg_str:>6} {eps_str:>8} {growth_str:>8} {rating:>8}")

# Show data freshness
latest = conn.execute("SELECT MAX(fetched_at) as ts FROM valuation_metrics").fetchone()
if latest and latest['ts']:
    print(f"\n  Data as of: {latest['ts'][:16]}")

print()
conn.close()
PYEOF
    ;;

  peers)
    # Peer comparison: same-sector symbols ranked by PEG
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh peers <symbol>"
      exit 1
    fi
    python3 - "$DB" "$SYMBOL" << 'PYEOF'
import sqlite3, sys

db_path = sys.argv[1]
symbol = sys.argv[2].upper()
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Look up sector/industry for the target symbol
sec = conn.execute("SELECT sector, industry FROM securities WHERE symbol = ?", (symbol,)).fetchone()
if not sec or not sec['sector']:
    print(f"\n  No sector data for {symbol}. Run 'pm-cli.sh valuation {symbol}' first to populate.\n")
    sys.exit(0)

sector = sec['sector']
industry = sec['industry'] or '—'

# Find all symbols in the same sector that have valuation data
peers = conn.execute("""
    SELECT DISTINCT vm.symbol, vm.trailing_pe, vm.forward_pe, vm.peg, vm.forward_peg,
           vm.eps_growth_pct, vm.peg_rating, vm.fair_low, vm.fair_high,
           s.industry
    FROM valuation_metrics vm
    JOIN securities s ON s.symbol = vm.symbol
    INNER JOIN (
        SELECT symbol, MAX(date) as max_date
        FROM valuation_metrics GROUP BY symbol
    ) latest ON vm.symbol = latest.symbol AND vm.date = latest.max_date
    WHERE s.sector = ?
    ORDER BY vm.symbol
""", (sector,)).fetchall()

if len(peers) < 2:
    print(f"\n  Insufficient peer data for comparison ({len(peers)} symbol(s) in {sector}).")
    print(f"  Run 'pm-cli.sh valuation <symbol>' for more sector peers.\n")
    sys.exit(0)

# Get current prices and held quantities
results = []
for p in peers:
    sym = p['symbol']

    price_row = conn.execute("""
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
    """, (sym,)).fetchone()
    price = price_row['close_price'] if price_row else 0

    # Check if held
    held_row = conn.execute("""
        SELECT SUM(p.quantity) as qty FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.symbol = ? AND p.quantity > 0
    """, (sym,)).fetchone()
    qty = int(held_row['qty']) if held_row and held_row['qty'] else 0

    t12_pe = p['trailing_pe']
    fwd_pe = p['forward_pe']
    peg = p['peg']
    fwd_peg = p['forward_peg']
    eps_g = p['eps_growth_pct']
    rating = p['peg_rating'] or ''
    fair_low = p['fair_low']
    fair_high = p['fair_high']
    ind = p['industry'] or ''

    # Use forward PEG for sorting if available, else PEG
    sort_peg = fwd_peg if fwd_peg and fwd_peg > 0 else (peg if peg and peg > 0 else 999)

    results.append({
        'symbol': sym,
        'price': price,
        't12_pe': t12_pe,
        'fwd_pe': fwd_pe,
        'peg': peg,
        'fwd_peg': fwd_peg,
        'sort_peg': sort_peg,
        'eps_g': eps_g,
        'rating': rating,
        'fair_low': fair_low,
        'fair_high': fair_high,
        'qty': qty,
        'industry': ind,
        'is_target': sym == symbol,
    })

# Sort by PEG ascending (cheapest first)
results.sort(key=lambda x: x['sort_peg'])

# Print header
print()
print(f"=== Peer Comparison: {symbol} ===")
print(f"  Sector: {sector}  |  Industry: {industry}")
print()
print(f"  {'Symbol':<7} {'Price':>8}  {'T12 PE':>7} {'Fwd PE':>7}  {'PEG':>6}  {'Growth':>7} {'Rating':>8}  {'Fair Range':>18}  {'Held?':>7}")
print(f"  {'─'*7} {'─'*8}  {'─'*7} {'─'*7}  {'─'*6}  {'─'*7} {'─'*8}  {'─'*18}  {'─'*7}")

target_rank = None
cheaper_peers = []
for i, r in enumerate(results):
    t12_str = f"{r['t12_pe']:.1f}x" if r['t12_pe'] and r['t12_pe'] > 0 else "—"
    fwd_str = f"{r['fwd_pe']:.1f}x" if r['fwd_pe'] and r['fwd_pe'] > 0 else "—"
    peg_val = r['fwd_peg'] if r['fwd_peg'] and r['fwd_peg'] > 0 else r['peg']
    peg_str = f"{peg_val:.2f}" if peg_val and peg_val > 0 else "—"
    growth_str = f"{r['eps_g']:+.0f}%" if r['eps_g'] else "—"
    rating_str = r['rating'] if r['rating'] else "—"

    if r['fair_low'] and r['fair_high']:
        fair_str = f"${r['fair_low']:.0f} – ${r['fair_high']:.0f}"
    else:
        fair_str = "—"

    if r['is_target']:
        fair_str += " \u2190 you"
        target_rank = i

    held_str = f"{r['qty']}sh" if r['qty'] > 0 else "—"

    print(f"  {r['symbol']:<7} ${r['price']:>7.0f}  {t12_str:>7} {fwd_str:>7}  {peg_str:>6}  {growth_str:>7} {rating_str:>8}  {fair_str:>18}  {held_str:>7}")

    if not r['is_target'] and target_rank is None:
        cheaper_peers.append(r['symbol'])

# Takeaway
print()
if target_rank == 0:
    print(f"  Takeaway: {symbol} is cheapest in peer group on PEG basis.")
elif cheaper_peers:
    if len(cheaper_peers) <= 3:
        names = " and ".join(cheaper_peers)
    else:
        names = ", ".join(cheaper_peers[:3]) + f" (+{len(cheaper_peers)-3} more)"
    print(f"  Takeaway: {names} {'is' if len(cheaper_peers)==1 else 'are'} cheaper on growth-adjusted basis.")
else:
    print(f"  Takeaway: {symbol} ranks well among peers.")
print()

conn.close()
PYEOF
    ;;

  earnings-prep)
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh earnings-prep <symbol>"
      echo "  Assembles pre-earnings review: position, valuation, scorecard,"
      echo "  observations, research notes, news, and technical levels."
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"

    python3 - "$SYMBOL" "$DB" "$THESIS_PATH" << 'PYEOF'
import sqlite3, sys, re, os
from datetime import datetime, timedelta

symbol = sys.argv[1]
db_path = sys.argv[2]
thesis_path = sys.argv[3]

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# ── 1. Company Header ──
sec = conn.execute("""
    SELECT id, symbol, name, sector, industry FROM securities WHERE symbol = ?
""", (symbol,)).fetchone()

if not sec:
    print(f"ERROR: Symbol {symbol} not found in securities table.")
    sys.exit(1)

sec_id = sec['id']
name = sec['name'] or symbol
sector = sec['sector'] or '—'
industry = sec['industry'] or '—'

# Next earnings date from earnings_reviews (most recent future date) or monitors
next_earnings = None
er = conn.execute("""
    SELECT earnings_date FROM earnings_reviews
    WHERE security_id = ? AND earnings_date >= date('now')
    ORDER BY earnings_date ASC LIMIT 1
""", (sec_id,)).fetchone()
if er:
    next_earnings = er['earnings_date']
else:
    mon = conn.execute("""
        SELECT reminder_date FROM monitors
        WHERE symbol = ? AND lower(label) LIKE '%earning%' AND status = 'active'
        ORDER BY reminder_date ASC LIMIT 1
    """, (symbol,)).fetchone()
    if mon:
        next_earnings = mon['reminder_date']

print()
print(f"{'=' * 65}")
print(f"  EARNINGS PREP: {symbol} — {name[:40]}")
print(f"{'=' * 65}")
print()
print(f"  Sector: {sector}  |  Industry: {industry}")
print(f"  Next Earnings: {next_earnings or 'Unknown'}")
print()

# ── 2. Current Position Info ──
positions = conn.execute("""
    SELECT p.id, p.quantity, p.cost_basis, a.name as acct_name,
           pi.tier, pi.thesis, pi.invalidation, pi.target_allocation_pct,
           pi.target_hold_period, pi.entry_style
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    JOIN accounts a ON p.account_id = a.id
    LEFT JOIN position_intents pi ON pi.position_id = p.id
    WHERE s.symbol = ? AND s.type NOT IN ('cash', 'option') AND p.quantity > 0
""", (symbol,)).fetchall()

# Get current price
price_row = conn.execute("""
    SELECT ph.close_price, ph.date FROM price_history ph
    JOIN securities s ON ph.security_id = s.id
    WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
""", (symbol,)).fetchone()
current_price = price_row['close_price'] if price_row else 0
price_date = price_row['date'] if price_row else '—'

print(f"── Position ──")
if not positions:
    print(f"  Not currently held")
else:
    total_qty = sum(p['quantity'] or 0 for p in positions)
    total_cost = sum(p['cost_basis'] or 0 for p in positions)
    avg_cost = total_cost / total_qty if total_qty > 0 else 0
    market_value = total_qty * current_price
    unrealized_pct = ((current_price - avg_cost) / avg_cost * 100) if avg_cost > 0 else 0

    print(f"  Shares: {total_qty:,.0f}  |  Avg Cost: ${avg_cost:.2f}  |  MTM: ${current_price:.2f} ({price_date})")
    print(f"  Market Value: ${market_value:,.0f}  |  Unrealized: {unrealized_pct:+.1f}%")

    if len(positions) > 1:
        for p in positions:
            qty = p['quantity'] or 0
            cb = p['cost_basis'] or 0
            ac = cb / qty if qty > 0 else 0
            print(f"    {p['acct_name']}: {qty:,.0f} shares @ ${ac:.2f}")

    # Intent info from first position with tier
    intent = None
    for p in positions:
        if p['tier']:
            intent = p
            break
    if intent:
        print(f"  Tier: {intent['tier']}  |  Entry: {intent['entry_style'] or '—'}  |  Hold: {intent['target_hold_period'] or '—'}")
        if intent['thesis']:
            thesis = intent['thesis']
            print(f"  Thesis: {thesis[:100]}{'...' if len(thesis) > 100 else ''}")
        if intent['invalidation']:
            inv = intent['invalidation']
            print(f"  Invalidation: {inv[:100]}{'...' if len(inv) > 100 else ''}")
print()

# ── 3. Valuation Snapshot ──
val = conn.execute("""
    SELECT * FROM valuation_metrics WHERE symbol = ? ORDER BY date DESC LIMIT 1
""", (symbol,)).fetchone()

print(f"── Valuation ──")
if not val:
    print(f"  No valuation data. Run: pm-cli.sh valuation {symbol}")
else:
    t_pe = f"{val['trailing_pe']:.1f}x" if val['trailing_pe'] and val['trailing_pe'] > 0 else "N/A"
    f_pe = f"{val['forward_pe']:.1f}x" if val['forward_pe'] and val['forward_pe'] > 0 else "N/A"
    peg = f"{val['forward_peg']:.2f}" if val['forward_peg'] and val['forward_peg'] > 0 else "N/A"
    eps_g = f"{val['eps_growth_pct']:+.0f}%" if val['eps_growth_pct'] else "N/A"
    t_eps = f"${val['trailing_eps']:.2f}" if val['trailing_eps'] else "N/A"
    f_eps = f"${val['forward_eps']:.2f}" if val['forward_eps'] else "N/A"
    rating = val['peg_rating'] or '—'

    print(f"  Trailing PE: {t_pe}  |  Forward PE: {f_pe}  |  PEG: {peg}")
    print(f"  Trailing EPS: {t_eps}  |  Forward EPS: {f_eps}  |  EPS Growth: {eps_g}")

    fair_low = val['fair_low']
    fair_mid = val['fair_mid']
    fair_high = val['fair_high']
    if fair_low and fair_mid and fair_high:
        print(f"  Fair Range: ${fair_low:.0f} — ${fair_mid:.0f} — ${fair_high:.0f}  |  Rating: {rating}")
        if current_price > 0 and fair_mid > 0:
            upside = (fair_mid - current_price) / current_price * 100
            print(f"  MTM vs Fair Mid: {upside:+.1f}%")
    print(f"  (as of {val['date']})")
print()

# ── 4. Scorecard Summary ──
print(f"── Scorecard ──")
if os.path.exists(thesis_path):
    with open(thesis_path, 'r') as f:
        content = f.read()

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
                    'id': cells[0], 'criterion': cells[1], 'metric': cells[2],
                    'threshold': cells[3], 'status': cells[4].lower().strip(),
                    'last_checked': cells[5],
                })
        return rows

    bulls = parse_table("Bull Criteria", content)
    bears = parse_table("Bear Criteria", content)

    if bulls or bears:
        bull_confirmed = sum(1 for b in bulls if b['status'] == 'confirmed')
        bull_pending = sum(1 for b in bulls if b['status'] == 'pending')
        bull_challenged = sum(1 for b in bulls if b['status'] == 'challenged')
        bear_triggered = sum(1 for b in bears if b['status'] == 'triggered')
        bear_watching = sum(1 for b in bears if b['status'] == 'watching')
        bear_clear = sum(1 for b in bears if b['status'] == 'not_triggered')

        print(f"  Bull: {bull_confirmed} confirmed, {bull_pending} pending, {bull_challenged} challenged (of {len(bulls)})")
        print(f"  Bear: {bear_triggered} triggered, {bear_watching} watching, {bear_clear} clear (of {len(bears)})")
        print()

        for b in bulls:
            icon = {'confirmed': '+', 'pending': '?', 'challenged': 'X'}.get(b['status'], ' ')
            print(f"  [{icon}] {b['id']}  {b['criterion']:<30s} {b['status']:<12s} {b['last_checked']}")
        if bulls and bears:
            print()
        for b in bears:
            icon = {'triggered': '!', 'watching': '*', 'not_triggered': '.'}.get(b['status'], ' ')
            print(f"  [{icon}] {b['id']}  {b['criterion']:<30s} {b['status']:<12s} {b['last_checked']}")
    else:
        print(f"  UNSCORED — no Bull/Bear criteria tables in thesis.md")
else:
    print(f"  No thesis doc found at {thesis_path}")

# Recent score changes
changes = conn.execute("""
    SELECT criteria_number, old_status, new_status, reason, changed_at
    FROM thesis_score_changes WHERE security_id = ?
    ORDER BY changed_at DESC LIMIT 5
""", (sec_id,)).fetchall()
if changes:
    print()
    print(f"  Recent score changes:")
    for c in changes:
        print(f"    {c['changed_at'][:10]}  #{c['criteria_number']}  {c['old_status']} -> {c['new_status']}  {c['reason'] or ''}")
print()

# ── 5. Recent Observations ──
obs = conn.execute("""
    SELECT observation_date, note, thesis_impact
    FROM observations WHERE security_id = ?
    ORDER BY observation_date DESC, created_at DESC LIMIT 10
""", (sec_id,)).fetchall()

print(f"── Observations (last 10) ──")
if not obs:
    print(f"  None recorded")
else:
    for o in obs:
        impact_icon = {'supports': '+', 'challenges': '-', 'neutral': '~'}.get(o['thesis_impact'], ' ')
        note = o['note']
        print(f"  [{impact_icon}] {o['observation_date']}  {note[:90]}{'...' if len(note) > 90 else ''}")
print()

# ── 6. Recent Research Notes ──
notes = conn.execute("""
    SELECT section, content, source, created_at
    FROM research_notes WHERE symbol = ?
    ORDER BY created_at DESC LIMIT 15
""", (symbol,)).fetchall()

print(f"── Research Notes (recent) ──")
if not notes:
    print(f"  None recorded. Add with: pm-cli.sh note {symbol} <section> \"<content>\"")
else:
    sections = {}
    for n in notes:
        sec_name = n['section']
        if sec_name not in sections:
            sections[sec_name] = []
        if len(sections[sec_name]) < 5:
            sections[sec_name].append(n)

    for sec_name, sec_notes in sections.items():
        print(f"  [{sec_name}]")
        for n in sec_notes:
            src = f" ({n['source']})" if n['source'] else ""
            content_text = n['content']
            print(f"    {n['created_at'][:10]}  {content_text[:80]}{'...' if len(content_text) > 80 else ''}{src}")
print()

# ── 7. Recent News ──
seven_days_ago = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
news = conn.execute("""
    SELECT title, source, published_at, url
    FROM news WHERE symbol = ? AND published_at >= ?
    ORDER BY published_at DESC LIMIT 10
""", (symbol, seven_days_ago)).fetchall()

print(f"── News (last 7 days) ──")
if not news:
    print(f"  No recent news. Run: pm-cli.sh news {symbol}")
else:
    for n in news:
        src = f" ({n['source']})" if n['source'] else ""
        print(f"  {n['published_at'][:10]}  {n['title'][:75]}{'...' if len(n['title']) > 75 else ''}{src}")
print()

# ── 8. Technical Levels (S/R) ──
levels = conn.execute("""
    SELECT level_type, price, strength FROM price_levels
    WHERE symbol = ? ORDER BY price
""", (symbol,)).fetchall()

supports = [r for r in levels if r['level_type'] == 'support']
resistances = [r for r in levels if r['level_type'] == 'resistance']

print(f"── Technical Levels ──")
print(f"  MTM: ${current_price:.2f}")
if supports:
    sup_str = ", ".join(
        f"${r['price']:.2f}" + (f" (x{r['strength']})" if r['strength'] and r['strength'] > 1 else "")
        for r in sorted(supports, key=lambda r: r['price'], reverse=True)
    )
    print(f"  Support: {sup_str}")
else:
    print(f"  Support: none computed. Run: pm-cli.sh levels-refresh {symbol}")
if resistances:
    res_str = ", ".join(
        f"${r['price']:.2f}" + (f" (x{r['strength']})" if r['strength'] and r['strength'] > 1 else "")
        for r in sorted(resistances, key=lambda r: r['price'])
    )
    print(f"  Resistance: {res_str}")
else:
    print(f"  Resistance: none computed")
print()

# ── 9. Suggested Commands ──
print(f"── After Earnings ──")
print(f"  pm-cli.sh earnings-review {symbol}          # Post-earnings review checklist")
print(f"  pm-cli.sh scorecard-update {symbol} <#> <status> \"<reason>\"  # Update criteria")
print(f"  pm-cli.sh observe {symbol} \"...\" [supports|challenges]       # Log observation")
print(f"  pm-cli.sh valuation {symbol}                # Refresh valuation metrics")
print(f"  pm-cli.sh note {symbol} earnings \"...\"      # Add earnings research note")
print()

conn.close()
PYEOF
    ;;

esac
