#!/bin/bash
# Watchlist commands: watchlists, watchlist, watchlist-add, watchlist-rm, watchlist-create, watchlist-delete
# Delegates to TypeScript CLI for typed queries and mutations

TS_CLI="$REPO_ROOT/src/cli/index.ts"
TSX="npx tsx"

case "$1" in
  watchlists)
    $TSX "$TS_CLI" --rw watchlist list 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('command') == 'list' and 'data' in data:
        watchlists = data['data']
        if not watchlists:
            print('No watchlists found.')
        else:
            print(f'{\"Name\":<20} {\"Items\":>6}  Description')
            print('-' * 60)
            for w in watchlists:
                name = w['name'][:20]
                count = w['itemCount']
                desc = (w.get('description') or '')[:35]
                print(f'{name:<20} {count:>6}  {desc}')
except:
    pass
"
    ;;
  watchlist)
    WL_NAME="$2"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist <name>"
      $TSX "$TS_CLI" --rw watchlist list 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('command') == 'list':
        for w in data['data']:
            print(w['name'])
except:
    pass
"
      exit 0
    fi
    $TSX "$TS_CLI" --rw watchlist show "$WL_NAME" 2>/dev/null | python3 -c "
import sys, json
WL_NAME = '$WL_NAME'
try:
    data = json.load(sys.stdin)
    if data.get('command') == 'show' and 'data' in data:
        w = data['data']
        print(f'=== Watchlist: {w[\"name\"]} ===')
        if w.get('description'):
            print(f'{w[\"description\"]}\\n')
        items = w.get('items', [])
        if not items:
            print('No items in this watchlist.')
        else:
            print(f'{\"Symbol\":<8} {\"Price\":>8} {\"Target\":>8} {\"vs Tgt\":>8}  Thesis')
            print('-' * 70)
            for item in items:
                sym = item['symbol']
                price = f\"\\\${item['price']:.2f}\" if item.get('price') is not None else '—'
                target = f\"\\\${item['targetEntryPrice']:.2f}\" if item.get('targetEntryPrice') is not None else '—'
                vs_tgt = f\"{item['vsTargetPct']:+.1f}%\" if item.get('vsTargetPct') is not None else ''
                thesis = (item.get('thesisSnippet') or '')[:40]
                if len(item.get('thesisSnippet') or '') > 42:
                    thesis += '..'
                print(f'{sym:<8} {price:>8} {target:>8} {vs_tgt:>8}  {thesis}')
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    pass
"
    ;;
  watchlist-add)
    WL_NAME="$2"; SYMBOL="$3"; TARGET="$4"; THESIS="$5"
    if [ -z "$WL_NAME" ] || [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh watchlist-add <watchlist_name> <symbol> [target_entry] [thesis_snippet]"
      exit 1
    fi
    $TSX "$TS_CLI" --rw watchlist add "$WL_NAME" "$SYMBOL" ${TARGET:+"$TARGET"} ${THESIS:+"$THESIS"} 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('command') == 'add' and 'data' in data:
        print(data['data']['message'])
except:
    pass
"
    ;;
  watchlist-rm)
    WL_NAME="$2"; SYMBOL="$3"
    if [ -z "$WL_NAME" ] || [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh watchlist-rm <watchlist_name> <symbol>"
      exit 1
    fi
    $TSX "$TS_CLI" --rw watchlist remove "$WL_NAME" "$SYMBOL" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('command') == 'remove' and 'data' in data:
        print(data['data']['message'])
except:
    pass
"
    ;;
  watchlist-create)
    WL_NAME="$2"; DESC="$3"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist-create <name> [description]"
      exit 1
    fi
    $TSX "$TS_CLI" --rw watchlist create "$WL_NAME" ${DESC:+"$DESC"} 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('command') == 'create' and 'data' in data:
        print(data['data']['message'])
except:
    pass
"
    ;;
  watchlist-delete)
    WL_NAME="$2"
    if [ -z "$WL_NAME" ]; then
      echo "Usage: pm-cli.sh watchlist-delete <name>"
      exit 1
    fi
    $TSX "$TS_CLI" --rw watchlist delete "$WL_NAME" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('command') == 'delete' and 'data' in data:
        print(data['data']['message'])
except:
    pass
"
    ;;
esac
