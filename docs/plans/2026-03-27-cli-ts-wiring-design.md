# CLI → TypeScript Analytics Wiring

## Problem

The CLI (`scripts/pm-cli.sh`, ~12K lines) embeds business logic in 166 inline Python blocks and raw bash. The same formulas exist as tested TypeScript in `src/shared/analytics/` (9 modules, 180 tests). The CLI can't use them because it has no Node.js integration.

Additionally, the Python blocks contain their own DB queries (via `sqlite3` module) interleaved with computation — untyped, untested, and duplicated from the Electron main process.

## Approach: Thin `tsx` Runner + TypeScript CLI Commands

The bash CLI becomes a thin shell: argument parsing and output formatting. All data loading (DB queries) and computation move to TypeScript, where they get proper typing and test coverage.

```
CLI command (bash) → run-ts.sh <command> [args] → tsx src/cli/<command>.ts → JSON result → bash formats output
```

### Why this approach

- **Zero build step** — `tsx` runs TypeScript directly, no compile needed
- **Natural fit** — CLI already shells out to external tools (sqlite3, python3, curl)
- **Incremental** — replace one command at a time, keep everything else
- **~200ms startup** — acceptable for interactive CLI (not called in tight loops)
- **Full type safety** — DB queries use better-sqlite3 with typed row mappers (same as Electron main)
- **Testable end-to-end** — DB loading + computation in one typed function = one test

## Architecture

### Layer split

```
┌─────────────────────────────────┐
│  Bash (presentation layer)      │  scripts/commands/*.sh
│  • Arg parsing, routing         │
│  • Output formatting (printf)   │
│  • Color codes, table layout    │
│  • User prompts / confirmations │
└──────────────┬──────────────────┘
               │ JSON on stdout
┌──────────────┴──────────────────┐
│  CLI commands (orchestration)   │  src/cli/commands/*.ts
│  • Calls repository for data    │
│  • Maps DB rows → analytics in  │
│  • Calls analytics functions    │
│  • Returns typed result as JSON │
└──────┬───────────────┬──────────┘
       │ imports       │ imports
┌──────┴──────┐  ┌─────┴──────────┐
│  Repository │  │  Analytics     │  src/shared/analytics/*.ts
│  (data)     │  │  (pure fns)    │
│             │  │                │
│  Typed SQL  │  │  No DB deps    │
│  Row maps   │  │  180 tests     │
│  Read-only  │  │                │
└─────────────┘  └────────────────┘
 src/shared/repositories/*.ts
```

### Key constraint: No raw SQL outside repositories

All database queries live in `src/shared/repositories/`. CLI commands, analytics modules, and future consumers never execute SQL directly — they call repository methods that return typed objects.

This gives us:
- **One place to change** when schema evolves
- **Typed returns** — row mappers colocated with queries
- **Testable** — repository methods tested against fixture DB
- **Reusable** — Electron main process can migrate to these same repositories over time, replacing the monolithic `database.ts` (4,174 lines)

### Components

#### 1. `scripts/run-ts.sh` — Shell wrapper

```bash
#!/bin/bash
# Usage: run-ts.sh <command> [args...]
# Example: run-ts.sh drift
# Example: run-ts.sh size AAPL 8
# Outputs JSON to stdout, errors to stderr
```

- Resolves project root and tsx binary
- Passes command name + args to the TypeScript entry point
- Passes `$DB` path as env var (or derives from standard location)

#### 2. `src/cli/index.ts` — TypeScript entry point

Single dispatcher that:
- Reads command name from argv[2]
- Routes to the appropriate command module
- Handles errors (writes to stderr, exits non-zero)

```typescript
const COMMANDS: Record<string, (args: string[]) => unknown> = {
  drift: (args) => require('./commands/drift').run(args),
  size: (args) => require('./commands/size').run(args),
  valuation: (args) => require('./commands/valuation').run(args),
  // ...
};
```

#### 3. `src/shared/repositories/` — Data access layer

Typed repository classes that encapsulate all SQL queries. Each repository:
- Receives a `better-sqlite3` Database instance (injected, not created)
- Exposes methods that return typed objects (not raw rows)
- Owns the row mapper for its domain
- Is tested against an in-memory DB with known fixtures

```typescript
// src/shared/repositories/db.ts — Connection factory
import Database from 'better-sqlite3';

const DB_PATH = process.env.PM_DB ||
  `${process.env.HOME}/Library/Application Support/portfolio-manager/portfolio.db`;

export function openDb(opts?: { readonly?: boolean }): Database.Database {
  return new Database(DB_PATH, { readonly: opts?.readonly ?? true });
}
```

```typescript
// src/shared/repositories/position-repository.ts
import type Database from 'better-sqlite3';
import type { PositionInput } from '../analytics/allocation';

export class PositionRepository {
  constructor(private db: Database.Database) {}

  /** All non-zero positions with latest price, intent, and security type. */
  getAllWithPriceAndIntent(): PositionInput[] {
    const rows = this.db.prepare(`
      SELECT s.symbol, s.type as security_type, p.quantity, p.account_id,
        COALESCE((...latest price subquery...), 0) as price,
        pi.target_allocation_pct, pi.tier
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN position_intents pi ON pi.position_id = p.id
      WHERE p.quantity > 0
    `).all();

    return rows.map(r => ({
      symbol: r.symbol,
      quantity: r.quantity,
      price: r.price,
      securityType: r.security_type,
      targetAllocationPct: r.target_allocation_pct ?? null,
      tier: r.tier || 'Untagged',
      accountId: r.account_id,
    }));
  }
}
```

**Repository per domain:**

| Repository | Methods | Used by commands |
|------------|---------|-----------------|
| `PositionRepository` | `getAllWithPriceAndIntent()`, `getBySymbol()` | drift, size, attribution |
| `ValuationRepository` | `getLatest(symbol)`, `getAll()` | valuation, confluence, screen |
| `PriceHistoryRepository` | `getOHLCV(symbol, days)`, `getLatestClose(symbol)` | levels-refresh, attribution, size (ATR) |
| `PriceLevelRepository` | `getSupport(symbol)`, `getResistance(symbol)` | size, confluence, screen |
| `TradeRepository` | `getClosedTrades(filters?)`, `getOpenTrades()` | trade-stats |
| `ScorecardRepository` | `getThesisContent(symbol)` | scorecard (reads .md files, not DB) |

#### 4. `src/cli/commands/*.ts` — Per-command modules

Each command:
- Opens DB via `openDb()`
- Instantiates repository(ies)
- Calls repository methods for typed data
- Calls shared analytics functions
- Returns typed result (serialized as JSON to stdout)

```typescript
// src/cli/commands/drift.ts
import { openDb } from '../../shared/repositories/db';
import { PositionRepository } from '../../shared/repositories/position-repository';
import { calculateAllocationDrift } from '../../shared/analytics/allocation';

export function run(_args: string[]) {
  const db = openDb();
  const repo = new PositionRepository(db);

  const positions = repo.getAllWithPriceAndIntent();
  return calculateAllocationDrift({ positions });
}
```

No raw SQL in command files. The command is pure orchestration: repo → analytics → result.

### CLI integration pattern

```bash
# Before (inline Python, ~50 lines):
drift)
  python3 <<'PYEOF'
  import sqlite3
  conn = sqlite3.connect(sys.argv[1])
  # ... query + compute + format ...
  PYEOF
;;

# After (~5 lines):
drift)
  RESULT=$("$SCRIPT_DIR/run-ts.sh" drift)
  echo "$RESULT" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
for r in rows:
    # format and print (presentation only)
  "
;;
```

## Migration Priority

Ordered by value (lines of Python replaced × bug risk):

| # | Command | What moves to TS | DB queries | Analytics module | ~Lines |
|---|---------|-----------------|------------|------------------|--------|
| 1 | `drift` | Position loading + drift calc | positions, intents, prices | `allocation` | ~60 |
| 2 | `size` | Position loading + sizing + tranches | positions, intents, prices, price_levels, price_history (ATR) | `sizing` | ~120 |
| 3 | `valuation` | Metric loading + fair range | valuation_metrics | `valuation` | ~80 |
| 4 | `confluence` | Signal detection + data loading | valuation_metrics, price_levels, prices | `confluence` | ~70 |
| 5 | `screen` | Composite scoring + data loading | watchlist_items, valuation_metrics, price_levels | `confluence` | ~60 |
| 6 | `trade-stats` | Trade aggregation + stats | closed trades (FIFO derivation) | `trading` | ~80 |
| 7 | `scorecard` | Thesis file reading + parsing | filesystem (thesis.md) | `scorecard` | ~60 |
| 8 | `levels-refresh` | Price history loading + swing detection | price_history (6mo OHLCV) | `levels` | ~100 |
| 9 | `attribution` | Price/position loading + decomposition | price_history, positions, intents | `attribution` | ~80 |

**~710 lines of Python/bash** replaced with tested, typed TypeScript.

## What stays in bash

- **Output formatting** — printf, color codes, table layout (presentation layer)
- **Schwab token management** — OAuth flow in common.sh
- **Order placement** — buy/sell commands (write operations with user confirmation)
- **EMS basket operations** — stateful DB writes with complex state machine
- **Pre-trade validation** — governance gates with interactive prompts
- **API calls** — curl for FMP/Schwab data fetching (these feed the DB, not analytics)
- **Ritual workflow** — interactive prompts, ritual-set writes

## Data Flow

```
1. Bash receives user args (e.g., "pm-cli.sh size AAPL 8")
2. Bash calls: run-ts.sh size AAPL 8
3. TypeScript CLI command instantiates repository(ies)
4. Repository opens DB (better-sqlite3, read-only), runs typed queries
5. Repository returns typed objects to command
6. Command passes typed objects to shared analytics functions
7. Analytics returns typed result
8. Command writes JSON to stdout
9. Bash receives JSON, formats with printf/python for display
```

## Testing Strategy

Four layers, all with vitest:

1. **Analytics functions** — 180 existing tests (pure functions, no DB)
2. **Repository methods** — new tests with in-memory DB fixture
   - Create schema + seed known data in `beforeEach`
   - Assert typed return objects match expected shape and values
   - Tests SQL correctness and row mapping
3. **CLI command functions** — integration tests
   - In-memory DB with fixture data
   - Call `run()` directly, assert JSON output
   - Tests orchestration: repo → analytics → result
4. **Runner integration** — 1 smoke test: spawn `tsx src/cli/index.ts drift`, verify JSON parses

**Test DB fixture helper:**
```typescript
// src/shared/repositories/__tests__/fixture.ts
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  // Create schema (same DDL as database.ts)
  // Seed with known positions, securities, prices, intents
  return db;
}
```

## Dependencies

- `tsx` — already in devDependencies
- `better-sqlite3` — already in dependencies (Electron main uses it)
- No new packages needed

## Future: Electron main migration

The repositories in `src/shared/repositories/` are shared code — not CLI-specific. Over time, the Electron main process can import these same repositories to replace the monolithic `database.ts` (4,174 lines). This is not in scope now, but the architecture supports it:

```
src/shared/repositories/  ← shared
  ├── used by src/cli/commands/     (CLI)
  └── used by src/main/ipc-handlers (Electron, future)
```

## Not in scope

- Rewriting the full CLI in TypeScript
- Adding a Node argument parser (yargs/commander)
- Replacing output formatting (printf → chalk)
- Migrating write operations (set-intent, buy/sell, ritual-set)
- Migrating API call logic (FMP fetch, Schwab sync)
- Migrating Electron main to shared repositories (future phase)
