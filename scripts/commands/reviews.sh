#!/bin/bash
# Review commands: trade-analytics, trade-journal, post-mortem, post-mortems,
# earnings-review, earnings-reviews, earnings-review-decide, reconcile, broker-pl

case "$1" in
  trade-analytics)
    trade_analytics
    ;;

  trade-journal)
    trade_journal "$2" "$3"
    ;;

  post-mortem)
    # Interactive post-mortem creation
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh post-mortem <symbol>"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Look up security_id
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "ERROR: Security '$SYMBOL' not found in database."
      exit 1
    fi

    echo "=== Post-Mortem: $SYMBOL ==="
    echo ""

    # Show recent sell transactions for context
    echo "--- Recent Sell Transactions ---"
    sqlite3 -header -column "$DB" "
      SELECT t.date, t.quantity, printf('%.2f', t.price) as price,
             printf('%.2f', t.amount) as amount, a.name as account
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE t.security_id = '$SEC_ID' AND t.type = 'Sell'
      ORDER BY t.date DESC LIMIT 5;
    "
    echo ""

    # Show current position intent if exists
    INTENT_ROW=$(sqlite3 -header -column "$DB" "
      SELECT pi.tag as tier, pi.thesis, pi.invalidation
      FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      WHERE p.security_id = '$SEC_ID' LIMIT 1;
    " 2>/dev/null)
    if [ -n "$INTENT_ROW" ]; then
      echo "--- Current Position Intent ---"
      echo "$INTENT_ROW"
      echo ""
    fi

    # Prompt for fields
    read -p "Original intent (investment/trade): " PM_INTENT
    read -p "Close date (YYYY-MM-DD): " PM_CLOSE_DATE
    read -p "Tier at entry: " PM_TIER
    echo "Entry thesis (what was the original idea?):"
    read -p "> " PM_ENTRY_THESIS
    echo "What happened (how did the position play out?):"
    read -p "> " PM_WHAT_HAPPENED
    echo "Rule adherence (did you follow your rules?):"
    read -p "> " PM_RULE_ADHERENCE

    # Error type menu
    ERROR_TYPES=("entry-timing" "sizing" "stop-discipline" "thesis-quality" "regime-misread" "overtrading" "none")
    echo "Error type:"
    echo "  1) entry-timing"
    echo "  2) sizing"
    echo "  3) stop-discipline"
    echo "  4) thesis-quality"
    echo "  5) regime-misread"
    echo "  6) overtrading"
    echo "  7) none"
    read -p "Select (1-7): " PM_ERROR_NUM
    if [ "$PM_ERROR_NUM" -ge 1 ] && [ "$PM_ERROR_NUM" -le 7 ] 2>/dev/null; then
      PM_ERROR_TYPE="${ERROR_TYPES[$((PM_ERROR_NUM - 1))]}"
    else
      echo "Invalid selection, defaulting to 'none'"
      PM_ERROR_TYPE="none"
    fi

    # Thesis quality
    echo "Thesis quality:"
    echo "  1) good  (thesis was sound, based on real insight)"
    echo "  2) bad   (thesis was flawed from the start)"
    read -p "Select (1-2): " PM_TQ_NUM
    if [ "$PM_TQ_NUM" = "2" ]; then PM_THESIS_QUALITY="bad"; else PM_THESIS_QUALITY="good"; fi

    # Execution quality
    echo "Execution quality:"
    echo "  1) good  (followed process, acted on signals)"
    echo "  2) bad   (broke rules, ignored invalidation, averaged down)"
    read -p "Select (1-2): " PM_EQ_NUM
    if [ "$PM_EQ_NUM" = "2" ]; then PM_EXECUTION_QUALITY="bad"; else PM_EXECUTION_QUALITY="good"; fi

    # Outcome
    echo "Outcome:"
    echo "  1) win"
    echo "  2) loss"
    read -p "Select (1-2): " PM_OC_NUM
    if [ "$PM_OC_NUM" = "2" ]; then PM_OUTCOME="loss"; else PM_OUTCOME="win"; fi

    echo "Lesson learned:"
    read -p "> " PM_LESSON
    read -p "Realized P&L ($): " PM_REALIZED
    read -p "Hold days: " PM_HOLD_DAYS

    # Escape single quotes for SQL
    PM_INTENT_ESC=$(echo "$PM_INTENT" | sed "s/'/''/g")
    PM_TIER_ESC=$(echo "$PM_TIER" | sed "s/'/''/g")
    PM_ENTRY_THESIS_ESC=$(echo "$PM_ENTRY_THESIS" | sed "s/'/''/g")
    PM_WHAT_HAPPENED_ESC=$(echo "$PM_WHAT_HAPPENED" | sed "s/'/''/g")
    PM_RULE_ADHERENCE_ESC=$(echo "$PM_RULE_ADHERENCE" | sed "s/'/''/g")
    PM_LESSON_ESC=$(echo "$PM_LESSON" | sed "s/'/''/g")

    # Generate UUID and timestamp
    PM_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Default numeric fields
    if [ -z "$PM_REALIZED" ]; then PM_REALIZED="0"; fi
    if [ -z "$PM_HOLD_DAYS" ]; then PM_HOLD_DAYS="0"; fi

    sqlite3 "$DB" "INSERT INTO post_mortems (id, security_id, close_date, original_intent, tier, entry_thesis, what_happened, rule_adherence, error_type, thesis_quality, execution_quality, outcome, lesson_learned, realized_gain, hold_days, created_at, updated_at) VALUES ('$PM_ID', '$SEC_ID', '$PM_CLOSE_DATE', '$PM_INTENT_ESC', '$PM_TIER_ESC', '$PM_ENTRY_THESIS_ESC', '$PM_WHAT_HAPPENED_ESC', '$PM_RULE_ADHERENCE_ESC', '$PM_ERROR_TYPE', '$PM_THESIS_QUALITY', '$PM_EXECUTION_QUALITY', '$PM_OUTCOME', '$PM_LESSON_ESC', $PM_REALIZED, $PM_HOLD_DAYS, '$NOW', '$NOW');"

    echo ""
    echo "Post-mortem created for $SYMBOL ($PM_THESIS_QUALITY thesis / $PM_EXECUTION_QUALITY execution / $PM_OUTCOME, error: $PM_ERROR_TYPE)"
    echo "ID: $PM_ID"
    ;;

  post-mortems)
    # List post-mortems, optionally filtered by symbol
    PM_FILTER="$2"
    if [ -n "$PM_FILTER" ]; then
      PM_FILTER=$(echo "$PM_FILTER" | tr '[:lower:]' '[:upper:]')
      PM_WHERE="WHERE s.symbol = '$PM_FILTER'"
      echo "=== Post-Mortems: $PM_FILTER ==="
    else
      PM_WHERE=""
      echo "=== All Post-Mortems ==="
    fi

    # Use raw mode to colorize output
    PM_ROWS=$(sqlite3 -separator '|' "$DB" "
      SELECT s.symbol, pm.close_date, pm.thesis_quality, pm.execution_quality, pm.outcome,
             pm.error_type, pm.hold_days, printf('%.2f', pm.realized_gain) as realized_gain,
             pm.lesson_learned
      FROM post_mortems pm
      JOIN securities s ON pm.security_id = s.id
      $PM_WHERE
      ORDER BY pm.close_date DESC;
    ")

    if [ -z "$PM_ROWS" ]; then
      echo "(none)"
    else
      printf "%-6s %-12s %-7s %-7s %-7s %-16s %5s %12s  %s\n" "SYMBOL" "CLOSE DATE" "THESIS" "EXEC" "RESULT" "ERROR" "DAYS" "P&L" "LESSON"
      printf "%-6s %-12s %-7s %-7s %-7s %-16s %5s %12s  %s\n" "------" "----------" "-------" "-------" "-------" "----------------" "-----" "------------" "------"
      echo "$PM_ROWS" | while IFS='|' read -r SYM CDATE TQ EQ OC ERR HDAYS GAIN LESSON; do
        # Color: green for wins, red for losses
        if [ "$OC" = "loss" ]; then
          COLOR="\033[31m"  # red
        else
          COLOR="\033[32m"  # green
        fi
        RESET="\033[0m"
        printf "${COLOR}%-6s %-12s %-7s %-7s %-7s %-16s %5s %12s${RESET}  %s\n" "$SYM" "$CDATE" "$TQ" "$EQ" "$OC" "$ERR" "$HDAYS" "$GAIN" "$LESSON"
      done
    fi
    ;;

  earnings-review)
    # Interactive post-earnings review
    SYMBOL="$2"
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh earnings-review <symbol>"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Look up security_id
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "ERROR: Security '$SYMBOL' not found in database."
      exit 1
    fi

    echo "=== Earnings Review: $SYMBOL ==="
    echo ""

    # Show current position info
    INTENT_INFO=$(sqlite3 -separator '|' "$DB" "
      SELECT pi.tier, pi.thesis, pi.invalidation
      FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      WHERE p.security_id = '$SEC_ID' LIMIT 1;
    " 2>/dev/null)
    if [ -n "$INTENT_INFO" ]; then
      ER_TIER=$(echo "$INTENT_INFO" | cut -d'|' -f1)
      ER_THESIS=$(echo "$INTENT_INFO" | cut -d'|' -f2)
      ER_INV=$(echo "$INTENT_INFO" | cut -d'|' -f3)
      echo "--- Current Position ---"
      echo "  Tier:           $ER_TIER"
      echo "  Thesis:         $ER_THESIS"
      echo "  Invalidation:   $ER_INV"
      echo ""
    fi

    # Show previous review if exists (for growth trajectory suggestion)
    PREV_REVIEW=$(sqlite3 -separator '|' "$DB" "
      SELECT quarter, revenue_growth_pct, eps_growth_pct, growth_trajectory, thesis_impact
      FROM earnings_reviews
      WHERE security_id = '$SEC_ID'
      ORDER BY earnings_date DESC LIMIT 1;
    " 2>/dev/null)
    if [ -n "$PREV_REVIEW" ]; then
      PR_QTR=$(echo "$PREV_REVIEW" | cut -d'|' -f1)
      PR_REV_G=$(echo "$PREV_REVIEW" | cut -d'|' -f2)
      PR_EPS_G=$(echo "$PREV_REVIEW" | cut -d'|' -f3)
      PR_TRAJ=$(echo "$PREV_REVIEW" | cut -d'|' -f4)
      PR_IMPACT=$(echo "$PREV_REVIEW" | cut -d'|' -f5)
      echo "--- Previous Review ($PR_QTR) ---"
      [ -n "$PR_REV_G" ] && echo "  Revenue growth: ${PR_REV_G}%"
      [ -n "$PR_EPS_G" ] && echo "  EPS growth:     ${PR_EPS_G}%"
      [ -n "$PR_TRAJ" ] && echo "  Trajectory:     $PR_TRAJ"
      echo "  Thesis impact:  $PR_IMPACT"
      echo ""
    fi

    # Prompt for data
    read -p "Quarter (e.g. Q4 2025): " ER_QUARTER
    read -p "Earnings date (YYYY-MM-DD): " ER_DATE
    read -p "Revenue expected ($M): " ER_REV_EXP
    read -p "Revenue actual ($M): " ER_REV_ACT
    read -p "EPS expected ($): " ER_EPS_EXP
    read -p "EPS actual ($): " ER_EPS_ACT

    # Compute beat/miss
    echo ""
    if [ -n "$ER_REV_EXP" ] && [ -n "$ER_REV_ACT" ]; then
      REV_RESULT=$(python3 -c "
exp, act = float('$ER_REV_EXP'), float('$ER_REV_ACT')
diff_pct = (act - exp) / exp * 100 if exp else 0
label = 'Beat' if act > exp else 'Miss' if act < exp else 'Inline'
print(f'  Revenue: {label} ({diff_pct:+.1f}%) — \${exp:.2f}M est vs \${act:.2f}M actual')
" 2>/dev/null)
      echo "$REV_RESULT"
    fi
    if [ -n "$ER_EPS_EXP" ] && [ -n "$ER_EPS_ACT" ]; then
      EPS_RESULT=$(python3 -c "
exp, act = float('$ER_EPS_EXP'), float('$ER_EPS_ACT')
diff_pct = (act - exp) / exp * 100 if exp else 0
label = 'Beat' if act > exp else 'Miss' if act < exp else 'Inline'
print(f'  EPS:     {label} ({diff_pct:+.1f}%) — \${exp:.2f} est vs \${act:.2f} actual')
" 2>/dev/null)
      echo "$EPS_RESULT"
    fi
    echo ""

    read -p "Revenue YoY growth % (e.g. 15.3): " ER_REV_GROWTH
    read -p "EPS YoY growth % (e.g. 22.1): " ER_EPS_GROWTH

    # Suggest trajectory if previous review exists
    if [ -n "$PR_TRAJ" ] && [ -n "$PR_REV_G" ] && [ -n "$ER_REV_GROWTH" ]; then
      TRAJ_SUGGEST=$(python3 -c "
prev, curr = float('$PR_REV_G'), float('$ER_REV_GROWTH')
if curr > prev + 2: print('accelerating')
elif curr < prev - 2: print('decelerating')
else: print('stable')
" 2>/dev/null)
      echo "  (Suggested trajectory based on prior: $TRAJ_SUGGEST)"
    fi

    echo "Growth trajectory:"
    echo "  1) accelerating"
    echo "  2) stable"
    echo "  3) decelerating"
    read -p "Select (1-3): " ER_TRAJ_NUM
    case "$ER_TRAJ_NUM" in
      1) ER_TRAJECTORY="accelerating" ;;
      3) ER_TRAJECTORY="decelerating" ;;
      *) ER_TRAJECTORY="stable" ;;
    esac

    echo "Thesis impact:"
    echo "  1) confirmed  (earnings support the thesis)"
    echo "  2) neutral    (no change to thesis)"
    echo "  3) challenged (earnings challenge the thesis)"
    read -p "Select (1-3): " ER_IMPACT_NUM
    case "$ER_IMPACT_NUM" in
      1) ER_IMPACT="confirmed" ;;
      3) ER_IMPACT="challenged" ;;
      *) ER_IMPACT="neutral" ;;
    esac

    read -p "Invalidation triggered? (y/n): " ER_INV_TRIG
    if [ "$ER_INV_TRIG" = "y" ]; then
      ER_INV_TRIGGERED=1
    else
      ER_INV_TRIGGERED=0
    fi

    # Set deadline if challenged or invalidation triggered
    ER_DEADLINE=""
    if [ "$ER_IMPACT" = "challenged" ] || [ "$ER_INV_TRIGGERED" = "1" ]; then
      ER_DEADLINE=$(python3 -c "
from datetime import datetime, timedelta
deadline = datetime.now() + timedelta(hours=48)
print(deadline.strftime('%Y-%m-%dT%H:%M:%S.000Z'))
" 2>/dev/null)
      echo ""
      echo "  ⚠ DECISION REQUIRED within 48 hours: hold, retier, or exit"
      echo "  Deadline: $ER_DEADLINE"
    fi

    # Decision
    echo ""
    echo "Decision:"
    echo "  1) hold"
    echo "  2) retier"
    echo "  3) exit"
    echo "  4) defer (decide within 48h)"
    read -p "Select (1-4): " ER_DEC_NUM
    case "$ER_DEC_NUM" in
      1) ER_DECISION="hold" ;;
      2) ER_DECISION="retier" ;;
      3) ER_DECISION="exit" ;;
      *) ER_DECISION="" ;;
    esac

    ER_NOTES=""
    if [ -n "$ER_DECISION" ]; then
      echo "Decision notes:"
      read -p "> " ER_NOTES
    fi

    # Generate UUID and timestamp
    ER_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Escape single quotes
    ER_QUARTER_ESC=$(echo "$ER_QUARTER" | sed "s/'/''/g")
    ER_NOTES_ESC=$(echo "$ER_NOTES" | sed "s/'/''/g")

    # Default numeric fields
    [ -z "$ER_REV_EXP" ] && ER_REV_EXP="NULL" || ER_REV_EXP="$ER_REV_EXP"
    [ -z "$ER_REV_ACT" ] && ER_REV_ACT="NULL" || ER_REV_ACT="$ER_REV_ACT"
    [ -z "$ER_EPS_EXP" ] && ER_EPS_EXP="NULL" || ER_EPS_EXP="$ER_EPS_EXP"
    [ -z "$ER_EPS_ACT" ] && ER_EPS_ACT="NULL" || ER_EPS_ACT="$ER_EPS_ACT"
    [ -z "$ER_REV_GROWTH" ] && ER_REV_GROWTH="NULL" || ER_REV_GROWTH="$ER_REV_GROWTH"
    [ -z "$ER_EPS_GROWTH" ] && ER_EPS_GROWTH="NULL" || ER_EPS_GROWTH="$ER_EPS_GROWTH"

    # Build decision/deadline SQL values
    [ -z "$ER_DECISION" ] && ER_DEC_SQL="NULL" || ER_DEC_SQL="'$ER_DECISION'"
    [ -z "$ER_DEADLINE" ] && ER_DL_SQL="NULL" || ER_DL_SQL="'$ER_DEADLINE'"
    [ -z "$ER_NOTES" ] && ER_NOTES_SQL="NULL" || ER_NOTES_SQL="'$ER_NOTES_ESC'"

    sqlite3 "$DB" "INSERT INTO earnings_reviews (id, security_id, quarter, earnings_date, revenue_expected, revenue_actual, eps_expected, eps_actual, revenue_growth_pct, eps_growth_pct, growth_trajectory, thesis_impact, invalidation_triggered, decision, decision_deadline, decision_notes, created_at, updated_at) VALUES ('$ER_ID', '$SEC_ID', '$ER_QUARTER_ESC', '$ER_DATE', $ER_REV_EXP, $ER_REV_ACT, $ER_EPS_EXP, $ER_EPS_ACT, $ER_REV_GROWTH, $ER_EPS_GROWTH, '$ER_TRAJECTORY', '$ER_IMPACT', $ER_INV_TRIGGERED, $ER_DEC_SQL, $ER_DL_SQL, $ER_NOTES_SQL, '$NOW', '$NOW');"

    echo ""
    echo "=== Review Summary ==="
    echo "  $SYMBOL $ER_QUARTER ($ER_DATE)"
    echo "  Trajectory: $ER_TRAJECTORY | Impact: $ER_IMPACT"
    [ "$ER_INV_TRIGGERED" = "1" ] && echo "  ⚠ Invalidation triggered"
    if [ -n "$ER_DECISION" ]; then
      echo "  Decision: $ER_DECISION"
      [ -n "$ER_NOTES" ] && echo "  Notes: $ER_NOTES"
    else
      echo "  Decision: DEFERRED (deadline: $ER_DEADLINE)"
    fi
    echo "  ID: $ER_ID"
    ;;

  earnings-reviews)
    # List earnings reviews, optionally filtered by symbol
    ER_FILTER="$2"
    if [ -n "$ER_FILTER" ]; then
      ER_FILTER=$(echo "$ER_FILTER" | tr '[:lower:]' '[:upper:]')
      ER_WHERE="WHERE s.symbol = '$ER_FILTER'"
      echo "=== Earnings Reviews: $ER_FILTER ==="
    else
      ER_WHERE=""
      echo "=== All Earnings Reviews ==="
    fi

    ER_ROWS=$(sqlite3 -separator '|' "$DB" "
      SELECT s.symbol, er.quarter, substr(er.earnings_date, 1, 10) as edate,
             CASE
               WHEN er.revenue_actual IS NOT NULL AND er.revenue_expected IS NOT NULL
                 THEN CASE WHEN er.revenue_actual > er.revenue_expected THEN 'Beat' WHEN er.revenue_actual < er.revenue_expected THEN 'Miss' ELSE 'Inline' END
               ELSE 'N/A'
             END as rev_result,
             CASE
               WHEN er.eps_actual IS NOT NULL AND er.eps_expected IS NOT NULL
                 THEN CASE WHEN er.eps_actual > er.eps_expected THEN 'Beat' WHEN er.eps_actual < er.eps_expected THEN 'Miss' ELSE 'Inline' END
               ELSE 'N/A'
             END as eps_result,
             COALESCE(er.growth_trajectory, 'N/A') as trajectory,
             er.thesis_impact,
             COALESCE(er.decision, 'pending') as decision
      FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      $ER_WHERE
      ORDER BY er.earnings_date DESC;
    ")

    if [ -z "$ER_ROWS" ]; then
      echo "(none)"
    else
      printf "%-6s %-10s %-12s %-8s %-8s %-14s %-12s %-8s\n" "SYMBOL" "QUARTER" "DATE" "REV" "EPS" "TRAJECTORY" "IMPACT" "DECISION"
      printf "%-6s %-10s %-12s %-8s %-8s %-14s %-12s %-8s\n" "------" "----------" "----------" "--------" "--------" "--------------" "----------" "--------"
      echo "$ER_ROWS" | while IFS='|' read -r SYM QTR EDATE REV_R EPS_R TRAJ IMPACT DEC; do
        # Color: green for confirmed, red for challenged, yellow for pending
        if [ "$IMPACT" = "challenged" ]; then
          COLOR="\033[31m"  # red
        elif [ "$IMPACT" = "confirmed" ]; then
          COLOR="\033[32m"  # green
        else
          COLOR="\033[33m"  # yellow
        fi
        RESET="\033[0m"
        printf "${COLOR}%-6s %-10s %-12s %-8s %-8s %-14s %-12s %-8s${RESET}\n" "$SYM" "$QTR" "$EDATE" "$REV_R" "$EPS_R" "$TRAJ" "$IMPACT" "$DEC"
      done
    fi
    ;;

  earnings-review-decide)
    # Update decision on a pending earnings review
    ER_DEC_ID="$2"
    if [ -z "$ER_DEC_ID" ]; then
      echo "Usage: pm-cli.sh earnings-review-decide <review-id>"
      echo ""
      echo "Pending reviews:"
      sqlite3 -separator '|' "$DB" "
        SELECT er.id, s.symbol, er.quarter, er.thesis_impact, er.decision_deadline
        FROM earnings_reviews er
        JOIN securities s ON er.security_id = s.id
        WHERE er.decision IS NULL
        ORDER BY er.decision_deadline ASC;
      " 2>/dev/null | while IFS='|' read -r RID RSYM RQTR RIMP RDL; do
        echo "  $RID  $RSYM $RQTR ($RIMP) deadline: ${RDL:-none}"
      done
      exit 1
    fi

    # Verify review exists and is pending
    ER_CHECK=$(sqlite3 -separator '|' "$DB" "
      SELECT s.symbol, er.quarter, er.thesis_impact
      FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      WHERE er.id = '$ER_DEC_ID' AND er.decision IS NULL;
    " 2>/dev/null)
    if [ -z "$ER_CHECK" ]; then
      echo "ERROR: Review not found or already has a decision."
      exit 1
    fi
    ER_DEC_SYM=$(echo "$ER_CHECK" | cut -d'|' -f1)
    ER_DEC_QTR=$(echo "$ER_CHECK" | cut -d'|' -f2)
    ER_DEC_IMP=$(echo "$ER_CHECK" | cut -d'|' -f3)

    echo "=== Decide: $ER_DEC_SYM $ER_DEC_QTR (thesis: $ER_DEC_IMP) ==="
    echo ""
    echo "Decision:"
    echo "  1) hold"
    echo "  2) retier"
    echo "  3) exit"
    read -p "Select (1-3): " ER_DECIDE_NUM
    case "$ER_DECIDE_NUM" in
      1) ER_FINAL_DEC="hold" ;;
      2) ER_FINAL_DEC="retier" ;;
      3) ER_FINAL_DEC="exit" ;;
      *) echo "Invalid selection."; exit 1 ;;
    esac
    echo "Decision notes:"
    read -p "> " ER_FINAL_NOTES
    ER_FINAL_NOTES_ESC=$(echo "$ER_FINAL_NOTES" | sed "s/'/''/g")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    sqlite3 "$DB" "UPDATE earnings_reviews SET decision = '$ER_FINAL_DEC', decision_notes = '$ER_FINAL_NOTES_ESC', updated_at = '$NOW' WHERE id = '$ER_DEC_ID';"
    echo ""
    echo "Decision recorded: $ER_FINAL_DEC for $ER_DEC_SYM $ER_DEC_QTR"
    ;;

  reconcile)
    csv_path="$2"
    [ -z "$csv_path" ] && { echo "Usage: pm-cli.sh reconcile <csv_path>"; exit 1; }
    [ ! -f "$csv_path" ] && { echo "File not found: $csv_path"; exit 1; }

    CSV_PATH="$csv_path" DB_PATH="$DB" python3 << 'PYEOF'
import csv, sqlite3, uuid, sys, os, io, re
from datetime import datetime

csv_path = os.environ.get('CSV_PATH', '')
db_path = os.environ.get('DB_PATH', '')

if not csv_path or not os.path.isfile(csv_path):
    print(f"File not found: {csv_path}")
    sys.exit(1)

basename = os.path.basename(csv_path)

def parse_money(val):
    if not val or val == '--' or val.strip() == '':
        return None
    return float(val.replace('$', '').replace(',', ''))

def parse_pct(val):
    if not val or val == '--' or val.strip() == '':
        return None
    return float(val.replace('%', '').replace(',', ''))

# Read all lines (handle BOM)
with open(csv_path, 'r', encoding='utf-8-sig') as f:
    lines = f.readlines()

# Multi-section parser: Schwab "All Accounts" CSVs have repeated headers per account
# Format: title row, account header, CSV header, data rows, empty row, next account header, ...
records = []
current_account = None
i = 0
while i < len(lines):
    line = lines[i].strip().strip('"').strip(',').strip('"')

    # Skip empty lines
    if not line or all(c in ',"' for c in lines[i].strip()):
        i += 1
        continue

    # Detect account header lines (e.g. "Trading Book ...005", "Monica ...819", "Jia ...196")
    if '"Symbol"' not in lines[i] and 'Symbol' not in lines[i].split(',')[0]:
        # Not a CSV header or data — likely account name or title
        if re.search(r'\.\.\.\d{3}', line):
            # Account section header like "Trading Book ...005" or "Monica ...819"
            # Clean: take just the meaningful part before any empty CSV fields
            current_account = re.split(r'[",]+\s*$', line)[0].strip().strip('"')
        # else: title row or other non-data line
        i += 1
        continue

    # This is a CSV header row — collect data rows until next section
    header_line = lines[i]
    data_lines = [header_line]
    i += 1
    while i < len(lines):
        stripped = lines[i].strip()
        # Skip empty lines (all commas/quotes)
        if not stripped or all(c in ',"' for c in stripped):
            i += 1
            continue
        # Extract first field
        first_field = stripped.split(',')[0].strip('"')
        # Stop at header rows
        if first_field == 'Symbol':
            break
        # Stop at account header rows (e.g. "Monica ...819")
        if re.search(r'\.\.\.\d{3}', first_field):
            break
        if not first_field:
            i += 1
            continue
        data_lines.append(lines[i])
        i += 1

    # Parse this section
    reader = csv.DictReader(io.StringIO(''.join(data_lines)))
    for row in reader:
        symbol = row.get('Symbol', '').strip()
        if not symbol or symbol == '--' or symbol == 'Symbol':
            continue
        # Skip account header rows that leaked through (e.g. "Jia ...196")
        if re.search(r'\.\.\.\d{3}', symbol):
            continue

        records.append({
            'id': str(uuid.uuid4()),
            'symbol': symbol,
            'account_name': current_account,
            'open_date': row.get('Opened Date', row.get('Date Acquired', '')).strip() or None,
            'close_date': row.get('Closed Date', row.get('Date Sold', '')).strip() or None,
            'quantity': parse_money(row.get('Quantity', row.get('Qty', ''))),
            'cost_basis': parse_money(row.get('Cost Basis (CB)', row.get('Cost', ''))),
            'proceeds': parse_money(row.get('Proceeds', '')),
            'gain_loss': parse_money(row.get('Gain/Loss ($)', row.get('Gain/loss ($)', ''))),
            'gain_loss_pct': parse_pct(row.get('Gain/Loss (%)', row.get('Gain/loss (%)', ''))),
            'term': row.get('Term', '').strip() or None,
            'source_file': basename,
            'imported_at': datetime.now().isoformat()
        })

if not records:
    print("No records found in CSV")
    sys.exit(1)

# Import to DB
conn = sqlite3.connect(db_path)
conn.execute("""CREATE TABLE IF NOT EXISTS realized_pl_broker (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, account_name TEXT,
    open_date TEXT, close_date TEXT, quantity REAL, cost_basis REAL,
    proceeds REAL, gain_loss REAL, gain_loss_pct REAL, term TEXT,
    source_file TEXT, imported_at TEXT NOT NULL
)""")
conn.execute("CREATE INDEX IF NOT EXISTS idx_rpl_symbol ON realized_pl_broker(symbol)")
conn.execute("CREATE INDEX IF NOT EXISTS idx_rpl_close_date ON realized_pl_broker(close_date)")
# Add unique constraint on content to prevent re-import duplicates
try:
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_rpl_dedup ON realized_pl_broker(symbol, open_date, close_date, quantity, cost_basis, proceeds, account_name)")
except:
    pass

imported = 0
skipped = 0
for r in records:
    try:
        conn.execute("""INSERT INTO realized_pl_broker
            (id, symbol, account_name, open_date, close_date, quantity, cost_basis,
             proceeds, gain_loss, gain_loss_pct, term, source_file, imported_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r['id'], r['symbol'], r['account_name'], r['open_date'], r['close_date'],
             r['quantity'], r['cost_basis'], r['proceeds'], r['gain_loss'],
             r['gain_loss_pct'], r['term'], r['source_file'], r['imported_at']))
        imported += 1
    except sqlite3.IntegrityError:
        skipped += 1
conn.commit()
print(f"Imported {imported} lots from {basename}" + (f" (skipped {skipped} duplicates)" if skipped else ""))

# Show summary
cursor = conn.execute("""
    SELECT symbol, COUNT(*) as lots, printf('%.2f', SUM(gain_loss)) as total_pl,
           MIN(close_date) as first_close, MAX(close_date) as last_close
    FROM realized_pl_broker
    WHERE source_file = ?
    GROUP BY symbol ORDER BY SUM(gain_loss)
""", (basename,))
print(f"\n{'SYMBOL':<8} {'LOTS':>5} {'TOTAL P&L':>12} {'FIRST CLOSE':>12} {'LAST CLOSE':>12}")
print(f"{'------':<8} {'----':>5} {'---------':>12} {'-----------':>12} {'----------':>12}")
for row in cursor:
    print(f"{row[0]:<8} {row[1]:>5} {'$'+row[2]:>12} {row[3] or '':>12} {row[4] or '':>12}")

total = conn.execute("SELECT printf('%.2f', SUM(gain_loss)) FROM realized_pl_broker WHERE source_file = ?",
    (basename,)).fetchone()[0]
lot_count = conn.execute("SELECT COUNT(*) FROM realized_pl_broker WHERE source_file = ?",
    (basename,)).fetchone()[0]
print(f"\nTotal realized P&L: ${total}  ({lot_count} lots)")
conn.close()
PYEOF
    ;;

  broker-pl)
    symbol="$2"
    if [ -n "$symbol" ]; then
      symbol=$(echo "$symbol" | tr '[:lower:]' '[:upper:]')
      echo "=== Broker P&L: $symbol ==="
      sqlite3 -header -column "$DB" "
        SELECT open_date as 'Opened', close_date as 'Closed', quantity as 'Qty',
               printf('$%.2f', cost_basis) as 'Cost Basis',
               printf('$%.2f', proceeds) as 'Proceeds',
               printf('$%.2f', gain_loss) as 'P&L',
               term as 'Term', account_name as 'Account'
        FROM realized_pl_broker WHERE symbol='$symbol' ORDER BY close_date
      "
      echo ""
      sqlite3 -column "$DB" "
        SELECT printf('$%.2f', SUM(gain_loss)) as 'Total P&L',
               COUNT(*) as 'Lots',
               printf('$%.2f', SUM(cost_basis)) as 'Total Cost',
               printf('$%.2f', SUM(proceeds)) as 'Total Proceeds'
        FROM realized_pl_broker WHERE symbol='$symbol'
      "
    else
      echo "=== Broker Realized P&L Summary ==="
      sqlite3 -header -column "$DB" "
        SELECT symbol as Symbol, COUNT(*) as Lots,
               printf('$%.2f', SUM(gain_loss)) as 'Total P&L',
               MAX(close_date) as 'Last Close',
               account_name as Account
        FROM realized_pl_broker GROUP BY symbol, account_name ORDER BY SUM(gain_loss)
      "
      echo ""
      sqlite3 -column "$DB" "
        SELECT printf('$%.2f', SUM(gain_loss)) as 'Grand Total',
               COUNT(*) as 'Total Lots',
               COUNT(DISTINCT symbol) as Symbols
        FROM realized_pl_broker
      "
    fi
    ;;
esac
