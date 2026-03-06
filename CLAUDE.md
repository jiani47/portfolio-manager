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
./scripts/pm-cli.sh positions    # List all non-cash positions with intents
./scripts/pm-cli.sh cash         # List cash positions
./scripts/pm-cli.sh intents      # List all position intents
./scripts/pm-cli.sh accounts     # List accounts with book designation
./scripts/pm-cli.sh summary      # Portfolio summary with tier coverage
./scripts/pm-cli.sh set-intent <position_id> <tier> <thesis> <invalidation> [entry_style] [hold_period]
./scripts/pm-cli.sh set-book <account_id> <investing|trading>
```

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
