# Portfolio Manager — Product Roadmap

The goal is to build a **state-aware judgment assistant** (PM co-pilot) that protects process, enforces discipline, and provides memory — without ever making buy/sell recommendations.

Design principles (from daily-pm-checklist.md):
- Automation = **friction + memory**, not speed
- The co-pilot **slows you down**, it doesn't push trades
- Human retains all decisions on regime, tier, thesis, and action

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

## Phase 2.5: Housekeeping & Data Quality

**Goal:** Clean up legacy data, align app terminology with actual usage.

### 2.5.1 Holdings Tags Cleanup ✅
- [x] Rename "security tags" → "holdings tags" throughout the app
- [x] Update DB seed tags from (core, event/macro, satellite) → (core, growth, starter, watchlist)
- [x] Align with position intent tier values
- [x] Migration code for existing DBs (idempotent)

### 2.5.2 Thesis Documentation ✅
- [x] Write thesis doc for each position in `docs/thesis/` (all 22 positions covered)
- [x] Include: thesis, invalidation framework, key levels, decision log
- [ ] Review and update during rituals over time (ongoing)

---

## Phase 3: Watchlists

**Goal:** Organized watchlists with clear themes and goals, not a dumping ground.

### 3.1 Schwab Watchlist Integration
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

## Phase 4: Monitors & Alerts

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

### 4.5 External Push (planned)
- [ ] Slack, SMS, or webhook for remote alerting
- [ ] Remote control capability

---

## Phase 5: Data Infrastructure

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
- [x] Overnight news section in morning briefing (portfolio symbols only, top 3 per symbol)

---

## Phase 6: Technical Analysis & Decision Support

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

### 7.4 S/R Level Display in Pre-Trade (planned)

**Motivation:** NVDA post-mortem — trimmed Core at $174-185 which was the support zone, and chased a gap-up buy at $202 without checking resistance.

- [ ] Show S/R levels and zones for the symbol during every buy/sell pre-trade checklist
- [ ] Warn if buying near resistance or selling near support — can only be overridden by a thesis change
- [ ] CLI: auto-display `pm-cli.sh levels <symbol>` output in pre-trade flow
- [ ] App: show S/R levels in the pre-trade checklist modal

---

## Phase 8: Decision Logging & Memory

**Goal:** Every action is recorded with context. The co-pilot can recall past decisions when you face similar situations.

Note: Basic decision logging already exists (decision_logs table, used during SHOP sell 2026-03-06). This phase adds intelligence on top.

### 8.1 Action Logging (partially done ✅)

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

## Phase 9: Transaction Analysis & Post-Mortems

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

---

## Phase 10: Portfolio Optimization & Exposure Analysis

**Goal:** Quantitative analysis of portfolio construction. Identify concentration risks, factor exposures, and diversification opportunities.

### 10.1 Correlation & Factor Analysis

- Correlation matrix across all holdings (from price_history)
- Sector/industry concentration heatmap
- Factor exposure decomposition (growth vs value, large vs small, US vs international)
- Overlap detection: "GOOG and MSFT are 0.85 correlated — you're doubling up on big tech"

### 10.2 Portfolio Optimization

- Efficient frontier analysis using historical returns
- "What-if" scenarios: adding/removing a position and impact on Sharpe ratio
- Suggest alternative tickers that improve risk-adjusted returns
- Constraint-aware: respect tier limits, book designations, thesis requirements
- CLI: `pm-cli.sh optimize` — propose Sharpe-improving changes

### 10.3 Stress Testing & Scenario Analysis

- Historical stress tests: "how would this portfolio have performed in 2020 COVID crash?"
- Factor shock scenarios: "what if rates rise 100bps?" (using rate sensitivity betas)
- Drawdown simulation based on current portfolio beta and vol
- Tail risk / VaR estimates from historical return distribution

### 10.4 Rebalancing Suggestions

- Drift analysis: current weights vs target tier allocations
- Tax-efficient rebalancing suggestions (harvest losses, avoid wash sales)
- "Your Core tier is 38% — target is 50%. Consider adding to GOOG/TSM/NVDA"

### 10.5 Position Sizing & Lifecycle Management (planned)

**Motivation:** SOFI/AFRM — overaggressive adds cut at a loss. SNOW — 2 years of churn on 1,451 shares ($268K deployed) for -$4,763 net. Constant build-trim-rebuild destroys value.

**Every position needs: a target size and a minimum hold duration.**

- **Target sizing:** Given tier limits and portfolio size, compute target share count and dollar allocation per position
- **Entry plan:** Suggest add tranches using S/R levels, volatility, ATR (e.g. "add 25% of target at S1, 25% at S2, 50% if thesis confirmed at earnings")
- **Hold duration enforcement:** Position intents already have `target_hold_period` — surface warnings when selling before it expires. "You set a 6-month hold on SNOW. It's been 3 weeks."
- **Churn detection:** Flag when a symbol has been bought and sold 3+ times in 90 days — "You've round-tripped SNOW 4 times this quarter. If you believe the thesis, hold."
- **Add-size guardrails:** Flag when an add is oversized relative to typical add pattern or remaining room in tier allocation
- CLI: `pm-cli.sh size <symbol> <target_shares>` — suggest entry plan with price levels and tranches

---

## Phase 11: Equity Research Engine

**Goal:** Structured research workflow that builds deep, living thesis documents. Not recommendations — evidence collection and thesis validation.

### 11.1 Research Templates

- Standardized research framework: business model, moat analysis, financials, risks, valuation
- Auto-populated data sections (financials from API, technicals from price_history)
- Peer comparison tables (same sector/industry)
- Research stored in `docs/positions/<SYMBOL>/`

### 11.2 Thesis Scoring & Tracking

- Track bull/bear criteria fulfillment over time
- "3 of 5 bull case items confirmed, 1 of 4 bear case items triggered"
- Visual thesis health dashboard per position
- Alert when thesis score changes materially

### 11.3 Earnings Workflow

**Motivation:** TTD post-mortem revealed that missing quarterly deceleration signals over 14 months led to -$5,442 loss. Earnings review must be a mandatory process step, not ad-hoc.

- Pre-earnings: key metrics to watch, consensus estimates, thesis implications
- **Post-earnings review (mandatory for all held positions):**
  - Actual vs expected on key metrics
  - Growth rate trajectory — is it accelerating, stable, or decelerating?
  - Thesis impact assessment: confirmed, neutral, or challenged?
  - Explicit invalidation check: does this quarter's data trigger any invalidation conditions?
  - If thesis is challenged: force a re-tier or exit decision within 48 hours
- Auto-pull earnings data and flag surprises
- Earnings history stored per position
- CLI: `pm-cli.sh earnings-review <symbol>` — guided post-earnings checklist

### 11.4 Research Integration

- Link research docs to position intents and monitors
- Surface relevant research during pre-trade checklist
- "Your thesis for KKR mentions credit cycle risk — here's the latest research from 2026-03-12"

---

## Phase 12: Risk Analysis & Monitoring

**Goal:** Continuous portfolio risk monitoring with proactive alerts when risk parameters change.

### 12.1 Risk Dashboard

- Real-time portfolio beta, volatility, Sharpe (partially done in analytics)
- Sector concentration with limits and alerts
- Geographic exposure breakdown
- Single-name concentration risk (already partially in pre-trade checklist)

### 12.2 Risk Budgeting

- Define risk budget per tier: "Core can use 60% of risk budget, Growth 30%, Starter 10%"
- Track actual vs budgeted risk contribution per position
- Alert when a position's risk contribution exceeds its tier allowance

### 12.3 Regime-Aware Risk

- Different risk parameters by regime type (trend vs sorting)
- "Portfolio beta is 1.3 on a sorting day — consider reducing"
- Historical drawdown by regime type
- Regime persistence analysis: how long do sorting/trend regimes last

---

## Implementation Priority

| Phase | Status | What | Why |
|-------|--------|------|-----|
| **1** | ✅ Done | Tier tags, position intent, risk shape | Foundation — know what you own and why |
| **2** | ✅ Done | Daily PM ritual + morning briefing | Daily discipline loop |
| **2.5** | ✅ Done | Tags cleanup, thesis docs | Data quality before building more |
| **3** | ✅ Done | Watchlists | Organized pipeline for future positions |
| **4.1** | ✅ Done | Price monitors | Real-time price alerts with desktop notifications |
| **4.2-4.4** | ✅ Done | Other monitors | Watchlist proximity, earnings, fundamental monitors |
| **4.5** | Planned | External push | Slack, SMS, webhook alerting |
| **5** | ✅ Done | Data infrastructure | Backfill, snapshots, news feed |
| **6** | ✅ Done | Technical analysis | Support/resistance, indicators, risk/reward |
| **7** | ✅ Done | Pre-trade checklists | Gates action with process |
| **8** | ✅ Done | Decision logging & memory | Institutional memory that compounds |
| **9.1** | ✅ Done | Post-mortem template | Structured review of closed positions |
| **9.2-9.4** | ✅ Done | Transaction analytics, patterns, journal | Closes the learning loop |
| **10** | Planned | Portfolio optimization & exposure | Quantitative portfolio construction |
| **11** | Planned | Equity research engine | Structured thesis building and tracking |
| **12** | Planned | Risk analysis & monitoring | Continuous risk awareness |

---

## What We Will NOT Build

Per the design principles:
- No buy/sell recommendations — optimization suggests alternatives, human decides
- No price targets or alpha scoring
- No "top ideas" ranking
- No alerts that demand action (monitors surface info, human decides)
- No predictions — scenarios show possibilities, not forecasts

The co-pilot exists to **protect process**, not ego.
