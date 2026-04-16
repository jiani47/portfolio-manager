#!/bin/bash
# Data commands: refresh, backfill, snapshot, snapshot-history, snapshot-position,
#                news, technicals, sectors, levels-refresh, levels, sync-transactions
# Market data fetching, price history, snapshots, and technical analysis

case "$1" in
  refresh)
    # Refresh prices via Schwab API using tokens from Electron app config
    schwab_ensure_token

    # Get all non-cash symbols from positions + watchlist items + sector ETFs
    SYMBOLS=$(sqlite3 "$DB" "
      SELECT DISTINCT symbol FROM (
        SELECT s.symbol FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.type != 'cash' AND s.symbol != ''
        UNION
        SELECT symbol FROM watchlist_items
        UNION
        VALUES ('XLK'),('XLF'),('XLV'),('XLE'),('XLI'),('XLY'),('XLP'),('XLU'),('XLRE'),('XLB'),('XLC'),('SPY')
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
    open_price = q.get('openPrice') or 0
    high_price = q.get('highPrice') or 0
    low_price = q.get('lowPrice') or 0
    if price <= 0:
        errors += 1
        continue
    sec_id = sec_map.get(sym)
    if not sec_id:
        continue
    row_id = str(uuid.uuid4())
    cur.execute('''
        INSERT OR REPLACE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at)
        VALUES (
            COALESCE((SELECT id FROM price_history WHERE security_id = ? AND date = ?), ?),
            ?, ?, ?, ?, ?, ?, ?, ?
        )
    ''', (sec_id, today, row_id, sec_id, today, open_price, high_price, low_price, price, volume, now))
    updated += 1

conn.commit()
conn.close()
print(f'Updated {updated} prices, {errors} errors')
" 2>/dev/null

    echo "Done. Run './scripts/pm-cli.sh briefing' to see the briefing."

    # Check monitors against new prices
    TRIGGERED=$(sqlite3 "$DB" "
      SELECT m.id, m.symbol, m.direction, m.price_level, m.label, m.action_type, ph.close_price
      FROM monitors m
      JOIN securities s ON s.symbol = m.symbol
      JOIN price_history ph ON ph.security_id = s.id AND ph.date = '$TODAY'
      WHERE m.status = 'active'
        AND (
          (m.direction = 'below' AND ph.close_price <= m.price_level)
          OR (m.direction = 'above' AND ph.close_price >= m.price_level)
        );
    ")
    if [ -n "$TRIGGERED" ]; then
      NOW_TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
      echo ""
      echo "🚨 === MONITOR ALERTS ==="
      echo "$TRIGGERED" | while IFS='|' read -r mid sym dir level label atype price; do
        sqlite3 "$DB" "UPDATE monitors SET status = 'triggered', triggered_at = '$NOW_TS', updated_at = '$NOW_TS' WHERE id = '$mid';"
        ICON="⬇️"
        [ "$dir" = "above" ] && ICON="⬆️"
        TYPE_TAG=""
        NTFY_PRI="high"
        [ "$atype" = "action_required" ] && TYPE_TAG=" [ACTION REQUIRED]" && NTFY_PRI="urgent"
        echo "  $ICON $sym \$$price crossed $dir \$$level — $label$TYPE_TAG"
        pm_notify "$sym $ICON \$$price crossed $dir \$$level" "$label$TYPE_TAG" "$NTFY_PRI"
      done
      echo "========================="
    fi

    # Fetch news from FMP
    FMP_KEY=$(get_fmp_key)
    if [ -n "$FMP_KEY" ]; then
      # Create news table if not exists
      sqlite3 "$DB" "
        CREATE TABLE IF NOT EXISTS news (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          title TEXT NOT NULL,
          snippet TEXT,
          source TEXT,
          url TEXT,
          published_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          UNIQUE(symbol, title)
        );
        CREATE INDEX IF NOT EXISTS idx_news_symbol ON news(symbol);
        CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at);
      "

      echo ""
      echo "Fetching news from FMP..."

      # Fetch latest news firehose (10 pages x 50 = ~500 articles covering ~24h)
      # Store all, filter to portfolio symbols when displaying
      TOTAL_NEW=0
      for PAGE in 0 1 2 3 4 5 6 7 8 9; do
        NEW_COUNT=$(curl -s "${FMP_BASE}/news/stock-latest?page=${PAGE}&limit=50&apikey=${FMP_KEY}" 2>/dev/null | python3 -c "
import json, sys, sqlite3, uuid

db = sys.argv[1]
now = sys.argv[2]

try:
    data = json.load(sys.stdin)
except:
    sys.exit(0)

if not isinstance(data, list) or len(data) == 0:
    sys.exit(0)

conn = sqlite3.connect(db)
cur = conn.cursor()
count = 0
for article in data:
    symbol = article.get('symbol', '')
    title = article.get('title', '')
    if not symbol or not title:
        continue
    snippet = (article.get('text', '') or '')[:500] or None
    source = article.get('site', '')
    url = article.get('url', '')
    published = article.get('publishedDate', now)
    row_id = str(uuid.uuid4())
    try:
        cur.execute('''
            INSERT OR IGNORE INTO news (id, symbol, title, snippet, source, url, published_at, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (row_id, symbol, title, snippet, source, url, published, now))
        count += cur.rowcount
    except:
        pass
conn.commit()
conn.close()
print(count)
" "$DB" "$NOW" 2>/dev/null)
        TOTAL_NEW=$((TOTAL_NEW + ${NEW_COUNT:-0}))
      done
      echo "  Stored $TOTAL_NEW new articles"

      # Archive articles older than 30 days to CSV, then remove from DB
      ARCHIVE_DIR="$HOME/Library/Application Support/portfolio-manager/news-archive"
      mkdir -p "$ARCHIVE_DIR"
      ARCHIVE_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM news WHERE published_at < datetime('now', '-30 days');")
      if [ "$ARCHIVE_COUNT" -gt 0 ]; then
        sqlite3 -header -csv "$DB" "SELECT * FROM news WHERE published_at < datetime('now', '-30 days') ORDER BY published_at;" >> "$ARCHIVE_DIR/news-archive.csv"
        sqlite3 "$DB" "DELETE FROM news WHERE published_at < datetime('now', '-30 days');"
        echo "  Archived $ARCHIVE_COUNT old articles to news-archive/"
      fi

      # Fetch valuation metrics for portfolio + watchlist stocks
      echo ""
      echo "Fetching valuations from FMP..."

      VAL_SYMBOLS=$(sqlite3 "$DB" "
        SELECT DISTINCT symbol FROM (
          SELECT s.symbol FROM positions p JOIN securities s ON p.security_id = s.id
          WHERE s.type = 'stock' AND p.quantity > 0
          UNION
          SELECT wi.symbol FROM watchlist_items wi
        ) ORDER BY symbol;
      ")

      python3 - "$FMP_KEY" "$DB" "$VAL_SYMBOLS" << 'PYEOF'
import json, urllib.request, sqlite3, sys, uuid, datetime

fmp_key = sys.argv[1]
db_path = sys.argv[2]
symbols_raw = sys.argv[3]
symbols = [s.strip() for s in symbols_raw.strip().split('\n') if s.strip()]
BASE = "https://financialmodelingprep.com/stable"
today = datetime.date.today()
today_str = today.isoformat()
now_ts = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Create table if not exists (for CLI-only usage without app)
conn.execute('''CREATE TABLE IF NOT EXISTS valuation_metrics (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, date TEXT NOT NULL,
    trailing_pe REAL, forward_pe REAL, peg REAL, forward_peg REAL,
    ps_ratio REAL, trailing_eps REAL, forward_eps REAL, forward_eps_fy_end TEXT,
    next_eps REAL, next_eps_fy_end TEXT, eps_growth_pct REAL, num_analysts INTEGER,
    fair_low REAL, fair_mid REAL, fair_high REAL, peg_rating TEXT,
    fetched_at TEXT NOT NULL, UNIQUE(symbol, date))''')

def fetch(endpoint, symbol, params=""):
    url = f"{BASE}/{endpoint}?symbol={symbol}&apikey={fmp_key}{params}"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except:
        return None

# Detect ADRs via individual profile calls
adr_cache = {}
def is_adr_check(sym):
    if sym in adr_cache:
        return adr_cache[sym]
    profile = fetch("profile", sym)
    result = False
    if profile and isinstance(profile, list) and len(profile) > 0:
        result = bool(profile[0].get('isAdr', False))
    adr_cache[sym] = result
    return result

count = 0
errors = 0
for symbol in symbols:
    try:
        is_adr = is_adr_check(symbol)

        # Get price
        price_row = conn.execute("""
            SELECT ph.close_price FROM price_history ph
            JOIN securities s ON ph.security_id = s.id
            WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
        """, (symbol,)).fetchone()
        if not price_row:
            continue
        price = price_row['close_price']

        # Ratios TTM (reliable for both ADRs and domestic — computed from USD price)
        ratios = fetch("ratios-ttm", symbol)
        t12_pe = 0; peg = 0; fwd_peg = 0; ps = 0
        if ratios and isinstance(ratios, list) and len(ratios) > 0:
            r = ratios[0]
            t12_pe = r.get('priceToEarningsRatioTTM', 0) or 0
            peg = r.get('priceToEarningsGrowthRatioTTM', 0) or 0
            fwd_peg = r.get('forwardPriceToEarningsGrowthRatioTTM', 0) or 0
            ps = r.get('priceToSalesRatioTTM', 0) or 0

        # Trailing EPS
        t12_eps = price / t12_pe if t12_pe and t12_pe > 0 else None

        # Analyst estimates — skip forward PE computation for ADRs (EPS in local currency)
        estimates = fetch("analyst-estimates", symbol, "&period=annual&limit=8")
        fwd_pe = None; fwd_eps = None; fwd_fy_end = None
        next_eps = None; next_fy_end = None; eps_growth = None; num_analysts = None

        if estimates and isinstance(estimates, list):
            estimates.sort(key=lambda x: x.get('date', ''))
            future = [e for e in estimates if e.get('date', '') > today_str and e.get('epsAvg', 0) and e.get('epsAvg', 0) > 0]

            if len(future) >= 1:
                fwd_fy_end = future[0]['date'][:10]
                num_analysts = future[0].get('numAnalystsEps', 0)
                if not is_adr:
                    # Only compute forward PE from estimates for domestic stocks
                    fwd_eps = future[0]['epsAvg']
                    fwd_pe = price / fwd_eps

            if len(future) >= 2:
                # EPS growth % is valid even for ADRs (same currency cancels out)
                eps_growth = (future[1]['epsAvg'] - future[0]['epsAvg']) / future[0]['epsAvg'] * 100
                if not is_adr:
                    next_eps = future[1]['epsAvg']
                    next_fy_end = future[1]['date'][:10]

        # Fair price range
        fair_low = fair_mid = fair_high = None
        if is_adr and t12_pe and t12_pe > 0 and t12_eps:
            # ADR: use trailing PE (USD-based) for fair range since forward EPS is in local currency
            if t12_pe > 30:
                fair_low = t12_eps * t12_pe * 0.75
                fair_mid = t12_eps * t12_pe * 0.90
                fair_high = t12_eps * t12_pe * 1.10
            else:
                fair_low = t12_eps * t12_pe * 0.85
                fair_mid = t12_eps * t12_pe * 1.0
                fair_high = t12_eps * t12_pe * 1.15
        elif fwd_eps and fwd_pe:
            if fwd_pe > 30:
                fair_low = fwd_eps * fwd_pe * 0.75
                fair_mid = fwd_eps * fwd_pe * 0.90
                fair_high = fwd_eps * fwd_pe * 1.10
            else:
                fair_low = fwd_eps * fwd_pe * 0.85
                fair_mid = fwd_eps * fwd_pe * 1.0
                fair_high = fwd_eps * fwd_pe * 1.15
            if eps_growth and eps_growth > 0 and fwd_eps:
                peg1_price = fwd_eps * eps_growth
                if peg1_price > fair_high:
                    fair_high = peg1_price

        # PEG rating
        peg_rating = None
        if fwd_peg and fwd_peg > 0:
            if fwd_peg < 0.8: peg_rating = 'CHEAP'
            elif fwd_peg < 1.2: peg_rating = 'FAIR'
            elif fwd_peg < 2.0: peg_rating = 'RICH'
            else: peg_rating = 'PRICEY'

        # Upsert
        row_id = str(uuid.uuid4())
        conn.execute("""
            INSERT OR REPLACE INTO valuation_metrics
            (id, symbol, date, trailing_pe, forward_pe, peg, forward_peg, ps_ratio,
             trailing_eps, forward_eps, forward_eps_fy_end, next_eps, next_eps_fy_end,
             eps_growth_pct, num_analysts, fair_low, fair_mid, fair_high, peg_rating, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (row_id, symbol, today_str, t12_pe, fwd_pe, peg, fwd_peg, ps,
              t12_eps, fwd_eps, fwd_fy_end, next_eps, next_fy_end,
              eps_growth, num_analysts, fair_low, fair_mid, fair_high, peg_rating, now_ts))
        count += 1
    except Exception as e:
        errors += 1

conn.commit()
conn.close()
print(f"  Updated {count} valuations, {errors} errors")
PYEOF
    fi

    # Auto-resize active baskets to match current prices × target allocations
    ACTIVE_BASKETS=$(sqlite3 "$DB" "SELECT name FROM rebalance_baskets WHERE status = 'active';")
    if [ -n "$ACTIVE_BASKETS" ]; then
      echo ""
      echo "Resizing active baskets..."
      SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
      echo "$ACTIVE_BASKETS" | while read -r BNAME; do
        "$SCRIPT_ROOT/pm-cli.sh" basket-resize "$BNAME" 2>/dev/null | tail -2
      done
    fi
    ;;

  backfill)
    # Backfill 3yr daily price history from Schwab API
    # Usage: pm-cli.sh backfill [symbol]
    schwab_ensure_token

    # Get symbols to backfill
    if [ -n "$2" ]; then
      SYMBOLS=$(echo "$2" | tr '[:lower:]' '[:upper:]')
    else
      SYMBOLS=$(sqlite3 "$DB" "
        SELECT DISTINCT symbol FROM (
          SELECT s.symbol FROM positions p JOIN securities s ON p.security_id = s.id
          WHERE s.type != 'cash' AND s.symbol != ''
          UNION
          SELECT symbol FROM watchlist_items
        ) ORDER BY symbol;
      ")
    fi

    SYMBOL_COUNT=$(echo "$SYMBOLS" | wc -l | tr -d ' ')
    echo "Backfilling 3yr price history for $SYMBOL_COUNT symbol(s)..."

    NOW_TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    for SYM in $SYMBOLS; do
      HIST_RESPONSE=$(curl -s "${SCHWAB_API}/marketdata/v1/pricehistory?symbol=${SYM}&periodType=year&period=3&frequencyType=daily" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}")

      CANDLE_COUNT=$(python3 -c "
import json, sys, sqlite3, uuid
from datetime import datetime, timezone

response = json.loads('''${HIST_RESPONSE}''')
candles = response.get('candles', [])
db = '$DB'
now = '$NOW_TS'

conn = sqlite3.connect(db)
cur = conn.cursor()

# Look up security_id
cur.execute('SELECT id FROM securities WHERE symbol = ?', ('${SYM}',))
row = cur.fetchone()
if not row:
    print('0 (security not found)')
    conn.close()
    sys.exit(0)
sec_id = row[0]

count = 0
for c in candles:
    epoch_ms = c.get('datetime', 0)
    date_str = datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
    open_p = c.get('open', 0)
    high_p = c.get('high', 0)
    low_p = c.get('low', 0)
    close_p = c.get('close', 0)
    vol = c.get('volume', 0)
    row_id = str(uuid.uuid4())
    cur.execute('''
        INSERT OR IGNORE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (row_id, sec_id, date_str, open_p, high_p, low_p, close_p, vol, now))
    count += cur.rowcount

conn.commit()
conn.close()
print(f'{len(candles)} candles ({count} new)')
" 2>/dev/null)

      echo "  Backfilling ${SYM}... ${CANDLE_COUNT}"
      sleep 0.5
    done

    echo "Backfill complete."
    ;;

  snapshot)
    # Take end-of-day portfolio snapshot — one per day, aggregated by symbol
    TODAY=$(date +"%Y-%m-%d")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Create table if not exists
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL,
        cost_basis REAL NOT NULL,
        close_price REAL NOT NULL,
        market_value REAL NOT NULL,
        unrealized_gain REAL NOT NULL,
        day_change REAL,
        day_pnl REAL,
        created_at TEXT NOT NULL,
        UNIQUE(date, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_date ON portfolio_snapshots(date);
      CREATE INDEX IF NOT EXISTS idx_snapshots_symbol ON portfolio_snapshots(symbol);
    "

    # Check if snapshot already exists for today
    EXISTING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM portfolio_snapshots WHERE date = '$TODAY';")
    if [ "$EXISTING" -gt 0 ]; then
      echo "Snapshot already exists for $TODAY ($EXISTING rows). Skipping."
      exit 0
    fi

    python3 -c "
import sqlite3, uuid, sys

db = '$DB'
today = '$TODAY'
now = '$NOW'

conn = sqlite3.connect(db)
cur = conn.cursor()

# Get all positions aggregated by symbol, with latest close price
cur.execute('''
    SELECT s.symbol, s.type,
           SUM(p.quantity) as total_qty,
           SUM(p.cost_basis) as total_cost
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    GROUP BY s.symbol, s.type
    HAVING total_qty != 0
''')
positions = cur.fetchall()

count = 0
for symbol, sec_type, qty, cost_basis in positions:
    if sec_type == 'cash':
        close_price = 1.0
        market_value = qty
        unrealized_gain = 0.0
        day_change = None
        day_pnl = None
    else:
        # Get today's close price
        cur.execute('''
            SELECT close_price FROM price_history ph
            JOIN securities s ON ph.security_id = s.id
            WHERE s.symbol = ? AND ph.date = (
                SELECT MAX(date) FROM price_history ph2
                JOIN securities s2 ON ph2.security_id = s2.id
                WHERE s2.symbol = ?
            )
        ''', (symbol, symbol))
        row = cur.fetchone()
        if not row:
            print(f'  WARNING: No price data for {symbol}, skipping')
            continue
        close_price = row[0]
        market_value = qty * close_price
        unrealized_gain = market_value - cost_basis

        # Get previous day's close for day change
        cur.execute('''
            SELECT close_price FROM price_history ph
            JOIN securities s ON ph.security_id = s.id
            WHERE s.symbol = ? AND ph.date = (
                SELECT MAX(date) FROM price_history ph2
                JOIN securities s2 ON ph2.security_id = s2.id
                WHERE s2.symbol = ? AND ph2.date < (
                    SELECT MAX(date) FROM price_history ph3
                    JOIN securities s3 ON ph3.security_id = s3.id
                    WHERE s3.symbol = ?
                )
            )
        ''', (symbol, symbol, symbol))
        prev_row = cur.fetchone()
        if prev_row:
            prev_close = prev_row[0]
            day_change = close_price - prev_close
            day_pnl = day_change * qty
        else:
            day_change = None
            day_pnl = None

    row_id = str(uuid.uuid4())
    cur.execute('''
        INSERT INTO portfolio_snapshots (id, date, symbol, quantity, cost_basis, close_price, market_value, unrealized_gain, day_change, day_pnl, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (row_id, today, symbol, qty, cost_basis, close_price, market_value, unrealized_gain, day_change, day_pnl, now))
    count += 1

conn.commit()
conn.close()
print(f'Snapshot taken for {today}: {count} positions')
# Recalculate from DB to get accurate totals
conn2 = sqlite3.connect(db)
c2 = conn2.cursor()
c2.execute('SELECT SUM(market_value), SUM(unrealized_gain), SUM(COALESCE(day_pnl, 0)) FROM portfolio_snapshots WHERE date = ?', (today,))
row = c2.fetchone()
if row and row[0]:
    print(f'  Total MV: \${row[0]:,.0f}  |  Unrealized P&L: \${row[1]:>+,.0f}  |  Day P&L: \${row[2]:>+,.0f}')
conn2.close()
" 2>/dev/null
    ;;

  snapshot-history)
    # Show portfolio totals for last N days
    DAYS="${2:-30}"

    # Create table if not exists (in case it hasn't been created yet)
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, symbol TEXT NOT NULL,
      quantity REAL NOT NULL, cost_basis REAL NOT NULL, close_price REAL NOT NULL,
      market_value REAL NOT NULL, unrealized_gain REAL NOT NULL,
      day_change REAL, day_pnl REAL, created_at TEXT NOT NULL, UNIQUE(date, symbol)
    );"

    echo "=== Portfolio Snapshot History (last $DAYS days) ==="
    sqlite3 "$DB" "
      SELECT date,
             printf('%.0f', SUM(market_value)) as total_mv,
             printf('%.0f', SUM(cost_basis)) as total_cost,
             printf('%.0f', SUM(unrealized_gain)) as total_pnl,
             printf('%.0f', SUM(COALESCE(day_pnl, 0))) as day_pnl,
             COUNT(*) as positions
      FROM portfolio_snapshots
      GROUP BY date
      ORDER BY date DESC
      LIMIT $DAYS;
    " | python3 -c "
import sys
print(f'{\"Date\":<12} {\"Total MV\":>12} {\"Cost Basis\":>12} {\"Unreal P&L\":>12} {\"Day P&L\":>10} {\"Pos\":>4}')
print('-' * 66)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 6: continue
    date, mv, cost, pnl, dpnl, pos = parts
    mv_f, cost_f, pnl_f, dpnl_f = float(mv), float(cost), float(pnl), float(dpnl)
    pnl_arrow = '+' if pnl_f >= 0 else ''
    dpnl_arrow = '+' if dpnl_f >= 0 else ''
    print(f'{date:<12} \${mv_f:>11,.0f} \${cost_f:>11,.0f} {pnl_arrow}\${pnl_f:>10,.0f} {dpnl_arrow}\${dpnl_f:>8,.0f} {pos:>4}')
" 2>/dev/null
    ;;

  snapshot-position)
    # Show one position's history over time
    SYMBOL="$2"; DAYS="${3:-30}"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh snapshot-position <symbol> [days]"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Create table if not exists
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, symbol TEXT NOT NULL,
      quantity REAL NOT NULL, cost_basis REAL NOT NULL, close_price REAL NOT NULL,
      market_value REAL NOT NULL, unrealized_gain REAL NOT NULL,
      day_change REAL, day_pnl REAL, created_at TEXT NOT NULL, UNIQUE(date, symbol)
    );"

    echo "=== $SYMBOL Snapshot History (last $DAYS days) ==="
    sqlite3 "$DB" "
      SELECT date,
             printf('%.2f', close_price) as price,
             printf('%.2f', quantity) as qty,
             printf('%.0f', market_value) as mv,
             printf('%.0f', cost_basis) as cost,
             printf('%.0f', unrealized_gain) as pnl,
             printf('%.2f', CASE WHEN cost_basis > 0 THEN unrealized_gain / cost_basis * 100 ELSE 0 END) as pnl_pct,
             printf('%.2f', COALESCE(day_change, 0)) as day_chg
      FROM portfolio_snapshots
      WHERE symbol = '$SYMBOL'
      ORDER BY date DESC
      LIMIT $DAYS;
    " | python3 -c "
import sys
print(f'{\"Date\":<12} {\"Price\":>10} {\"Qty\":>10} {\"MV\":>10} {\"Cost\":>10} {\"P&L\":>10} {\"P&L%\":>8} {\"Day Chg\":>8}')
print('-' * 82)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 8: continue
    date, price, qty, mv, cost, pnl, pnl_pct, day_chg = parts
    pnl_f = float(pnl)
    pnl_arrow = '+' if pnl_f >= 0 else ''
    day_f = float(day_chg)
    day_arrow = '+' if day_f >= 0 else ''
    print(f'{date:<12} \${float(price):>9,.2f} {float(qty):>10,.2f} \${float(mv):>9,.0f} \${float(cost):>9,.0f} {pnl_arrow}\${pnl_f:>8,.0f} {pnl_arrow}{float(pnl_pct):>6.1f}% {day_arrow}\${day_f:>.2f}')
" 2>/dev/null
    ;;

  news)
    # Show recent news, optionally filtered by symbol
    SYMBOL="$2"

    # Create table if not exists
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, title TEXT NOT NULL,
      snippet TEXT, source TEXT, url TEXT, published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL, UNIQUE(symbol, title)
    );"

    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      echo "=== News: $SYMBOL (last 7 days) ==="
      sqlite3 "$DB" "
        SELECT published_at, title, source, url
        FROM news
        WHERE symbol = '$SYMBOL'
          AND published_at >= datetime('now', '-7 days')
        ORDER BY published_at DESC
        LIMIT 20;
      " | python3 -c "
import sys
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 4: continue
    pub, title, source, url = parts[0], parts[1], parts[2], parts[3]
    time_str = pub[5:16] if len(pub) > 16 else pub
    print(f'  {time_str}  [{source}] {title}')
    print(f'             {url}')
" 2>/dev/null
    else
      echo "=== Portfolio News (last 24h) ==="
      sqlite3 "$DB" "
        SELECT symbol, published_at, title, source, url
        FROM news
        WHERE published_at >= datetime('now', '-1 day')
        ORDER BY symbol, published_at DESC;
      " | python3 -c "
import sys
from collections import defaultdict
by_symbol = defaultdict(list)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 5: continue
    sym, pub, title, source, url = parts[0], parts[1], parts[2], parts[3], parts[4]
    by_symbol[sym].append((pub, title, source, url))

if not by_symbol:
    print('  No news in the last 24 hours.')
else:
    for sym in sorted(by_symbol):
        print(f'  --- {sym} ---')
        for pub, title, source, url in by_symbol[sym]:
            time_str = pub[11:16] if len(pub) > 16 else pub
            print(f'    {time_str} [{source}] {title}')
        print()
" 2>/dev/null
    fi
    ;;

  news-unanalyzed)
    # Show news pending AI classification
    LIMIT="${2:-50}"
    echo "=== Unanalyzed News (pending AI classification) ==="

    COUNT=$(sqlite3 "$DB" "
      SELECT COUNT(*)
      FROM news n
      LEFT JOIN news_analysis na ON n.id = na.news_id
      WHERE na.id IS NULL
    ")

    if [ "$COUNT" -eq 0 ]; then
      echo "  No unanalyzed news"
    else
      echo "  Total unanalyzed: $COUNT"
      echo ""
      sqlite3 "$DB" "
        SELECT n.symbol, n.published_at, n.title, n.source
        FROM news n
        LEFT JOIN news_analysis na ON n.id = na.news_id
        WHERE na.id IS NULL
        ORDER BY n.published_at DESC
        LIMIT $LIMIT
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
    print(f'  {sym}:')
    for pub, title, source in by_symbol[sym]:
        time_str = pub[5:16] if len(pub) > 16 else pub
        print(f'    {time_str}  [{source}] {title}')
    print()
" 2>/dev/null
    fi
    ;;

  news-analyzed)
    # Show news with AI analysis results
    SYMBOL="$2"
    LIMIT="${3:-20}"

    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      echo "=== Analyzed News: $SYMBOL ==="
      sqlite3 "$DB" "
        SELECT na.analyzed_at, n.title, na.category, na.materiality, na.confidence, na.summary
        FROM news_analysis na
        JOIN news n ON na.news_id = n.id
        WHERE na.symbol = '$SYMBOL' OR na.symbols_affected LIKE '%$SYMBOL%'
        ORDER BY na.analyzed_at DESC
        LIMIT $LIMIT
      " | python3 -c "
import sys
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 6: continue
    analyzed, title, category, materiality, confidence, summary = parts
    time_str = analyzed[5:16] if len(analyzed) > 16 else analyzed
    conf_pct = int(float(confidence) * 100)

    # Color codes
    if materiality == 'high':
        mat_color = '\033[91m'  # red
    elif materiality == 'medium':
        mat_color = '\033[93m'  # yellow
    else:
        mat_color = '\033[37m'  # white
    reset = '\033[0m'

    print(f'  {time_str}  {mat_color}[{materiality.upper()}]{reset}  {category}  ({conf_pct}%)')
    print(f'    {title}')
    if summary and summary != 'null':
        print(f'    → {summary}')
    print()
" 2>/dev/null
    else
      echo "=== Analyzed News (recent) ==="

      TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM news_analysis")
      echo "  Total analyzed: $TOTAL"
      echo ""

      sqlite3 "$DB" "
        SELECT na.symbol, na.analyzed_at, n.title, na.category, na.materiality, na.confidence
        FROM news_analysis na
        JOIN news n ON na.news_id = n.id
        ORDER BY na.analyzed_at DESC
        LIMIT $LIMIT
      " | python3 -c "
import sys
from collections import defaultdict
by_symbol = defaultdict(list)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 6: continue
    sym, analyzed, title, category, materiality, confidence = parts
    by_symbol[sym].append((analyzed, title, category, materiality, confidence))

for sym in sorted(by_symbol):
    print(f'  {sym}:')
    for analyzed, title, category, materiality, confidence in by_symbol[sym]:
        time_str = analyzed[5:16] if len(analyzed) > 16 else analyzed
        conf_pct = int(float(confidence) * 100)

        # Materiality badge
        if materiality == 'high':
            mat_badge = '\033[91m[HIGH]\033[0m'
        elif materiality == 'medium':
            mat_badge = '\033[93m[MED]\033[0m'
        else:
            mat_badge = '[LOW]'

        print(f'    {time_str}  {mat_badge}  {category}  ({conf_pct}%)')
        print(f'      {title}')
    print()
" 2>/dev/null
    fi
    ;;

  technicals)
    # Show technical indicators for portfolio symbols via FMP API
    FMP_KEY=$(get_fmp_key)
    if [ -z "$FMP_KEY" ]; then
      echo "ERROR: FMP API key not configured in ~/.pm-cli.conf"
      exit 1
    fi

    SYMBOL="$2"
    if [ -n "$SYMBOL" ]; then
      # Single symbol detail view
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      echo "=== Technical Indicators: $SYMBOL ==="
      python3 - "$SYMBOL" "$FMP_KEY" <<'PYEOF'
import json, urllib.request, sys

symbol = sys.argv[1]
key = sys.argv[2]
base = 'https://financialmodelingprep.com/stable/technical-indicators'

def fetch(indicator, period):
    url = f'{base}/{indicator}?symbol={symbol}&periodLength={period}&timeframe=1day&apikey={key}'
    try:
        data = json.loads(urllib.request.urlopen(url).read())
        return data[0] if data else None
    except:
        return None

sma20 = fetch('sma', 20)
sma50 = fetch('sma', 50)
sma200 = fetch('sma', 200)
rsi = fetch('rsi', 14)

if not sma20:
    print(f'  No data available for {symbol}')
    sys.exit(0)

price = sma20.get('close', 0)
s20 = sma20.get('sma', 0)
s50 = sma50.get('sma', 0) if sma50 else 0
s200 = sma200.get('sma', 0) if sma200 else 0
rsi_val = rsi.get('rsi', 0) if rsi else 0

print(f'  Price:    ${price:,.2f}')
print(f'  20 DMA:   ${s20:,.2f}  ({"above" if price >= s20 else "BELOW"})')
print(f'  50 DMA:   ${s50:,.2f}  ({"above" if price >= s50 else "BELOW"})')
print(f'  200 DMA:  ${s200:,.2f}  ({"above" if price >= s200 else "BELOW"})')
rsi_label = ''
if rsi_val >= 70: rsi_label = '  ⚠️  OVERBOUGHT'
elif rsi_val <= 30: rsi_label = '  ⚠️  OVERSOLD'
elif rsi_val >= 60: rsi_label = '  (approaching overbought)'
elif rsi_val <= 40: rsi_label = '  (approaching oversold)'
else: rsi_label = '  (neutral)'
print(f'  RSI(14):  {rsi_val:.1f}{rsi_label}')

above_count = sum(1 for s in [s20, s50, s200] if price >= s)
if above_count == 3: print(f'  Trend:    Strong uptrend (above all DMAs)')
elif above_count == 0: print(f'  Trend:    Strong downtrend (below all DMAs)')
elif price >= s200: print(f'  Trend:    Pullback in uptrend')
else: print(f'  Trend:    Weakening / breakdown')
PYEOF
    else
      # All portfolio symbols table
      echo "=== Portfolio Technical Indicators ==="
      SYMBOLS=$(sqlite3 "$DB" "
        SELECT DISTINCT s.symbol FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.type != 'cash' AND s.symbol != ''
        ORDER BY s.symbol;
      ")
      python3 - "$FMP_KEY" "$SYMBOLS" <<'PYEOF'
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

print(f'{"Symbol":<8} {"Price":>8} {"20 DMA":>8} {"50 DMA":>8} {"200 DMA":>9} {"RSI":>6}  Signal')
print('-' * 72)

for symbol in symbols:
    sma20 = fetch('sma', symbol, 20)
    sma50 = fetch('sma', symbol, 50)
    sma200 = fetch('sma', symbol, 200)
    rsi = fetch('rsi', symbol, 14)

    if not sma20:
        print(f'{symbol:<8} No data')
        continue

    price = sma20.get('close', 0)
    s20 = sma20.get('sma', 0)
    s50 = sma50.get('sma', 0) if sma50 else 0
    s200 = sma200.get('sma', 0) if sma200 else 0
    rsi_val = rsi.get('rsi', 0) if rsi else 0

    signals = []
    if price < s50: signals.append('< 50DMA')
    if price < s200: signals.append('< 200DMA')
    if rsi_val >= 70: signals.append('OB')
    elif rsi_val <= 30: signals.append('OS')
    signal_str = ', '.join(signals) if signals else ''

    print(f'{symbol:<8} ${price:>7,.2f} ${s20:>7,.2f} ${s50:>7,.2f} ${s200:>8,.2f} {rsi_val:>5.1f}  {signal_str}')
PYEOF
    fi
    ;;

  sectors)
    # Show sector performance heatmap with regime classification
    DATE="${2:-$(date +%Y-%m-%d)}"
    echo "=== Sector Performance: $DATE ==="

    python3 - "$DB" "$DATE" <<'PYEOF'
import sqlite3, sys, math

db, date = sys.argv[1], sys.argv[2]

ETFS = {
    'XLK':  'Technology',
    'SMH':  'Technology',
    'IGV':  'Technology',
    'XLF':  'Financials',
    'XLV':  'Health Care',
    'XBI':  'Health Care',
    'XLE':  'Energy',
    'XOP':  'Energy',
    'AMLP': 'Energy',
    'XLI':  'Industrials',
    'ITA':  'Industrials',
    'SHLD': 'Industrials',
    'XLY':  'Consumer Cyclical',
    'XLP':  'Consumer Defensive',
    'XLU':  'Utilities',
    'XLRE': 'Real Estate',
    'XLB':  'Basic Materials',
    'XLC':  'Communication Svcs',
    'ARKX': 'Technology',
}
ALL_SYMS = list(ETFS.keys()) + ['SPY', 'QQQ']
INDEX_CORR_THRESHOLD = 0.6
AUTO_CORR_THRESHOLD = 0.3
TREND_SECTOR_MIN = 7

def pearson(a, b):
    n = min(len(a), len(b))
    if n < 2: return 0
    ma = sum(a[:n])/n; mb = sum(b[:n])/n
    cov = sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    va = sum((a[i]-ma)**2 for i in range(n))
    vb = sum((b[i]-mb)**2 for i in range(n))
    d = math.sqrt(va*vb)
    return cov/d if d > 0 else 0

def autocorr(returns, lag=1):
    if len(returns) < lag + 2: return 0
    return pearson(returns[:-lag], returns[lag:])

def daily_returns(prices):
    return [(prices[i]-prices[i-1])/prices[i-1] for i in range(1, len(prices)) if prices[i-1] > 0]

conn = sqlite3.connect(db)
cur = conn.cursor()

placeholders = ','.join('?' * len(ALL_SYMS))

# Find last 11 dates where ALL symbols have data (date-aligned)
cur.execute(f"""
    SELECT ph.date, COUNT(DISTINCT s.symbol) as cnt
    FROM price_history ph
    JOIN securities s ON s.id = ph.security_id
    WHERE s.symbol IN ({placeholders}) AND ph.date <= ?
    GROUP BY ph.date
    HAVING cnt = ?
    ORDER BY ph.date DESC
    LIMIT 11
""", ALL_SYMS + [date, len(ALL_SYMS)])
aligned_dates = [r[0] for r in reversed(cur.fetchall())]  # oldest first

if len(aligned_dates) < 3:
    print("  Not enough aligned price data. Run: pm-cli.sh refresh + backfill")
    sys.exit(0)

date_placeholders = ','.join('?' * len(aligned_dates))
cur.execute(f"""
    SELECT s.symbol, ph.date, ph.close_price
    FROM price_history ph
    JOIN securities s ON s.id = ph.security_id
    WHERE s.symbol IN ({placeholders}) AND ph.date IN ({date_placeholders})
    ORDER BY s.symbol, ph.date ASC
""", ALL_SYMS + aligned_dates)
rows = cur.fetchall()
conn.close()

# Group by symbol — all will have same dates now
by_sym = {}
for sym, dt, price in rows:
    by_sym.setdefault(sym, []).append(price)

# Compute returns
sym_returns = {}
for sym in ALL_SYMS:
    prices = by_sym.get(sym, [])
    if len(prices) >= 3:
        sym_returns[sym] = daily_returns(prices)

spy_ret = sym_returns.get('SPY', [])

if not spy_ret:
    print("  No sector ETF data. Run: pm-cli.sh refresh")
    sys.exit(0)

# Compute per-sector metrics
results = []
for etf, sector in ETFS.items():
    ret = sym_returns.get(etf)
    if not ret or len(ret) < 2: continue
    prices = by_sym.get(etf, [])
    price = prices[-1] if prices else 0
    chg = ret[-1] * 100  # today's return as %

    corr = pearson(ret, spy_ret[:len(ret)])
    ac = autocorr(ret)

    high_corr = abs(corr) >= INDEX_CORR_THRESHOLD
    high_auto = ac >= AUTO_CORR_THRESHOLD
    if high_corr and high_auto: quad = 'trend'
    elif high_corr: quad = 'toggle'
    elif high_auto: quad = 'rotate'
    else: quad = 'noise'

    results.append((sector, etf, chg, price, corr, ac, quad))

if not results:
    print("  No sector ETF data. Run: pm-cli.sh refresh")
    sys.exit(0)

# SPY benchmark
spy_prices = by_sym.get('SPY', [])
spy_chg = spy_ret[-1] * 100 if spy_ret else None

ranked = sorted(results, key=lambda x: -x[2])

# Regime classification
correlated = sum(1 for _,_,_,_,c,_,_ in results if abs(c) >= INDEX_CORR_THRESHOLD)
total = len(results)
regime = 'TREND' if correlated >= TREND_SECTOR_MIN else 'SORTING'
confidence = (correlated / total if regime == 'TREND' else (total - correlated) / total) * 100
changes = [r[2] for r in results]
mean_chg = sum(changes) / len(changes)
dispersion = math.sqrt(sum((c - mean_chg)**2 for c in changes) / (len(changes) - 1)) if len(changes) > 1 else 0

print(f'  {"Sector":<22} {"ETF":>5} {"Price":>8} {"Change":>8} {"Corr":>6} {"AutoC":>6}  Signal')
print(f'  {"-"*22} {"-"*5} {"-"*8} {"-"*8} {"-"*6} {"-"*6}  {"-"*6}')
for sector, etf, chg, price, corr, ac, quad in ranked:
    bar = '█' * int(abs(chg) * 2)
    color = '\033[32m' if chg >= 0 else '\033[31m'
    print(f'  {sector:<22} {etf:>5} {price:>8.2f} {chg:>+7.2f}% {corr:>6.2f} {ac:>6.2f}  {quad:<6} {color}{bar}\033[0m')

if spy_chg is not None:
    print(f'\n  SPY benchmark: {spy_prices[-1]:.2f} ({spy_chg:>+.2f}%)')

print(f'\n  Regime: {regime} ({confidence:.0f}%) — {correlated}/{total} correlated, dispersion {dispersion:.2f}%')
print()
top = ranked[:3]
bottom = ranked[-3:]
print(f'  Rewarded: {", ".join(f"{s} ({e})" for s,e,_,_,_,_,_ in top)}')
print(f'  Punished: {", ".join(f"{s} ({e})" for s,e,_,_,_,_,_ in bottom)}')
PYEOF
    ;;

  levels-refresh)
    SYMBOL="$2"

    # Create table if not exists
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS price_levels (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        level_type TEXT NOT NULL,
        price REAL NOT NULL,
        strength INTEGER DEFAULT 1,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(symbol, level_type, price)
      );
      CREATE INDEX IF NOT EXISTS idx_price_levels_symbol ON price_levels(symbol);
    "

    echo "=== Refreshing Support/Resistance Levels ==="

    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      RESULT=$("$SCRIPT_DIR/run-ts.sh" --rw levels-refresh "$SYMBOL" 2>/dev/null)
    else
      RESULT=$("$SCRIPT_DIR/run-ts.sh" --rw levels-refresh 2>/dev/null)
    fi

    if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
      echo "Error refreshing levels." >&2
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json

data = json.load(sys.stdin)
# Handle single result or array
if isinstance(data, dict):
    data = [data]

for r in data:
    sym = r['symbol']
    price = r['currentPrice']
    n_s = len(r['support'])
    n_r = len(r['resistance'])
    print(f'  {sym:<6} \${price:>8,.2f}  {n_s}S / {n_r}R levels')

print('Done.')
"
    ;;

  levels)
    # Show support/resistance levels with risk/reward
    SYMBOL="$2"

    # Create table if not exists
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS price_levels (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, level_type TEXT NOT NULL,
      price REAL NOT NULL, strength INTEGER DEFAULT 1, source TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(symbol, level_type, price)
    );"

    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      # Detailed single-symbol view
      echo "=== Support/Resistance: $SYMBOL ==="
      LATEST_PRICE=$(sqlite3 "$DB" "
        SELECT ph.close_price FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = '$SYMBOL'
        ORDER BY ph.date DESC LIMIT 1;
      ")
      echo "  Current Price: \$$LATEST_PRICE"
      echo ""
      echo "  Resistance (above):"
      sqlite3 "$DB" "
        SELECT printf('%.2f', price), strength FROM price_levels
        WHERE symbol = '$SYMBOL' AND level_type = 'resistance'
        ORDER BY price ASC;
      " | while IFS='|' read -r price str; do
        if [ "$str" -ge 8 ]; then label="Very Strong";
        elif [ "$str" -ge 6 ]; then label="Strong";
        elif [ "$str" -ge 4 ]; then label="Moderate";
        else label="Weak"; fi
        echo "    R  \$$price  ${str}/10  ${label}"
      done
      echo ""
      echo "  Support (below):"
      sqlite3 "$DB" "
        SELECT printf('%.2f', price), strength FROM price_levels
        WHERE symbol = '$SYMBOL' AND level_type = 'support'
        ORDER BY price DESC;
      " | while IFS='|' read -r price str; do
        if [ "$str" -ge 8 ]; then label="Very Strong";
        elif [ "$str" -ge 6 ]; then label="Strong";
        elif [ "$str" -ge 4 ]; then label="Moderate";
        else label="Weak"; fi
        echo "    S  \$$price  ${str}/10  ${label}"
      done
      echo ""
      # Risk/reward
      python3 - "$DB" "$SYMBOL" "$LATEST_PRICE" <<'PYEOF'
import sqlite3, sys

db, symbol, price = sys.argv[1], sys.argv[2], float(sys.argv[3])
conn = sqlite3.connect(db)
cur = conn.cursor()

cur.execute("SELECT price FROM price_levels WHERE symbol = ? AND level_type = 'support' ORDER BY price DESC LIMIT 1", (symbol,))
s = cur.fetchone()
cur.execute("SELECT price FROM price_levels WHERE symbol = ? AND level_type = 'resistance' ORDER BY price ASC LIMIT 1", (symbol,))
r = cur.fetchone()

if s and r:
    support, resist = s[0], r[0]
    downside = price - support
    upside = resist - price
    rr = upside / downside if downside > 0 else float('inf')
    print(f'  Risk/Reward:')
    print(f'    Upside to R1:   ${upside:>8,.2f}  ({upside/price*100:>+.1f}%)')
    print(f'    Downside to S1: ${downside:>8,.2f}  ({-downside/price*100:>+.1f}%)')
    print(f'    R:R Ratio:      {rr:.2f}x', end='')
    if rr < 1: print('  ⚠️  Unfavorable')
    elif rr >= 2: print('  ✓ Favorable')
    else: print('')
elif s:
    print(f'  Nearest support: ${s[0]:,.2f} (no resistance levels found)')
elif r:
    print(f'  Nearest resistance: ${r[0]:,.2f} (no support levels found)')
else:
    print(f'  No levels computed. Run: pm-cli.sh levels-refresh {symbol}')
conn.close()
PYEOF
    else
      # All portfolio symbols summary
      echo "=== Portfolio Support/Resistance & Risk/Reward ==="
      python3 - "$DB" <<'PYEOF'
import sqlite3, sys

db = sys.argv[1]
conn = sqlite3.connect(db)
cur = conn.cursor()

# Get portfolio symbols with latest price
cur.execute('''
    SELECT DISTINCT s.symbol,
           (SELECT ph.close_price FROM price_history ph
            WHERE ph.security_id = s.id ORDER BY ph.date DESC LIMIT 1) as price
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    WHERE s.type != 'cash' AND s.symbol != ''
    ORDER BY s.symbol
''')
positions = cur.fetchall()

print(f'{"Symbol":<8} {"Price":>8} {"S1":>8} {"R1":>8} {"Downside":>9} {"Upside":>8} {"R:R":>5}  Flag')
print('-' * 72)

for symbol, price in positions:
    if not price:
        continue

    cur.execute("SELECT price FROM price_levels WHERE symbol = ? AND level_type = 'support' ORDER BY price DESC LIMIT 1", (symbol,))
    s = cur.fetchone()
    cur.execute("SELECT price FROM price_levels WHERE symbol = ? AND level_type = 'resistance' ORDER BY price ASC LIMIT 1", (symbol,))
    r = cur.fetchone()

    s1 = f'${s[0]:>7,.2f}' if s else '     —'
    r1 = f'${r[0]:>7,.2f}' if r else '     —'

    if s and r:
        downside = price - s[0]
        upside = r[0] - price
        rr = upside / downside if downside > 0 else 99
        ds_pct = f'{-downside/price*100:.1f}%'
        us_pct = f'{upside/price*100:.1f}%'
        rr_str = f'{rr:.1f}x'
        flag = '⚠️ R:R<1' if rr < 1 else ''
    else:
        ds_pct, us_pct, rr_str, flag = '—', '—', '—', 'no levels'

    print(f'{symbol:<8} ${price:>7,.2f} {s1} {r1} {ds_pct:>9} {us_pct:>8} {rr_str:>5}  {flag}')

conn.close()
PYEOF
    fi
    ;;

  sync-transactions)
    # Sync transactions from Schwab API
    # Usage: sync-transactions [days] [end-date]
    # Example: sync-transactions 180 2025-09-15
    DAYS=${2:-30}
    END_DATE=${3:-}
    schwab_ensure_token

    # Get account hashes
    echo "Fetching account numbers..."
    ACCOUNTS_RESPONSE=$(curl -s "${SCHWAB_API}/trader/v1/accounts/accountNumbers" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}")

    # Fetch and import transactions for each account
    python3 << PYEOF
import json, sys, sqlite3, uuid, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

db_path = "$DB"
access_token = "$ACCESS_TOKEN"
schwab_api = "$SCHWAB_API"
days = $DAYS

accounts = json.loads('''$ACCOUNTS_RESPONSE''')
if not isinstance(accounts, list):
    print(f"ERROR: Failed to fetch accounts: {accounts}")
    sys.exit(1)

conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Build security map
sec_map = {}
cur.execute('SELECT id, symbol FROM securities')
for row in cur.fetchall():
    sec_map[row[1]] = row[0]

# Build account map (account_number -> account_id in our DB)
acct_map = {}
cur.execute('SELECT id, account_number FROM accounts')
for row in cur.fetchall():
    acct_map[row[1]] = row[0]

end_date_str = "$END_DATE" if "$END_DATE" else ""
if end_date_str:
    end_date = datetime.strptime(end_date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
else:
    end_date = datetime.now(timezone.utc)
start_date = end_date - timedelta(days=days)
start_str = start_date.strftime('%Y-%m-%dT00:00:00.000Z')
end_str = end_date.strftime('%Y-%m-%dT23:59:59.000Z')

total_synced = 0
total_skipped = 0

for acct in accounts:
    acct_num = acct['accountNumber']
    acct_hash = acct['hashValue']
    acct_id = acct_map.get(acct_num)
    if not acct_id:
        print(f"  Skipping account {acct_num} (not in DB)")
        continue

    params = urllib.parse.urlencode({
        'startDate': start_str,
        'endDate': end_str,
        'types': 'TRADE,DIVIDEND_OR_INTEREST,RECEIVE_AND_DELIVER',
    })
    url = f"{schwab_api}/trader/v1/accounts/{acct_hash}/transactions?{params}"
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {access_token}'})
    resp = urllib.request.urlopen(req)
    txns = json.loads(resp.read())

    print(f"  Account {acct_num}: {len(txns)} transactions from Schwab")

    for txn in txns:
        items = txn.get('transferItems', [])
        if not items:
            continue

        for item in items:
            instrument = item.get('instrument', {})
            symbol = instrument.get('symbol')
            if not symbol:
                continue

            # Map transaction type
            txn_type_raw = txn.get('type', '')
            net_amount = txn.get('netAmount', 0)
            if txn_type_raw == 'TRADE':
                txn_type = 'buy' if net_amount < 0 else 'sell'
            elif txn_type_raw == 'DIVIDEND_OR_INTEREST':
                txn_type = 'dividend' if net_amount > 0 else 'interest'
            elif txn_type_raw == 'RECEIVE_AND_DELIVER':
                txn_type = 'transfer_in' if net_amount >= 0 else 'transfer_out'
            else:
                txn_type = 'transfer_in' if net_amount >= 0 else 'transfer_out'

            date_str = (txn.get('tradeDate') or txn.get('time', '')).split('T')[0]

            # Find or create security
            sec_id = sec_map.get(symbol)
            if not sec_id:
                asset_type = instrument.get('assetType', 'EQUITY')
                type_map = {'EQUITY': 'stock', 'MUTUAL_FUND': 'mutual_fund', 'ETF': 'etf',
                            'OPTION': 'option', 'FIXED_INCOME': 'bond', 'CASH_EQUIVALENT': 'cash'}
                sec_type = type_map.get(asset_type, 'other')
                sec_id = str(uuid.uuid4())
                cur.execute('INSERT INTO securities (id, symbol, name, type, currency, created_at) VALUES (?,?,?,?,?,datetime("now"))',
                    (sec_id, symbol, instrument.get('description', symbol), sec_type, 'USD'))
                sec_map[symbol] = sec_id

            # Dedup check
            cur.execute('''SELECT amount FROM transactions
                WHERE account_id = ? AND security_id = ? AND type = ? AND date = ?''',
                (acct_id, sec_id, txn_type, date_str))
            existing_amounts = [r[0] for r in cur.fetchall()]
            if any(abs(a - net_amount) < 0.01 for a in existing_amounts):
                total_skipped += 1
                continue

            qty = abs(item.get('amount', 0))
            price = item.get('price', 0)

            cur.execute('''INSERT INTO transactions (id, account_id, security_id, type, date, quantity, price, amount, fees, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,0,datetime("now"),datetime("now"))''',
                (str(uuid.uuid4()), acct_id, sec_id, txn_type, date_str, qty, price, net_amount))
            total_synced += 1

conn.commit()
conn.close()
print(f"\nSynced {total_synced} new transactions ({total_skipped} duplicates skipped)")
PYEOF
    ;;
esac
