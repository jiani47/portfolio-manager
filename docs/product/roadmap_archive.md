# Portfolio Manager — Completed Phases (Archive)

This file contains completed roadmap phases moved from the active roadmap. See `roadmap.md` for remaining and planned work.

---

## Phase 1: Position Baseline & Classification ✅

**Goal:** Every position has a clear identity — tier, book, thesis, and invalidation conditions. This is the foundation everything else builds on.

### 1.1 Tier & Book Tagging ✅

Implemented as position intents with tier field (Core, Growth, Starter, Watchlist) and book on accounts (investing/trading).

### 1.2 Position Intent Capture ✅

Each position has: tier, thesis, invalidation, entry style, target hold period. Stored in `position_intents` table with 1:1 relationship to positions.

### 1.3 Risk Shape View ✅

Client-side computed tier concentration, book split, sector exposure. Displayed on Holdings page.

---

## Phase 2: Daily PM Ritual ✅

**Goal:** A guided 20-25 minute workflow that enforces the 3-pass decision process.

### 2.1 Regime Read ✅
Conversational with Claude Code. Regime (rewarding/punishing/type) stored in `daily_rituals` table.

### 2.2 Portfolio Alignment ✅
Walk through positions by tier via `pm-cli.sh positions`. Intent changes auto-logged to `position_intent_change_logs`.

### 2.3 Decision Gate ✅
One action per day. Action + detail stored in ritual record.

### 2.4 End-of-Day Journal ✅
One-sentence journal stored in ritual record.

### 2.5 Morning Briefing ✅
`pm-cli.sh morning` — refreshes prices via Schwab API, shows market context + portfolio quotes + P&L + movers.

### 2.6 CLI Infrastructure ✅
`pm-cli.sh` with auto-approved commands: morning, portfolio, refresh, briefing, positions, intents, ritual-set, etc. Order placement still requires manual approval.

---

## Phase 2.5: Housekeeping & Data Quality ✅

**Goal:** Clean up legacy data, align app terminology with actual usage.

### 2.5.1 Holdings Tags Cleanup ✅
- [x] Rename "security tags" → "holdings tags" throughout the app
- [x] Update DB seed tags from (core, event/macro, satellite) → (core, growth, starter, watchlist)
- [x] Align with position intent tier values
- [x] Migration code for existing DBs (idempotent)

### 2.5.2 Thesis Documentation ✅
- [x] Write thesis doc for each position in `docs/thesis/` (all 22 positions covered)
- [x] Include: thesis, invalidation framework, key levels, decision log

---

## Phase 3: Watchlists ✅

**Goal:** Organized watchlists with clear themes and goals, not a dumping ground.

### 3.1 Schwab Watchlist Integration ✅
- [x] Schwab API dropped watchlist endpoints — built custom system instead
- [x] Watchlist symbols included in Schwab price refresh

### 3.2 Themed Watchlist System ✅
- [x] Multiple named watchlists with description/theme
- [x] Each entry has: symbol, notes, target entry price, target exit price, thesis snippet
- [x] DB tables (`watchlists`, `watchlist_items`), IPC handlers, preload, React hook
- [x] App page with sidebar, item table, add/delete controls
- [x] Seeded: "dip-reentry" watchlist with SHOP@$120

### 3.3 Watchlist in CLI ✅
- [x] `pm-cli.sh watchlist [name]` — show items with prices vs targets
- [x] `watchlists`, `watchlist-add`, `watchlist-rm`, `watchlist-create`, `watchlist-delete`
- [x] Morning briefing alerts: items within 5% of target entry price

---

## Phase 4: Monitors & Alerts ✅

**Goal:** Turn thesis validation/invalidation rules into active monitors that surface when conditions change.

### 4.1 Price Monitors ✅
- [x] `monitors` table with symbol, direction, price level, label, action type, status
- [x] CLI: `monitor-add`, `monitor-dismiss`, `monitor-rm`, `monitor-reset`, `monitors`
- [x] Trigger during `pm-cli.sh refresh` — print alerts inline
- [x] Trigger during Electron WebSocket streaming — desktop notifications
- [x] Triggered monitors shown at top of morning briefing
- [x] Monitors page in app (view, add, dismiss, delete)
- [x] Seeded 18 monitors from thesis doc price levels

### 4.2 Watchlist Proximity Monitors ✅
- [x] Auto-create price monitors from watchlist items with target entry prices
- [x] Linked via `linked_watchlist_item_id` FK — auto-sync on add/update/remove
- [x] Real-time alerting via existing WebSocket streaming + extended hours polling

### 4.3 Earnings Date Monitors ✅
- [x] `pm-cli.sh earnings [days]` — upcoming earnings for portfolio symbols (FMP API)
- [x] Auto-create earnings monitors (expires day after earnings) via `syncEarningsMonitors()`
- [x] Earnings section in morning briefing
- [x] Monitors auto-cleaned after expiration

### 4.4 Manual/Fundamental Monitors ✅
- [x] `pm-cli.sh monitor-add-note <symbol> <label> [reminder_date]`
- [x] Fundamental reminders surfaced in morning briefing when due
- [x] Monitors page updated with type filter (Price/Earnings/Fundamental) and multi-type add form

### 4.5 Earnings Gap-Up Warning ✅

**Motivation:** NVDA post-mortem — chased a gap-up buy at $202 after earnings without checking resistance. Gap-ups after earnings are high-risk entry points.

- [x] Detect when a symbol has gapped up >5% in the last 5 trading days
- [x] Surface warning in pre-trade buy flow with mean reversion risk
- [x] Show nearest resistance level and distance
- [x] CLI + TypeScript integration in pre-trade flow

### 4.6 External Push ✅
- [x] ntfy.sh push notifications to iOS/Mac (topic: pm-alerts-061bd711, config in ~/.pm-cli.conf)
- [x] Monitor triggers (urgent for action_required, high for informational)
- [x] EMS date triggers + EOD reconcile results
- [x] CLI refresh + Electron streaming + scheduler all wired

---

## Phase 5: Data Infrastructure ✅

**Goal:** Rich historical data for analysis, snapshots for retro, and real-time news.

### 5.1 Historical Price Backfill ✅
- [x] `pm-cli.sh backfill [symbol]` — 3yr daily OHLCV from Schwab API
- [x] 50,735 candles across 73 symbols (portfolio + watchlists)
- [x] Daily refresh now writes full OHLC (not just close+volume)
- [x] Idempotent (INSERT OR IGNORE on existing dates)

### 5.2 Daily Portfolio Snapshots ✅
- [x] `pm-cli.sh snapshot` — EOD snapshot aggregated by symbol across accounts
- [x] `portfolio_snapshots` table: symbol, quantity, cost_basis, close_price, market_value, unrealized_gain, day_change, day_pnl
- [x] `pm-cli.sh snapshot-history [n]` — portfolio totals over last N days
- [x] `pm-cli.sh snapshot-position <symbol> [days]` — per-symbol history

### 5.3 News Feed ✅
- [x] FMP stock news API (already configured, uses existing `FMP_API_KEY`)
- [x] `news` table with 30-day retention, deduped by symbol+title
- [x] Fetched during `pm-cli.sh refresh`, batched 10 symbols at a time
- [x] `pm-cli.sh news [symbol]` — recent news (24h all, 7d per symbol)
- [x] Overnight news section in morning briefing (portfolio + watchlist symbols, top 3 per symbol)

---

## Phase 6: Technical Analysis & Decision Support ✅

**Goal:** Equip with data to make real-time decisions — support/resistance, technicals, risk/reward.

### 6.1 Support & Resistance Levels ✅
- [x] Compute swing highs/lows from 6 months of price_history (5-day window)
- [x] Cluster nearby levels within 2%, track strength (times tested)
- [x] Store in `price_levels` table, up to 5 support + 5 resistance per symbol
- [x] `pm-cli.sh levels [symbol]` — show levels with current price
- [x] `pm-cli.sh levels-refresh [symbol]` — recompute from price_history
- [x] S/R proximity alerts in morning briefing (within 3% of key level)

### 6.2 Technical Indicators ✅
- [x] FMP technical indicators API (SMA, RSI endpoints)
- [x] `pm-cli.sh technicals [symbol]` — SMA 20/50/200 + RSI(14), single or all portfolio symbols
- [x] Technical signals in morning briefing — notable conditions only (below DMA, overbought/oversold)
- [x] Live fetch from FMP, no storage needed

### 6.3 Risk/Reward Ratio ✅
- [x] For each position: distance to nearest support vs nearest resistance
- [x] R:R ratio computed and displayed in `pm-cli.sh levels`
- [x] Flag positions with R:R < 1 (more downside than upside)

---

## Phase 7: Pre-Trade Checklists ✅

**Goal:** Interactive gate before any order placement. Different checklists for investing vs trading accounts.

### 7.1 Investing Account Checklist ✅

Before any add/entry in the investing book:
- Intent confirmed (tier assigned)
- Thesis documented, invalidation defined
- Regime read done, sorting day awareness (warn, not block)
- Position size within tier limits (Core ≤25%, Growth ≤10%, Starter ≤5%)
- Manual: expect to hold months+, would hold through 20-30% drawdown

### 7.2 Trading Account Checklist ✅

Before any trade entry:
- Separate account confirmed
- Regime read done, sorting day awareness
- Position size ≤1% of portfolio
- Manual: stop defined, time discipline (20-30 days), accept stop-out

### 7.3 Integration ✅

- Orders page: checklist modal between Review and Confirm, with acknowledge/override
- CLI: `pm-cli.sh buy/sell` runs checklist before confirmation prompt
- Audit trail: all checklist results stored in `pre_trade_checks` table
- Soft gate: all items are warnings with override, never hard blocks

### 7.4 S/R Level Display in Pre-Trade ✅

**Motivation:** NVDA post-mortem — trimmed Core at $174-185 which was the support zone, and chased a gap-up buy at $202 without checking resistance.

- [x] Show S/R levels and zones for the symbol during every buy/sell pre-trade checklist
- [x] Warn if buying near resistance or selling near support (3% threshold)
- [x] CLI: auto-display levels in pre-trade flow
- [x] TypeScript PreTradeValidator: `checkSRLevels()` in all check paths

### 7.5 Panic Sell Cooling-Off ✅

**Motivation:** INTU, SHOP, SOFI — panic sells at or near support on red days. Recurring pattern: sell in fear, buy back higher.

- [x] Detect panic sell conditions: selling on a red day when price is within 3% of support
- [x] Surface past bad-execution loss lessons from post-mortems
- [x] Require explicit acknowledgment — not a block, but meaningful friction
- [x] CLI: `check_panic_sell()` integrated into sell pre-trade flow
- [x] TypeScript: `checkPanicSell()` in sell checks

### 7.6 Thesis Hard Gate ✅

**Motivation:** ETN, ZETA — entered positions with no documented thesis. Half-conviction entries lead to early exits at losses.

- [x] Pre-trade check: if no thesis doc exists in `docs/positions/<SYMBOL>/thesis.md`, warn
- [x] For investing book: hard fail — "Investment positions require a thesis doc"
- [x] For trading book: soft warn — "No thesis doc. Confirm pure technical/momentum trade."
- [x] CLI + TypeScript integration in pre-trade flow

### 7.7 Trading/Investing Boundary Enforcement ✅

**Motivation:** SOFI, AFRM — positions that blur the line between investing and trading. Frequent adds/trims on what should be a long-term hold destroy value through churn.

- [x] Detect boundary violations: 3+ round-trips in 90 days on investing-book position
- [x] Detect investing-sized (>2%) positions in trading account
- [x] CLI + TypeScript integration in pre-trade flow

---

## Phase 8: Decision Logging & Memory ✅

**Goal:** Every action is recorded with context. The co-pilot can recall past decisions when you face similar situations.

Note: Basic decision logging already exists (decision_logs table, used during SHOP sell 2026-03-06). This phase adds intelligence on top.

### 8.1 Action Logging ✅

Every action tagged with:
- Action type: Reduce / Re-tier / Add / No-op
- Regime at time of action
- One-sentence rationale
- Position(s) affected

### 8.2 Memory Recall ✅

When contemplating an action, the co-pilot surfaces:
- [x] What you did last time in a similar situation
- [x] Why you did it
- [x] How it turned out (factual P&L, not judgment)
- [x] `getDecisionMemory(symbol)` joins past trades, post-mortems, decision logs, intent changes
- [x] CLI: `pm-cli.sh recall <symbol>` — full decision history
- [x] Auto-surfaced in pre-trade checklist (CLI and Electron IPC)

This defeats emotional recursion and hindsight bias.

### 8.3 Conflict Surfacing ✅

Not alerts — questions:
- [x] Action conflict: "Today's action is 'reduce' — buying conflicts"
- [x] Sector conflict: "You sold other Tech names in the last 7 days — adding reintroduces exposure"
- [x] Wired into both CLI pre-trade check and Electron PreTradeValidator

### 8.4 Sequencing Enforcement ✅

- [x] "You haven't completed the regime read" (checkRegimeRead — hard fail)
- [x] "Adds are disabled on sorting days" (checkSortingDay — warn)
- [x] "This conflicts with today's action" (checkActionConflict — warn)

---

## Phase 9: Transaction Analysis & Post-Mortems ✅

**Goal:** Structured review of every closed position. Win/loss classification, pattern detection, and institutional memory that compounds over time.

### 9.1 Post-Mortem Template ✅

For every closed position (mandatory for large losses or big wins):
- [x] Original intent (investment vs trade, tier/setup)
- [x] Thesis vs reality (what happened vs what was expected)
- [x] Rule adherence audit (sizing, stops, no averaging down, no thesis upgrade)
- [x] Primary error classification (entry timing, sizing, stop discipline, thesis quality, regime misread, overtrading, none)
- [x] One concrete change for next time
- [x] Classification: good loss / bad loss / good win / bad win
- [x] `post_mortems` table with full schema, CRUD in database.ts
- [x] CLI: `pm-cli.sh post-mortem <symbol>` (interactive) + `post-mortems [symbol]` (list)

### 9.2 Transaction Analytics ✅

Structured analysis of trading history:
- [x] FIFO lot matching from transactions table (~4K closed trades)
- [x] Win/loss rate by hold period, regime at entry, entry style
- [x] Trade Performance tab on Analytics page with date range filter (30D/90D/180D/1Y/All)
- [x] Top winners/losers tables
- [x] Stock split detection in FIFO engine
- [x] Behavioral pre-trade rules derived from analysis (re-entry cooldown, rapid flip)

### 9.3 Pattern Detection ✅

Surface behavioral patterns over time:
- [x] Per-symbol stats: trade count, win rate, P&L, avg hold, flags (overtrading/consistent loser/strong performer)
- [x] Timing patterns: rapid flips, long-hold outperformance, monthly overtrading, symbol churn
- [x] Hold period insights and overall behavioral summary
- [x] Patterns section on Trade Performance tab with insight banner, pattern cards, symbol breakdown table

### 9.4 Trade Journal ✅

Automated trade journal from transaction + ritual + decision data:
- [x] Every sell annotated with: entry price/date, hold period, regime at exit, decision log notes
- [x] Searchable by symbol and date range in app (Summary/Journal toggle)
- [x] CLI: `pm-cli.sh trade-journal [symbol] [days]` — full history with context
- [x] Grouped by date with regime and journal context headers (CLI)

### 9.5 P&L Reconciliation ✅

**Motivation:** Post-mortem review revealed our FIFO lot matching doesn't match Schwab's realized P&L. Simple sum of buys/sells diverges significantly (e.g. PLTR: we calculated -$5,995, Schwab says +$738). Broker data is authoritative.

- [x] Import Schwab realized gain/loss CSV (`GainLoss_Realized_Details` export)
- [x] Store broker-reported P&L per lot in `realized_pl_broker` table with dedup
- [x] CLI: `pm-cli.sh reconcile <csv_path>` — import with summary
- [x] CLI: `pm-cli.sh broker-pl [symbol]` — view broker P&L summary or per-lot detail
- [x] Account auto-detection from filename

---

## Phase 13: Entry Plans & Position Lifecycle ✅

**Goal:** Persist sizing decisions and entry plans so they survive across sessions and integrate into the trading workflow.

### 13.1 Entry Plan System ✅

**Motivation:** ROKU analysis showed we can compute sizing + tranches but can't persist or track them. Decisions made in conversation are lost.

- `target_allocation_pct` field on `position_intents` — e.g. ROKU = 8%
- `entry_plans` table: symbol, tranche_number, trigger_price, shares, status (pending/filled/cancelled), created_at
- `pm-cli.sh plan <symbol>` — create, view, update entry plans
- Auto-create monitors from entry plan tranches
- When monitor fires, surface full plan context: "Tranche 1 triggered. Buy 60 shares. Current 6.5% → 7.3%. Target 8%."
- Pre-trade check: if buying a symbol with an active plan, show the plan and warn if deviating
- **App:** Entry plan modal in Holdings, plan status in pre-trade checklist modal

### 13.2 Target Allocation Tracking ✅

- [x] Dashboard widget: current allocation vs target per position with drift severity coloring
- [x] Holdings weight column: shows current/target with drift indicator
- [x] Holdings intent modal: target allocation % field
- [x] `pm-cli.sh drift` — CLI allocation drift report with color-coded severity
- [x] Drift detection: positions without targets flagged for awareness

### 13.3 EMS — Execution Management System ✅

**Motivation:** Rebalance plans were text documents with no execution tracking. Needed: baskets of orders with triggers, user confirmation, brokerage submission, fill tracking.

- [x] `rebalance_baskets` table + extended `entry_plans`/`entry_plan_tranches` with EMS columns
- [x] Date-triggered tranches (scheduled weekly buys) + price-triggered tranches (opportunistic)
- [x] Tranche lifecycle: pending → triggered → confirmed → submitted → filled/expired/cancelled
- [x] Scheduler: `ems-date-check` (10am ET) + `ems-eod-reconcile` (after close)
- [x] CLI: basket-create, baskets, basket, basket-add, basket-orders, basket-confirm, basket-cancel, basket-fill, basket-fills, basket-status
- [x] Briefing integration: triggered/submitted/filled orders shown in morning briefing
- [x] Push notifications via ntfy.sh when triggers fire
- [x] Read-only app page: EMS Baskets with progress bar + tranche table
- [x] CLI-only execution by design (confirmation friction = feature)
- [x] Design doc: `docs/plans/2026-03-16-ems-design.md`

---

## Phase 14: App/CLI Parity — Close Governance Gaps ✅

**Goal:** Every process discipline feature must be accessible in the Electron app. CLI-only governance = governance leak.

### 14.1 Pre-Trade Modal Parity ✅

The app's pre-trade checklist modal now includes all CLI checks:
- Decision memory (last post-mortem lesson, last decision log entry)
- S/R level display with proximity warnings
- Panic sell cooling-off detection
- Entry plan context
- Pending earnings review gate
- Earnings gap-up warning
- Churn detection + hold duration enforcement
- Trading/investing boundary violation
- Thesis file hard gate

### 14.2 Missing App Pages ✅

- Post-Mortems page
- Earnings Reviews page
- Portfolio History page
- Broker P&L page

### 14.3 CLI-Only Exceptions (documented)

The following features are intentionally CLI-only with rationale:
- **morning** — Compound convenience command (refresh + briefing + ritual-status). The app does these on startup automatically.
- **backfill** — One-time 3yr historical data fetch. Operational maintenance, not daily workflow.
- **snapshot** — EOD cron job. Automated, not interactive.
- **reconcile** — CSV file import. File picker could be added to app but low priority — done quarterly.

---

## Phase 15: Research & Thesis Intelligence ✅

**Goal:** Structured research that builds conviction systematically, not by vibes.

### 15.1 Observations Table ✅

- [x] `observations` table: security_id, date, note, source, thesis_impact (supports/challenges/neutral)
- [x] CLI: `pm-cli.sh observe <sym> "<note>" [impact]` + `observations [sym]`
- [x] Integrated into `recall` output
- [x] Logged during daily ritual when reading news

### 15.2 Thesis Scoring ✅

**Motivation:** Thesis docs had prose criteria that couldn't be tracked. Scoring needed to be mechanical, not vibes.

- [x] Standardized template: Bull Criteria + Bear Criteria tables with measurable thresholds and status fields
- [x] Scoring algorithm: confirmed bulls + triggered/watching bears → suggested conviction (A/B/C/D)
- [x] `thesis_score_changes` table for audit trail
- [x] CLI: scorecard, scorecards, scorecard-update, scorecard-history, scorecard-add, scorecard-rm
- [x] Integrated into recall + morning briefing (score changes last 7 days)
- [x] 19 positions scored (all active + exits)
- [x] Thesis doc = source of truth, DB = change log only
- [x] Post-earnings cadence: score reviewed when data changes, observations accumulate between
- [x] Design doc: `docs/plans/2026-03-16-thesis-scoring-design.md`

### 15.3 Factor Attribution ✅

- [x] `pm-cli.sh attribution [30|90|YTD]` — Brinson-style decomposition vs QQQ
- [x] Beta effect + sector allocation + stock selection breakdown
- [x] Per-position return contribution table
- [x] Core+Growth benchmarked vs QQQ, Starters shown separately (not benchmarked)
- [x] High-beta names flagged
