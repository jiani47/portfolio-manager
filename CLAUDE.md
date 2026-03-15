# Portfolio Manager - Claude Code Guide

## Project Overview
Electron desktop app for portfolio management. TypeScript + React + SQLite (better-sqlite3). Tailwind CSS for styling.

## Architecture
- `src/main/` — Electron main process (database, IPC handlers, services)
- `src/renderer/` — React frontend (pages, hooks, components)
- `src/shared/types.ts` — Shared type definitions
- Main↔Renderer communication via IPC (preload.ts exposes methods)

## Key Files
- `src/main/database.ts` — SQLite schema, migrations (ALTER TABLE try/catch pattern), all CRUD methods, row mappers
- `src/main/ipc-handlers.ts` — IPC handler registration
- `src/main/preload.ts` — contextBridge API exposure
- `src/renderer/hooks/useApi.ts` — React hooks + `Window.electronAPI` type declaration
- `src/renderer/pages/Holdings.tsx` — Main portfolio view with position tables
- `src/renderer/pages/Dashboard.tsx` — Summary dashboard with charts
- `src/renderer/pages/Accounts.tsx` — Account management

## Database
- Path: `~/Library/Application Support/portfolio-manager/portfolio.db`
- SQLite with WAL mode, better-sqlite3 (synchronous API)
- Migrations: try `ALTER TABLE ADD COLUMN`, catch if exists (see database.ts ~line 300)
- All IDs are UUIDs (v4)

## CLI Database Access
`scripts/pm-cli.sh` provides direct database access for Claude Code:
```
./scripts/pm-cli.sh morning                # Full morning: refresh + briefing + ritual status
./scripts/pm-cli.sh portfolio              # Full view: positions + summary + intent changes
./scripts/pm-cli.sh refresh                # Refresh prices via Schwab API (no app needed)
./scripts/pm-cli.sh briefing               # Morning briefing: portfolio quotes, market context
./scripts/pm-cli.sh positions              # List all non-cash positions with intents
./scripts/pm-cli.sh cash                   # List cash positions
./scripts/pm-cli.sh intents                # List all position intents
./scripts/pm-cli.sh accounts               # List accounts with book designation
./scripts/pm-cli.sh summary                # Portfolio summary with tier coverage
./scripts/pm-cli.sh set-intent <position_id> <tier> <thesis> <invalidation> [entry_style] [hold_period]
./scripts/pm-cli.sh set-book <account_id> <investing|trading>
./scripts/pm-cli.sh ritual-today           # Show today's ritual (or "not started")
./scripts/pm-cli.sh ritual-set <field> <value>  # Set a field on today's ritual
./scripts/pm-cli.sh ritual-history [n]     # Last n rituals (default 5)
./scripts/pm-cli.sh ritual-status          # Quick: regime set? action chosen? journal written?
./scripts/pm-cli.sh intent-history [positionId]  # Show change log for a position (or all)
./scripts/pm-cli.sh intent-changes-today   # Show all intent changes made today
./scripts/pm-cli.sh watchlists               # List all watchlists
./scripts/pm-cli.sh watchlist <name>          # Show items with prices vs targets
./scripts/pm-cli.sh watchlist-add <list> <symbol> [target] [thesis]
./scripts/pm-cli.sh watchlist-rm <list> <symbol>
./scripts/pm-cli.sh watchlist-create <name> [description]
./scripts/pm-cli.sh watchlist-delete <name>
./scripts/pm-cli.sh monitors                # List active + triggered monitors
./scripts/pm-cli.sh monitor-add <symbol> <above|below> <price> <label> [action_required]
./scripts/pm-cli.sh monitor-dismiss <id>     # Dismiss a triggered monitor
./scripts/pm-cli.sh monitor-rm <id>          # Delete a monitor
./scripts/pm-cli.sh monitor-reset <id>       # Re-arm a monitor
./scripts/pm-cli.sh monitor-add-note <sym> <label> [date]  # Fundamental monitor (no price trigger)
./scripts/pm-cli.sh earnings [days]          # Upcoming earnings for portfolio (default 14 days)
./scripts/pm-cli.sh analytics [days]         # Portfolio analytics: beta, sharpe, drawdown (default 90)
./scripts/pm-cli.sh backfill [symbol]        # Backfill 3yr price history from Schwab (all if no arg)
./scripts/pm-cli.sh snapshot              # Take EOD portfolio snapshot (one per day)
./scripts/pm-cli.sh snapshot-history [n]  # Portfolio totals for last n days (default 30)
./scripts/pm-cli.sh snapshot-position <symbol> [days]  # Position history over time
./scripts/pm-cli.sh news [symbol]         # Recent news (24h all, 7d per symbol)
./scripts/pm-cli.sh technicals [symbol]  # Technical indicators: SMA 20/50/200, RSI (via FMP)
./scripts/pm-cli.sh levels [symbol]      # Support/resistance levels with risk/reward
./scripts/pm-cli.sh levels-refresh [sym] # Recompute S/R from price history swing highs/lows
./scripts/pm-cli.sh sectors [date]       # Sector performance heatmap (via FMP)
./scripts/pm-cli.sh trade-journal [symbol] [days]  # Trade journal with regime/decision context (default 90d)
./scripts/pm-cli.sh buy <qty> <sym> <at <price>|market> <DAY|GTC> [acct]   # Place buy order
./scripts/pm-cli.sh sell <qty> <sym> <at <price>|market|stop <price>> <DAY|GTC> [acct]  # Place sell order
./scripts/pm-cli.sh orders [all]        # List orders (open, or all including filled)
./scripts/pm-cli.sh cancel-order <id>   # Cancel order by ID
./scripts/pm-cli.sh post-mortem <symbol>  # Interactive post-mortem for a closed position
./scripts/pm-cli.sh post-mortems [symbol] # List post-mortems (optionally filtered by symbol)
./scripts/pm-cli.sh earnings-review <symbol>  # Interactive post-earnings review checklist
./scripts/pm-cli.sh earnings-reviews [symbol] # List earnings reviews (optionally filtered)
./scripts/pm-cli.sh earnings-review-decide <id> # Decide on a pending earnings review
./scripts/pm-cli.sh recall <symbol>       # Decision memory: trades, post-mortems, decisions, intents
./scripts/pm-cli.sh size <symbol> [target] # Position sizing: current vs target, entry plan with S/R tranches
./scripts/pm-cli.sh reconcile <csv_path>  # Import Schwab realized P&L CSV
./scripts/pm-cli.sh broker-pl [symbol]    # Broker P&L summary (or per-lot detail)
```

## Daily PM Ritual

Run with the user in conversation. Three phases across the day.

### Pre-Market (~5 min, before open)
1. Run `pm-cli.sh briefing` — overnight news, futures, portfolio quotes, S/R proximity, technical signals
2. Summarize: what's moving, any overnight news that challenges a thesis
3. Flag tier misalignments — only surface if a position size is misaligned with its tier (e.g. Starter grown to Growth-sized)
4. No regime read yet — pre-market liquidity is thin, can't determine what's being rewarded/punished

### Mid-Morning (~10 min, after 10:30am)
1. Run `pm-cli.sh sectors` to pull sector performance heatmap from FMP
2. Regime read — based on actual price action, sector rotation, breadth:
   - "What's being rewarded? What's being punished?" (informed by sector data)
   - "Trend day or sorting day?"
3. Record via: `pm-cli.sh ritual-set regime_rewarding "..."`, `ritual-set regime_punishing "..."`, `ritual-set regime_type trend|sorting`
4. If sorting day: adds are disabled
5. Decision gate (now informed by regime):
   - "One action today: reduce, re-tier, add, or nothing?"
   - Record: `pm-cli.sh ritual-set action_chosen "reduce|retier|add|nothing"`
   - If action chosen, record detail: `pm-cli.sh ritual-set action_detail "..."`
   - Enforce: action must be regime-consistent

### EOD
1. Ask: "One sentence — today I did/didn't act because ___"
2. Record: `pm-cli.sh ritual-set journal "..."`

## Build Commands
- `npm run build:main` — TypeScript compile main process
- `npm run build:renderer` — Vite build renderer
- `npm run dev` — Development mode (electron-vite)

## Conventions
- Tags are free-text, not hardcoded tier names
- `book` is on accounts (investing/trading), not positions
- Position intents are 1:1 with positions, CASCADE delete
- Risk shape views are client-side computed (no extra DB queries)
- DB column names use snake_case, TypeScript uses camelCase
- Row mappers convert between the two (e.g., `mapRowToAccount`)

## Data Providers
Supports FMP, Massive API, and Schwab (with WebSocket streaming for real-time quotes).
Unified `data:refresh-prices` handler auto-routes to configured provider.

## Accounts
- Schwab 8819 — Jia's individual brokerage
- Schwab 6196 — Monica's individual brokerage
- Schwab 4005 — (smaller account)
