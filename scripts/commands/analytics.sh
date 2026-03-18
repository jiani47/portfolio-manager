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
esac
