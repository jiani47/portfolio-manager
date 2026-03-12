# Pre-Trade Checklist Design

## Context

Phase 7 of the roadmap. Orders currently go to Schwab with minimal validation — no thesis checks, no regime awareness, no position sizing guardrails. The checklist adds governance friction before order placement without blocking action.

## Design Decisions

- **Soft gate**: all items are warnings, never hard blocks. User acknowledges and overrides to proceed.
- **Both paths**: shared backend `PreTradeValidator` service called by UI (Orders page) and CLI (`pm-cli.sh buy/sell`).
- **Hybrid evaluation**: auto-evaluate what's computable (tier, thesis, regime, sizing), manual acknowledgment for judgment calls.
- **Audit trail**: every checklist run stored in `pre_trade_checks` table for Phase 9 pattern detection.
- **Two checklists**: investing vs trading, routed by account book designation.

## Architecture

```
Order intent
  → IPC: 'pre-trade:evaluate' → PreTradeValidator.evaluate(order)
    → determines book (investing/trading) from account
    → runs auto-checks against DB (intents, rituals, positions, portfolio value)
    → returns ChecklistResult[] with manual items marked as "needs_ack"
  → caller (UI or CLI) presents results
  → user acknowledges/overrides failed items
  → IPC: 'pre-trade:record' → PreTradeValidator.record(results, overrides)
  → order proceeds to Schwab API
```

## Checklist Items

### Investing Book

| # | Check | Type | Logic |
|---|-------|------|-------|
| 1 | Intent confirmed | auto | Position intent exists with tier assigned |
| 2 | Thesis documented | auto | intent.thesis is non-empty |
| 3 | Invalidation defined | auto | intent.invalidation is non-empty |
| 4 | Regime read done today | auto | daily_rituals has entry with regime_type set |
| 5 | Sorting day awareness | auto/warn | If buy + sorting day: warn "adds typically disabled on sorting days" |
| 6 | Position size within tier limits | auto | After-trade % within guidelines (Core ≤25%, Growth ≤10%, Starter ≤5%) |
| 7 | Expect to hold months+ | manual | "This is an investment, not a trade" |
| 8 | Would hold through 20-30% drawdown | manual | Final gut check |

### Trading Book

| # | Check | Type | Logic |
|---|-------|------|-------|
| 1 | Separate account confirmed | auto | Account book = 'trading' |
| 2 | Regime read done today | auto | Same as investing #4 |
| 3 | Sorting day awareness | auto/warn | Same as investing #5 (buys only) |
| 4 | Position size ≤ 1% of portfolio | auto | After-trade value / total portfolio ≤ 1% |
| 5 | Invalidation/stop defined | manual | "I have a stop level — technical, not emotional" |
| 6 | Exit if no progress in 20-30 days | manual | Time discipline acknowledgment |
| 7 | Accept stop-out as success | manual | "Not hoping, not averaging down" |

### Sell Orders (Both Books)

Lighter checklist — regime read + manual "reason for sell" prompt. No sizing or thesis checks.

## Data Model

### `pre_trade_checks` table

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| order_symbol | TEXT | Symbol being traded |
| order_side | TEXT | buy/sell |
| order_qty | REAL | Quantity |
| account_id | TEXT | Account |
| book | TEXT | investing/trading |
| checks_json | TEXT | JSON array of check results |
| overrides | TEXT | JSON array of overridden item IDs |
| passed | INTEGER | 1 if all passed/overridden, 0 if abandoned |
| created_at | TEXT | Timestamp |

`checks_json` format: `[{ id, label, type: "auto"|"manual", status: "pass"|"fail"|"warn", value?, overridden? }]`

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/main/pre-trade-validator.ts` | New service: evaluate() and record() |
| `src/main/database.ts` | pre_trade_checks table, CRUD methods |
| `src/main/ipc-handlers.ts` | pre-trade:evaluate, pre-trade:record handlers |
| `src/main/preload.ts` | Expose IPC methods |
| `src/renderer/hooks/useApi.ts` | usePreTradeCheck hook |
| `src/renderer/pages/Orders.tsx` | Checklist UI between form and confirmation |
| `src/shared/types.ts` | PreTradeCheck, CheckItem types |
| `scripts/pm-cli.sh` | Call evaluate before order, print checklist |

## UI Flow (Orders Page)

1. User fills order form, clicks "Review Order"
2. Instead of going straight to confirmation, app calls `pre-trade:evaluate`
3. Checklist panel appears showing all items with pass/fail/warn status
4. Failed auto-checks and manual items require acknowledgment (checkbox)
5. User clicks "Proceed" (all acknowledged) or "Cancel"
6. On proceed: record checklist, then show existing confirmation dialog
7. On confirm: place order via Schwab

## CLI Flow

1. User runs `pm-cli.sh buy 10 AAPL at 200 DAY`
2. Before confirmation prompt, CLI calls a new `pm-cli.sh pre-trade-check` subcommand internally
3. Prints checklist with pass/fail/warn items
4. Manual items shown as questions requiring y/n
5. If any failures: "Override and proceed? (y/n)"
6. On proceed: record checklist, then place order

## Verification

1. `npm run build:main && npm run build:renderer` compiles
2. Place a buy order via UI on investing account — see investing checklist
3. Place a buy order via UI on trading account — see trading checklist
4. Place a sell order — see lighter sell checklist
5. Override a failed check — order proceeds, override recorded
6. Abandon a checklist — recorded as passed=0
7. `pm-cli.sh buy` shows checklist before confirmation
8. Query `pre_trade_checks` table — full audit trail present
