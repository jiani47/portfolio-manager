#!/bin/bash
# Watchlist commands: watchlists, watchlist, watchlist-add, watchlist-rm, watchlist-create, watchlist-delete

case "$1" in
  watchlists)
    sqlite3 -header -column "$DB" "
      SELECT w.id, w.name, w.description,
             COUNT(wi.id) as items
      FROM watchlists w
      LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
      GROUP BY w.id
      ORDER BY w.name;
    "
    ;;
  watchlist)
    WL_NAME="$2"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist <name>"
      "$0" watchlists
      exit 0
    fi
    LATEST_DATE=$(sqlite3 "$DB" "SELECT MAX(date) FROM price_history;")
    sqlite3 "$DB" "
      SELECT wi.symbol,
             printf('%.2f', ph.close_price) as price,
             printf('%.2f', COALESCE(wi.target_entry_price, 0)) as target_entry,
             CASE WHEN wi.target_entry_price IS NOT NULL AND ph.close_price IS NOT NULL
               THEN printf('%.1f%%', (ph.close_price - wi.target_entry_price) / wi.target_entry_price * 100)
               ELSE '' END as vs_target,
             wi.thesis_snippet,
             wi.notes
      FROM watchlist_items wi
      JOIN watchlists w ON wi.watchlist_id = w.id
      LEFT JOIN securities s ON wi.security_id = s.id
      LEFT JOIN price_history ph ON ph.security_id = s.id AND ph.date = '$LATEST_DATE'
      WHERE w.name = '$WL_NAME'
      ORDER BY wi.symbol;
    " | python3 -c "
import sys
print(f'=== Watchlist: $WL_NAME ===')
print(f'{\"Symbol\":<8} {\"Price\":>8} {\"Target\":>8} {\"vs Tgt\":>8}  Thesis')
print('-' * 70)
for line in sys.stdin:
    parts = line.strip().split('|')
    if len(parts) < 6: continue
    sym, price, target, vs_tgt, thesis, notes = parts
    price_str = f'\${float(price):>.2f}' if price and float(price) > 0 else '—'
    target_str = f'\${float(target):>.2f}' if target and float(target) > 0 else '—'
    thesis_str = (thesis[:40] + '..') if len(thesis) > 42 else thesis
    print(f'{sym:<8} {price_str:>8} {target_str:>8} {vs_tgt:>8}  {thesis_str}')
" 2>/dev/null
    ;;
  watchlist-add)
    WL_NAME="$2"; SYMBOL="$3"; TARGET="$4"; THESIS="$5"
    if [ -z "$WL_NAME" ] || [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh watchlist-add <watchlist_name> <symbol> [target_entry] [thesis_snippet]"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:lower:]' '[:upper:]' | tr '[:upper:]' '[:lower:]')

    # Get or create watchlist
    WL_ID=$(sqlite3 "$DB" "SELECT id FROM watchlists WHERE name = '$(echo "$WL_NAME" | sed "s/'/''/g")';")
    if [ -z "$WL_ID" ]; then
      WL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
      sqlite3 "$DB" "INSERT INTO watchlists (id, name, created_at, updated_at) VALUES ('$WL_ID', '$(echo "$WL_NAME" | sed "s/'/''/g")', '$NOW', '$NOW');"
      echo "Created watchlist: $WL_NAME"
    fi

    # Ensure security exists
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL';")
    if [ -z "$SEC_ID" ]; then
      SEC_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
      sqlite3 "$DB" "INSERT INTO securities (id, symbol, name, type, currency, created_at) VALUES ('$SEC_ID', '$SYMBOL', '$SYMBOL', 'stock', 'USD', '$NOW');"
    fi

    # Insert item (upsert)
    sqlite3 "$DB" "
      INSERT OR REPLACE INTO watchlist_items (id, watchlist_id, symbol, security_id, target_entry_price, thesis_snippet, created_at, updated_at)
      VALUES (
        COALESCE((SELECT id FROM watchlist_items WHERE watchlist_id = '$WL_ID' AND symbol = '$SYMBOL'), '$ID'),
        '$WL_ID', '$SYMBOL', '$SEC_ID',
        $([ -n "$TARGET" ] && echo "$TARGET" || echo "NULL"),
        $([ -n "$THESIS" ] && echo "'$(echo "$THESIS" | sed "s/'/''/g")'" || echo "NULL"),
        COALESCE((SELECT created_at FROM watchlist_items WHERE watchlist_id = '$WL_ID' AND symbol = '$SYMBOL'), '$NOW'),
        '$NOW'
      );
    "
    echo "Added $SYMBOL to $WL_NAME$([ -n "$TARGET" ] && echo " (target: \$$TARGET)")"
    ;;
  watchlist-rm)
    WL_NAME="$2"; SYMBOL="$3"
    if [ -z "$WL_NAME" ] || [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh watchlist-rm <watchlist_name> <symbol>"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
    sqlite3 "$DB" "
      DELETE FROM watchlist_items WHERE symbol = '$SYMBOL'
      AND watchlist_id = (SELECT id FROM watchlists WHERE name = '$(echo "$WL_NAME" | sed "s/'/''/g")');
    "
    echo "Removed $SYMBOL from $WL_NAME"
    ;;
  watchlist-create)
    WL_NAME="$2"; DESC="$3"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist-create <name> [description]"
      exit 1
    fi
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    sqlite3 "$DB" "INSERT INTO watchlists (id, name, description, created_at, updated_at) VALUES ('$ID', '$(echo "$WL_NAME" | sed "s/'/''/g")', $([ -n "$DESC" ] && echo "'$(echo "$DESC" | sed "s/'/''/g")'" || echo "NULL"), '$NOW', '$NOW');"
    echo "Created watchlist: $WL_NAME"
    ;;
  watchlist-delete)
    WL_NAME="$2"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist-delete <name>"
      exit 1
    fi
    sqlite3 "$DB" "DELETE FROM watchlists WHERE name = '$(echo "$WL_NAME" | sed "s/'/''/g")';"
    echo "Deleted watchlist: $WL_NAME"
    ;;
esac
