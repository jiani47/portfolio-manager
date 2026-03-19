#!/bin/bash
# Research commands: recall, observe, observations, scorecard, scorecards,
# scorecard-update, scorecard-history, scorecard-add, scorecard-rm,
# note, notes, thesis-export

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

    # Auto-update the thesis doc status in-place
    python3 - "$THESIS_PATH" "$CRITERIA_NUM" "$NEW_STATUS_LOWER" "$TODAY" << 'PYEOF'
import sys
thesis_path, criteria_num, new_status, today = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(thesis_path) as f:
    lines = f.readlines()
new_lines = []
for line in lines:
    if '|' in line:
        cols = [c.strip() for c in line.split('|')]
        if len(cols) >= 7 and cols[1].strip() == criteria_num:
            cols[5] = f' {new_status} '
            cols[6] = f' {today} '
            line = '|'.join(cols) + '\n'
    new_lines.append(line)
with open(thesis_path, 'w') as f:
    f.writelines(new_lines)
PYEOF
    echo "Thesis doc updated: $THESIS_PATH"
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

  research)
    # Generate a research template for a symbol, auto-populated with available data
    # Usage: pm-cli.sh research <symbol>
    R_SYM=$(echo "${2:-}" | tr '[:lower:]' '[:upper:]')
    if [ -z "$R_SYM" ]; then
      echo "Usage: pm-cli.sh research <symbol>"
      echo "  Generates a research brief with auto-populated data from FMP + DB"
      exit 1
    fi

    python3 - "$R_SYM" "$DB" << 'PYEOF'
import sqlite3, sys, datetime, urllib.request, json, os

symbol = sys.argv[1]
db_path = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# Read FMP key
fmp_key = None
conf_path = os.path.expanduser("~/.pm-cli.conf")
if os.path.exists(conf_path):
    with open(conf_path) as f:
        for line in f:
            if line.startswith("FMP_API_KEY="):
                fmp_key = line.split("=", 1)[1].strip()

def fmp_fetch(endpoint, params=""):
    if not fmp_key: return None
    url = f"https://financialmodelingprep.com/stable/{endpoint}?symbol={symbol}&apikey={fmp_key}{params}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url)) as resp:
            return json.loads(resp.read())
    except:
        return None

# === Gather Data ===

# Profile
profile = fmp_fetch("profile")
p = profile[0] if profile and isinstance(profile, list) and len(profile) > 0 else {}

# Price
price_row = conn.execute("""
    SELECT ph.close_price, ph.date FROM price_history ph
    JOIN securities s ON ph.security_id = s.id
    WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
""", (symbol,)).fetchone()
price = price_row['close_price'] if price_row else p.get('price', 0)

# Valuation from DB
val = conn.execute("SELECT * FROM valuation_metrics WHERE symbol = ? ORDER BY date DESC LIMIT 1", (symbol,)).fetchone()

# Key metrics
metrics = fmp_fetch("key-metrics", "&period=annual&limit=1")
km = metrics[0] if metrics and isinstance(metrics, list) and len(metrics) > 0 else {}

# Income statement
income = fmp_fetch("income-statement", "&period=annual&limit=3")

# Analyst estimates
estimates = fmp_fetch("analyst-estimates", "&period=annual&limit=5")

# S/R levels
supports = conn.execute("""
    SELECT price, strength FROM price_levels WHERE symbol = ? AND level_type = 'support' ORDER BY price DESC LIMIT 3
""", (symbol,)).fetchall()
resistances = conn.execute("""
    SELECT price, strength FROM price_levels WHERE symbol = ? AND level_type = 'resistance' ORDER BY price ASC LIMIT 3
""", (symbol,)).fetchall()

# Existing research notes
notes = conn.execute("SELECT section, content, source, created_at FROM research_notes WHERE symbol = ? ORDER BY section, created_at", (symbol,)).fetchall()

# Existing observations
obs = conn.execute("SELECT observation_date, note, thesis_impact FROM observations WHERE security_id = (SELECT id FROM securities WHERE symbol = ? LIMIT 1) ORDER BY observation_date DESC LIMIT 5", (symbol,)).fetchall()

# Watchlist
wl = conn.execute("SELECT w.name, wi.thesis_snippet FROM watchlist_items wi JOIN watchlists w ON wi.watchlist_id = w.id WHERE wi.symbol = ?", (symbol,)).fetchone()

# === Output ===
now = datetime.datetime.now().strftime('%Y-%m-%d')
print()
print(f"{'='*60}")
print(f"  RESEARCH BRIEF: {symbol}")
print(f"  {p.get('companyName', '')}  |  {p.get('sector', '?')} / {p.get('industry', '?')}")
print(f"  {p.get('exchange', '?')}  |  Mkt Cap: ${p.get('mktCap', 0)/1e9:.1f}B  |  Employees: {p.get('fullTimeEmployees', '?')}")
if wl:
    print(f"  Watchlist: {wl['name']}" + (f" — {wl['thesis_snippet']}" if wl['thesis_snippet'] else ""))
print(f"  Generated: {now}")
print(f"{'='*60}")

# Business Description
print(f"\n── Business Description ──")
desc = p.get('description', '')
if desc:
    # Truncate to ~300 chars
    if len(desc) > 300:
        desc = desc[:297] + "..."
    print(f"  {desc}")
else:
    print(f"  [No description available]")

# Financials
print(f"\n── Financials ──")
if income and isinstance(income, list):
    print(f"  {'Year':<6} {'Revenue':>12} {'Net Income':>12} {'EPS':>8} {'Margin':>8}")
    print(f"  {'─'*6} {'─'*12} {'─'*12} {'─'*8} {'─'*8}")
    for stmt in sorted(income, key=lambda x: x.get('date', '')):
        yr = stmt.get('date', '')[:4]
        rev = stmt.get('revenue', 0)
        ni = stmt.get('netIncome', 0)
        eps_val = stmt.get('eps', 0)
        margin = (ni / rev * 100) if rev else 0
        print(f"  {yr:<6} ${rev/1e9:>10.1f}B ${ni/1e9:>10.1f}B ${eps_val:>7.2f} {margin:>7.1f}%")
else:
    print(f"  [No financial data]")

# Key Metrics
print(f"\n── Key Metrics ──")
if km:
    print(f"  ROE: {km.get('returnOnEquity', 0)*100:.1f}%  |  ROA: {km.get('returnOnAssets', 0)*100:.1f}%  |  ROIC: {km.get('returnOnInvestedCapital', 0)*100:.1f}%")
    print(f"  Current Ratio: {km.get('currentRatio', 0):.1f}  |  D/E: {km.get('debtToEquity', 0):.2f}")
    print(f"  FCF Yield: {km.get('freeCashFlowYield', 0)*100:.1f}%  |  Earnings Yield: {km.get('earningsYield', 0)*100:.1f}%")

# Valuation
print(f"\n── Valuation ──")
if val:
    t12 = f"{val['trailing_pe']:.1f}x" if val['trailing_pe'] else "N/A"
    fwd = f"{val['forward_pe']:.1f}x" if val['forward_pe'] else "N/A"
    peg = f"{val['forward_peg']:.2f}" if val['forward_peg'] else "N/A"
    rating = val['peg_rating'] or '—'
    print(f"  T12 PE: {t12}  |  Fwd PE: {fwd}  |  PEG: {peg}  |  Rating: {rating}")
    if val['fair_low'] and val['fair_high']:
        print(f"  Fair Range: ${val['fair_low']:.0f} – ${val['fair_mid']:.0f} – ${val['fair_high']:.0f}  |  Current: ${price:.2f}")

# EPS Estimates
if estimates and isinstance(estimates, list):
    estimates.sort(key=lambda x: x.get('date', ''))
    future = [e for e in estimates if e.get('date', '') > now and e.get('epsAvg', 0)]
    if future:
        print(f"\n── Analyst Estimates ──")
        print(f"  {'FY End':<12} {'EPS':>8} {'Revenue':>12} {'Analysts':>10}")
        print(f"  {'─'*12} {'─'*8} {'─'*12} {'─'*10}")
        for e in future[:4]:
            eps_e = e.get('epsAvg', 0)
            rev_e = e.get('revenueAvg', 0)
            n = e.get('numAnalystsEps', 0)
            print(f"  {e['date'][:10]:<12} ${eps_e:>7.2f} ${rev_e/1e9:>10.1f}B {n:>10}")

# Technical Levels
print(f"\n── Technical Levels ──")
print(f"  Price: ${price:.2f}")
for s in supports:
    dist = (price - s['price']) / price * 100
    print(f"  S  ${s['price']:.2f}  (str {s['strength']}/10, {dist:.1f}% below)")
for r in resistances:
    dist = (r['price'] - price) / price * 100
    print(f"  R  ${r['price']:.2f}  (str {r['strength']}/10, {dist:.1f}% above)")

# Existing Research
if notes:
    print(f"\n── Existing Research Notes ──")
    cur_sec = None
    for n in notes:
        if n['section'] != cur_sec:
            cur_sec = n['section']
            print(f"  [{cur_sec}]")
        src = f" ({n['source']})" if n['source'] else ""
        content = n['content'][:100] + "..." if len(n['content']) > 100 else n['content']
        print(f"    {n['created_at'][:10]}: {content}{src}")

if obs:
    print(f"\n── Recent Observations ──")
    for o in obs:
        impact = {'+': 'supports', '-': 'challenges', '~': 'neutral'}.get(o['thesis_impact'], o['thesis_impact'])
        note_text = o['note'][:100] + "..." if len(o['note']) > 100 else o['note']
        print(f"  {o['observation_date'][:10]} [{impact}] {note_text}")

# Template for thesis
print(f"\n── Thesis Template ──")
print(f"  To build thesis, add research notes:")
print(f"    pm-cli.sh note {symbol} business_model \"...\"")
print(f"    pm-cli.sh note {symbol} moat \"...\"")
print(f"    pm-cli.sh note {symbol} risks \"...\"")
print(f"    pm-cli.sh note {symbol} catalyst \"...\"")
print(f"    pm-cli.sh note {symbol} valuation \"...\"")
print(f"  Then export: pm-cli.sh thesis-export {symbol}")
print()

conn.close()
PYEOF
    ;;

  note)
    # Add a research note: pm-cli.sh note <symbol> <section> "<content>" [source]
    # Sections: business_model, moat, risks, valuation, catalyst, competitive, management, other
    NOTE_SYM="$2"
    NOTE_SECTION="$3"
    NOTE_CONTENT="$4"
    NOTE_SOURCE="${5:-}"
    if [ -z "$NOTE_SYM" ] || [ -z "$NOTE_SECTION" ] || [ -z "$NOTE_CONTENT" ]; then
      echo "Usage: pm-cli.sh note <symbol> <section> \"<content>\" [source]"
      echo "  Sections: business_model, moat, risks, valuation, catalyst, competitive, management, other"
      exit 1
    fi
    NOTE_SYM=$(echo "$NOTE_SYM" | tr '[:lower:]' '[:upper:]')
    SEC_ID=$(sqlite3 "$DB" "SELECT id FROM securities WHERE symbol = '$NOTE_SYM' LIMIT 1;")
    if [ -z "$SEC_ID" ]; then
      echo "Error: Security '$NOTE_SYM' not found"
      exit 1
    fi
    NOTE_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Create table if not exists (for CLI-only usage)
    sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS research_notes (id TEXT PRIMARY KEY, security_id TEXT NOT NULL, symbol TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL, source TEXT, created_at TEXT NOT NULL);"
    sqlite3 "$DB" "CREATE INDEX IF NOT EXISTS idx_research_notes_symbol ON research_notes(symbol);"

    NOTE_CONTENT_ESC=$(echo "$NOTE_CONTENT" | sed "s/'/''/g")
    NOTE_SOURCE_ESC=$(echo "$NOTE_SOURCE" | sed "s/'/''/g")
    SOURCE_SQL="NULL"
    [ -n "$NOTE_SOURCE" ] && SOURCE_SQL="'$NOTE_SOURCE_ESC'"

    sqlite3 "$DB" "INSERT INTO research_notes (id, security_id, symbol, section, content, source, created_at) VALUES ('$NOTE_ID', '$SEC_ID', '$NOTE_SYM', '$NOTE_SECTION', '$NOTE_CONTENT_ESC', $SOURCE_SQL, '$NOW');"
    echo "Research note added: $NOTE_SYM [$NOTE_SECTION]"
    ;;

  notes)
    # List research notes: pm-cli.sh notes [symbol]
    NOTES_SYM="$2"
    if [ -n "$NOTES_SYM" ]; then
      NOTES_SYM=$(echo "$NOTES_SYM" | tr '[:lower:]' '[:upper:]')
      NOTES_FILTER="WHERE symbol = '$NOTES_SYM'"
    else
      NOTES_FILTER=""
    fi
    echo "=== Research Notes ==="
    sqlite3 "$DB" "
      SELECT date(created_at) as date, symbol, section, substr(content, 1, 80) as content, source
      FROM research_notes $NOTES_FILTER
      ORDER BY created_at DESC LIMIT 30;
    " | while IFS='|' read -r DATE SYM SEC CONTENT SRC; do
      SRC_TAG=""
      [ -n "$SRC" ] && SRC_TAG=" [${SRC}]"
      echo "  $DATE  $SYM  ($SEC)  ${CONTENT}${SRC_TAG}"
    done
    ;;

  thesis-export)
    # Export thesis as markdown snapshot: pm-cli.sh thesis-export <symbol>
    # Assembles all DB parts into a single document
    EXPORT_SYM="$2"
    if [ -z "$EXPORT_SYM" ]; then
      echo "Usage: pm-cli.sh thesis-export <symbol>"
      exit 1
    fi
    EXPORT_SYM=$(echo "$EXPORT_SYM" | tr '[:lower:]' '[:upper:]')

    python3 - "$EXPORT_SYM" "$DB" << 'PYEOF'
import sqlite3, sys, datetime

symbol = sys.argv[1]
db_path = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

sec = conn.execute("SELECT id FROM securities WHERE symbol = ?", (symbol,)).fetchone()
if not sec:
    print(f"Error: {symbol} not found")
    sys.exit(1)
sec_id = sec['id']

now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

# --- Gather all parts ---

# Intent
intent = conn.execute("""
    SELECT pi.tier, pi.thesis, pi.invalidation, pi.entry_style,
           pi.target_hold_period, pi.target_allocation_pct
    FROM position_intents pi
    JOIN positions p ON pi.position_id = p.id
    WHERE p.security_id = ? LIMIT 1
""", (sec_id,)).fetchone()

# Position
pos = conn.execute("""
    SELECT SUM(p.quantity) as qty, SUM(p.cost_basis) as cost,
        (SELECT ph.close_price FROM price_history ph WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1) as price
    FROM positions p WHERE p.security_id = ? AND p.quantity > 0
""", (sec_id,)).fetchone()

# Recent score changes
score_changes = conn.execute("""
    SELECT criteria_number, old_status, new_status, reason, changed_at
    FROM thesis_score_changes WHERE security_id = ?
    ORDER BY changed_at DESC LIMIT 10
""", (sec_id,)).fetchall()

# Observations
observations = conn.execute("""
    SELECT observation_date as date, note, thesis_impact FROM observations
    WHERE security_id = ? ORDER BY observation_date DESC LIMIT 20
""", (sec_id,)).fetchall()

# Research notes
notes = conn.execute("""
    SELECT section, content, source, created_at FROM research_notes
    WHERE symbol = ? ORDER BY section, created_at
""", (symbol,)).fetchall()

# Valuation
val = conn.execute("""
    SELECT * FROM valuation_metrics WHERE symbol = ? ORDER BY date DESC LIMIT 1
""", (symbol,)).fetchone()

# Earnings reviews
reviews = conn.execute("""
    SELECT quarter, earnings_date, revenue_expected, revenue_actual,
           eps_expected, eps_actual, growth_trajectory, thesis_impact,
           decision, decision_notes
    FROM earnings_reviews WHERE security_id = ?
    ORDER BY earnings_date DESC LIMIT 5
""", (sec_id,)).fetchall()

# S/R levels
levels = conn.execute("""
    SELECT level_type, price, strength FROM price_levels
    WHERE symbol = ? ORDER BY price
""", (symbol,)).fetchall()

# --- Assemble ---
lines = []
lines.append(f"# {symbol} — Thesis Snapshot")
lines.append(f"*Exported {now} from portfolio-manager DB*\n")

# Position
if intent:
    lines.append("## Position")
    lines.append(f"- **Tier**: {intent['tier'] or '—'}")
    lines.append(f"- **Target Allocation**: {intent['target_allocation_pct'] or '—'}%")
    if pos and pos['qty']:
        qty = int(pos['qty'])
        price = pos['price'] or 0
        cost = pos['cost'] or 0
        mv = qty * price
        avg = cost / qty if qty > 0 else 0
        pnl_pct = ((price - avg) / avg * 100) if avg > 0 else 0
        lines.append(f"- **Shares**: {qty} @ ${avg:.2f} avg → ${price:.2f} ({pnl_pct:+.1f}%)")
        lines.append(f"- **Market Value**: ${mv:,.0f}")
    lines.append(f"- **Hold Period**: {intent['target_hold_period'] or '—'}")
    lines.append("")

# Thesis & Invalidation
if intent:
    lines.append("## Thesis")
    lines.append(f"{intent['thesis'] or 'No thesis documented.'}\n")
    lines.append("## Invalidation Conditions")
    lines.append(f"{intent['invalidation'] or 'No invalidation documented.'}\n")

# Scorecard — read from thesis doc on disk if exists
import os
thesis_disk = os.path.expanduser(f"~/workspace/portfolio-manager/docs/positions/{symbol}/thesis.md")
if os.path.exists(thesis_disk):
    with open(thesis_disk) as f:
        content = f.read()
    # Extract bull/bear tables if present
    for section_name in ['Bull Criteria', 'Bear Criteria']:
        idx = content.find(section_name)
        if idx >= 0:
            # Find the table after the header
            table_start = content.find('|', idx)
            if table_start >= 0:
                table_end = content.find('\n\n', table_start)
                if table_end < 0: table_end = len(content)
                table_block = content[idx:table_end].strip()
                if 'Scorecard' not in ''.join(lines):
                    lines.append("## Scorecard")
                lines.append(f"\n### {section_name}")
                for line in table_block.split('\n')[1:]:  # skip the header "### Bull Criteria"
                    lines.append(line)
    if 'Scorecard' in ''.join(lines):
        lines.append("")

# Score changes (from DB — always available)
if score_changes:
    lines.append("### Recent Score Changes")
    for sc in score_changes:
        lines.append(f"- **{sc['changed_at'][:10]}** {sc['criteria_number']}: {sc['old_status']} → {sc['new_status']} — {sc['reason']}")
    lines.append("")

# Valuation
if val:
    lines.append("## Valuation")
    lines.append(f"- T12 PE: {val['trailing_pe']:.1f}x" if val['trailing_pe'] else "- T12 PE: N/A")
    lines.append(f"- Forward PE: {val['forward_pe']:.1f}x" if val['forward_pe'] else "- Forward PE: N/A (ADR)")
    lines.append(f"- PEG (forward): {val['forward_peg']:.2f}" if val['forward_peg'] else "- PEG: N/A")
    lines.append(f"- Rating: **{val['peg_rating']}**" if val['peg_rating'] else "- Rating: N/A")
    if val['eps_growth_pct']:
        lines.append(f"- EPS Growth: {val['eps_growth_pct']:+.1f}%")
    if val['fair_low'] and val['fair_high']:
        lines.append(f"- Fair Range: ${val['fair_low']:.0f} – ${val['fair_mid']:.0f} – ${val['fair_high']:.0f}")
    lines.append(f"- *As of {val['date']}*")
    lines.append("")

# S/R Levels
if levels:
    supports = [l for l in levels if l['level_type'] == 'support']
    resistances = [l for l in levels if l['level_type'] == 'resistance']
    lines.append("## Support / Resistance")
    for s in supports:
        lines.append(f"- S ${s['price']:.2f} (strength {s['strength']}/10)")
    for r in resistances:
        lines.append(f"- R ${r['price']:.2f} (strength {r['strength']}/10)")
    lines.append("")

# Research Notes
if notes:
    lines.append("## Research Notes")
    current_section = None
    for n in notes:
        if n['section'] != current_section:
            current_section = n['section']
            lines.append(f"\n### {current_section.replace('_', ' ').title()}")
        src = f" [{n['source']}]" if n['source'] else ""
        lines.append(f"- *{n['created_at'][:10]}*: {n['content']}{src}")
    lines.append("")

# Observations
if observations:
    lines.append("## Observations (recent)")
    for o in observations:
        impact = {'supports': '+', 'challenges': '-', 'neutral': '~'}.get(o['thesis_impact'] or '', '~')
        lines.append(f"- **{o['date'][:10]}** [{impact}] {o['note']}")
    lines.append("")

# Earnings Reviews
if reviews:
    lines.append("## Earnings Reviews")
    for r in reviews:
        rev_str = f"Rev: {r['revenue_actual'] or '?'} vs {r['revenue_expected'] or '?'}" if r['revenue_expected'] else ""
        eps_str = f"EPS: {r['eps_actual'] or '?'} vs {r['eps_expected'] or '?'}" if r['eps_expected'] else ""
        lines.append(f"### {r['quarter']} ({r['earnings_date']})")
        if rev_str: lines.append(f"- {rev_str}")
        if eps_str: lines.append(f"- {eps_str}")
        lines.append(f"- Trajectory: {r['growth_trajectory']} | Impact: **{r['thesis_impact']}**")
        if r['decision']:
            lines.append(f"- Decision: {r['decision']}")
        if r['decision_notes']:
            lines.append(f"- Notes: {r['decision_notes']}")
    lines.append("")

# Output
output = "\n".join(lines)
print(output)

# Also write to docs/positions/<SYMBOL>/thesis.md
import os
thesis_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(db_path))), "workspace", "portfolio-manager", "docs", "positions", symbol)
# Try the standard path
thesis_dir = os.path.expanduser(f"~/workspace/portfolio-manager/docs/positions/{symbol}")
os.makedirs(thesis_dir, exist_ok=True)
thesis_path = os.path.join(thesis_dir, "thesis.md")
with open(thesis_path, "w") as f:
    f.write(output)
print(f"\n--- Exported to {thesis_path} ---")

conn.close()
PYEOF
    ;;

esac
