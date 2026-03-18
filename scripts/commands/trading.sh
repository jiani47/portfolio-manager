#!/bin/bash
# Trading commands: buy/sell order placement, order listing, order cancellation.
# Extracted from pm-cli.sh. Requires: schwab_ensure_token, schwab_get_account_hash,
# resolve_account, pre_trade_check, SCHWAB_API, DB, ACCESS_TOKEN, TOKEN_TYPE.

case "$1" in
  buy|sell)
    ACTION=$(echo "$1" | tr '[:lower:]' '[:upper:]')
    INSTRUCTION="$ACTION"
    QTY="$2"
    SYMBOL=$(echo "$3" | tr '[:lower:]' '[:upper:]')
    ORDER_TYPE_IND="$4"

    if [ -z "$QTY" ] || [ -z "$SYMBOL" ] || [ -z "$ORDER_TYPE_IND" ]; then
      echo "Usage: pm-cli.sh buy|sell <qty> <symbol> at <price> <DAY|GTC> [account]"
      echo "       pm-cli.sh buy|sell <qty> <symbol> market <DAY|GTC> [account]"
      echo "       pm-cli.sh buy|sell <qty> <symbol> stop <price> <DAY|GTC> [account]"
      exit 1
    fi

    # Parse based on order type indicator
    case "$ORDER_TYPE_IND" in
      at)
        ORDER_TYPE="LIMIT"
        PRICE="$5"
        DURATION=$(echo "$6" | tr '[:lower:]' '[:upper:]')
        ACCT_HINT="$7"
        if [ -z "$PRICE" ] || [ -z "$DURATION" ]; then
          echo "Usage: pm-cli.sh $1 <qty> <symbol> at <price> <DAY|GTC> [account]"
          exit 1
        fi
        ;;
      market)
        ORDER_TYPE="MARKET"
        PRICE=""
        DURATION=$(echo "$5" | tr '[:lower:]' '[:upper:]')
        ACCT_HINT="$6"
        if [ -z "$DURATION" ]; then
          echo "Usage: pm-cli.sh $1 <qty> <symbol> market <DAY|GTC> [account]"
          exit 1
        fi
        ;;
      stop)
        ORDER_TYPE="STOP"
        PRICE="$5"
        DURATION=$(echo "$6" | tr '[:lower:]' '[:upper:]')
        ACCT_HINT="$7"
        if [ -z "$PRICE" ] || [ -z "$DURATION" ]; then
          echo "Usage: pm-cli.sh $1 <qty> <symbol> stop <price> <DAY|GTC> [account]"
          exit 1
        fi
        ;;
      *)
        echo "ERROR: Unknown order type '$ORDER_TYPE_IND'. Use: at, market, or stop"
        exit 1
        ;;
    esac

    # Validate duration
    if [ "$DURATION" != "DAY" ] && [ "$DURATION" != "GTC" ]; then
      echo "ERROR: Duration must be DAY or GTC (got '$DURATION')"
      exit 1
    fi

    # Resolve account
    resolve_account "$INSTRUCTION" "$SYMBOL" "$ACCT_HINT"
    if [ $? -ne 0 ]; then
      exit 1
    fi

    ACCT_NAME=$(sqlite3 "$DB" "SELECT name FROM accounts WHERE account_number LIKE '%$RESOLVED_ACCOUNT' LIMIT 1")

    # Pre-trade checklist
    pre_trade_check "$SYMBOL" "$INSTRUCTION" "$QTY" "$RESOLVED_ACCOUNT" "$PRICE" || exit 1

    # Print order summary
    echo "==============================="
    echo "  ORDER SUMMARY"
    echo "==============================="
    echo "  Action:   $INSTRUCTION"
    echo "  Symbol:   $SYMBOL"
    echo "  Quantity: $QTY"
    echo "  Type:     $ORDER_TYPE"
    if [ "$ORDER_TYPE" = "LIMIT" ]; then
      echo "  Price:    \$$PRICE"
    elif [ "$ORDER_TYPE" = "STOP" ]; then
      echo "  Stop:     \$$PRICE"
    fi
    echo "  Duration: $DURATION"
    echo "  Account:  $ACCT_NAME ($RESOLVED_ACCOUNT)"
    echo "==============================="

    # Check for --confirm flag
    CONFIRMED=0
    for arg in "$@"; do
      if [ "$arg" = "--confirm" ]; then
        CONFIRMED=1
        break
      fi
    done

    if [ "$CONFIRMED" -eq 0 ]; then
      printf "Place order? [y/N] "
      read -r REPLY
      if [ "$REPLY" != "y" ] && [ "$REPLY" != "Y" ]; then
        echo "Order cancelled."
        exit 0
      fi
    fi

    # Authenticate and get account hash
    schwab_ensure_token
    schwab_get_account_hash "$RESOLVED_ACCOUNT"
    if [ -z "$ACCOUNT_HASH" ]; then
      exit 1
    fi

    # Build order JSON
    ORDER_JSON=$(python3 -c "
import json
order = {
    'orderType': '$ORDER_TYPE',
    'session': 'NORMAL',
    'duration': '$DURATION',
    'orderStrategyType': 'SINGLE',
    'orderLegCollection': [{
        'instruction': '$INSTRUCTION',
        'quantity': $QTY,
        'instrument': {
            'symbol': '$SYMBOL',
            'assetType': 'EQUITY'
        }
    }]
}
if '$ORDER_TYPE' == 'LIMIT':
    order['price'] = '$PRICE'
elif '$ORDER_TYPE' == 'STOP':
    order['stopPrice'] = '$PRICE'
print(json.dumps(order))
")

    # Place order
    HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
      "${SCHWAB_API}/trader/v1/accounts/${ACCOUNT_HASH}/orders" \
      -H "Authorization: ${TOKEN_TYPE} ${ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$ORDER_JSON")

    HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
    HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -1)

    if [ "$HTTP_STATUS" = "201" ]; then
      echo "Order placed successfully."
    else
      echo "ERROR: Order failed (HTTP $HTTP_STATUS)"
      if [ -n "$HTTP_BODY" ]; then
        echo "$HTTP_BODY" | python3 -m json.tool 2>/dev/null || echo "$HTTP_BODY"
      fi
      exit 1
    fi
    ;;

  orders)
    schwab_ensure_token

    SHOW_ALL=0
    if [ "${2:-}" = "all" ]; then
      SHOW_ALL=1
    fi

    # Fetch account numbers
    ACCTS_JSON=$(curl -s "${SCHWAB_API}/trader/v1/accounts/accountNumbers" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}")

    python3 - "$ACCESS_TOKEN" "$SCHWAB_API" "$SHOW_ALL" "$ACCTS_JSON" <<'PYEOF'
import sys, json, urllib.request, datetime

token = sys.argv[1]
api = sys.argv[2]
show_all = sys.argv[3] == "1"
accts = json.loads(sys.argv[4])

now = datetime.datetime.now(datetime.timezone.utc)
from_date = (now - datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
to_date = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")

all_orders = []

for acct in accts:
    acct_num = acct.get("accountNumber", "")
    acct_hash = acct.get("hashValue", "")
    if not acct_hash:
        continue

    url = f"{api}/trader/v1/accounts/{acct_hash}/orders?fromEnteredTime={from_date}&toEnteredTime={to_date}"
    if not show_all:
        url += "&status=WORKING"

    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        resp = urllib.request.urlopen(req)
        orders = json.loads(resp.read())
    except Exception as e:
        print(f"Warning: failed to fetch orders for ...{acct_num[-4:]}: {e}", file=sys.stderr)
        continue

    for o in orders:
        legs = o.get("orderLegCollection", [])
        symbol = legs[0]["instrument"]["symbol"] if legs else "?"
        side = legs[0].get("instruction", "?") if legs else "?"
        qty = int(legs[0].get("quantity", 0)) if legs else 0
        filled = int(o.get("filledQuantity", 0))
        order_type = o.get("orderType", "?")
        price = o.get("price") or o.get("stopPrice") or ""
        if price:
            price = f"${float(price):.2f}"
        duration = o.get("duration", "?")
        status = o.get("status", "?")
        entered = o.get("enteredTime", "")[:19].replace("T", " ")
        order_id = str(o.get("orderId", "?"))
        all_orders.append((entered, order_id, acct_num[-4:], symbol, side, qty, filled, order_type, price, duration, status))

# Sort by entered time descending
all_orders.sort(key=lambda x: x[0], reverse=True)

if not all_orders:
    label = "open" if not show_all else ""
    print(f"No {label} orders found.")
    sys.exit(0)

# Print table
hdr = f"{'ORDER_ID':>12}  {'ACCT':>4}  {'SYMBOL':<6}  {'SIDE':<5}  {'QTY':>5}  {'FILL':>4}  {'TYPE':<6}  {'PRICE':>10}  {'DUR':<3}  {'STATUS':<12}  {'ENTERED':<19}"
print(hdr)
print("-" * len(hdr))
for row in all_orders:
    entered, oid, acct4, sym, side, qty, filled, otype, price, dur, status = row
    # Shorten side
    side_short = {"BUY": "BUY", "SELL": "SELL", "BUY_TO_COVER": "BTC", "SELL_SHORT": "SS"}.get(side, side)
    print(f"{oid:>12}  {acct4:>4}  {sym:<6}  {side_short:<5}  {qty:>5}  {filled:>4}  {otype:<6}  {price:>10}  {dur:<3}  {status:<12}  {entered:<19}")
PYEOF
    ;;

  cancel-order)
    ORDER_ID="${2:-}"
    if [ -z "$ORDER_ID" ]; then
      echo "Usage: pm-cli.sh cancel-order <orderId>"
      exit 1
    fi

    schwab_ensure_token

    # Fetch account numbers
    ACCTS_JSON=$(curl -s "${SCHWAB_API}/trader/v1/accounts/accountNumbers" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}")

    # Try DELETE on each account until one succeeds
    FOUND=0
    for ACCT_HASH in $(echo "$ACCTS_JSON" | python3 -c "import json,sys; [print(a['hashValue']) for a in json.load(sys.stdin)]" 2>/dev/null); do
      HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "${SCHWAB_API}/trader/v1/accounts/${ACCT_HASH}/orders/${ORDER_ID}" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}")
      if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "204" ]; then
        echo "Order $ORDER_ID cancelled successfully."
        FOUND=1
        break
      fi
    done

    if [ "$FOUND" -eq 0 ]; then
      echo "ERROR: Order $ORDER_ID not found or could not be cancelled."
      exit 1
    fi
    ;;
esac
