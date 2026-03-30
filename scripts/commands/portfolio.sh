#!/bin/bash
# Portfolio commands: positions, cash, intents, set-intent, set-book, accounts, summary, drift

case "$1" in
  positions)
    sqlite3 -header -column "$DB" "
      SELECT p.id as position_id, s.symbol, s.name as security_name,
             a.name as account, a.book,
             printf('%.2f', p.quantity) as qty,
             printf('%.2f', p.cost_basis) as cost_basis,
             printf('%.2f', COALESCE(p.market_value, 0)) as market_value,
             s.sector, s.type as sec_type,
             pi.tier, pi.thesis, pi.invalidation, pi.target_hold_period
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN accounts a ON p.account_id = a.id
      LEFT JOIN position_intents pi ON pi.position_id = p.id
      WHERE s.type != 'cash'
      ORDER BY COALESCE(p.market_value, 0) DESC;
    "
    ;;
  cash)
    sqlite3 -header -column "$DB" "
      SELECT a.name as account, printf('%.2f', p.quantity) as amount
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN accounts a ON p.account_id = a.id
      WHERE s.type = 'cash';
    "
    ;;
  intents)
    sqlite3 -header -column "$DB" "
      SELECT s.symbol, pi.tier, pi.thesis, pi.invalidation, pi.entry_style, pi.target_hold_period
      FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      JOIN securities s ON p.security_id = s.id
      ORDER BY pi.tier, s.symbol;
    "
    ;;
  set-intent)
    # Usage: pm-cli.sh set-intent <position_id> <tier> <thesis> <invalidation> [entry_style] [hold_period] [target_alloc_pct]
    POS_ID="$2"; TIER="$3"; THESIS="$4"; INVAL="$5"; ENTRY="${6:-}"; HOLD="${7:-}"; TARGET_ALLOC="${8:-}"
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    TODAY=$(date +"%Y-%m-%d")

    # Log changes if intent already exists
    OLD_TIER=$(sqlite3 "$DB" "SELECT tier FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_THESIS=$(sqlite3 "$DB" "SELECT thesis FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_INVAL=$(sqlite3 "$DB" "SELECT invalidation FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_ENTRY=$(sqlite3 "$DB" "SELECT entry_style FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_HOLD=$(sqlite3 "$DB" "SELECT target_hold_period FROM position_intents WHERE position_id = '$POS_ID';")
    OLD_TARGET_ALLOC=$(sqlite3 "$DB" "SELECT target_allocation_pct FROM position_intents WHERE position_id = '$POS_ID';")

    log_change() {
      local FIELD="$1" OLD="$2" NEW="$3"
      if [ "$OLD" != "$NEW" ] && [ -n "$NEW" -o -n "$OLD" ]; then
        local LOG_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
        local RITUAL_DATE=$(sqlite3 "$DB" "SELECT date FROM daily_rituals WHERE date = '$TODAY';")
        sqlite3 "$DB" "INSERT INTO position_intent_change_logs (id, position_id, ritual_date, field_changed, old_value, new_value, created_at) VALUES ('$LOG_ID', '$POS_ID', $([ -n "$RITUAL_DATE" ] && echo "'$RITUAL_DATE'" || echo "NULL"), '$FIELD', $([ -n "$OLD" ] && echo "'$OLD'" || echo "NULL"), $([ -n "$NEW" ] && echo "'$NEW'" || echo "NULL"), '$NOW');"
      fi
    }

    log_change "tier" "$OLD_TIER" "$TIER"
    log_change "thesis" "$OLD_THESIS" "$THESIS"
    log_change "invalidation" "$OLD_INVAL" "$INVAL"
    [ -n "$ENTRY" ] && log_change "entry_style" "$OLD_ENTRY" "$ENTRY"
    [ -n "$HOLD" ] && log_change "target_hold_period" "$OLD_HOLD" "$HOLD"
    [ -n "$TARGET_ALLOC" ] && log_change "target_allocation_pct" "$OLD_TARGET_ALLOC" "$TARGET_ALLOC"

    sqlite3 "$DB" "
      INSERT OR REPLACE INTO position_intents (id, position_id, tier, thesis, invalidation, entry_style, target_hold_period, target_allocation_pct, created_at, updated_at)
      VALUES (
        COALESCE((SELECT id FROM position_intents WHERE position_id = '$POS_ID'), '$ID'),
        '$POS_ID',
        $([ -n "$TIER" ] && echo "'$TIER'" || echo "NULL"),
        $([ -n "$THESIS" ] && echo "'$THESIS'" || echo "NULL"),
        $([ -n "$INVAL" ] && echo "'$INVAL'" || echo "NULL"),
        $([ -n "$ENTRY" ] && echo "'$ENTRY'" || echo "NULL"),
        $([ -n "$HOLD" ] && echo "'$HOLD'" || echo "NULL"),
        $([ -n "$TARGET_ALLOC" ] && echo "$TARGET_ALLOC" || echo "COALESCE((SELECT target_allocation_pct FROM position_intents WHERE position_id = '$POS_ID'), NULL)"),
        COALESCE((SELECT created_at FROM position_intents WHERE position_id = '$POS_ID'), '$NOW'),
        '$NOW'
      );
    "
    echo "Intent set for position $POS_ID"
    ;;
  set-book)
    # Usage: pm-cli.sh set-book <account_id> <investing|trading>
    sqlite3 "$DB" "UPDATE accounts SET book = '$3', updated_at = '$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")' WHERE id = '$2';"
    echo "Book set for account $2"
    ;;
  accounts)
    sqlite3 -header -column "$DB" "SELECT id, name, broker, account_type, book FROM accounts;"
    ;;
  summary)
    echo "=== Portfolio Summary ==="
    sqlite3 -header -column "$DB" "
      SELECT
        a.name as account,
        a.book,
        COUNT(CASE WHEN s.type != 'cash' THEN 1 END) as positions,
        printf('%.2f', SUM(CASE WHEN s.type != 'cash' THEN COALESCE(p.market_value, 0) ELSE 0 END)) as equity_value,
        printf('%.2f', SUM(CASE WHEN s.type = 'cash' THEN p.quantity ELSE 0 END)) as cash
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN accounts a ON p.account_id = a.id
      GROUP BY a.id;
    "
    echo ""
    echo "=== Tier Coverage ==="
    sqlite3 -header -column "$DB" "
      SELECT
        COUNT(*) as total_positions,
        SUM(CASE WHEN pi.tier IS NOT NULL THEN 1 ELSE 0 END) as with_tier,
        SUM(CASE WHEN pi.thesis IS NOT NULL THEN 1 ELSE 0 END) as with_thesis
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN position_intents pi ON pi.position_id = p.id
      WHERE s.type != 'cash';
    "
    ;;
  drift)
    RESULT=$("$SCRIPT_DIR/run-ts.sh" drift 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
      echo "Error computing drift. Check run-ts.sh drift for details." >&2
      exit 1
    fi
    echo "=== Allocation Drift ==="
    echo ""
    printf "  %-6s  %7s  %7s  %10s  %10s  %7s  %s\n" "Symbol" "Current" "Target" "Current MV" "Target MV" "Drift" "Tier"
    printf "  %-6s  %7s  %7s  %10s  %10s  %7s  %s\n" "──────" "───────" "──────" "──────────" "─────────" "──────" "────────"
    echo "$RESULT" | python3 -c "
import sys, json

rows = json.load(sys.stdin)
with_target = [r for r in rows if r['targetPct'] is not None and r['driftPct'] is not None]
no_target = [r for r in rows if r['targetPct'] is None]

with_target.sort(key=lambda r: abs(r['driftPct']), reverse=True)

for r in with_target:
    drift = r['driftPct']
    abs_drift = abs(drift)
    if abs_drift > 3:
        color = '\033[31m'
    elif abs_drift > 1:
        color = '\033[33m'
    else:
        color = '\033[32m'
    reset = '\033[0m'
    sign = '+' if drift > 0 else ''
    print(f'  {r[\"symbol\"]:<6}  {r[\"currentPct\"]:>6.1f}%  {r[\"targetPct\"]:>5.1f}%  \${r[\"marketValue\"]:>9,.0f}  \${r[\"targetMarketValue\"]:>9,.0f}  {color}{sign}{drift:.1f}%{reset}  {r[\"tier\"]}')

if no_target:
    symbols = ' '.join(r['symbol'] for r in no_target if r['symbol'] != 'Cash')
    if symbols:
        print()
        print(f'No target set: {symbols}')
"
    ;;
esac
