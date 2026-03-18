#!/bin/bash
# Monitor commands: monitors, monitor-add, monitor-dismiss, monitor-rm, monitor-reset, monitor-add-note, earnings

case "$1" in
  monitors)
    echo "=== Active Monitors ==="
    sqlite3 -header -column "$DB" "
      SELECT id, symbol, direction, printf('%.2f', price_level) as price,
             label, action_type, status,
             CASE WHEN triggered_at IS NOT NULL THEN substr(triggered_at, 1, 10) ELSE '' END as triggered
      FROM monitors
      WHERE status IN ('active', 'triggered')
      ORDER BY status DESC, symbol;
    "
    ;;
  monitor-add)
    SYMBOL="$2"; DIRECTION="$3"; PRICE="$4"; LABEL="$5"; ACTION_TYPE="${6:-informational}"
    if [ -z "$SYMBOL" ] || [ -z "$DIRECTION" ] || [ -z "$PRICE" ] || [ -z "$LABEL" ]; then
      echo "Usage: pm-cli.sh monitor-add <symbol> <above|below> <price> <label> [action_required]"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    if [ "$DIRECTION" != "above" ] && [ "$DIRECTION" != "below" ]; then
      echo "Direction must be 'above' or 'below'"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    sqlite3 "$DB" "INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, status, created_at, updated_at) VALUES ('$ID', '$SYMBOL', '$DIRECTION', $PRICE, '$(echo "$LABEL" | sed "s/'/''/g")', '$ACTION_TYPE', 'active', '$NOW', '$NOW');"
    echo "Monitor added: $SYMBOL $DIRECTION \$$PRICE — $LABEL [$ACTION_TYPE]"
    ;;
  monitor-dismiss)
    MON_ID="$2"
    if [ -z "$MON_ID" ]; then
      echo "Usage: pm-cli.sh monitor-dismiss <id>"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    sqlite3 "$DB" "UPDATE monitors SET status = 'dismissed', updated_at = '$NOW' WHERE id = '$MON_ID';"
    echo "Monitor dismissed: $MON_ID"
    ;;
  monitor-rm)
    MON_ID="$2"
    if [ -z "$MON_ID" ]; then
      echo "Usage: pm-cli.sh monitor-rm <id>"
      exit 1
    fi
    sqlite3 "$DB" "DELETE FROM monitors WHERE id = '$MON_ID';"
    echo "Monitor deleted: $MON_ID"
    ;;
  monitor-reset)
    MON_ID="$2"
    if [ -z "$MON_ID" ]; then
      echo "Usage: pm-cli.sh monitor-reset <id>"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    sqlite3 "$DB" "UPDATE monitors SET status = 'active', triggered_at = NULL, updated_at = '$NOW' WHERE id = '$MON_ID';"
    echo "Monitor re-armed: $MON_ID"
    ;;

  monitor-add-note)
    MON_SYMBOL="$2"
    MON_LABEL="$3"
    MON_REMINDER="$4"
    if [ -z "$MON_SYMBOL" ] || [ -z "$MON_LABEL" ]; then
      echo "Usage: pm-cli.sh monitor-add-note <symbol> <label> [reminder_date]"
      echo "  Creates a fundamental/note monitor (no price trigger)"
      echo "  reminder_date: YYYY-MM-DD (default: today)"
      exit 1
    fi
    MON_SYMBOL=$(echo "$MON_SYMBOL" | tr '[:lower:]' '[:upper:]')
    if [ -z "$MON_REMINDER" ]; then
      MON_REMINDER=$(date +%Y-%m-%d)
    fi
    MON_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    sqlite3 "$DB" "INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, monitor_type, status, reminder_date, created_at, updated_at) VALUES ('$MON_ID', '$MON_SYMBOL', 'below', 0, '$MON_LABEL', 'informational', 'fundamental', 'active', '$MON_REMINDER', '$NOW', '$NOW');"
    echo "Fundamental monitor created: $MON_SYMBOL — $MON_LABEL (reminder: $MON_REMINDER)"
    ;;

  earnings)
    # Show upcoming earnings for portfolio symbols
    DAYS="${2:-14}"
    FROM_DATE=$(date +%Y-%m-%d)
    TO_DATE=$(date -v+${DAYS}d +%Y-%m-%d 2>/dev/null || date -d "+${DAYS} days" +%Y-%m-%d 2>/dev/null)

    # Get FMP API key
    if [ -f "$HOME/.pm-cli.conf" ]; then
      FMP_KEY=$(grep '^FMP_API_KEY=' "$HOME/.pm-cli.conf" | cut -d= -f2)
    fi
    if [ -z "$FMP_KEY" ]; then
      echo "ERROR: FMP_API_KEY not set in ~/.pm-cli.conf"
      exit 1
    fi

    # Get portfolio symbols (comma-separated for safe passing)
    SYMBOLS=$(sqlite3 "$DB" "SELECT GROUP_CONCAT(DISTINCT s.symbol) FROM positions p JOIN securities s ON p.security_id = s.id WHERE s.type != 'cash' AND p.quantity > 0;")

    echo "=== Upcoming Earnings (next ${DAYS} days) ==="
    echo ""

    # Fetch earnings calendar from FMP
    python3 <<PYEOF
import urllib.request, json, sys

fmp_key = "$FMP_KEY"
from_date = "$FROM_DATE"
to_date = "$TO_DATE"
symbols_csv = "$SYMBOLS"
portfolio_symbols = set(symbols_csv.split(',')) if symbols_csv else set()

if not portfolio_symbols:
    print("No portfolio positions found.")
    sys.exit(0)

url = f"https://financialmodelingprep.com/stable/earnings-calendar?from={from_date}&to={to_date}&apikey={fmp_key}"
try:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
except Exception as e:
    print(f"Error fetching earnings: {e}")
    sys.exit(1)

# Filter to portfolio symbols
matches = [e for e in data if e.get('symbol', '').upper() in portfolio_symbols]

if not matches:
    print("No upcoming earnings for portfolio symbols.")
    sys.exit(0)

matches.sort(key=lambda x: x.get('date', ''))
print(f"{'Date':<12} {'Symbol':<8} {'Time':<14} {'EPS Est':>10}")
print("-" * 46)
for e in matches:
    date = e.get('date', 'N/A')
    symbol = e.get('symbol', 'N/A')
    time_raw = e.get('time', '')
    if time_raw == 'bmo':
        time_label = 'Before Open'
    elif time_raw == 'amc':
        time_label = 'After Close'
    else:
        time_label = time_raw or 'TBD'
    eps_est = e.get('epsEstimated')
    eps_str = f"  \${eps_est:.2f}" if eps_est is not None else '       N/A'
    print(f"{date:<12} {symbol:<8} {time_label:<14} {eps_str:>10}")
PYEOF
    ;;
esac
