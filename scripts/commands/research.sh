#!/bin/bash
# Research commands: recall, observe, observations, scorecard, scorecards,
# scorecard-update, scorecard-history, scorecard-add, scorecard-rm

case "$1" in
  recall)
    recall_symbol "$2"
    ;;

  observe)
    SYMBOL="$2"
    NOTE="$3"
    IMPACT="${4:-neutral}"
    if [ -z "$SYMBOL" ] || [ -z "$NOTE" ]; then
      echo "Usage: pm-cli.sh observe <symbol> \"<note>\" [supports|challenges|neutral]"
      exit 1
    fi
    SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')

    # Validate thesis_impact
    case "$IMPACT" in
      supports|challenges|neutral) ;;
      *) echo "ERROR: thesis_impact must be supports, challenges, or neutral"; exit 1 ;;
    esac

    # Look up security_id
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "ERROR: Security '$SYMBOL' not found in database."
      exit 1
    fi

    OBS_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    OBS_DATE=$(date +%Y-%m-%d)
    OBS_NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

    sqlite3 "$DB" "
      INSERT INTO observations (id, security_id, observation_date, note, source, thesis_impact, created_at)
      VALUES ('$OBS_ID', '$SEC_ID', '$OBS_DATE', '$(echo "$NOTE" | sed "s/'/''/g")', NULL, '$IMPACT', '$OBS_NOW');
    "

    case "$IMPACT" in
      supports) IND="+" ;;
      challenges) IND="-" ;;
      *) IND="~" ;;
    esac
    echo "Observation recorded for $SYMBOL [$IND]: $NOTE"
    ;;

  observations)
    SYMBOL="$2"
    if [ -n "$SYMBOL" ]; then
      SYMBOL=$(echo "$SYMBOL" | tr '[:lower:]' '[:upper:]')
      ROWS=$(sqlite3 -separator '|' "$DB" "
        SELECT o.observation_date, s.symbol,
          CASE o.thesis_impact WHEN 'supports' THEN '+' WHEN 'challenges' THEN '-' ELSE '~' END,
          o.note
        FROM observations o
        JOIN securities s ON o.security_id = s.id
        WHERE s.symbol = '$SYMBOL'
        ORDER BY o.observation_date DESC
        LIMIT 20;
      ")
    else
      ROWS=$(sqlite3 -separator '|' "$DB" "
        SELECT o.observation_date, s.symbol,
          CASE o.thesis_impact WHEN 'supports' THEN '+' WHEN 'challenges' THEN '-' ELSE '~' END,
          o.note
        FROM observations o
        JOIN securities s ON o.security_id = s.id
        ORDER BY o.observation_date DESC
        LIMIT 20;
      ")
    fi

    if [ -z "$ROWS" ]; then
      echo "(no observations found)"
    else
      printf "%-12s %-6s %s  %s\n" "DATE" "SYMBOL" "I" "NOTE"
      printf "%-12s %-6s %s  %s\n" "----------" "------" "-" "----"
      echo "$ROWS" | while IFS='|' read -r ODATE OSYM OIMPACT ONOTE; do
        printf "%-12s %-6s %s  %s\n" "$ODATE" "$OSYM" "$OIMPACT" "$ONOTE"
      done
    fi
    ;;

  scorecard)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    if [ -z "$SYMBOL" ]; then
      echo "Usage: pm-cli.sh scorecard <symbol>"
      exit 1
    fi
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"
    if [ ! -f "$THESIS_PATH" ]; then
      echo "ERROR: No thesis doc found at $THESIS_PATH"
      exit 1
    fi

    python3 <<PYEOF
import re, sys

thesis_path = "$THESIS_PATH"
symbol = "$SYMBOL"

with open(thesis_path, "r") as f:
    content = f.read()

# Extract header fields
tier_match = re.search(r'\*\*Tier:\*\*\s*(.+)', content)
tier = tier_match.group(1).strip() if tier_match else "Unknown"

last_updated_match = re.search(r'\*\*Last Updated:\*\*\s*(.+)', content)
last_updated = last_updated_match.group(1).strip() if last_updated_match else "—"

# Parse a criteria table section
def parse_table(section_header, text):
    """Parse a markdown table under a ## header. Returns list of dicts."""
    pattern = r'## ' + re.escape(section_header) + r'\s*\n\s*\n?\s*\|[^\n]+\|\s*\n\s*\|[-| ]+\|\s*\n((?:\s*\|[^\n]+\|\s*\n?)*)'
    match = re.search(pattern, text)
    if not match:
        return []
    rows = []
    for line in match.group(1).strip().split('\n'):
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 6:
            rows.append({
                'id': cells[0],
                'criterion': cells[1],
                'metric': cells[2],
                'threshold': cells[3],
                'status': cells[4].lower().strip(),
                'last_checked': cells[5],
            })
    return rows

bulls = parse_table("Bull Criteria", content)
bears = parse_table("Bear Criteria", content)

if not bulls and not bears:
    print(f"=== {symbol} Scorecard ===")
    print(f"  Tier: {tier}")
    print(f"  Status: UNSCORED — no Bull/Bear criteria tables found")
    print(f"  Add ## Bull Criteria and ## Bear Criteria tables to thesis.md")
    sys.exit(0)

# Count statuses
bull_confirmed = sum(1 for b in bulls if b['status'] == 'confirmed')
bull_pending = sum(1 for b in bulls if b['status'] == 'pending')
bull_challenged = sum(1 for b in bulls if b['status'] == 'challenged')
bear_triggered = sum(1 for b in bears if b['status'] == 'triggered')
bear_watching = sum(1 for b in bears if b['status'] == 'watching')
bear_not_triggered = sum(1 for b in bears if b['status'] == 'not_triggered')

total_bulls = len(bulls)
total_bears = len(bears)
bull_pct = (bull_confirmed / total_bulls * 100) if total_bulls > 0 else 0

# Suggested conviction
# Watching bears and challenged bulls count as half-signals
effective_bear = bear_triggered + bear_watching * 0.5
effective_bull_pct = ((bull_confirmed - bull_challenged * 0.5) / total_bulls * 100) if total_bulls > 0 else 0
if effective_bull_pct > 75 and effective_bear == 0:
    suggested = "A"
elif effective_bull_pct > 50 and effective_bear <= 1:
    suggested = "B"
elif effective_bull_pct >= 25 and effective_bear <= 1.5:
    suggested = "C"
else:
    suggested = "D"

# Display
print(f"=== {symbol} Scorecard ===")
print(f"  Tier: {tier}")
print(f"  Last Updated: {last_updated}")
print()

# Bull criteria
print(f"  Bull Criteria ({bull_confirmed}/{total_bulls} confirmed)")
print(f"  {'─' * 70}")
for b in bulls:
    status_icon = {'confirmed': '✓', 'pending': '?', 'challenged': '✗'}.get(b['status'], ' ')
    status_color = {'confirmed': 'confirmed', 'pending': 'pending', 'challenged': 'CHALLENGED'}.get(b['status'], b['status'])
    print(f"  {status_icon} {b['id']}  {b['criterion']:<30s} {b['metric']:<25s} {status_color:<12s} {b['last_checked']}")
print()

# Bear criteria
bear_label = f"{bear_triggered}/{total_bears} triggered"
if bear_triggered > 0:
    bear_label += " ⚠" * bear_triggered
print(f"  Bear Criteria ({bear_label})")
print(f"  {'─' * 70}")
for b in bears:
    status_icon = {'triggered': '⚠', 'watching': '◉', 'not_triggered': '·'}.get(b['status'], ' ')
    status_display = {'triggered': 'TRIGGERED', 'watching': 'watching', 'not_triggered': 'clear'}.get(b['status'], b['status'])
    print(f"  {status_icon} {b['id']}  {b['criterion']:<30s} {b['metric']:<25s} {status_display:<12s} {b['last_checked']}")
print()

# Score summary
print(f"  Score Summary")
print(f"  {'─' * 40}")
print(f"  Bull: {bull_confirmed} confirmed, {bull_pending} pending, {bull_challenged} challenged")
print(f"  Bear: {bear_triggered} triggered, {bear_watching} watching, {bear_not_triggered} clear")
print(f"  Bull %: {bull_pct:.0f}%")
print(f"  Suggested conviction: {suggested}")
PYEOF
    ;;

  scorecards)
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    POSITIONS_DIR="$PROJ_ROOT/docs/positions"

    python3 <<PYEOF
import re, os, sys

positions_dir = "$POSITIONS_DIR"

# Parse a criteria table section
def parse_table(section_header, text):
    pattern = r'## ' + re.escape(section_header) + r'\s*\n\s*\n?\s*\|[^\n]+\|\s*\n\s*\|[-| ]+\|\s*\n((?:\s*\|[^\n]+\|\s*\n?)*)'
    match = re.search(pattern, text)
    if not match:
        return []
    rows = []
    for line in match.group(1).strip().split('\n'):
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 6:
            rows.append({
                'id': cells[0],
                'criterion': cells[1],
                'status': cells[4].lower().strip(),
            })
    return rows

tier_priority = {'Core': 0, 'Growth': 1, 'Starter': 2, 'Watchlist': 3, 'Exit': 4}

def extract_tier_base(tier_str):
    """Extract base tier name from string like 'Growth (B- conviction, lower end)'"""
    for t in tier_priority:
        if t.lower() in tier_str.lower():
            return t
    return tier_str.split('(')[0].strip() if '(' in tier_str else tier_str.strip()

results = []
unscored = []

if not os.path.isdir(positions_dir):
    print(f"ERROR: Positions directory not found at {positions_dir}")
    sys.exit(1)

for symbol_dir in sorted(os.listdir(positions_dir)):
    thesis_path = os.path.join(positions_dir, symbol_dir, "thesis.md")
    if not os.path.isfile(thesis_path):
        continue

    with open(thesis_path, "r") as f:
        content = f.read()

    # Extract fields
    tier_match = re.search(r'\*\*Tier:\*\*\s*(.+)', content)
    tier_raw = tier_match.group(1).strip() if tier_match else "Unknown"
    tier_base = extract_tier_base(tier_raw)

    last_updated_match = re.search(r'\*\*Last Updated:\*\*\s*(.+)', content)
    last_updated = last_updated_match.group(1).strip() if last_updated_match else "—"

    bulls = parse_table("Bull Criteria", content)
    bears = parse_table("Bear Criteria", content)

    if not bulls and not bears:
        unscored.append((symbol_dir, tier_base))
        continue

    bull_confirmed = sum(1 for b in bulls if b['status'] == 'confirmed')
    bull_challenged = sum(1 for b in bulls if b['status'] == 'challenged')
    bear_triggered = sum(1 for b in bears if b['status'] == 'triggered')
    bear_watching = sum(1 for b in bears if b['status'] == 'watching')
    total_bulls = len(bulls)
    total_bears = len(bears)
    effective_bear = bear_triggered + bear_watching * 0.5
    effective_bull_pct = ((bull_confirmed - bull_challenged * 0.5) / total_bulls * 100) if total_bulls > 0 else 0

    if effective_bull_pct > 75 and effective_bear == 0:
        conv = "A"
    elif effective_bull_pct > 50 and effective_bear <= 1:
        conv = "B"
    elif effective_bull_pct >= 25 and effective_bear <= 1.5:
        conv = "C"
    else:
        conv = "D"

    bear_display = f"{bear_triggered}/{total_bears}"
    if bear_triggered > 0:
        bear_display += "  " + "⚠" * bear_triggered

    results.append({
        'symbol': symbol_dir,
        'tier': tier_base,
        'bull': f"{bull_confirmed}/{total_bulls}",
        'bear': bear_display,
        'conv': conv,
        'last_scored': last_updated,
        'bear_triggered': bear_triggered,
        'tier_priority': tier_priority.get(tier_base, 99),
    })

# Sort by tier priority, then symbol
results.sort(key=lambda r: (r['tier_priority'], r['symbol']))

print("=== Thesis Scorecards ===")
print()
print(f"  {'Symbol':<8s} {'Tier':<10s} {'Bull':<10s} {'Bear':<13s} {'Conv':<7s} {'Last Scored'}")
print(f"  {'───────':<8s} {'─────────':<10s} {'─────────':<10s} {'────────────':<13s} {'──────':<7s} {'───────────'}")

for r in results:
    print(f"  {r['symbol']:<8s} {r['tier']:<10s} {r['bull']:<10s} {r['bear']:<13s} {r['conv']:<7s} {r['last_scored']}")

total_triggers = sum(r['bear_triggered'] for r in results)
print()
print(f"  Total bear triggers: {total_triggers}")

if unscored:
    print()
    print(f"  Unscored ({len(unscored)} positions with thesis but no criteria tables):")
    for sym, tier in sorted(unscored, key=lambda x: (tier_priority.get(x[1], 99), x[0])):
        print(f"    {sym:<8s} ({tier})")
PYEOF
    ;;

  scorecard-update)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    CRITERIA_NUM="${3:-}"
    NEW_STATUS="${4:-}"
    REASON="${5:-}"
    if [ -z "$SYMBOL" ] || [ -z "$CRITERIA_NUM" ] || [ -z "$NEW_STATUS" ]; then
      echo "Usage: pm-cli.sh scorecard-update <symbol> <criteria#> <status> \"<reason>\""
      echo "  status: confirmed, pending, challenged (bull) or triggered, watching, not_triggered (bear)"
      exit 1
    fi
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"
    if [ ! -f "$THESIS_PATH" ]; then
      echo "ERROR: No thesis doc found at $THESIS_PATH"
      exit 1
    fi

    # Parse current status from thesis doc
    OLD_STATUS=$(python3 -c "
import sys
criteria_num = '$CRITERIA_NUM'
with open('$THESIS_PATH', 'r') as f:
    for line in f:
        if '|' in line:
            cols = [c.strip() for c in line.split('|')[1:-1]]
            if len(cols) >= 5 and cols[0].strip() == criteria_num:
                print(cols[4].strip().lower())
                sys.exit(0)
print('NOT_FOUND')
")

    if [ "$OLD_STATUS" = "NOT_FOUND" ]; then
      echo "ERROR: Criterion $CRITERIA_NUM not found in $THESIS_PATH"
      exit 1
    fi

    NEW_STATUS_LOWER=$(echo "$NEW_STATUS" | tr '[:upper:]' '[:lower:]')
    if [ "$OLD_STATUS" = "$NEW_STATUS_LOWER" ]; then
      echo "$SYMBOL $CRITERIA_NUM: already $OLD_STATUS — no change"
      exit 0
    fi

    # Look up security_id
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$SYMBOL' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "ERROR: Symbol $SYMBOL not found in securities table"
      exit 1
    fi

    # Ensure thesis_score_changes table exists
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS thesis_score_changes (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        criteria_number TEXT NOT NULL,
        old_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        reason TEXT,
        changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (security_id) REFERENCES securities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_thesis_score_security ON thesis_score_changes(security_id);
      CREATE INDEX IF NOT EXISTS idx_thesis_score_date ON thesis_score_changes(changed_at);
    "

    # Insert change record
    CHANGE_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    TODAY=$(date +%Y-%m-%d)
    sqlite3 "$DB" "INSERT INTO thesis_score_changes (id, security_id, criteria_number, old_status, new_status, reason, changed_at) VALUES ('$CHANGE_ID', '$SEC_ID', '$CRITERIA_NUM', '$OLD_STATUS', '$NEW_STATUS_LOWER', '$(echo "$REASON" | sed "s/'/''/g")', '$TODAY');"

    echo "$SYMBOL $CRITERIA_NUM: $OLD_STATUS → $NEW_STATUS_LOWER ($REASON)"
    echo "Remember to update the thesis doc: docs/positions/$SYMBOL/thesis.md"
    ;;

  scorecard-history)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')

    # Ensure thesis_score_changes table exists
    sqlite3 "$DB" "
      CREATE TABLE IF NOT EXISTS thesis_score_changes (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        criteria_number TEXT NOT NULL,
        old_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        reason TEXT,
        changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (security_id) REFERENCES securities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_thesis_score_security ON thesis_score_changes(security_id);
      CREATE INDEX IF NOT EXISTS idx_thesis_score_date ON thesis_score_changes(changed_at);
    "

    if [ -n "$SYMBOL" ]; then
      echo "=== $SYMBOL Scorecard History ==="
      echo ""
      sqlite3 -separator '|' "$DB" "
        SELECT tsc.changed_at, tsc.criteria_number, tsc.old_status, tsc.new_status, COALESCE(tsc.reason, '')
        FROM thesis_score_changes tsc
        JOIN securities s ON tsc.security_id = s.id
        WHERE s.symbol = '$SYMBOL'
        ORDER BY tsc.changed_at DESC
        LIMIT 20;
      " | while IFS='|' read -r dt crit old_s new_s reason; do
        if [ -n "$reason" ]; then
          printf "  %s  %-5s  %s → %s  (%s)\n" "$dt" "$crit" "$old_s" "$new_s" "$reason"
        else
          printf "  %s  %-5s  %s → %s\n" "$dt" "$crit" "$old_s" "$new_s"
        fi
      done
    else
      echo "=== All Scorecard Changes ==="
      echo ""
      sqlite3 -separator '|' "$DB" "
        SELECT tsc.changed_at, s.symbol, tsc.criteria_number, tsc.old_status, tsc.new_status, COALESCE(tsc.reason, '')
        FROM thesis_score_changes tsc
        JOIN securities s ON tsc.security_id = s.id
        ORDER BY tsc.changed_at DESC
        LIMIT 30;
      " | while IFS='|' read -r dt sym crit old_s new_s reason; do
        if [ -n "$reason" ]; then
          printf "  %s  %-6s %-5s  %s → %s  (%s)\n" "$dt" "$sym" "$crit" "$old_s" "$new_s" "$reason"
        else
          printf "  %s  %-6s %-5s  %s → %s\n" "$dt" "$sym" "$crit" "$old_s" "$new_s"
        fi
      done
    fi

    COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM thesis_score_changes tsc JOIN securities s ON tsc.security_id = s.id $([ -n "$SYMBOL" ] && echo "WHERE s.symbol = '$SYMBOL'");")
    if [ "$COUNT" -eq 0 ]; then
      echo "  (no changes recorded)"
    fi
    ;;

  scorecard-add)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    TYPE="${3:-}"
    LABEL="${4:-}"
    METRIC="${5:-}"
    THRESHOLD="${6:-}"
    if [ -z "$SYMBOL" ] || [ -z "$TYPE" ] || [ -z "$LABEL" ] || [ -z "$METRIC" ] || [ -z "$THRESHOLD" ]; then
      echo "Usage: pm-cli.sh scorecard-add <symbol> <bull|bear> \"<label>\" \"<metric>\" \"<threshold>\""
      exit 1
    fi
    if [ "$TYPE" != "bull" ] && [ "$TYPE" != "bear" ]; then
      echo "ERROR: type must be 'bull' or 'bear'"
      exit 1
    fi
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"
    if [ ! -f "$THESIS_PATH" ]; then
      echo "ERROR: No thesis doc found at $THESIS_PATH"
      exit 1
    fi

    python3 <<PYEOF
import re, sys
from datetime import date

thesis_path = "$THESIS_PATH"
criteria_type = "$TYPE"
label = """$LABEL"""
metric = """$METRIC"""
threshold = """$THRESHOLD"""
today = date.today().isoformat()

with open(thesis_path, "r") as f:
    content = f.read()

if criteria_type == "bull":
    section_header = "Bull Criteria"
    prefix = "B"
    default_status = "pending"
else:
    section_header = "Bear Criteria"
    prefix = None  # auto-detect from existing rows
    default_status = "not_triggered"

# Find the section
pattern = r'(## ' + re.escape(section_header) + r'\s*\n\s*\n?\s*\|[^\n]+\|\s*\n\s*\|[-| ]+\|\s*\n)((?:\s*\|[^\n]+\|\s*\n?)*)'
match = re.search(pattern, content)

if not match:
    print(f"ERROR: ## {section_header} table not found in thesis doc")
    sys.exit(1)

header_part = match.group(1)
rows_part = match.group(2)

# Find existing row IDs to determine next number and prefix
existing_ids = []
for line in rows_part.strip().split('\n'):
    if '|' in line:
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if cells:
            existing_ids.append(cells[0])

if existing_ids:
    last_id = existing_ids[-1]
    # Extract prefix letters and number
    id_match = re.match(r'([A-Za-z]+)(\d+)', last_id)
    if id_match:
        prefix = id_match.group(1)
        next_num = int(id_match.group(2)) + 1
    else:
        prefix = prefix or "X"
        next_num = 1
else:
    if criteria_type == "bull":
        prefix = "B"
    else:
        prefix = "X"
    next_num = 1

new_id = f"{prefix}{next_num}"
new_row = f"| {new_id} | {label} | {metric} | {threshold} | {default_status} | {today} |\n"

# Insert the new row at the end of the table rows
insert_pos = match.start(2) + len(rows_part.rstrip('\n'))
# If rows_part doesn't end with newline, add one
if rows_part and not rows_part.rstrip('\n').endswith('\n'):
    new_row = '\n' + new_row

new_content = content[:insert_pos] + new_row + content[insert_pos + len(rows_part) - len(rows_part.rstrip('\n')):]

with open(thesis_path, "w") as f:
    f.write(new_content)

print(f"Added {new_id} to {section_header}: {label} ({default_status})")
PYEOF
    ;;

  scorecard-rm)
    SYMBOL=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    CRITERIA_NUM="${3:-}"
    if [ -z "$SYMBOL" ] || [ -z "$CRITERIA_NUM" ]; then
      echo "Usage: pm-cli.sh scorecard-rm <symbol> <criteria#>"
      exit 1
    fi
    PROJ_ROOT=$(cd "$(dirname "$0")/.." && pwd)
    THESIS_PATH="$PROJ_ROOT/docs/positions/$SYMBOL/thesis.md"
    if [ ! -f "$THESIS_PATH" ]; then
      echo "ERROR: No thesis doc found at $THESIS_PATH"
      exit 1
    fi

    python3 <<PYEOF
import sys

thesis_path = "$THESIS_PATH"
criteria_num = "$CRITERIA_NUM"

with open(thesis_path, "r") as f:
    lines = f.readlines()

found = False
new_lines = []
for line in lines:
    if '|' in line:
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 1 and cells[0] == criteria_num:
            found = True
            # Extract label for confirmation message
            label = cells[1] if len(cells) >= 2 else ""
            print(f"Removed {criteria_num} from thesis: {label}")
            continue
    new_lines.append(line)

if not found:
    print(f"ERROR: Criterion {criteria_num} not found in {thesis_path}")
    sys.exit(1)

with open(thesis_path, "w") as f:
    f.writelines(new_lines)
PYEOF
    ;;
esac
