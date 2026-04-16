#!/usr/bin/env bash

# Thesis Review CLI Commands
# Manage AI-generated thesis update suggestions

show_pending_suggestions() {
  local symbol="${1:-}"
  local sql="
    SELECT
      tus.id,
      tus.symbol,
      tus.suggestion_type,
      tus.criteria_number,
      tus.old_status,
      tus.new_status,
      tus.observation_note,
      tus.thesis_impact,
      tus.rationale,
      tus.confidence,
      tus.suggested_at
    FROM thesis_update_suggestions tus
    WHERE tus.status = 'pending'
  "

  if [ -n "$symbol" ]; then
    sql="$sql AND tus.symbol = '$symbol'"
  fi

  sql="$sql ORDER BY tus.suggested_at DESC"

  local results=$(sqlite3 "$DB_PATH" -json "$sql")
  local count=$(echo "$results" | jq length)

  if [ "$count" -eq 0 ]; then
    echo "No pending thesis update suggestions."
    return 0
  fi

  echo "=== Pending Thesis Update Suggestions ($count) ==="
  echo ""

  echo "$results" | jq -r '.[] |
    "ID: \(.id)\n" +
    "Symbol: \(.symbol)\n" +
    "Type: \(.suggestion_type)\n" +
    (if .criteria_number then "Criterion: \(.criteria_number) (\(.old_status) → \(.new_status))\n" else "" end) +
    (if .observation_note then "Observation: \(.observation_note)\n" else "" end) +
    (if .thesis_impact then "Impact: \(.thesis_impact)\n" else "" end) +
    "Rationale: \(.rationale)\n" +
    "Confidence: \((.confidence * 100 | floor))%\n" +
    "Suggested: \(.suggested_at | split("T")[0])\n" +
    "---"'
}

approve_suggestion() {
  local suggestion_id="$1"

  if [ -z "$suggestion_id" ]; then
    echo "Usage: pm-cli.sh thesis-approve <suggestion_id>"
    return 1
  fi

  # Get suggestion details
  local suggestion=$(sqlite3 "$DB_PATH" -json "
    SELECT * FROM thesis_update_suggestions WHERE id = '$suggestion_id'
  " | jq -r '.[0]')

  if [ -z "$suggestion" ] || [ "$suggestion" = "null" ]; then
    echo "Error: Suggestion not found"
    return 1
  fi

  local symbol=$(echo "$suggestion" | jq -r '.symbol')
  local type=$(echo "$suggestion" | jq -r '.suggestion_type')
  local security_id=$(echo "$suggestion" | jq -r '.security_id')

  echo "Approving suggestion for $symbol..."

  local now=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  if [ "$type" = "scorecard_update" ]; then
    local criteria_number=$(echo "$suggestion" | jq -r '.criteria_number')
    local old_status=$(echo "$suggestion" | jq -r '.old_status // "unknown"')
    local new_status=$(echo "$suggestion" | jq -r '.new_status // "unknown"')
    local rationale=$(echo "$suggestion" | jq -r '.rationale')

    # Log the scorecard change
    local change_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
    sqlite3 "$DB_PATH" "
      INSERT INTO thesis_score_changes (id, security_id, criteria_number, old_status, new_status, reason, changed_at, created_at)
      VALUES ('$change_id', '$security_id', '$criteria_number', '$old_status', '$new_status', '$rationale', '$now', '$now')
    "

    echo "✓ Scorecard updated: $criteria_number ($old_status → $new_status)"

  elif [ "$type" = "observation" ]; then
    local observation_note=$(echo "$suggestion" | jq -r '.observation_note')
    local thesis_impact=$(echo "$suggestion" | jq -r '.thesis_impact // "neutral"')

    # Create observation
    local obs_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
    local today=$(date -u +"%Y-%m-%d")
    sqlite3 "$DB_PATH" "
      INSERT INTO observations (id, security_id, observation_date, note, source, thesis_impact, created_at)
      VALUES ('$obs_id', '$security_id', '$today', '$observation_note', 'AI analysis', '$thesis_impact', '$now')
    "

    echo "✓ Observation added: $observation_note"
  fi

  # Mark as approved
  sqlite3 "$DB_PATH" "
    UPDATE thesis_update_suggestions
    SET status = 'approved', reviewed_at = '$now', reviewed_by = 'CLI'
    WHERE id = '$suggestion_id'
  "

  echo "✓ Suggestion approved"
}

reject_suggestion() {
  local suggestion_id="$1"

  if [ -z "$suggestion_id" ]; then
    echo "Usage: pm-cli.sh thesis-reject <suggestion_id>"
    return 1
  fi

  local now=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  local count=$(sqlite3 "$DB_PATH" "
    UPDATE thesis_update_suggestions
    SET status = 'rejected', reviewed_at = '$now', reviewed_by = 'CLI'
    WHERE id = '$suggestion_id';
    SELECT changes();
  ")

  if [ "$count" -eq 0 ]; then
    echo "Error: Suggestion not found"
    return 1
  fi

  echo "✓ Suggestion rejected"
}

approve_all_for_symbol() {
  local symbol="$1"

  if [ -z "$symbol" ]; then
    echo "Usage: pm-cli.sh thesis-approve-all <symbol>"
    return 1
  fi

  local pending=$(sqlite3 "$DB_PATH" -json "
    SELECT id FROM thesis_update_suggestions
    WHERE symbol = '$symbol' AND status = 'pending'
  ")

  local count=$(echo "$pending" | jq length)

  if [ "$count" -eq 0 ]; then
    echo "No pending suggestions for $symbol"
    return 0
  fi

  echo "Approving $count suggestion(s) for $symbol..."

  echo "$pending" | jq -r '.[].id' | while read -r id; do
    approve_suggestion "$id"
  done

  echo ""
  echo "✓ Approved $count suggestion(s)"
}

show_review_history() {
  local symbol="${1:-}"
  local limit="${2:-20}"

  local sql="
    SELECT
      tus.symbol,
      tus.suggestion_type,
      tus.status,
      tus.rationale,
      tus.suggested_at,
      tus.reviewed_at,
      tus.reviewed_by
    FROM thesis_update_suggestions tus
    WHERE tus.status IN ('approved', 'rejected')
  "

  if [ -n "$symbol" ]; then
    sql="$sql AND tus.symbol = '$symbol'"
  fi

  sql="$sql ORDER BY tus.reviewed_at DESC LIMIT $limit"

  local results=$(sqlite3 "$DB_PATH" -json "$sql")
  local count=$(echo "$results" | jq length)

  if [ "$count" -eq 0 ]; then
    echo "No review history."
    return 0
  fi

  echo "=== Thesis Review History ($count) ==="
  echo ""

  echo "$results" | jq -r '.[] |
    "\(.symbol) | \(.suggestion_type) | \(.status | ascii_upcase) | \(.reviewed_at | split("T")[0])\n" +
    "  \(.rationale)\n" +
    "  Reviewed by: \(.reviewed_by)\n"'
}

show_thesis_review_stats() {
  echo "=== Thesis Review Statistics ==="
  echo ""

  # Pending count
  local pending=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM thesis_update_suggestions WHERE status = 'pending'")
  echo "Pending: $pending"

  # Approved today
  local today=$(date -u +"%Y-%m-%d")
  local approved_today=$(sqlite3 "$DB_PATH" "
    SELECT COUNT(*) FROM thesis_update_suggestions
    WHERE status = 'approved' AND date(reviewed_at) = '$today'
  ")
  echo "Approved today: $approved_today"

  # Rejected today
  local rejected_today=$(sqlite3 "$DB_PATH" "
    SELECT COUNT(*) FROM thesis_update_suggestions
    WHERE status = 'rejected' AND date(reviewed_at) = '$today'
  ")
  echo "Rejected today: $rejected_today"

  # Total by type
  echo ""
  echo "By type:"
  sqlite3 "$DB_PATH" "
    SELECT
      suggestion_type,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
    FROM thesis_update_suggestions
    GROUP BY suggestion_type
  " | while IFS='|' read -r type pend appr rej; do
    echo "  $type: $pend pending, $appr approved, $rej rejected"
  done

  # Queue size
  echo ""
  local queue_size=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM thesis_review_queue WHERE status = 'pending'")
  echo "News in review queue: $queue_size"
}

# Command dispatch
case "$CMD" in
  thesis-pending)
    show_pending_suggestions "${@:2}"
    ;;
  thesis-approve)
    approve_suggestion "${@:2}"
    ;;
  thesis-reject)
    reject_suggestion "${@:2}"
    ;;
  thesis-approve-all)
    approve_all_for_symbol "${@:2}"
    ;;
  thesis-history)
    show_review_history "${@:2}"
    ;;
  thesis-stats)
    show_thesis_review_stats
    ;;
esac
