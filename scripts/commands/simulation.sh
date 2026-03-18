#!/bin/bash
# Simulation commands: whatif, stress, construct
# Portfolio what-if analysis, stress testing, and conviction-weighted construction

case "$1" in
  whatif)
    ACTION="$2"
    ARG1="$3"
    ARG2="$4"
    if [ -z "$ACTION" ]; then
      echo "Usage: pm-cli.sh whatif <action> [args...]"
      echo ""
      echo "Actions:"
      echo "  add <symbol> <amount>       Add \$ amount to portfolio"
      echo "  remove <symbol>             Remove position entirely"
      echo "  reweight <symbol> <pct>     Set position to specific %"
      echo "  swap <old_sym> <new_sym>    Replace one position with another"
      exit 1
    fi

    python3 <<PYEOF
import sqlite3, math, sys, os

db = sqlite3.connect("$DB")

# --- Core Simulation Engine ---

def get_daily_returns(symbol, days=756):
    rows = db.execute("""
        SELECT date, close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? AND ph.close_price > 0
        ORDER BY date DESC LIMIT ?
    """, (symbol, days + 1)).fetchall()
    rows.reverse()
    returns = {}
    for i in range(1, len(rows)):
        if rows[i-1][1] > 0:
            returns[rows[i][0]] = (rows[i][1] - rows[i-1][1]) / rows[i-1][1]
    return returns

def get_current_portfolio():
    rows = db.execute("""
        SELECT s.symbol, s.sector, SUM(p.quantity) as qty,
            (SELECT close_price FROM price_history ph
             WHERE ph.security_id = s.id ORDER BY date DESC LIMIT 1) as price
        FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE p.quantity > 0 AND s.type NOT IN ('cash', 'option')
        GROUP BY s.symbol
    """).fetchall()
    positions = {}
    total_mv = 0
    for sym, sector, qty, price in rows:
        if price and price > 0 and qty > 0:
            mv = qty * price
            positions[sym] = {'mv': mv, 'sector': sector or 'Other', 'qty': qty, 'price': price}
            total_mv += mv
    for sym in positions:
        positions[sym]['weight'] = positions[sym]['mv'] / total_mv if total_mv > 0 else 0
    return positions, total_mv

def simulate(weights, start_date=None, end_date=None, shocks=None, window_days=756):
    all_returns = {}
    date_set = None
    for sym in weights:
        if weights[sym] == 0:
            continue
        rets = get_daily_returns(sym, window_days)
        if not rets:
            continue
        all_returns[sym] = rets
        if date_set is None:
            date_set = set(rets.keys())
        else:
            date_set &= set(rets.keys())

    if not date_set or len(date_set) < 10:
        return None

    dates = sorted(date_set)

    if start_date:
        dates = [d for d in dates if d >= start_date]
    if end_date:
        dates = [d for d in dates if d <= end_date]

    if len(dates) < 10:
        return None

    # Apply synthetic shocks
    if shocks:
        n = len(dates)
        for sym, shock_pct in shocks.items():
            if sym in all_returns:
                daily_shock = (1 + shock_pct) ** (1.0 / n) - 1
                for d in dates:
                    if d in all_returns[sym]:
                        all_returns[sym][d] += daily_shock

    # SPY returns for beta
    spy_rets = get_daily_returns('SPY', window_days)

    # Portfolio daily returns
    rets = []
    for d in dates:
        daily_r = sum(weights.get(sym, 0) * all_returns.get(sym, {}).get(d, 0)
                       for sym in weights if sym in all_returns)
        rets.append(daily_r)

    n = len(rets)
    if n < 2:
        return None

    # Cumulative return
    cumulative = 1.0
    for r in rets:
        cumulative *= (1 + r)
    ann_factor = 252 / n
    ann_return = cumulative ** ann_factor - 1

    # Volatility
    mean_r = sum(rets) / n
    variance = sum((r - mean_r) ** 2 for r in rets) / (n - 1)
    daily_vol = math.sqrt(variance)
    ann_vol = daily_vol * math.sqrt(252)

    # Sharpe (risk-free = 4.3% SGOV)
    rf = 0.043
    sharpe = (ann_return - rf) / ann_vol if ann_vol > 0 else 0

    # Max drawdown
    peak = cv = 1.0
    max_dd = 0
    dd_start = dd_end = dates[0]
    cur_dd_start = dates[0]
    for i, r in enumerate(rets):
        cv *= (1 + r)
        if cv > peak:
            peak = cv
            cur_dd_start = dates[i]
        dd = (cv - peak) / peak
        if dd < max_dd:
            max_dd = dd
            dd_start = cur_dd_start
            dd_end = dates[i]

    # Beta vs SPY
    common_dates = [d for d in dates if d in spy_rets]
    beta = 1.0
    if len(common_dates) >= 10:
        p_rets = [sum(weights.get(s, 0) * all_returns.get(s, {}).get(d, 0)
                      for s in weights if s in all_returns) for d in common_dates]
        s_rets = [spy_rets[d] for d in common_dates]
        mp = sum(p_rets) / len(p_rets)
        ms = sum(s_rets) / len(s_rets)
        cov = sum((p_rets[i] - mp) * (s_rets[i] - ms) for i in range(len(common_dates)))
        var_s = sum((s_rets[i] - ms) ** 2 for i in range(len(common_dates)))
        beta = cov / var_s if var_s > 0 else 1.0

    # VaR / CVaR
    sorted_rets = sorted(rets)
    var_idx = max(1, int(len(sorted_rets) * 0.05))
    var95 = sorted_rets[var_idx]
    cvar95 = sum(sorted_rets[:var_idx]) / var_idx

    # HHI
    active_weights = {s: w for s, w in weights.items() if w > 0}
    hhi = sum(w ** 2 for w in active_weights.values())

    # Sector breakdown
    positions, _ = get_current_portfolio()
    sector_weights = {}
    for sym, w in weights.items():
        if w > 0:
            sector = positions.get(sym, {}).get('sector', 'Other')
            sector_weights[sector] = sector_weights.get(sector, 0) + w

    # Risk contributors
    risk_contributors = []
    for sym in weights:
        if sym not in all_returns or weights[sym] == 0:
            continue
        sym_rets = [all_returns[sym].get(d, 0) for d in dates]
        sym_mean = sum(sym_rets) / len(sym_rets)
        cov_with_port = sum((sym_rets[i] - sym_mean) * (rets[i] - mean_r)
                            for i in range(len(dates))) / (len(dates) - 1)
        marginal = weights[sym] * cov_with_port / (daily_vol if daily_vol > 0 else 1)
        risk_contributors.append({
            'symbol': sym,
            'weight': weights[sym],
            'marginalRisk': marginal * math.sqrt(252),
        })
    risk_contributors.sort(key=lambda x: -abs(x['marginalRisk']))

    return {
        'annualReturn': ann_return,
        'annualVolatility': ann_vol,
        'sharpeRatio': sharpe,
        'maxDrawdown': max_dd,
        'maxDrawdownPeriod': {'start': dd_start, 'end': dd_end},
        'betaSpy': beta,
        'var95': var95,
        'cvar95': cvar95,
        'hhi': hhi,
        'effectivePositions': 1.0 / hhi if hhi > 0 else 0,
        'sectorBreakdown': sector_weights,
        'riskContributors': risk_contributors,
        'dataPoints': n,
    }

# --- Display helpers ---

def fmt_pct(v, signed=False):
    if v is None: return 'N/A'
    return f"{v*100:+.2f}%" if signed else f"{v*100:.2f}%"

def print_comparison(current, proposed, label):
    W = 58
    print(f"\n{'=' * W}")
    print(f"  {label}")
    print(f"{'=' * W}\n")
    print(f"  {'Metric':<22} {'Current':>10} {'Proposed':>10} {'Delta':>10}")
    print(f"  {'─'*22} {'─'*10} {'─'*10} {'─'*10}")
    metrics = [
        ('Ann. Return', 'annualReturn', 'pct'),
        ('Volatility', 'annualVolatility', 'pct'),
        ('Sharpe', 'sharpeRatio', 'num'),
        ('Max Drawdown', 'maxDrawdown', 'pct'),
        ('Beta (SPY)', 'betaSpy', 'num'),
        ('VaR 95% (daily)', 'var95', 'pct'),
        ('HHI', 'hhi', 'num'),
        ('Eff. Positions', 'effectivePositions', 'num'),
    ]
    for name, key, fmt in metrics:
        c = current[key]
        p = proposed[key]
        d = p - c
        if fmt == 'num':
            print(f"  {name:<22} {c:>10.2f} {p:>10.2f} {d:>+10.2f}")
        else:
            print(f"  {name:<22} {fmt_pct(c):>10} {fmt_pct(p):>10} {fmt_pct(d, True):>10}")

def print_metrics(result, label=""):
    if label:
        print(f"\n  {label}")
        print(f"  {'─' * 44}")
    print(f"  Ann. Return:       {fmt_pct(result['annualReturn'], True)}")
    print(f"  Volatility:        {fmt_pct(result['annualVolatility'])}")
    print(f"  Sharpe:            {result['sharpeRatio']:.2f}")
    print(f"  Max Drawdown:      {fmt_pct(result['maxDrawdown'])}  ({result['maxDrawdownPeriod']['start']} to {result['maxDrawdownPeriod']['end']})")
    print(f"  Beta (SPY):        {result['betaSpy']:.2f}")
    print(f"  VaR 95% (daily):   {fmt_pct(result['var95'])}")
    print(f"  CVaR 95% (daily):  {fmt_pct(result['cvar95'])}")
    print(f"  HHI:               {result['hhi']:.3f} ({result['effectivePositions']:.1f} effective positions)")
    print(f"  Data points:       {result['dataPoints']} days")

# --- What-If Command ---

action = "$ACTION"
arg1 = "$ARG1"
arg2 = "$ARG2"

positions, total_mv = get_current_portfolio()
current_weights = {s: p['weight'] for s, p in positions.items()}
proposed_weights = dict(current_weights)

desc = ""

if action == 'add':
    symbol = arg1.upper()
    amount = float(arg2)
    new_total = total_mv + amount
    for s in proposed_weights:
        proposed_weights[s] *= total_mv / new_total
    proposed_weights[symbol] = proposed_weights.get(symbol, 0) + amount / new_total
    desc = f"Add \${amount:,.0f} {symbol}"

elif action == 'remove':
    symbol = arg1.upper()
    removed = proposed_weights.pop(symbol, 0)
    remaining = sum(proposed_weights.values())
    if remaining > 0:
        for s in proposed_weights:
            proposed_weights[s] /= remaining
    desc = f"Remove {symbol} ({removed*100:.1f}%)"

elif action == 'reweight':
    symbol = arg1.upper()
    target_pct = float(arg2) / 100
    old_weight = proposed_weights.get(symbol, 0)
    proposed_weights[symbol] = target_pct
    others_total = sum(w for s, w in proposed_weights.items() if s != symbol)
    if others_total > 0:
        for s in proposed_weights:
            if s != symbol:
                proposed_weights[s] *= (1 - target_pct) / others_total
    desc = f"Reweight {symbol} to {arg2}%"

elif action == 'swap':
    old_sym = arg1.upper()
    new_sym = arg2.upper()
    swap_weight = proposed_weights.pop(old_sym, 0)
    proposed_weights[new_sym] = proposed_weights.get(new_sym, 0) + swap_weight
    desc = f"Swap {old_sym} → {new_sym} ({swap_weight*100:.1f}%)"

else:
    print(f"Unknown action: {action}")
    sys.exit(1)

# Run simulations
current_result = simulate(current_weights)
proposed_result = simulate(proposed_weights)

if not current_result or not proposed_result:
    print("ERROR: Not enough price history to simulate. Run 'pm-cli.sh backfill' first.")
    sys.exit(1)

print_comparison(current_result, proposed_result, f"What-If: {desc}")

# Weight changes
print(f"\n  Weight Changes:")
all_syms = sorted(set(list(current_weights.keys()) + list(proposed_weights.keys())),
                  key=lambda s: abs(proposed_weights.get(s, 0) - current_weights.get(s, 0)),
                  reverse=True)
for s in all_syms:
    cw = current_weights.get(s, 0)
    pw = proposed_weights.get(s, 0)
    if abs(cw - pw) > 0.001:
        print(f"    {s:<7} {cw*100:>6.1f}% → {pw*100:>6.1f}%  ({(pw-cw)*100:>+.1f}%)")

# Risk contributors change
print(f"\n  Top Risk Contributors (proposed):")
for rc in proposed_result['riskContributors'][:5]:
    print(f"    {rc['symbol']:<7} {rc['weight']*100:>5.1f}%  marginal risk: {rc['marginalRisk']*100:>+.2f}%")

# Sector breakdown
print(f"\n  Sector Breakdown (proposed):")
for sector, w in sorted(proposed_result['sectorBreakdown'].items(), key=lambda x: -x[1]):
    cw = current_result['sectorBreakdown'].get(sector, 0)
    delta = w - cw
    delta_s = f" ({delta*100:+.1f}%)" if abs(delta) > 0.005 else ""
    print(f"    {sector:<25} {w*100:>5.1f}%{delta_s}")

db.close()
PYEOF
    ;;

  stress)
    shift  # remove 'stress'
    STRESS_ARGS="$*"

    python3 <<PYEOF
import sqlite3, math, sys, os

db = sqlite3.connect("$DB")

# --- Reuse simulation engine functions (same as whatif) ---

def get_daily_returns(symbol, days=756):
    rows = db.execute("""
        SELECT date, close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? AND ph.close_price > 0
        ORDER BY date DESC LIMIT ?
    """, (symbol, days + 1)).fetchall()
    rows.reverse()
    returns = {}
    for i in range(1, len(rows)):
        if rows[i-1][1] > 0:
            returns[rows[i][0]] = (rows[i][1] - rows[i-1][1]) / rows[i-1][1]
    return returns

def get_current_portfolio():
    rows = db.execute("""
        SELECT s.symbol, s.sector, SUM(p.quantity) as qty,
            (SELECT close_price FROM price_history ph
             WHERE ph.security_id = s.id ORDER BY date DESC LIMIT 1) as price
        FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE p.quantity > 0 AND s.type NOT IN ('cash', 'option')
        GROUP BY s.symbol
    """).fetchall()
    positions = {}
    total_mv = 0
    for sym, sector, qty, price in rows:
        if price and price > 0 and qty > 0:
            mv = qty * price
            positions[sym] = {'mv': mv, 'sector': sector or 'Other', 'qty': qty, 'price': price}
            total_mv += mv
    for sym in positions:
        positions[sym]['weight'] = positions[sym]['mv'] / total_mv if total_mv > 0 else 0
    return positions, total_mv

def simulate(weights, start_date=None, end_date=None, shocks=None, window_days=756):
    all_returns = {}
    date_set = None
    for sym in weights:
        if weights[sym] == 0:
            continue
        rets = get_daily_returns(sym, window_days)
        if not rets:
            continue
        all_returns[sym] = rets
        if date_set is None:
            date_set = set(rets.keys())
        else:
            date_set &= set(rets.keys())

    if not date_set or len(date_set) < 10:
        return None

    dates = sorted(date_set)
    if start_date:
        dates = [d for d in dates if d >= start_date]
    if end_date:
        dates = [d for d in dates if d <= end_date]
    if len(dates) < 10:
        return None

    if shocks:
        n = len(dates)
        for sym, shock_pct in shocks.items():
            if sym in all_returns:
                daily_shock = (1 + shock_pct) ** (1.0 / n) - 1
                for d in dates:
                    if d in all_returns[sym]:
                        all_returns[sym][d] += daily_shock

    spy_rets = get_daily_returns('SPY', window_days)

    rets = []
    for d in dates:
        daily_r = sum(weights.get(sym, 0) * all_returns.get(sym, {}).get(d, 0)
                       for sym in weights if sym in all_returns)
        rets.append(daily_r)

    n = len(rets)
    if n < 2:
        return None

    cumulative = 1.0
    for r in rets:
        cumulative *= (1 + r)
    ann_factor = 252 / n
    ann_return = cumulative ** ann_factor - 1

    mean_r = sum(rets) / n
    variance = sum((r - mean_r) ** 2 for r in rets) / (n - 1)
    daily_vol = math.sqrt(variance)
    ann_vol = daily_vol * math.sqrt(252)

    rf = 0.043
    sharpe = (ann_return - rf) / ann_vol if ann_vol > 0 else 0

    peak = cv = 1.0
    max_dd = 0
    dd_start = dd_end = dates[0]
    cur_dd_start = dates[0]
    for i, r in enumerate(rets):
        cv *= (1 + r)
        if cv > peak:
            peak = cv
            cur_dd_start = dates[i]
        dd = (cv - peak) / peak
        if dd < max_dd:
            max_dd = dd
            dd_start = cur_dd_start
            dd_end = dates[i]

    common_dates = [d for d in dates if d in spy_rets]
    beta = 1.0
    if len(common_dates) >= 10:
        p_rets = [sum(weights.get(s, 0) * all_returns.get(s, {}).get(d, 0)
                      for s in weights if s in all_returns) for d in common_dates]
        s_rets = [spy_rets[d] for d in common_dates]
        mp = sum(p_rets) / len(p_rets)
        ms = sum(s_rets) / len(s_rets)
        cov = sum((p_rets[i] - mp) * (s_rets[i] - ms) for i in range(len(common_dates)))
        var_s = sum((s_rets[i] - ms) ** 2 for i in range(len(common_dates)))
        beta = cov / var_s if var_s > 0 else 1.0

    sorted_rets = sorted(rets)
    var_idx = max(1, int(len(sorted_rets) * 0.05))
    var95 = sorted_rets[var_idx]
    cvar95 = sum(sorted_rets[:var_idx]) / var_idx

    active_weights = {s: w for s, w in weights.items() if w > 0}
    hhi = sum(w ** 2 for w in active_weights.values())

    positions_data, _ = get_current_portfolio()
    sector_weights = {}
    for sym, w in weights.items():
        if w > 0:
            sector = positions_data.get(sym, {}).get('sector', 'Other')
            sector_weights[sector] = sector_weights.get(sector, 0) + w

    risk_contributors = []
    for sym in weights:
        if sym not in all_returns or weights[sym] == 0:
            continue
        sym_rets = [all_returns[sym].get(d, 0) for d in dates]
        sym_mean = sum(sym_rets) / len(sym_rets)
        cov_with_port = sum((sym_rets[i] - sym_mean) * (rets[i] - mean_r)
                            for i in range(len(dates))) / (len(dates) - 1)
        marginal = weights[sym] * cov_with_port / (daily_vol if daily_vol > 0 else 1)
        risk_contributors.append({
            'symbol': sym, 'weight': weights[sym],
            'marginalRisk': marginal * math.sqrt(252),
        })
    risk_contributors.sort(key=lambda x: -abs(x['marginalRisk']))

    return {
        'annualReturn': ann_return, 'annualVolatility': ann_vol,
        'sharpeRatio': sharpe, 'maxDrawdown': max_dd,
        'maxDrawdownPeriod': {'start': dd_start, 'end': dd_end},
        'betaSpy': beta, 'var95': var95, 'cvar95': cvar95,
        'hhi': hhi, 'effectivePositions': 1.0 / hhi if hhi > 0 else 0,
        'sectorBreakdown': sector_weights,
        'riskContributors': risk_contributors,
        'dataPoints': n,
    }

def fmt_pct(v, signed=False):
    if v is None: return 'N/A'
    return f"{v*100:+.2f}%" if signed else f"{v*100:.2f}%"

def print_comparison(current, proposed, label):
    W = 58
    print(f"\n{'=' * W}")
    print(f"  {label}")
    print(f"{'=' * W}\n")
    print(f"  {'Metric':<22} {'Current':>10} {'Proposed':>10} {'Delta':>10}")
    print(f"  {'─'*22} {'─'*10} {'─'*10} {'─'*10}")
    for name, key, fmt in [
        ('Ann. Return', 'annualReturn', 'pct'), ('Volatility', 'annualVolatility', 'pct'),
        ('Sharpe', 'sharpeRatio', 'num'), ('Max Drawdown', 'maxDrawdown', 'pct'),
        ('Beta (SPY)', 'betaSpy', 'num'), ('VaR 95% (daily)', 'var95', 'pct'),
        ('HHI', 'hhi', 'num'), ('Eff. Positions', 'effectivePositions', 'num'),
    ]:
        c, p = current[key], proposed[key]
        d = p - c
        if fmt == 'num':
            print(f"  {name:<22} {c:>10.2f} {p:>10.2f} {d:>+10.2f}")
        else:
            print(f"  {name:<22} {fmt_pct(c):>10} {fmt_pct(p):>10} {fmt_pct(d, True):>10}")

def print_metrics(result, label=""):
    if label:
        print(f"\n  {label}")
        print(f"  {'─' * 44}")
    print(f"  Ann. Return:       {fmt_pct(result['annualReturn'], True)}")
    print(f"  Volatility:        {fmt_pct(result['annualVolatility'])}")
    print(f"  Sharpe:            {result['sharpeRatio']:.2f}")
    print(f"  Max Drawdown:      {fmt_pct(result['maxDrawdown'])}  ({result['maxDrawdownPeriod']['start']} to {result['maxDrawdownPeriod']['end']})")
    print(f"  Beta (SPY):        {result['betaSpy']:.2f}")
    print(f"  VaR 95% (daily):   {fmt_pct(result['var95'])}")
    print(f"  CVaR 95% (daily):  {fmt_pct(result['cvar95'])}")
    print(f"  HHI:               {result['hhi']:.3f} ({result['effectivePositions']:.1f} effective positions)")
    print(f"  Data points:       {result['dataPoints']} days")

# --- Stress Test Command ---

NAMED_SCENARIOS = {
    'covid':        ('2020-02-19', '2020-03-23', 'COVID crash (-34% SPY)'),
    '2022-bear':    ('2022-01-03', '2022-10-12', 'Rate hike bear market (-25% SPY)'),
    '2022-rally':   ('2022-10-12', '2023-01-31', 'Bear market rally (+15% SPY)'),
    'tariff-shock': ('2025-01-20', '2025-04-01', 'Trump tariff escalation'),
}

args = "$STRESS_ARGS".split()
positions, total_mv = get_current_portfolio()
weights = {s: p['weight'] for s, p in positions.items()}

if not args:
    # No args — run all named scenarios
    print(f"\n=== Stress Test: All Scenarios ===")
    print(f"  Portfolio: \${total_mv:,.0f} across {len(weights)} positions\n")

    baseline = simulate(weights)
    if not baseline:
        print("ERROR: Not enough price history. Run 'pm-cli.sh backfill' first.")
        sys.exit(1)

    print(f"  {'Scenario':<20} {'Period':<27} {'Return':>10} {'MaxDD':>10} {'Sharpe':>8} {'Beta':>6}")
    print(f"  {'─'*20} {'─'*27} {'─'*10} {'─'*10} {'─'*8} {'─'*6}")

    print(f"  {'Current (3yr)':.<20} {'':.<27} {fmt_pct(baseline['annualReturn'], True):>10} {fmt_pct(baseline['maxDrawdown']):>10} {baseline['sharpeRatio']:>8.2f} {baseline['betaSpy']:>6.2f}")

    for name, (start, end, desc) in NAMED_SCENARIOS.items():
        result = simulate(weights, start_date=start, end_date=end)
        if result:
            period = f"{start} to {end}"
            print(f"  {name:<20} {period:<27} {fmt_pct(result['annualReturn'], True):>10} {fmt_pct(result['maxDrawdown']):>10} {result['sharpeRatio']:>8.2f} {result['betaSpy']:>6.2f}")
        else:
            print(f"  {name:<20} {'insufficient data':<27}")

    # Per-position drawdown in worst scenario (covid)
    print(f"\n  Per-Position COVID Drawdown:")
    print(f"  {'Symbol':<7} {'Weight':>7} {'Return':>10}")
    print(f"  {'─'*7} {'─'*7} {'─'*10}")
    covid_start, covid_end = '2020-02-19', '2020-03-23'
    for sym in sorted(weights.keys(), key=lambda s: -weights[s]):
        if weights[sym] < 0.005:
            continue
        sym_rets = get_daily_returns(sym, 1500)
        covid_days = {d: r for d, r in sym_rets.items() if covid_start <= d <= covid_end}
        if covid_days:
            cum = 1.0
            for d in sorted(covid_days.keys()):
                cum *= (1 + covid_days[d])
            total_ret = cum - 1
            print(f"  {sym:<7} {weights[sym]*100:>6.1f}% {fmt_pct(total_ret, True):>10}")

elif args[0] == '--shock':
    # Synthetic shock mode
    shock_str = args[1] if len(args) > 1 else ''
    shocks = {}

    # Get per-position betas for factor shocks
    pos_betas = {}
    for sym in weights:
        sym_rets = get_daily_returns(sym, 252)
        spy_rets_map = get_daily_returns('SPY', 252)
        common = set(sym_rets.keys()) & set(spy_rets_map.keys())
        if len(common) >= 20:
            cd = sorted(common)
            sr = [sym_rets[d] for d in cd]
            sp = [spy_rets_map[d] for d in cd]
            ms = sum(sp) / len(sp)
            cov = sum((sr[i] - sum(sr)/len(sr)) * (sp[i] - ms) for i in range(len(cd)))
            var_s = sum((sp[i] - ms) ** 2 for i in range(len(cd)))
            pos_betas[sym] = cov / var_s if var_s > 0 else 1.0

    for item in shock_str.split(','):
        item = item.strip()
        if not item:
            continue
        parts = item.split(':')
        target = parts[0]
        shock_val = float(parts[1].replace('%', '')) / 100

        if '>' in target:
            # Factor filter: e.g. "beta>1.5"
            factor, threshold = target.split('>')
            threshold = float(threshold)
            for sym in weights:
                if factor.lower() == 'beta' and pos_betas.get(sym, 1.0) > threshold:
                    shocks[sym] = shock_val
        elif '<' in target:
            factor, threshold = target.split('<')
            threshold = float(threshold)
            for sym in weights:
                if factor.lower() == 'beta' and pos_betas.get(sym, 1.0) < threshold:
                    shocks[sym] = shock_val
        else:
            shocks[target.upper()] = shock_val

    baseline = simulate(weights)
    shocked = simulate(weights, shocks=shocks)

    if not baseline or not shocked:
        print("ERROR: Not enough data.")
        sys.exit(1)

    print_comparison(baseline, shocked, f"Stress: {shock_str}")

    print(f"\n  Shocks applied:")
    for sym, sv in sorted(shocks.items()):
        print(f"    {sym:<7} {sv*100:>+.0f}%")

elif args[0] == '--dates':
    # Custom date range
    start = args[1] if len(args) > 1 else None
    end = args[2] if len(args) > 2 else None
    if not start or not end:
        print("Usage: pm-cli.sh stress --dates <start> <end>")
        sys.exit(1)
    result = simulate(weights, start_date=start, end_date=end)
    if not result:
        print(f"ERROR: Not enough data for {start} to {end}.")
        sys.exit(1)
    print_metrics(result, f"Stress: {start} to {end}")

else:
    # Named scenario
    scenario_name = args[0]
    if scenario_name not in NAMED_SCENARIOS:
        print(f"Unknown scenario: {scenario_name}")
        print(f"Available: {', '.join(NAMED_SCENARIOS.keys())}")
        print(f"Or use: --shock 'SPY:-20%' or --dates <start> <end>")
        sys.exit(1)
    start, end, desc = NAMED_SCENARIOS[scenario_name]
    baseline = simulate(weights)
    scenario_result = simulate(weights, start_date=start, end_date=end)
    if not baseline or not scenario_result:
        print("ERROR: Not enough data.")
        sys.exit(1)
    print_comparison(baseline, scenario_result, f"Stress: {desc} ({start} to {end})")

db.close()
PYEOF
    ;;

  construct)
    shift  # remove 'construct'
    CONSTRUCT_ARGS="$*"

    python3 <<PYEOF
import sqlite3, math, sys, os, glob, re

db = sqlite3.connect("$DB")

# --- Simulation engine (same as whatif/stress) ---

def get_daily_returns(symbol, days=756):
    rows = db.execute("""
        SELECT date, close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? AND ph.close_price > 0
        ORDER BY date DESC LIMIT ?
    """, (symbol, days + 1)).fetchall()
    rows.reverse()
    returns = {}
    for i in range(1, len(rows)):
        if rows[i-1][1] > 0:
            returns[rows[i][0]] = (rows[i][1] - rows[i-1][1]) / rows[i-1][1]
    return returns

def get_current_portfolio():
    rows = db.execute("""
        SELECT s.symbol, s.sector, SUM(p.quantity) as qty,
            (SELECT close_price FROM price_history ph
             WHERE ph.security_id = s.id ORDER BY date DESC LIMIT 1) as price
        FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE p.quantity > 0 AND s.type NOT IN ('cash', 'option')
        GROUP BY s.symbol
    """).fetchall()
    positions = {}
    total_mv = 0
    for sym, sector, qty, price in rows:
        if price and price > 0 and qty > 0:
            mv = qty * price
            positions[sym] = {'mv': mv, 'sector': sector or 'Other', 'qty': qty, 'price': price}
            total_mv += mv
    for sym in positions:
        positions[sym]['weight'] = positions[sym]['mv'] / total_mv if total_mv > 0 else 0
    return positions, total_mv

def simulate(weights, start_date=None, end_date=None, shocks=None, window_days=756):
    all_returns = {}
    date_set = None
    for sym in weights:
        if weights[sym] == 0:
            continue
        rets = get_daily_returns(sym, window_days)
        if not rets:
            continue
        all_returns[sym] = rets
        if date_set is None:
            date_set = set(rets.keys())
        else:
            date_set &= set(rets.keys())

    if not date_set or len(date_set) < 10:
        return None

    dates = sorted(date_set)
    if start_date:
        dates = [d for d in dates if d >= start_date]
    if end_date:
        dates = [d for d in dates if d <= end_date]
    if len(dates) < 10:
        return None

    if shocks:
        n = len(dates)
        for sym, shock_pct in shocks.items():
            if sym in all_returns:
                daily_shock = (1 + shock_pct) ** (1.0 / n) - 1
                for d in dates:
                    if d in all_returns[sym]:
                        all_returns[sym][d] += daily_shock

    spy_rets = get_daily_returns('SPY', window_days)

    rets = []
    for d in dates:
        daily_r = sum(weights.get(sym, 0) * all_returns.get(sym, {}).get(d, 0)
                       for sym in weights if sym in all_returns)
        rets.append(daily_r)

    n = len(rets)
    if n < 2:
        return None

    cumulative = 1.0
    for r in rets:
        cumulative *= (1 + r)
    ann_factor = 252 / n
    ann_return = cumulative ** ann_factor - 1

    mean_r = sum(rets) / n
    variance = sum((r - mean_r) ** 2 for r in rets) / (n - 1)
    daily_vol = math.sqrt(variance)
    ann_vol = daily_vol * math.sqrt(252)

    rf = 0.043
    sharpe = (ann_return - rf) / ann_vol if ann_vol > 0 else 0

    peak = cv = 1.0
    max_dd = 0
    dd_start = dd_end = dates[0]
    cur_dd_start = dates[0]
    for i, r in enumerate(rets):
        cv *= (1 + r)
        if cv > peak:
            peak = cv
            cur_dd_start = dates[i]
        dd = (cv - peak) / peak
        if dd < max_dd:
            max_dd = dd
            dd_start = cur_dd_start
            dd_end = dates[i]

    common_dates = [d for d in dates if d in spy_rets]
    beta = 1.0
    if len(common_dates) >= 10:
        p_rets = [sum(weights.get(s, 0) * all_returns.get(s, {}).get(d, 0)
                      for s in weights if s in all_returns) for d in common_dates]
        s_rets = [spy_rets[d] for d in common_dates]
        mp = sum(p_rets) / len(p_rets)
        ms = sum(s_rets) / len(s_rets)
        cov_val = sum((p_rets[i] - mp) * (s_rets[i] - ms) for i in range(len(common_dates)))
        var_s = sum((s_rets[i] - ms) ** 2 for i in range(len(common_dates)))
        beta = cov_val / var_s if var_s > 0 else 1.0

    sorted_rets = sorted(rets)
    var_idx = max(1, int(len(sorted_rets) * 0.05))
    var95 = sorted_rets[var_idx]
    cvar95 = sum(sorted_rets[:var_idx]) / var_idx

    active_weights = {s: w for s, w in weights.items() if w > 0}
    hhi = sum(w ** 2 for w in active_weights.values())

    positions_data, _ = get_current_portfolio()
    sector_weights = {}
    for sym, w in weights.items():
        if w > 0:
            sector = positions_data.get(sym, {}).get('sector', 'Other')
            sector_weights[sector] = sector_weights.get(sector, 0) + w

    return {
        'annualReturn': ann_return, 'annualVolatility': ann_vol,
        'sharpeRatio': sharpe, 'maxDrawdown': max_dd,
        'maxDrawdownPeriod': {'start': dd_start, 'end': dd_end},
        'betaSpy': beta, 'var95': var95, 'cvar95': cvar95,
        'hhi': hhi, 'effectivePositions': 1.0 / hhi if hhi > 0 else 0,
        'sectorBreakdown': sector_weights,
        'riskContributors': [],
        'dataPoints': n,
    }

def fmt_pct(v, signed=False):
    if v is None: return 'N/A'
    return f"{v*100:+.2f}%" if signed else f"{v*100:.2f}%"

# --- Construction Engine ---

# Parse args
args = "$CONSTRUCT_ARGS".split()
target_return = None
max_drawdown = None
window = 504  # 2 years

i = 0
while i < len(args):
    if args[i] == '--target-return' and i + 1 < len(args):
        target_return = float(args[i+1]) / 100
        i += 2
    elif args[i] == '--max-drawdown' and i + 1 < len(args):
        max_drawdown = float(args[i+1]) / 100
        i += 2
    elif args[i] == '--window' and i + 1 < len(args):
        window = int(args[i+1])
        i += 2
    else:
        i += 1

# Load scored universe from thesis docs
positions, total_mv = get_current_portfolio()
proj_root = os.path.expanduser("~/workspace/portfolio-manager")
thesis_dir = os.path.join(proj_root, "docs", "positions")

scored = {}
filtered = []

# Get conviction from thesis docs
for sym in list(positions.keys()):
    thesis_path = os.path.join(thesis_dir, sym, "thesis.md")
    if not os.path.exists(thesis_path):
        filtered.append({'symbol': sym, 'reason': 'no thesis doc'})
        continue

    with open(thesis_path) as f:
        content = f.read()

    # Parse conviction from "Suggested Conviction: X" or "Conviction: X" line
    conv_match = re.search(r'[Cc]onviction[:\s]+([A-D][+-]?)', content)
    if not conv_match:
        # Try tier
        tier_match = re.search(r'[Tt]ier[:\s]+(Core|Growth|Starter|Exit)', content)
        if tier_match:
            tier_map = {'Core': 'A', 'Growth': 'B', 'Starter': 'C', 'Exit': 'D'}
            conv = tier_map.get(tier_match.group(1), 'C')
        else:
            filtered.append({'symbol': sym, 'reason': 'no conviction/tier in thesis'})
            continue
    else:
        conv = conv_match.group(1)[0]  # just the letter

    scored[sym] = conv

# Also check watchlist names with thesis docs
watchlist_syms = db.execute("""
    SELECT DISTINCT wi.symbol FROM watchlist_items wi
    WHERE wi.symbol NOT IN (
        SELECT s.symbol FROM positions p JOIN securities s ON p.security_id = s.id
        WHERE p.quantity > 0
    )
""").fetchall()
for (sym,) in watchlist_syms:
    thesis_path = os.path.join(thesis_dir, sym, "thesis.md")
    if os.path.exists(thesis_path):
        with open(thesis_path) as f:
            content = f.read()
        conv_match = re.search(r'[Cc]onviction[:\s]+([A-D][+-]?)', content)
        if conv_match:
            scored[sym] = conv_match.group(1)[0]

# Conviction-based starting weights
conviction_base = {'A': 0.12, 'B': 0.06, 'C': 0.03, 'D': 0.0}

# Build initial weights from conviction
universe = [s for s in scored if scored[s] != 'D']
base_weights = {}
for sym in universe:
    base_weights[sym] = conviction_base.get(scored[sym], 0.03)

# Normalize to sum to 1 (remainder is cash)
total_w = sum(base_weights.values())
if total_w > 1.0:
    for s in base_weights:
        base_weights[s] /= total_w
cash_weight = max(0, 1.0 - sum(base_weights.values()))

# Penalty function
def compute_penalty(weights):
    penalty = 0

    # Single-name concentration: penalize >15%
    for s, w in weights.items():
        if w > 0.15:
            penalty += 5 * (w - 0.15) ** 2

    # Sector concentration: penalize >50%
    pos_data, _ = get_current_portfolio()
    sector_w = {}
    for s, w in weights.items():
        sec = pos_data.get(s, {}).get('sector', 'Other')
        sector_w[sec] = sector_w.get(sec, 0) + w
    for sec, sw in sector_w.items():
        if sw > 0.50:
            penalty += 2 * (sw - 0.50) ** 2

    # Tier limit violations
    tier_max = {'A': 0.20, 'B': 0.10, 'C': 0.05}
    for s, w in weights.items():
        conv = scored.get(s, 'C')
        mx = tier_max.get(conv, 0.05)
        if w > mx:
            penalty += 10 * (w - mx) ** 2

    # Drawdown penalty if target set
    if max_drawdown:
        result = simulate(weights, window_days=window)
        if result and abs(result['maxDrawdown']) > max_drawdown:
            penalty += 8 * (abs(result['maxDrawdown']) - max_drawdown) ** 2

    return penalty

# Hill-climbing optimizer
best_weights = dict(base_weights)
best_result = simulate(best_weights, window_days=window)
if not best_result:
    print("ERROR: Not enough price history. Run 'pm-cli.sh backfill' first.")
    sys.exit(1)

best_score = best_result['sharpeRatio'] - compute_penalty(best_weights)

print(f"\n=== Portfolio Construction ===")
if target_return:
    print(f"  Target return: {target_return*100:.0f}%")
if max_drawdown:
    print(f"  Max drawdown: {max_drawdown*100:.0f}%")
print(f"  Universe: {len(universe)} scored names ({len(filtered)} filtered)")
print(f"  Window: {window} days")
print(f"  Optimizing...")

# Iterate
improved = True
iteration = 0
max_iterations = 50
step_sizes = [0.02, 0.01, 0.005]

while improved and iteration < max_iterations:
    improved = False
    iteration += 1

    for sym in universe:
        for step in step_sizes:
            for direction in [1, -1]:
                trial = dict(best_weights)
                trial[sym] = max(0, trial.get(sym, 0) + direction * step)

                # Ensure weights sum to <= 1
                total = sum(trial.values())
                if total > 1.0:
                    for s in trial:
                        trial[s] /= total

                # Skip if no meaningful change
                if abs(trial.get(sym, 0) - best_weights.get(sym, 0)) < 0.001:
                    continue

                result = simulate(trial, window_days=window)
                if not result:
                    continue

                score = result['sharpeRatio'] - compute_penalty(trial)
                if score > best_score + 0.001:
                    best_score = score
                    best_weights = trial
                    best_result = result
                    improved = True

print(f"  Completed in {iteration} iterations")

# Output
current_weights = {s: p['weight'] for s, p in positions.items()}
current_result = simulate(current_weights, window_days=window)

print(f"\n  Proposed Portfolio:")
print(f"  {'Symbol':<7} {'Conv':<5} {'Current':>8} {'Proposed':>9} {'Delta':>8}  Reason")
print(f"  {'─'*7} {'─'*5} {'─'*8} {'─'*9} {'─'*8}  {'─'*20}")

all_syms = sorted(set(list(current_weights.keys()) + list(best_weights.keys())),
                  key=lambda s: -best_weights.get(s, 0))
for s in all_syms:
    cw = current_weights.get(s, 0)
    pw = best_weights.get(s, 0)
    if cw < 0.001 and pw < 0.001:
        continue
    conv = scored.get(s, '?')
    delta = pw - cw
    # Reason
    reason = ""
    if s not in scored:
        reason = "unscored"
    elif pw > cw + 0.005:
        reason = f"underweight for {conv}"
    elif pw < cw - 0.005:
        if cw > 0.15:
            reason = "concentration limit"
        else:
            reason = "risk-adjusted"
    else:
        reason = "near target"
    print(f"  {s:<7} {conv:<5} {cw*100:>7.1f}% {pw*100:>8.1f}% {delta*100:>+7.1f}%  {reason}")

cash = 1.0 - sum(best_weights.values())
if cash > 0.005:
    print(f"  {'Cash':<7} {'—':<5} {'':>8} {cash*100:>8.1f}%{'':>9}  drawdown buffer")

# Metrics comparison
if current_result:
    W = 58
    print(f"\n{'=' * W}")
    print(f"  Metrics Comparison")
    print(f"{'=' * W}\n")
    print(f"  {'Metric':<22} {'Current':>10} {'Proposed':>10} {'Delta':>10}")
    print(f"  {'─'*22} {'─'*10} {'─'*10} {'─'*10}")
    for name, key, fmt in [
        ('Ann. Return', 'annualReturn', 'pct'), ('Volatility', 'annualVolatility', 'pct'),
        ('Sharpe', 'sharpeRatio', 'num'), ('Max Drawdown', 'maxDrawdown', 'pct'),
        ('Beta (SPY)', 'betaSpy', 'num'), ('HHI', 'hhi', 'num'),
    ]:
        c, p = current_result[key], best_result[key]
        d = p - c
        if fmt == 'num':
            print(f"  {name:<22} {c:>10.2f} {p:>10.2f} {d:>+10.2f}")
        else:
            print(f"  {name:<22} {fmt_pct(c):>10} {fmt_pct(p):>10} {fmt_pct(d, True):>10}")

# Stress tests on proposed
print(f"\n  Stress Tests (proposed):")
print(f"  {'Scenario':<20} {'Return':>10} {'MaxDD':>10}")
print(f"  {'─'*20} {'─'*10} {'─'*10}")
for name, (start, end, desc) in [
    ('covid', ('2020-02-19', '2020-03-23', 'COVID crash')),
    ('2022-bear', ('2022-01-03', '2022-10-12', '2022 bear')),
]:
    sr = simulate(best_weights, start_date=start, end_date=end)
    if sr:
        print(f"  {name:<20} {fmt_pct(sr['annualReturn'], True):>10} {fmt_pct(sr['maxDrawdown']):>10}")

# Filtered
if filtered:
    print(f"\n  Filtered (excluded from construction):")
    for f in filtered:
        print(f"    {f['symbol']:<7} — {f['reason']}")

db.close()
PYEOF
    ;;
esac
