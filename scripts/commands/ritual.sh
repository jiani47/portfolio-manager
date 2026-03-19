#!/bin/bash
# Ritual commands: morning, portfolio, briefing, ritual-today, ritual-set, ritual-history, ritual-status, intent-history, intent-changes-today

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

    # === EMS Orders ===
    EMS_TRIGGERED=$(sqlite3 "$DB" "
      SELECT s.symbol, ep.side, ept.shares, ept.trigger_type,
        COALESCE(ept.trigger_date, '\$' || printf('%.2f', ept.trigger_price)) as trigger_val,
        substr(ept.id, 1, 8) as tid, rb.name as basket
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN rebalance_baskets rb ON ep.basket_id = rb.id
      WHERE ept.status = 'triggered' AND ep.status = 'active';
    " 2>/dev/null)
    EMS_SUBMITTED=$(sqlite3 "$DB" "
      SELECT s.symbol, ep.side, ept.shares, '\$' || printf('%.2f', ept.limit_price) as lim,
        ept.brokerage_order_status as bstatus, rb.name as basket
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN rebalance_baskets rb ON ep.basket_id = rb.id
      WHERE ept.status = 'submitted' AND ep.status = 'active';
    " 2>/dev/null)
    EMS_FILLED_TODAY=$(sqlite3 "$DB" "
      SELECT s.symbol, ep.side, ept.filled_qty, '\$' || printf('%.2f', ept.filled_price) as fpx,
        ept.filled_at, rb.name as basket
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      LEFT JOIN rebalance_baskets rb ON ep.basket_id = rb.id
      WHERE ept.status = 'filled' AND date(ept.filled_at) = date('now');
    " 2>/dev/null)

    if [ -n "$EMS_TRIGGERED" ] || [ -n "$EMS_SUBMITTED" ] || [ -n "$EMS_FILLED_TODAY" ]; then
      echo "=== EMS Orders ==="
      if [ -n "$EMS_TRIGGERED" ]; then
        echo "  --- Awaiting Confirmation ---"
        echo "$EMS_TRIGGERED" | while IFS='|' read -r SYM SIDE SHARES TTYPE TVAL TID BNAME; do
          SIDE_UP=$(echo "$SIDE" | tr '[:lower:]' '[:upper:]')
          echo "  $SIDE_UP $SHARES $SYM | trigger: $TVAL ($TTYPE) | confirm: pm-cli.sh basket-confirm $TID"
        done
        TRIGGERED_COUNT=$(echo "$EMS_TRIGGERED" | wc -l | tr -d ' ')
        # Only push-notify for tranches not yet notified (tracked in DB)
        sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS ems_notifications (tranche_id TEXT PRIMARY KEY, notified_at TEXT NOT NULL);" 2>/dev/null
        NEW_TRIGGERED=$(echo "$EMS_TRIGGERED" | while IFS='|' read -r _SYM _SIDE _SHARES _TTYPE _TVAL _TID _BNAME; do
          ALREADY=$(sqlite3 "$DB" "SELECT COUNT(*) FROM ems_notifications WHERE tranche_id = '$_TID';" 2>/dev/null)
          if [ "${ALREADY:-0}" = "0" ]; then
            sqlite3 "$DB" "INSERT OR IGNORE INTO ems_notifications (tranche_id, notified_at) VALUES ('$_TID', '$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")');" 2>/dev/null
            echo "$(echo "$_SIDE" | tr '[:lower:]' '[:upper:]') $_SHARES $_SYM @ $_TVAL"
          fi
        done)
        if [ -n "$NEW_TRIGGERED" ]; then
          NEW_COUNT=$(echo "$NEW_TRIGGERED" | wc -l | tr -d ' ')
          pm_notify "EMS: $NEW_COUNT orders triggered" "$NEW_TRIGGERED" "high"
        fi
      fi
      if [ -n "$EMS_SUBMITTED" ]; then
        echo "  --- Working at Broker ---"
        echo "$EMS_SUBMITTED" | while IFS='|' read -r SYM SIDE SHARES LIM BSTATUS BNAME; do
          SIDE_UP=$(echo "$SIDE" | tr '[:lower:]' '[:upper:]')
          echo "  $SIDE_UP $SHARES $SYM @ $LIM | $BSTATUS"
        done
      fi
      if [ -n "$EMS_FILLED_TODAY" ]; then
        echo "  --- Filled Today ---"
        echo "$EMS_FILLED_TODAY" | while IFS='|' read -r SYM SIDE QTY FPX FAT BNAME; do
          SIDE_UP=$(echo "$SIDE" | tr '[:lower:]' '[:upper:]')
          echo "  $SIDE_UP $QTY $SYM @ $FPX | $FAT"
        done
      fi
      echo ""
    fi

    EMS_PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches ept JOIN entry_plans ep ON ept.plan_id = ep.id WHERE ept.status = 'pending' AND ep.status = 'active';" 2>/dev/null)
    if [ "$EMS_PENDING" -gt 0 ]; then
      echo "=== EMS: $EMS_PENDING orders pending trigger ==="
      echo ""
    fi

    # === Thesis Score Changes (last 7 days) ===
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS thesis_score_changes (id TEXT PRIMARY KEY, security_id TEXT NOT NULL, criteria_number TEXT NOT NULL, old_status TEXT NOT NULL, new_status TEXT NOT NULL, reason TEXT, changed_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (security_id) REFERENCES securities(id));" 2>/dev/null
    SCORE_RECENT=$(sqlite3 "$DB" "
      SELECT s.symbol, tsc.criteria_number, tsc.old_status, tsc.new_status, COALESCE(tsc.reason, '')
      FROM thesis_score_changes tsc
      JOIN securities s ON tsc.security_id = s.id
      WHERE tsc.changed_at >= date('now', '-7 days')
      ORDER BY tsc.changed_at DESC;
    " 2>/dev/null)
    if [ -n "$SCORE_RECENT" ]; then
      echo "=== Thesis Score Changes (last 7 days) ==="
      echo "$SCORE_RECENT" | while IFS='|' read -r SYM CRIT OLD NEW REASON; do
        echo "  $SYM $CRIT: $OLD -> $NEW" $([ -n "$REASON" ] && echo "— $REASON")
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

    # === Valuation Alerts ===
    VAL_ALERTS=$(python3 - "$DB" <<'PYEOF'
import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row

# 1) PEG rating changes: compare latest vs previous day's peg_rating
changes = conn.execute("""
    SELECT v1.symbol, v1.peg_rating as new_rating, v2.peg_rating as old_rating,
           printf('%.2f', v1.forward_peg) as peg_val
    FROM valuation_metrics v1
    JOIN valuation_metrics v2 ON v1.symbol = v2.symbol
    WHERE v1.date = (SELECT MAX(date) FROM valuation_metrics WHERE symbol = v1.symbol)
      AND v2.date = (SELECT MAX(date) FROM valuation_metrics WHERE symbol = v1.symbol AND date < v1.date)
      AND v1.peg_rating IS NOT NULL AND v2.peg_rating IS NOT NULL
      AND v1.peg_rating != v2.peg_rating
""").fetchall()

# 2) Valuation vs tier contradictions
contradictions = conn.execute("""
    SELECT vm.symbol, vm.peg_rating, printf('%.2f', vm.forward_peg) as peg_val,
           pi.tier, printf('%.1f', vm.forward_pe) as fwd_pe
    FROM valuation_metrics vm
    JOIN securities s ON vm.symbol = s.symbol
    JOIN positions p ON p.security_id = s.id
    JOIN position_intents pi ON pi.position_id = p.id
    WHERE vm.date = (SELECT MAX(date) FROM valuation_metrics WHERE symbol = vm.symbol)
      AND vm.peg_rating IS NOT NULL AND pi.tier IS NOT NULL
      AND (
        (vm.peg_rating = 'PRICEY' AND pi.tier IN ('Core', 'Growth'))
        OR (vm.peg_rating = 'CHEAP' AND pi.tier IN ('Starter', 'Exit'))
      )
""").fetchall()

output = []
if changes:
    for c in changes:
        output.append(f"  {c['symbol']:<6} PEG rating: {c['old_rating']} -> {c['new_rating']} (PEG {c['peg_val']})")

if contradictions:
    if changes:
        output.append("")
    output.append("  --- Tier/Valuation Mismatches ---")
    for c in contradictions:
        if c['peg_rating'] == 'CHEAP':
            output.append(f"  {c['symbol']} is {c['peg_rating']} (PEG {c['peg_val']}) at {c['tier']} tier — conviction may be too low")
        else:
            output.append(f"  {c['symbol']} is {c['peg_rating']} (PEG {c['peg_val']}, fwd PE {c['fwd_pe']}x) at {c['tier']} tier — validate thesis still holds")

if output:
    for line in output:
        print(line)

conn.close()
PYEOF
)
    if [ -n "$VAL_ALERTS" ]; then
      echo "=== Valuation Alerts ==="
      echo "$VAL_ALERTS"
      echo ""
    fi

    # === Trading Position Alerts ===
    TRADE_ALERTS=$(sqlite3 "$DB" "
      SELECT tp.symbol, tp.shares, tp.entry_price, tp.entry_date, tp.stop_price, tp.time_limit_days,
        julianday('now') - julianday(tp.entry_date) as days_held,
        tp.time_limit_days - (julianday('now') - julianday(tp.entry_date)) as days_left,
        (SELECT ph.close_price FROM price_history ph JOIN securities s ON ph.security_id = s.id
         WHERE s.symbol = tp.symbol ORDER BY ph.date DESC LIMIT 1) as mtm
      FROM trading_positions tp
      WHERE tp.status = 'open';
    " 2>/dev/null)

    if [ -n "$TRADE_ALERTS" ]; then
      NEEDS_ALERT=0
      ALERT_LINES=""
      echo "$TRADE_ALERTS" | while IFS='|' read -r SYM SHARES ENTRY EDATE STOP LIMIT HELD LEFT MTM; do
        HELD_INT=$(printf "%.0f" "$HELD" 2>/dev/null)
        LEFT_INT=$(printf "%.0f" "$LEFT" 2>/dev/null)
        UPNL_PCT=$(python3 -c "print(f'{($MTM - $ENTRY) / $ENTRY * 100:+.1f}%')" 2>/dev/null)

        WARN=""
        if [ "$LEFT_INT" -le 0 ] 2>/dev/null; then
          WARN="⛔ EXPIRED"
        elif [ "$LEFT_INT" -le 5 ] 2>/dev/null; then
          WARN="⚠ ${LEFT_INT}d left"
        fi

        # Check if stop not set (no stop price)
        STOP_WARN=""
        if [ -z "$STOP" ] || [ "$STOP" = "0" ] || [ "$STOP" = "0.0" ]; then
          STOP_WARN=" ⚠ NO STOP"
        fi

        if [ -n "$WARN" ] || [ -n "$STOP_WARN" ]; then
          echo "  $SYM ${SHARES}sh \$$MTM ($UPNL_PCT) | stop \$$STOP | ${HELD_INT}d/${LIMIT}d ${WARN}${STOP_WARN}"
        fi
      done > /tmp/pm-trade-alerts-$$

      if [ -s /tmp/pm-trade-alerts-$$ ]; then
        echo "=== Trading Position Alerts ==="
        cat /tmp/pm-trade-alerts-$$
        echo ""
      fi
      rm -f /tmp/pm-trade-alerts-$$
    fi

    # === Entry Confluence ===
    CONFLUENCE=$(sqlite3 "$DB" "
      SELECT DISTINCT vm.symbol, vm.peg_rating, vm.forward_peg, vm.eps_growth_pct,
        (SELECT ph.close_price FROM price_history ph JOIN securities s2 ON ph.security_id = s2.id
         WHERE s2.symbol = vm.symbol ORDER BY ph.date DESC LIMIT 1) as price,
        (SELECT pl.price FROM price_levels pl
         WHERE pl.symbol = vm.symbol AND pl.level_type = 'support' AND pl.price <
           (SELECT ph2.close_price FROM price_history ph2 JOIN securities s3 ON ph2.security_id = s3.id
            WHERE s3.symbol = vm.symbol ORDER BY ph2.date DESC LIMIT 1)
         ORDER BY pl.price DESC LIMIT 1) as nearest_support
      FROM valuation_metrics vm
      WHERE vm.date = (SELECT MAX(date) FROM valuation_metrics WHERE symbol = vm.symbol)
        AND vm.peg_rating IN ('CHEAP', 'FAIR')
        AND vm.forward_peg IS NOT NULL AND vm.forward_peg > 0 AND vm.forward_peg < 1.2
    " 2>/dev/null)

    if [ -n "$CONFLUENCE" ]; then
      CONFLUENCE_HITS=""
      echo "$CONFLUENCE" | while IFS='|' read -r SYM RATING PEG GROWTH PRICE SUPPORT; do
        SIGNALS=0
        SIGNAL_LIST=""
        # Signal 1: Valuation
        SIGNALS=$((SIGNALS + 1))
        PEG_FMT=$(printf "%.2f" "$PEG" 2>/dev/null || echo "$PEG")
        SIGNAL_LIST="$RATING PEG:$PEG_FMT"
        # Signal 2: Near support
        if [ -n "$SUPPORT" ] && [ -n "$PRICE" ]; then
          PCT_FROM_S=$(python3 -c "print(f'{($PRICE - $SUPPORT) / $PRICE * 100:.1f}')" 2>/dev/null)
          if [ "$(echo "$PCT_FROM_S < 5" | bc -l 2>/dev/null)" = "1" ]; then
            SIGNALS=$((SIGNALS + 1))
            SIGNAL_LIST="$SIGNAL_LIST, S\$$SUPPORT ${PCT_FROM_S}%"
          fi
        fi
        # Signal 3: Growth
        if [ -n "$GROWTH" ]; then
          if [ "$(echo "$GROWTH > 20" | bc -l 2>/dev/null)" = "1" ]; then
            SIGNALS=$((SIGNALS + 1))
            GROWTH_FMT=$(printf "%.0f" "$GROWTH" 2>/dev/null || echo "$GROWTH")
            SIGNAL_LIST="$SIGNAL_LIST, EPS+${GROWTH_FMT}%"
          fi
        fi
        if [ "$SIGNALS" -ge 2 ]; then
          echo "  $SYM \$$PRICE — $SIGNAL_LIST ($SIGNALS signals)"
        fi
      done > /tmp/pm-confluence-$$

      if [ -s /tmp/pm-confluence-$$ ]; then
        echo "=== Entry Confluence (2+ signals) ==="
        cat /tmp/pm-confluence-$$
        echo ""
      fi
      rm -f /tmp/pm-confluence-$$
    fi

    # Overnight news (last 24h) — portfolio + watchlist symbols
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
          UNION
          SELECT DISTINCT wi.symbol FROM watchlist_items wi
        ) tracked ON n.symbol = tracked.symbol
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

    # Pending earnings reviews
    OVERDUE_REVIEWS=$(sqlite3 -separator '|' "$DB" "
      SELECT s.symbol, er.quarter, er.thesis_impact, er.decision_deadline,
             er.invalidation_triggered
      FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      WHERE er.decision IS NULL
      ORDER BY er.decision_deadline ASC;
    " 2>/dev/null)
    if [ -n "$OVERDUE_REVIEWS" ]; then
      echo "=== Pending Earnings Reviews ==="
      echo "$OVERDUE_REVIEWS" | while IFS='|' read -r SYM QTR IMPACT DEADLINE INV_TRIG; do
        NOW_TS=$(date +%s)
        if [ -n "$DEADLINE" ]; then
          DL_TS=$(python3 -c "from datetime import datetime; print(int(datetime.fromisoformat('$DEADLINE'.replace('Z','+00:00')).timestamp()))" 2>/dev/null || echo "0")
          HOURS_LEFT=$(( (DL_TS - NOW_TS) / 3600 ))
          if [ "$HOURS_LEFT" -lt 0 ]; then
            echo "  ⚠ OVERDUE: $SYM $QTR earnings review — thesis $IMPACT, deadline was ${DEADLINE:0:10}"
          elif [ "$HOURS_LEFT" -lt 24 ]; then
            echo "  ⚠ DUE SOON: $SYM $QTR earnings review — due in ${HOURS_LEFT}h"
          else
            DAYS_LEFT=$(( HOURS_LEFT / 24 ))
            echo "  ⏳ PENDING: $SYM $QTR earnings review — thesis $IMPACT, ${DAYS_LEFT}d remaining"
          fi
        else
          echo "  ⏳ PENDING: $SYM $QTR earnings review — thesis $IMPACT, no deadline"
        fi
      done
      echo ""
    fi

    echo "(Run 'pm-cli.sh refresh' to update prices. Use web search for news.)"
    echo "============================================"
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
esac
