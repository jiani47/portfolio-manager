#!/bin/bash
# CLI helper for portfolio-manager database operations
# Used by Claude Code to read/write position intents and account books

DB="$HOME/Library/Application Support/portfolio-manager/portfolio.db"

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
    # Usage: pm-cli.sh set-intent <position_id> <tier> <thesis> <invalidation> [entry_style] [hold_period]
    POS_ID="$2"; TIER="$3"; THESIS="$4"; INVAL="$5"; ENTRY="${6:-}"; HOLD="${7:-}"
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    sqlite3 "$DB" "
      INSERT OR REPLACE INTO position_intents (id, position_id, tier, thesis, invalidation, entry_style, target_hold_period, created_at, updated_at)
      VALUES (
        COALESCE((SELECT id FROM position_intents WHERE position_id = '$POS_ID'), '$ID'),
        '$POS_ID',
        $([ -n "$TIER" ] && echo "'$TIER'" || echo "NULL"),
        $([ -n "$THESIS" ] && echo "'$THESIS'" || echo "NULL"),
        $([ -n "$INVAL" ] && echo "'$INVAL'" || echo "NULL"),
        $([ -n "$ENTRY" ] && echo "'$ENTRY'" || echo "NULL"),
        $([ -n "$HOLD" ] && echo "'$HOLD'" || echo "NULL"),
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
  *)
    echo "Usage: pm-cli.sh <command>"
    echo "  positions   - List all non-cash positions with intents"
    echo "  cash        - List cash positions"
    echo "  intents     - List all position intents"
    echo "  accounts    - List accounts with book designation"
    echo "  summary     - Portfolio summary with tier coverage"
    echo "  set-intent  - Set intent: <position_id> <tier> <thesis> <invalidation> [entry_style] [hold_period]"
    echo "  set-book    - Set book: <account_id> <investing|trading>"
    ;;
esac
