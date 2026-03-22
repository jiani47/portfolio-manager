#!/bin/bash
# Portfolio Manager CLI — thin router
# Commands are implemented in scripts/commands/*.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/commands/common.sh"

# Show usage
show_usage() {
  cat << 'USAGE'
Usage: pm-cli.sh <command> [args...]

Portfolio:
  positions, cash, intents, set-intent, set-book, accounts, summary, drift

Ritual:
  morning, portfolio, briefing, ritual-today, ritual-set, ritual-history
  ritual-status, intent-history, intent-changes-today

Trading:
  buy, sell, orders, cancel-order, trade-enter, trade-setup, trade-open
  trade-close, trades, trade-stats

EMS (Execution Management):
  basket-create, baskets, basket, basket-add, basket-orders, basket-confirm
  basket-cancel, basket-fill, basket-fills, basket-status, basket-resize

Research:
  scorecard, scorecards, scorecard-update, scorecard-history, scorecard-add
  scorecard-rm, observe, observations, recall, note, notes, thesis-export
  research

Analytics:
  analytics, correlations, attribution

Monitors:
  monitors, monitor-add, monitor-dismiss, monitor-rm, monitor-reset
  monitor-add-note, earnings

Data:
  refresh, backfill, snapshot, snapshot-history, snapshot-position
  news, technicals, levels, levels-refresh, sectors, sync-transactions

Watchlists:
  watchlists, watchlist, watchlist-add, watchlist-rm, watchlist-create
  watchlist-delete

Planning:
  size, plan, plans, plan-fill, plan-cancel, valuation, valuations
  screen, confluence

Reviews:
  post-mortem, post-mortems, earnings-review, earnings-reviews
  earnings-review-decide, trade-journal, trade-analytics, broker-pl, reconcile
USAGE
}

CMD="$1"
if [ -z "$CMD" ]; then
  show_usage
  exit 1
fi

case "$CMD" in
  # Portfolio
  positions|cash|intents|set-intent|set-book|accounts|summary|drift)
    source "$SCRIPT_DIR/commands/portfolio.sh" ;;

  # Ritual
  morning|portfolio|briefing|triage|ritual-today|ritual-set|ritual-history|ritual-status|intent-history|intent-changes-today)
    source "$SCRIPT_DIR/commands/ritual.sh" ;;

  # Trading
  buy|sell|orders|cancel-order|trade-enter|trade-setup|trade-open|trade-close|trades|trade-stats)
    source "$SCRIPT_DIR/commands/pretrade.sh"
    source "$SCRIPT_DIR/commands/trading.sh" ;;

  # EMS
  basket-create|basket-add|baskets|basket|basket-orders|basket-confirm|basket-cancel|basket-fill|basket-fills|basket-status|basket-resize)
    source "$SCRIPT_DIR/commands/pretrade.sh"
    source "$SCRIPT_DIR/commands/ems.sh" ;;

  # Research
  scorecard|scorecards|scorecard-update|scorecard-history|scorecard-add|scorecard-rm|observe|observations|recall|note|notes|thesis-export|research)
    source "$SCRIPT_DIR/commands/pretrade.sh"
    source "$SCRIPT_DIR/commands/research.sh" ;;

  # Analytics
  analytics|correlations|attribution)
    source "$SCRIPT_DIR/commands/analytics.sh" ;;

  # Simulation
  whatif|stress|construct)
    source "$SCRIPT_DIR/commands/simulation.sh" ;;

  # Monitors
  monitors|monitor-add|monitor-dismiss|monitor-rm|monitor-reset|monitor-add-note|earnings)
    source "$SCRIPT_DIR/commands/monitors.sh" ;;

  # Data
  refresh|backfill|snapshot|snapshot-history|snapshot-position|news|technicals|levels|levels-refresh|sectors|sync-transactions)
    source "$SCRIPT_DIR/commands/data.sh" ;;

  # Watchlists
  watchlists|watchlist|watchlist-add|watchlist-rm|watchlist-create|watchlist-delete)
    source "$SCRIPT_DIR/commands/watchlists.sh" ;;

  # Planning
  size|plan|plans|plan-fill|plan-cancel|valuation|valuations|screen|confluence|scan-trades|earnings-prep|peers)
    source "$SCRIPT_DIR/commands/pretrade.sh"
    source "$SCRIPT_DIR/commands/planning.sh" ;;

  # Reviews
  post-mortem|post-mortems|earnings-review|earnings-reviews|earnings-review-decide|trade-journal|trade-analytics|broker-pl|reconcile)
    source "$SCRIPT_DIR/commands/pretrade.sh"
    source "$SCRIPT_DIR/commands/reviews.sh" ;;

  help|--help|-h)
    show_usage ;;

  *)
    echo "Unknown command: $CMD"
    echo "Run 'pm-cli.sh help' for usage."
    exit 1 ;;
esac
