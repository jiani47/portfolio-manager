#!/bin/bash
# Analytics commands: analytics, attribution, correlations
# Portfolio analytics, factor attribution, and correlation analysis

case "$1" in
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
    DAYS_ARG="${2:-30}"

    RESULT=$("$SCRIPT_DIR/run-ts.sh" attribution "$DAYS_ARG" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
      echo "Error computing attribution." >&2
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json

d = json.load(sys.stdin)
days = d['days']
port_ret = d['portfolioReturn']
bench_ret = d['benchmarkReturn']
beta = d['portfolioBeta']
decomp = d['decomposition']
contribs = d['positionContributions']

W = 55
print()
print('=' * W)
print(f'  FACTOR ATTRIBUTION vs QQQ — {days}-day (Core + Growth only)')
print('=' * W)
print()

print(f'  Portfolio: {port_ret*100:>7.2f}%    QQQ: {bench_ret*100:>7.2f}%    Gap: {decomp[\"gap\"]*100:>7.2f}%')
print(f'  Beta vs QQQ: {beta:.2f}')
print()

print('=' * W)
print('  DECOMPOSITION')
print('=' * W)
print()
print(f'  Beta effect:            {decomp[\"betaEffect\"]*100:>7.2f}%')
print(f'  Sector allocation:      {decomp[\"sectorAllocation\"]*100:>7.2f}%')
print(f'  Stock selection:        {decomp[\"stockSelection\"]*100:>7.2f}%')
print(f'  {\"─\" * 39}')
print(f'  Total tracking error:   {decomp[\"gap\"]*100:>7.2f}%')
print()

# Per-position
if contribs:
    print('=' * W)
    print('  PER-POSITION ATTRIBUTION')
    print('=' * W)
    print()
    print(f'  {\"Symbol\":<7} {\"Weight\":>6}  {\"Return\":>7}  {\"vs QQQ\":>7}  {\"Contrib\":>8}')

    contribs.sort(key=lambda x: x['contribution'])
    for p in contribs:
        ret_str = f'{p[\"positionReturn\"]*100:>+.1f}%'
        vs_str = f'{p[\"excessReturn\"]*100:>+.1f}%'
        contrib_str = f'{p[\"contribution\"]*100:>+.2f}%'
        print(f'  {p[\"symbol\"]:<7} {p[\"weight\"]*100:>5.1f}%  {ret_str:>7}  {vs_str:>7}  {contrib_str:>8}')
    print()
"
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
esac
