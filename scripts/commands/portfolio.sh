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
    echo "=== Allocation Drift ==="
    echo ""
    # Compute portfolio total first
    PORTFOLIO_TOTAL=$(sqlite3 "$DB" "
      SELECT SUM(p.quantity * COALESCE(
        (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1),
        0
      )) FROM positions p JOIN securities s ON p.security_id = s.id WHERE s.type NOT IN ('cash','option') AND p.quantity > 0;
    ")
    printf "  %-6s  %7s  %7s  %10s  %10s  %7s  %s\n" "Symbol" "Current" "Target" "Current MV" "Target MV" "Drift" "Tier"
    printf "  %-6s  %7s  %7s  %10s  %10s  %7s  %s\n" "──────" "───────" "──────" "──────────" "─────────" "──────" "────────"
    sqlite3 "$DB" "
      SELECT s.symbol,
        printf('%.1f', pi.target_allocation_pct) as target_pct,
        printf('%.1f',
          SUM(p.quantity * COALESCE(
            (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1),
            0
          )) * 100.0 / NULLIF($PORTFOLIO_TOTAL, 0)
        ) as current_pct,
        printf('%.0f',
          SUM(p.quantity * COALESCE(
            (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1),
            0
          ))
        ) as current_mv,
        printf('%.0f', pi.target_allocation_pct * $PORTFOLIO_TOTAL / 100.0) as target_mv,
        printf('%.1f',
          SUM(p.quantity * COALESCE(
            (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1),
            0
          )) * 100.0 / NULLIF($PORTFOLIO_TOTAL, 0)
          - pi.target_allocation_pct
        ) as drift_pct,
        pi.tier
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      JOIN position_intents pi ON pi.position_id = p.id
      WHERE s.type NOT IN ('cash','option') AND p.quantity > 0 AND pi.target_allocation_pct IS NOT NULL
      GROUP BY s.symbol
      ORDER BY ABS(
        SUM(p.quantity * COALESCE(
          (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1),
          0
        )) * 100.0 / NULLIF($PORTFOLIO_TOTAL, 0)
        - pi.target_allocation_pct
      ) DESC;
    " | while IFS='|' read -r SYMBOL TARGET CURRENT CURRENT_MV TARGET_MV DRIFT TIER; do
      if [ -z "$SYMBOL" ]; then continue; fi
      ABS_DRIFT=$(echo "$DRIFT" | tr -d '-')
      if (( $(echo "$ABS_DRIFT > 3" | bc -l 2>/dev/null || echo 0) )); then
        COLOR="\033[31m"
      elif (( $(echo "$ABS_DRIFT > 1" | bc -l 2>/dev/null || echo 0) )); then
        COLOR="\033[33m"
      else
        COLOR="\033[32m"
      fi
      RESET="\033[0m"
      SIGN=""
      if (( $(echo "$DRIFT > 0" | bc -l 2>/dev/null || echo 0) )); then SIGN="+"; fi
      printf "  %-6s  %6s%%  %5s%%  \$%'9d  \$%'9d  ${COLOR}%s%s%%${RESET}  %s\n" "$SYMBOL" "$CURRENT" "$TARGET" "$CURRENT_MV" "$TARGET_MV" "$SIGN" "$DRIFT" "$TIER"
    done

    # Show positions WITHOUT a target (for awareness)
    NO_TARGET=$(sqlite3 "$DB" "
      SELECT s.symbol FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN position_intents pi ON pi.position_id = p.id
      WHERE s.type NOT IN ('cash','option') AND p.quantity > 0
        AND (pi.target_allocation_pct IS NULL)
      GROUP BY s.symbol ORDER BY s.symbol;
    ")
    if [ -n "$NO_TARGET" ]; then
      echo ""
      echo "No target set: $(echo $NO_TARGET | tr '\n' ' ')"
    fi
    ;;
esac
