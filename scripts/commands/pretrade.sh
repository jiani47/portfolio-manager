#!/bin/bash
# Pre-trade validation functions for pm-cli

# Pre-trade checklist functions
check_regime_read() {
  local today=$(date +%Y-%m-%d)
  local regime=$(sqlite3 "$DB" "SELECT regime_type FROM daily_rituals WHERE date='$today'" 2>/dev/null)
  if [ -n "$regime" ]; then
    echo "  ✓ PASS: Regime read done ($regime day)"
  else
    echo "  ✗ FAIL: No regime read recorded for today"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_sorting_day() {
  local today=$(date +%Y-%m-%d)
  local regime=$(sqlite3 "$DB" "SELECT regime_type FROM daily_rituals WHERE date='$today'" 2>/dev/null)
  if [ "$regime" = "sorting" ]; then
    echo "  ⚠ WARN: Sorting day — adds typically disabled"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: Not a sorting day"
  fi
  return 0
}

check_intent_exists() {
  local symbol="$1"
  local tier=$(sqlite3 "$DB" "SELECT pi.tier FROM position_intents pi JOIN positions p ON pi.position_id=p.id JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol' LIMIT 1" 2>/dev/null)
  if [ -n "$tier" ]; then
    echo "  ✓ PASS: Intent assigned ($tier)"
  else
    echo "  ✗ FAIL: No tier assigned"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_thesis() {
  local symbol="$1"
  local thesis=$(sqlite3 "$DB" "SELECT pi.thesis FROM position_intents pi JOIN positions p ON pi.position_id=p.id JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol' AND pi.thesis IS NOT NULL AND pi.thesis != '' LIMIT 1" 2>/dev/null)
  if [ -n "$thesis" ]; then
    echo "  ✓ PASS: Thesis documented"
  else
    echo "  ✗ FAIL: No thesis in position intent"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_invalidation() {
  local symbol="$1"
  local inv=$(sqlite3 "$DB" "SELECT pi.invalidation FROM position_intents pi JOIN positions p ON pi.position_id=p.id JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol' AND pi.invalidation IS NOT NULL AND pi.invalidation != '' LIMIT 1" 2>/dev/null)
  if [ -n "$inv" ]; then
    echo "  ✓ PASS: Invalidation defined"
  else
    echo "  ✗ FAIL: No invalidation conditions"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_reentry_cooldown() {
  local symbol="$1"
  local last_sell=$(sqlite3 "$DB" "SELECT MAX(t.date) FROM transactions t JOIN securities s ON t.security_id=s.id WHERE s.symbol='$symbol' AND t.type='sell'" 2>/dev/null)
  if [ -n "$last_sell" ] && [ "$last_sell" != "" ]; then
    local days_ago=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$last_sell" +%s 2>/dev/null || echo 0)) / 86400 ))
    if [ "$days_ago" -lt 14 ] 2>/dev/null; then
      local wait_days=$((14 - days_ago))
      echo "  ✗ BLOCKED: Re-entry cooldown — you sold $symbol ${days_ago}d ago (last: $last_sell)"
      echo "             Re-entries within 14d are premature 70% of the time. Wait ${wait_days} more days."
      return 1
    else
      echo "  ✓ PASS: Re-entry cooldown clear (${days_ago}d since last sell)"
    fi
  else
    echo "  ✓ PASS: Re-entry cooldown (no prior sells)"
  fi
  return 0
}

check_rapid_flip() {
  local symbol="$1" side="$2" sell_price="${3:-0}"
  if [ "$side" = "buy" ]; then
    local last_sell=$(sqlite3 "$DB" "SELECT MAX(t.date) FROM transactions t JOIN securities s ON t.security_id=s.id WHERE s.symbol='$symbol' AND t.type='sell'" 2>/dev/null)
    if [ -n "$last_sell" ] && [ "$last_sell" != "" ]; then
      local days_ago=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$last_sell" +%s 2>/dev/null || echo 0)) / 86400 ))
      if [ "$days_ago" -le 5 ] 2>/dev/null; then
        echo "  ⚠ WARN: Rapid flip — sold $symbol ${days_ago}d ago, now buying back"
        echo "          <5d round-trips have 27-31% win rate on conviction names."
        read -p "    Override? (y/n): " ov
        [ "$ov" != "y" ] && return 1
      fi
    fi
  else
    local last_buy=$(sqlite3 "$DB" "SELECT MAX(t.date) FROM transactions t JOIN securities s ON t.security_id=s.id WHERE s.symbol='$symbol' AND t.type='buy'" 2>/dev/null)
    if [ -n "$last_buy" ] && [ "$last_buy" != "" ]; then
      local days_ago=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$last_buy" +%s 2>/dev/null || echo 0)) / 86400 ))
      if [ "$days_ago" -le 5 ] 2>/dev/null; then
        # Only warn if materializing a loss
        local avg_cost=$(sqlite3 "$DB" "SELECT CASE WHEN p.quantity > 0 THEN p.cost_basis / p.quantity ELSE 0 END FROM positions p JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol' LIMIT 1" 2>/dev/null)
        if [ -n "$avg_cost" ] && [ "$sell_price" != "0" ]; then
          local is_loss=$(python3 -c "print(1 if $sell_price < $avg_cost else 0)" 2>/dev/null)
          if [ "$is_loss" = "1" ]; then
            echo "  ⚠ WARN: Rapid flip at a loss — bought $symbol ${days_ago}d ago (avg cost \$$avg_cost, selling at \$$sell_price)"
            echo "          Your 90d+ holds have 57% win rate vs 33% for <30d."
            read -p "    Override? (y/n): " ov
            [ "$ov" != "y" ] && return 1
          fi
        fi
      fi
    fi
  fi
  echo "  ✓ PASS: No rapid flip detected"
  return 0
}

check_sr_levels() {
  local symbol="$1" side="$2" price="${3:-0}"

  # Get current price if not provided
  if [ "$price" = "0" ]; then
    price=$(sqlite3 "$DB" "SELECT ph.close_price FROM price_history ph JOIN securities s ON ph.security_id=s.id WHERE s.symbol='$symbol' ORDER BY ph.date DESC LIMIT 1" 2>/dev/null)
  fi
  [ -z "$price" ] && { echo "  ✓ PASS: S/R check (no price data)"; return 0; }

  # Get levels
  local levels=$(sqlite3 -separator '|' "$DB" "SELECT level_type, price, strength FROM price_levels WHERE symbol='$symbol' ORDER BY price" 2>/dev/null)
  if [ -z "$levels" ]; then
    echo "  ✓ PASS: S/R check (no levels computed)"
    return 0
  fi

  # Display S/R context
  echo "  ── S/R Levels for $symbol (price: \$$price) ──"
  echo "$levels" | while IFS='|' read -r LTYPE LPRICE LSTR; do
    local pct=$(python3 -c "print(f'{abs(($LPRICE - $price) / $price * 100):.1f}')" 2>/dev/null)
    if [ "$LTYPE" = "resistance" ]; then
      echo "    R: \$$LPRICE (strength $LSTR) — ${pct}% away"
    else
      echo "    S: \$$LPRICE (strength $LSTR) — ${pct}% away"
    fi
  done

  # Check proximity warnings
  if [ "$side" = "BUY" ] || [ "$side" = "buy" ]; then
    # Nearest resistance above
    local nearest_r=$(sqlite3 -separator '|' "$DB" "SELECT price, strength FROM price_levels WHERE symbol='$symbol' AND level_type='resistance' AND price > $price ORDER BY price ASC LIMIT 1" 2>/dev/null)
    if [ -n "$nearest_r" ]; then
      local r_price=$(echo "$nearest_r" | cut -d'|' -f1)
      local r_str=$(echo "$nearest_r" | cut -d'|' -f2)
      local pct_away=$(python3 -c "print(f'{($r_price - $price) / $price * 100:.1f}')" 2>/dev/null)
      if python3 -c "exit(0 if float('$pct_away') < 3 else 1)" 2>/dev/null; then
        echo "  ⚠ WARN: Buying within ${pct_away}% of resistance at \$$r_price (strength $r_str)"
        read -p "    Override? (y/n): " ov
        [ "$ov" != "y" ] && return 1
      fi
    fi
  else
    # Nearest support below
    local nearest_s=$(sqlite3 -separator '|' "$DB" "SELECT price, strength FROM price_levels WHERE symbol='$symbol' AND level_type='support' AND price < $price ORDER BY price DESC LIMIT 1" 2>/dev/null)
    if [ -n "$nearest_s" ]; then
      local s_price=$(echo "$nearest_s" | cut -d'|' -f1)
      local s_str=$(echo "$nearest_s" | cut -d'|' -f2)
      local pct_away=$(python3 -c "print(f'{($price - $s_price) / $price * 100:.1f}')" 2>/dev/null)
      if python3 -c "exit(0 if float('$pct_away') < 3 else 1)" 2>/dev/null; then
        echo "  ⚠ WARN: Selling within ${pct_away}% of support at \$$s_price (strength $s_str)"
        read -p "    Override? (y/n): " ov
        [ "$ov" != "y" ] && return 1
      fi
    fi
  fi
  return 0
}

check_gap_up() {
  local symbol="$1"

  # Get last 6 trading days of price history
  local prices=$(sqlite3 -separator '|' "$DB" "
    SELECT date, open_price, close_price FROM price_history ph
    JOIN securities s ON ph.security_id=s.id
    WHERE s.symbol='$symbol' AND ph.open_price IS NOT NULL
    ORDER BY ph.date DESC LIMIT 6
  " 2>/dev/null)

  [ -z "$prices" ] && { echo "  ✓ PASS: Gap-up check (no price data)"; return 0; }

  # Reverse to chronological order and check consecutive days
  local reversed=$(echo "$prices" | tail -r 2>/dev/null || echo "$prices" | tac 2>/dev/null || echo "$prices")
  local prev_close=""
  local gap_found=0
  local gap_date="" gap_pct=""

  while IFS='|' read -r pdate popen pclose; do
    if [ -n "$prev_close" ] && [ -n "$popen" ]; then
      local gpct=$(python3 -c "
pc = float('$prev_close')
if pc > 0:
    print(f'{($popen - pc) / pc * 100:.1f}')
else:
    print('0')
" 2>/dev/null)
      if python3 -c "exit(0 if float('$gpct') > 5 else 1)" 2>/dev/null; then
        gap_found=1
        gap_date="$pdate"
        gap_pct="$gpct"
        break
      fi
    fi
    prev_close="$pclose"
  done <<< "$reversed"

  if [ "$gap_found" = "1" ]; then
    echo "  ⚠ WARN: $symbol gapped up ${gap_pct}% on $gap_date — mean reversion risk elevated"
    # Show nearest resistance
    local latest_close=$(echo "$prices" | head -1 | cut -d'|' -f3)
    if [ -n "$latest_close" ]; then
      local nearest_r=$(sqlite3 -separator '|' "$DB" "SELECT price, strength FROM price_levels WHERE symbol='$symbol' AND level_type='resistance' AND price > $latest_close ORDER BY price ASC LIMIT 1" 2>/dev/null)
      if [ -n "$nearest_r" ]; then
        local r_price=$(echo "$nearest_r" | cut -d'|' -f1)
        local r_str=$(echo "$nearest_r" | cut -d'|' -f2)
        local dist_pct=$(python3 -c "print(f'{($r_price - $latest_close) / $latest_close * 100:.1f}')" 2>/dev/null)
        echo "          Nearest resistance: \$$r_price (strength $r_str, ${dist_pct}% away)"
      fi
    fi
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: No recent gap-up detected"
  fi
  return 0
}

check_thesis_file() {
  local symbol="$1" book="$2"
  local PROJ_ROOT
  PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
  local thesis_path="$PROJ_ROOT/docs/positions/$(echo "$symbol" | tr '[:lower:]' '[:upper:]')/thesis.md"

  if [ -f "$thesis_path" ]; then
    echo "  ✓ PASS: Thesis doc exists"
    return 0
  fi

  if [ "$book" = "investing" ]; then
    echo "  ✗ FAIL: Thesis doc missing — required for investment positions"
    echo "          Create docs/positions/$(echo "$symbol" | tr '[:lower:]' '[:upper:]')/thesis.md first."
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ⚠ WARN: No thesis doc — confirm this is a pure technical/momentum trade"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_panic_sell() {
  local symbol="$1" price="${2:-0}"

  # Get current and previous close
  local prices=$(sqlite3 -separator '|' "$DB" "
    SELECT close_price FROM price_history ph
    JOIN securities s ON ph.security_id=s.id
    WHERE s.symbol='$symbol'
    ORDER BY ph.date DESC LIMIT 2
  " 2>/dev/null)

  local current_close=$(echo "$prices" | head -1)
  local prev_close=$(echo "$prices" | tail -1)

  [ -z "$current_close" ] || [ -z "$prev_close" ] && { echo "  ✓ PASS: Panic sell check (no price data)"; return 0; }

  local is_red=$(python3 -c "print(1 if float('$current_close') < float('$prev_close') else 0)" 2>/dev/null)
  [ "$is_red" != "1" ] && { echo "  ✓ PASS: Not a red day"; return 0; }

  # Check if near support
  local use_price="$price"
  [ "$use_price" = "0" ] && use_price="$current_close"

  local nearest_s=$(sqlite3 -separator '|' "$DB" "SELECT price, strength FROM price_levels WHERE symbol='$symbol' AND level_type='support' AND price < $use_price ORDER BY price DESC LIMIT 1" 2>/dev/null)
  [ -z "$nearest_s" ] && { echo "  ✓ PASS: No support level below"; return 0; }

  local s_price=$(echo "$nearest_s" | cut -d'|' -f1)
  local pct_away=$(python3 -c "print(f'{($use_price - $s_price) / $use_price * 100:.1f}')" 2>/dev/null)

  if python3 -c "exit(0 if float('$pct_away') < 3 else 1)" 2>/dev/null; then
    echo ""
    echo "  🚨 PANIC SELL PATTERN DETECTED"
    echo "     Red day + selling within ${pct_away}% of support at \$$s_price"

    # Surface past panic sell post-mortems
    local past_panics=$(sqlite3 "$DB" "
      SELECT s.symbol || ': ' || pm.lesson_learned
      FROM post_mortems pm
      JOIN securities s ON pm.security_id = s.id
      WHERE pm.execution_quality = 'bad' AND pm.outcome = 'loss'
      ORDER BY pm.close_date DESC LIMIT 3
    " 2>/dev/null)
    if [ -n "$past_panics" ]; then
      echo "     Past lessons from bad-execution losses:"
      echo "$past_panics" | while read -r line; do echo "       • $line"; done
    fi

    echo ""
    read -p "    I acknowledge this may be a panic sell. Proceed? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: Not near support (${pct_away}% away)"
  fi
  return 0
}

recall_symbol() {
  local symbol="$1"
  if [ -z "$symbol" ]; then
    echo "Usage: pm-cli.sh recall <symbol>"
    exit 1
  fi
  symbol=$(echo "$symbol" | tr '[:lower:]' '[:upper:]')

  echo ""
  echo "╔═══════════════════════════════════════╗"
  echo "║       DECISION MEMORY: $symbol"
  echo "╚═══════════════════════════════════════╝"
  echo ""

  # Recent transactions (last 5 buys/sells)
  echo "── Recent Transactions ──"
  local txns
  txns=$(sqlite3 -separator '|' "$DB" "
    SELECT t.date, t.type, t.quantity, printf('%.2f', t.price) as price,
           printf('%.2f', t.amount) as amount, a.name as account
    FROM transactions t
    JOIN securities s ON t.security_id = s.id
    JOIN accounts a ON t.account_id = a.id
    WHERE s.symbol = '$symbol' AND t.type IN ('Buy', 'Sell', 'buy', 'sell')
    ORDER BY t.date DESC LIMIT 5;
  " 2>/dev/null)

  if [ -z "$txns" ]; then
    echo "  (no transactions found)"
  else
    printf "  %-12s %-5s %8s %10s %12s  %s\n" "DATE" "SIDE" "QTY" "PRICE" "AMOUNT" "ACCOUNT"
    printf "  %-12s %-5s %8s %10s %12s  %s\n" "----------" "-----" "--------" "----------" "------------" "-------"
    echo "$txns" | while IFS='|' read -r TDATE TTYPE TQTY TPRICE TAMT TACCT; do
      printf "  %-12s %-5s %8s %10s %12s  %s\n" "$TDATE" "$TTYPE" "$TQTY" "$TPRICE" "$TAMT" "$TACCT"
    done
  fi
  echo ""

  # Post-mortems
  echo "── Post-Mortems ──"
  local pms
  pms=$(sqlite3 -separator '|' "$DB" "
    SELECT pm.close_date, pm.thesis_quality, pm.execution_quality, pm.outcome,
           pm.error_type, printf('%.2f', pm.realized_gain) as realized_gain,
           pm.hold_days, pm.lesson_learned
    FROM post_mortems pm
    JOIN securities s ON pm.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY pm.close_date DESC;
  " 2>/dev/null)

  if [ -z "$pms" ]; then
    echo "  (no post-mortems)"
  else
    echo "$pms" | while IFS='|' read -r CDATE TQ EQ OC ERR GAIN HDAYS LESSON; do
      if [ "$OC" = "loss" ]; then
        COLOR="\033[31m"
      else
        COLOR="\033[32m"
      fi
      RESET="\033[0m"
      printf "  ${COLOR}%s | %s thesis / %s exec / %s | %s | P&L: %s | %s days${RESET}\n" "$CDATE" "$TQ" "$EQ" "$OC" "$ERR" "$GAIN" "$HDAYS"
      echo "    Lesson: $LESSON"
    done
  fi
  echo ""

  # Decision logs
  echo "── Decision Logs ──"
  local dlogs
  dlogs=$(sqlite3 -separator '|' "$DB" "
    SELECT dl.decision_date, dl.decision_type, dl.decision, dl.background
    FROM decision_logs dl
    JOIN securities s ON dl.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY dl.decision_date DESC;
  " 2>/dev/null)

  if [ -z "$dlogs" ]; then
    echo "  (no decision logs)"
  else
    echo "$dlogs" | while IFS='|' read -r DDATE DTYPE DDEC DBKG; do
      echo "  $DDATE [$DTYPE] $DDEC"
      [ -n "$DBKG" ] && echo "    Background: $DBKG"
    done
  fi
  echo ""

  # Observations
  echo "── Observations ──"
  local obs
  obs=$(sqlite3 -separator '|' "$DB" "
    SELECT o.observation_date,
      CASE o.thesis_impact WHEN 'supports' THEN '+' WHEN 'challenges' THEN '-' ELSE '~' END,
      o.note
    FROM observations o
    JOIN securities s ON o.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY o.observation_date DESC
    LIMIT 10;
  " 2>/dev/null)

  if [ -z "$obs" ]; then
    echo "  (no observations)"
  else
    echo "$obs" | while IFS='|' read -r ODATE OIMPACT ONOTE; do
      echo "  $ODATE [$OIMPACT] $ONOTE"
    done
  fi
  echo ""

  # Intent changes
  echo "── Intent Changes ──"
  local intlogs
  intlogs=$(sqlite3 -separator '|' "$DB" "
    SELECT cl.changed_at, cl.field_name, cl.old_value, cl.new_value
    FROM position_intent_change_logs cl
    JOIN positions p ON cl.position_id = p.id
    JOIN securities s ON p.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY cl.changed_at DESC LIMIT 10;
  " 2>/dev/null)

  if [ -z "$intlogs" ]; then
    echo "  (no intent changes)"
  else
    echo "$intlogs" | while IFS='|' read -r IDATE IFIELD IOLD INEW; do
      echo "  $IDATE  $IFIELD: $IOLD → $INEW"
    done
  fi
  echo ""

  # Score changes
  echo "── Score Changes ──"
  sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS thesis_score_changes (id TEXT PRIMARY KEY, security_id TEXT NOT NULL, criteria_number TEXT NOT NULL, old_status TEXT NOT NULL, new_status TEXT NOT NULL, reason TEXT, changed_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (security_id) REFERENCES securities(id));" 2>/dev/null
  local score_changes
  score_changes=$(sqlite3 -separator '|' "$DB" "
    SELECT tsc.changed_at, tsc.criteria_number,
      tsc.old_status || ' -> ' || tsc.new_status as change,
      COALESCE(tsc.reason, '') as reason
    FROM thesis_score_changes tsc
    JOIN securities s ON tsc.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY tsc.changed_at DESC
    LIMIT 10;
  " 2>/dev/null)

  if [ -z "$score_changes" ]; then
    echo "  (no score changes)"
  else
    echo "$score_changes" | while IFS='|' read -r SCDATE SCCRIT SCCHANGE SCREASON; do
      echo "  $SCDATE  $SCCRIT: $SCCHANGE" $([ -n "$SCREASON" ] && echo "— $SCREASON")
    done
  fi
  echo ""
}

check_boundary() {
  local symbol="$1" side="$2" book="$3" qty="${4:-0}" price="${5:-0}"

  if [ "$book" = "investing" ]; then
    # Count sells (proxy for round-trips) in last 90 days
    local sell_count=$(sqlite3 "$DB" "
      SELECT COUNT(*) FROM transactions t
      JOIN securities s ON t.security_id=s.id
      WHERE s.symbol='$symbol' AND t.type IN ('sell','Sell')
      AND t.date >= date('now', '-90 days')
    " 2>/dev/null)
    if [ "$sell_count" -ge 3 ] 2>/dev/null; then
      echo "  ⚠ WARN: Boundary violation — $sell_count sells on $symbol in 90 days"
      echo "          This is an investing position. If you believe the thesis, hold."
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && return 1
    else
      echo "  ✓ PASS: Boundary check (investing, $sell_count sells in 90d)"
    fi
  elif [ "$book" = "trading" ]; then
    # Check if position is investing-sized (>2% of portfolio)
    local portfolio_total=$(sqlite3 "$DB" "
      SELECT COALESCE(SUM(
        CASE WHEN s.type IN ('cash') THEN p.quantity
        ELSE p.quantity * COALESCE((SELECT ph.close_price FROM price_history ph WHERE ph.security_id=p.security_id ORDER BY ph.date DESC LIMIT 1), 0)
        END
      ), 0)
      FROM positions p JOIN securities s ON p.security_id=s.id
    " 2>/dev/null)
    local existing_mv=$(sqlite3 "$DB" "
      SELECT COALESCE(p.quantity * (SELECT ph.close_price FROM price_history ph WHERE ph.security_id=p.security_id ORDER BY ph.date DESC LIMIT 1), 0)
      FROM positions p JOIN securities s ON p.security_id=s.id WHERE s.symbol='$symbol'
    " 2>/dev/null)
    [ -z "$existing_mv" ] && existing_mv=0
    local order_val=$(python3 -c "print($qty * $price)" 2>/dev/null)
    [ -z "$order_val" ] && order_val=0
    local after_mv=$(python3 -c "print($existing_mv + $order_val)" 2>/dev/null)
    local pct=$(python3 -c "print(f'{$after_mv / $portfolio_total * 100:.1f}' if $portfolio_total > 0 else '0.0')" 2>/dev/null)
    if python3 -c "exit(0 if float('$pct') > 2.0 else 1)" 2>/dev/null; then
      echo "  ⚠ WARN: Position ${pct}% — investing-sized for trading account"
      echo "          Consider moving to investing book or sizing down."
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && return 1
    else
      echo "  ✓ PASS: Trading position size OK (${pct}%)"
    fi
  fi
  return 0
}

check_hold_duration() {
  local symbol="$1"
  local hold_period=$(sqlite3 "$DB" "
    SELECT pi.target_hold_period FROM position_intents pi
    JOIN positions p ON pi.position_id=p.id
    JOIN securities s ON p.security_id=s.id
    WHERE s.symbol='$symbol' LIMIT 1
  " 2>/dev/null)
  [ -z "$hold_period" ] && { echo "  ✓ PASS: Hold duration (no target set)"; return 0; }

  local first_buy=$(sqlite3 "$DB" "
    SELECT MIN(t.date) FROM transactions t
    JOIN securities s ON t.security_id=s.id
    WHERE s.symbol='$symbol' AND t.type IN ('buy','Buy')
  " 2>/dev/null)
  [ -z "$first_buy" ] && { echo "  ✓ PASS: Hold duration (no buy history)"; return 0; }

  local days_held=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$first_buy" +%s 2>/dev/null || echo 0)) / 86400 ))

  # Parse target hold period to days
  local target_days=$(python3 -c "
import re
p = '$hold_period'.lower()
m = re.search(r'(\d+)\s*(month|year|week|day)', p)
if m:
    n, unit = int(m.group(1)), m.group(2)
    if 'year' in unit: print(n * 365)
    elif 'month' in unit: print(n * 30)
    elif 'week' in unit: print(n * 7)
    else: print(n)
else:
    print(0)
" 2>/dev/null)

  [ "$target_days" = "0" ] && { echo "  ✓ PASS: Hold duration (unparseable target: $hold_period)"; return 0; }

  if [ "$days_held" -lt "$target_days" ] 2>/dev/null; then
    local remaining=$((target_days - days_held))
    echo "  ⚠ WARN: Hold duration — target is '$hold_period' but only held ${days_held}d ($remaining days remaining)"
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: Hold duration met (${days_held}d, target: $hold_period)"
  fi
  return 0
}

check_churn() {
  local symbol="$1"
  local sell_count=$(sqlite3 "$DB" "
    SELECT COUNT(*) FROM transactions t
    JOIN securities s ON t.security_id=s.id
    WHERE s.symbol='$symbol' AND t.type IN ('sell','Sell')
    AND t.date >= date('now', '-90 days')
  " 2>/dev/null)
  if [ "$sell_count" -ge 3 ] 2>/dev/null; then
    echo "  ⚠ WARN: Churn detected — $sell_count round-trips on $symbol in 90 days"
    echo "          Constant build-trim-rebuild destroys value."
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ✓ PASS: No churn ($sell_count sells in 90d)"
  fi
  return 0
}

check_pending_earnings_review() {
  local symbol="$1"
  local pending=$(sqlite3 -separator '|' "$DB" "
    SELECT er.quarter, er.thesis_impact, er.invalidation_triggered, er.decision_deadline
    FROM earnings_reviews er
    JOIN securities s ON er.security_id = s.id
    WHERE s.symbol = '$symbol' AND er.decision IS NULL
    ORDER BY er.earnings_date DESC LIMIT 1;
  " 2>/dev/null)
  if [ -z "$pending" ]; then
    echo "  ✓ PASS: No pending earnings reviews"
    return 0
  fi
  local quarter=$(echo "$pending" | cut -d'|' -f1)
  local impact=$(echo "$pending" | cut -d'|' -f2)
  local invalidation=$(echo "$pending" | cut -d'|' -f3)
  local deadline=$(echo "$pending" | cut -d'|' -f4)
  if [ "$impact" = "challenged" ] || [ "$invalidation" = "1" ]; then
    echo "  ✗ FAIL: Pending earnings review for $symbol — thesis $impact"
    echo "          $quarter review pending${deadline:+ (deadline: $deadline)}. Complete review before trading."
    read -p "    Override? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  else
    echo "  ⚠ WARN: Pending $quarter earnings review for $symbol ($impact, no decision yet)"
    read -p "    Acknowledged? (y/n): " ov
    [ "$ov" != "y" ] && return 1
  fi
  return 0
}

check_valuation() {
  local symbol="$1" side="$2"

  local val_data=$(sqlite3 -separator '|' "$DB" "
    SELECT vm.peg_rating, printf('%.2f', vm.forward_peg) as peg_val,
           printf('%.1f', vm.forward_pe) as fwd_pe,
           printf('%.2f', vm.fair_low) as fair_low,
           printf('%.2f', vm.fair_mid) as fair_mid,
           printf('%.2f', vm.fair_high) as fair_high
    FROM valuation_metrics vm
    WHERE vm.symbol = '$symbol'
    ORDER BY vm.date DESC LIMIT 1
  " 2>/dev/null)

  if [ -z "$val_data" ]; then
    echo "  ✓ PASS: Valuation check (no valuation data)"
    return 0
  fi

  IFS='|' read -r peg_rating peg_val fwd_pe fair_low fair_mid fair_high <<< "$val_data"

  # Get current price
  local cur_price=$(sqlite3 "$DB" "
    SELECT ph.close_price FROM price_history ph
    JOIN securities s ON ph.security_id = s.id
    WHERE s.symbol = '$symbol' ORDER BY ph.date DESC LIMIT 1
  " 2>/dev/null)

  local price_ctx=""
  if [ -n "$cur_price" ] && [ -n "$fair_low" ] && [ "$fair_low" != "0.00" ]; then
    price_ctx=" | Current \$$cur_price vs fair range \$$fair_low-\$$fair_high"
  fi

  if [ "$side" = "BUY" ] || [ "$side" = "buy" ]; then
    if [ "$peg_rating" = "PRICEY" ]; then
      echo "  ⚠ WARN: Valuation is PRICEY — PEG $peg_val, fwd PE ${fwd_pe}x${price_ctx}"
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && return 1
    else
      echo "  ✓ PASS: Valuation ($peg_rating, PEG $peg_val)${price_ctx}"
    fi
  else
    if [ "$peg_rating" = "CHEAP" ]; then
      echo "  ⚠ WARN: Selling an undervalued name — valuation is CHEAP (PEG $peg_val, fwd PE ${fwd_pe}x)${price_ctx}"
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && return 1
    else
      echo "  ✓ PASS: Valuation ($peg_rating, PEG $peg_val)${price_ctx}"
    fi
  fi
  return 0
}

check_entry_plan() {
  local symbol="$1" qty="$2" price="${3:-0}"
  local plan_id target_pct
  plan_id=$(sqlite3 "$DB" "
    SELECT ep.id FROM entry_plans ep
    JOIN securities s ON ep.security_id = s.id
    WHERE s.symbol = '$symbol' AND ep.status = 'active'
    ORDER BY ep.created_at DESC LIMIT 1
  " 2>/dev/null)

  if [ -z "$plan_id" ]; then
    echo "  ✓ PASS: No active entry plan"
    return 0
  fi

  target_pct=$(sqlite3 "$DB" "SELECT target_allocation_pct FROM entry_plans WHERE id = '$plan_id'" 2>/dev/null)
  local pending_count
  pending_count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entry_plan_tranches WHERE plan_id = '$plan_id' AND status = 'pending'" 2>/dev/null)
  local target_display="${target_pct:-unset}%"

  # Check if order matches any pending tranche (2% price tolerance)
  local match
  match=$(sqlite3 "$DB" "
    SELECT tranche_number, shares, trigger_price FROM entry_plan_tranches
    WHERE plan_id = '$plan_id' AND status = 'pending'
    AND shares = $qty
    AND ABS(trigger_price - $price) / trigger_price <= 0.02
    LIMIT 1
  " 2>/dev/null)

  if [ -n "$match" ]; then
    local t_num=$(echo "$match" | cut -d'|' -f1)
    echo "  ✓ PASS: Matches tranche $t_num of entry plan (target $target_display, $pending_count pending)"
    return 0
  fi

  # Show plan context
  local tranche_info
  tranche_info=$(sqlite3 "$DB" "
    SELECT 'T' || tranche_number || ': ' || shares || '@$' || printf('%.2f', trigger_price)
    FROM entry_plan_tranches WHERE plan_id = '$plan_id' AND status = 'pending'
  " 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

  echo "  ⚠ WARN: Buy deviates from entry plan (target $target_display)"
  echo "    Pending tranches: $tranche_info"
  read -p "    Override? (y/n): " ov
  [ "$ov" != "y" ] && return 1
  return 0
}

pre_trade_check() {
  local symbol="$1" side="$2" qty="$3" acct="$4" price="${5:-0}"

  # Determine book
  local book=$(sqlite3 "$DB" "SELECT book FROM accounts WHERE account_number LIKE '%$acct'" 2>/dev/null)
  [ -z "$book" ] && book="unassigned"

  echo ""
  echo "╔═══════════════════════════════════════╗"
  echo "║       PRE-TRADE CHECKLIST             ║"
  echo "╚═══════════════════════════════════════╝"
  echo "  $side $qty $symbol ($book book)"
  echo ""

  # Decision memory context
  local dm_pm dm_dl
  dm_pm=$(sqlite3 "$DB" "
    SELECT pm.lesson_learned FROM post_mortems pm
    JOIN securities s ON pm.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY pm.close_date DESC LIMIT 1;
  " 2>/dev/null)
  dm_dl=$(sqlite3 "$DB" "
    SELECT dl.decision FROM decision_logs dl
    JOIN securities s ON dl.security_id = s.id
    WHERE s.symbol = '$symbol'
    ORDER BY dl.date DESC LIMIT 1;
  " 2>/dev/null)
  if [ -n "$dm_pm" ] || [ -n "$dm_dl" ]; then
    echo "  ── Decision Memory ──"
    [ -n "$dm_pm" ] && echo "  Last lesson: $dm_pm"
    [ -n "$dm_dl" ] && echo "  Last decision: $dm_dl"
    echo ""
  fi

  # Conflict surfacing (buys only)
  if [ "$side" = "BUY" ]; then
    # Check if today's ritual action conflicts
    local action=$(sqlite3 "$DB" "SELECT action_chosen FROM daily_rituals WHERE date = date('now')" 2>/dev/null)
    if [ "$action" = "reduce" ]; then
      echo "  ⚠ CONFLICT: Today's action is 'reduce' but you're buying."
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    elif [ "$action" = "nothing" ]; then
      echo "  ⚠ CONFLICT: Today's action is 'nothing' but you're trading."
      read -p "    Override? (y/n): " ov
      [ "$ov" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    fi

    # Check if recently sold same sector
    local sector=$(sqlite3 "$DB" "SELECT sector FROM securities WHERE symbol='$symbol'" 2>/dev/null)
    if [ -n "$sector" ] && [ "$sector" != "" ]; then
      local recent_sector_sells=$(sqlite3 "$DB" "
        SELECT s.symbol || ' on ' || t.date
        FROM transactions t
        JOIN securities s ON t.security_id = s.id
        WHERE s.sector = '$sector' AND t.type = 'sell'
        AND t.date >= date('now', '-7 days')
        AND s.symbol != '$symbol'
        ORDER BY t.date DESC LIMIT 3
      " 2>/dev/null)
      if [ -n "$recent_sector_sells" ]; then
        echo "  ⚠ CONFLICT: You sold other $sector names in the last 7 days:"
        echo "$recent_sector_sells" | while read -r line; do echo "    $line"; done
        echo "    Adding $symbol reintroduces sector exposure you just reduced."
        read -p "    Acknowledged? (y/n): " ack
        [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
      fi
    fi
  fi

  if [ "$side" = "SELL" ]; then
    check_regime_read || return 1
    check_rapid_flip "$symbol" "sell" "$price" || return 1
    check_sr_levels "$symbol" "SELL" "$price" || return 1
    check_panic_sell "$symbol" "$price" || return 1
    check_hold_duration "$symbol" || return 1
    check_valuation "$symbol" "SELL" || return 1
    [ "$book" = "investing" ] && { check_boundary "$symbol" "sell" "$book" || return 1; }
    echo ""
    echo "  Manual acknowledgments:"
    read -p "  ☐ I have a clear reason for this sell (y/n): " ack
    [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    echo ""
    echo "  ✓ Checklist complete"
    return 0
  fi

  if [ "$book" = "trading" ]; then
    check_thesis_file "$symbol" "$book" || return 1
    check_regime_read || return 1
    check_sorting_day || return 1
    check_reentry_cooldown "$symbol" || return 1
    check_rapid_flip "$symbol" "buy" || return 1
    check_sr_levels "$symbol" "BUY" "$price" || return 1
    check_gap_up "$symbol" || return 1
    check_valuation "$symbol" "BUY" || return 1
    check_boundary "$symbol" "buy" "$book" "$qty" "$price" || return 1
    check_churn "$symbol" || return 1
    check_pending_earnings_review "$symbol" || return 1
    check_entry_plan "$symbol" "$qty" "$price" || return 1
    echo "  ✓ PASS: Position size ≤1% check (manual verification)"
    echo ""
    echo "  Manual acknowledgments:"
    for item in \
      "I have a stop level defined — technical, not emotional" \
      "I will exit if no progress in 20-30 days" \
      "I accept a stop-out as success — not hoping, not averaging down"; do
      read -p "  ☐ $item (y/n): " ack
      [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    done
  else
    # Investing
    check_intent_exists "$symbol" || return 1
    check_thesis_file "$symbol" "$book" || return 1
    check_thesis "$symbol" || return 1
    check_invalidation "$symbol" || return 1
    check_regime_read || return 1
    check_sorting_day || return 1
    check_reentry_cooldown "$symbol" || return 1
    check_rapid_flip "$symbol" "buy" || return 1
    check_sr_levels "$symbol" "BUY" "$price" || return 1
    check_gap_up "$symbol" || return 1
    check_valuation "$symbol" "BUY" || return 1
    check_boundary "$symbol" "buy" "$book" "$qty" "$price" || return 1
    check_churn "$symbol" || return 1
    check_pending_earnings_review "$symbol" || return 1
    check_entry_plan "$symbol" "$qty" "$price" || return 1
    echo "  ✓ PASS: Position size check (manual verification)"
    echo ""
    echo "  Manual acknowledgments:"
    for item in \
      "This is an investment — I expect to hold for months+" \
      "I would hold through a 20-30% drawdown"; do
      read -p "  ☐ $item (y/n): " ack
      [ "$ack" != "y" ] && { echo "  Checklist abandoned."; return 1; }
    done
  fi

  echo ""
  echo "  ✓ Checklist complete"
  return 0
}

trade_analytics() {
  local results
  results=$(sqlite3 "$DB" "
    WITH buys AS (
      SELECT t.account_id, t.security_id, s.symbol,
             SUM(t.quantity) as total_qty,
             SUM(ABS(t.amount)) as total_cost
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'buy' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
      GROUP BY t.account_id, t.security_id
    ),
    sells AS (
      SELECT t.account_id, t.security_id, s.symbol,
             t.date as sell_date,
             t.quantity,
             t.price as sell_price,
             ABS(t.amount) as proceeds
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'sell' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
    ),
    matched AS (
      SELECT s.symbol, s.sell_date, s.quantity, s.sell_price, s.proceeds,
             CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END as avg_buy_price,
             s.proceeds - (s.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END) as gain
      FROM sells s
      LEFT JOIN buys b ON s.account_id = b.account_id AND s.security_id = b.security_id
    )
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN gain > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN gain <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(100.0 * SUM(CASE WHEN gain > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
      ROUND(SUM(gain), 2) as total_pnl,
      ROUND(AVG(CASE WHEN gain > 0 THEN gain END), 2) as avg_win,
      ROUND(AVG(CASE WHEN gain <= 0 THEN gain END), 2) as avg_loss
    FROM matched;
  ")

  if [ -z "$results" ] || [ "$results" = "0||||||" ]; then
    echo ""
    echo "=== Trade Performance (avg cost method) ==="
    echo ""
    echo "  No sell transactions found."
    echo ""
    return
  fi

  IFS='|' read -r total wins losses win_rate total_pnl avg_win avg_loss <<< "$results"

  echo ""
  echo "=== Trade Performance (avg cost method) ==="
  echo ""
  printf "  %-20s %s\n" "Total Trades:" "$total"
  printf "  %-20s %s (%s W / %s L)\n" "Win Rate:" "${win_rate}%" "$wins" "$losses"
  printf "  %-20s \$%s\n" "Total P&L:" "$total_pnl"
  printf "  %-20s \$%s\n" "Avg Win:" "$avg_win"
  printf "  %-20s \$%s\n" "Avg Loss:" "$avg_loss"
  echo ""
  echo "(Note: CLI uses avg cost method. App uses precise FIFO matching.)"

  echo ""
  echo "--- Top 5 Winners ---"
  sqlite3 -header -column "$DB" "
    WITH buys AS (
      SELECT t.account_id, t.security_id,
             SUM(t.quantity) as total_qty, SUM(ABS(t.amount)) as total_cost
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'buy' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
      GROUP BY t.account_id, t.security_id
    )
    SELECT s.symbol, se.sell_date as date, se.quantity as qty,
           ROUND(se.sell_price, 2) as sell_px,
           ROUND(CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END, 2) as avg_cost,
           ROUND(ABS(se.proceeds) - (se.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END), 2) as pnl
    FROM (
      SELECT t.account_id, t.security_id, s.symbol, t.date as sell_date,
             t.quantity, t.price as sell_price, ABS(t.amount) as proceeds
      FROM transactions t JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'sell' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
    ) se
    JOIN securities s ON se.security_id = s.id
    LEFT JOIN buys b ON se.account_id = b.account_id AND se.security_id = b.security_id
    ORDER BY pnl DESC LIMIT 5;
  "

  echo ""
  echo "--- Top 5 Losers ---"
  sqlite3 -header -column "$DB" "
    WITH buys AS (
      SELECT t.account_id, t.security_id,
             SUM(t.quantity) as total_qty, SUM(ABS(t.amount)) as total_cost
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'buy' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
      GROUP BY t.account_id, t.security_id
    )
    SELECT s.symbol, se.sell_date as date, se.quantity as qty,
           ROUND(se.sell_price, 2) as sell_px,
           ROUND(CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END, 2) as avg_cost,
           ROUND(ABS(se.proceeds) - (se.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END), 2) as pnl
    FROM (
      SELECT t.account_id, t.security_id, s.symbol, t.date as sell_date,
             t.quantity, t.price as sell_price, ABS(t.amount) as proceeds
      FROM transactions t JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'sell' AND s.symbol NOT LIKE 'CURRENCY_%' AND t.quantity > 0
    ) se
    JOIN securities s ON se.security_id = s.id
    LEFT JOIN buys b ON se.account_id = b.account_id AND se.security_id = b.security_id
    ORDER BY pnl ASC LIMIT 5;
  "
}

trade_journal() {
  local symbol="${1:-}"
  local days="${2:-90}"
  local cutoff=$(date -v-${days}d +%Y-%m-%d 2>/dev/null || date -d "$days days ago" +%Y-%m-%d)

  echo ""
  echo "═══════════════════════════════════════"
  echo "  TRADE JOURNAL${symbol:+ — $symbol} (last ${days}d)"
  echo "═══════════════════════════════════════"
  echo ""

  local query="
    SELECT
      s.symbol,
      t.date as sell_date,
      t.quantity as sell_qty,
      t.price as sell_price,
      t.amount as proceeds,
      (SELECT tb.date FROM transactions tb
       WHERE tb.security_id = t.security_id AND tb.account_id = t.account_id
       AND tb.type = 'buy' AND tb.date <= t.date
       ORDER BY tb.date DESC LIMIT 1) as buy_date,
      (SELECT tb.price FROM transactions tb
       WHERE tb.security_id = t.security_id AND tb.account_id = t.account_id
       AND tb.type = 'buy' AND tb.date <= t.date
       ORDER BY tb.date DESC LIMIT 1) as buy_price,
      (SELECT dr.regime_type FROM daily_rituals dr WHERE dr.date = t.date) as regime_at_sell,
      (SELECT dr.action_chosen FROM daily_rituals dr WHERE dr.date = t.date) as action_chosen,
      (SELECT dr.journal FROM daily_rituals dr WHERE dr.date = t.date) as journal,
      (SELECT dl.decision FROM decision_logs dl
       WHERE dl.security_id = t.security_id
       AND dl.decision_date BETWEEN date(t.date, '-3 days') AND t.date
       ORDER BY dl.decision_date DESC LIMIT 1) as decision_note,
      a.account_number
    FROM transactions t
    JOIN securities s ON t.security_id = s.id
    JOIN accounts a ON t.account_id = a.id
    WHERE t.type = 'sell'
      AND t.date >= '$cutoff'
      ${symbol:+AND UPPER(s.symbol) = UPPER('$symbol')}
    ORDER BY t.date DESC
    LIMIT 100
  "

  local results=$(sqlite3 -separator '|' "$DB" "$query" 2>/dev/null)

  if [ -z "$results" ]; then
    echo "  No sell transactions found${symbol:+ for $symbol} in last ${days} days."
    echo ""
    return
  fi

  local prev_date=""
  echo "$results" | while IFS='|' read -r sym sell_date sell_qty sell_price proceeds buy_date buy_price regime_sell action journal decision acct; do
    # Date header
    if [ "$sell_date" != "$prev_date" ]; then
      [ -n "$prev_date" ] && echo ""
      echo "── $sell_date ──────────────────────────"
      [ -n "$regime_sell" ] && echo "  Regime: $regime_sell"
      [ -n "$action" ] && echo "  Action: $action"
      [ -n "$journal" ] && echo "  Journal: $journal"
      echo ""
      prev_date="$sell_date"
    fi

    # P&L calculation
    local pnl_info=""
    if [ -n "$buy_price" ] && [ "$buy_price" != "" ]; then
      pnl_info=$(python3 -c "
bp=float('$buy_price'); sp=float('$sell_price'); q=float('$sell_qty')
gain=(sp-bp)*q; pct=((sp/bp)-1)*100 if bp>0 else 0
print(f'\${gain:+,.0f} ({pct:+.1f}%)')
" 2>/dev/null)
    fi

    # Hold period
    local hold=""
    if [ -n "$buy_date" ] && [ "$buy_date" != "" ]; then
      hold=$(python3 -c "
from datetime import datetime
d1=datetime.strptime('$buy_date','%Y-%m-%d')
d2=datetime.strptime('$sell_date','%Y-%m-%d')
print(f'{(d2-d1).days}d')
" 2>/dev/null)
    fi

    echo "  SELL $sell_qty $sym @ \$$sell_price  $pnl_info"
    [ -n "$buy_date" ] && [ "$buy_date" != "" ] && echo "    Entry: $buy_date @ \$$buy_price (held $hold)"
    [ -n "$decision" ] && [ "$decision" != "" ] && echo "    Decision: $decision"
  done

  echo ""
}
