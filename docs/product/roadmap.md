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

## Phase 7: Pre-Trade Checklists

**Goal:** Interactive gate before any order placement. Different checklists for investing vs trading accounts.

### 7.1 Investing Account Checklist

Before any add/entry in the investing book:
- Intent confirmation (not a trade, expect to hold months+)
- Tier & role clarity (assigned tier, within limits)
- Ranking discipline (justifies capital over existing names)
- Thesis quality (moat articulated, failure conditions defined)
- Execution sanity (adding on weakness, building position intentionally)
- Final gate: "If this goes down 20-30%, would I still own it?"

### 7.2 Trading Account Checklist

Before any trade entry:
- Mandate check (separate account, not an investment)
- Setup qualification (momentum leader, entry style selected)
- Invalidation defined (stop level, technical not emotional)
- Sizing discipline (<=1%, no averaging down, within concurrent limit)
- Time discipline (exit if no progress in 20-30 days)
- Mental check (not hoping, accept stop-out as success)

### 7.3 Integration with Orders Page

Checklist must be completed before order submission. Checklist responses stored with the order for audit trail.

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

### 8.2 Memory Recall

When contemplating an action, the co-pilot surfaces:
- What you did last time in a similar situation
- Why you did it
- How it turned out (factual P&L, not judgment)

This defeats emotional recursion and hindsight bias.

### 8.3 Conflict Surfacing

Not alerts — questions:
- "This increases consumer beta by +8%. Is that intentional?"
- "This adds duration exposure after you reduced it this morning."
- "You trimmed DDOG for duration risk — this add reintroduces it."

### 8.4 Sequencing Enforcement

- "You haven't completed the regime read"
- "Adds are disabled on sorting days"
- "This conflicts with yesterday's trim logic"

---

## Phase 9: Post-Mortem & Review

**Goal:** Structured review of wins and losses to build institutional memory.

### 9.1 Post-Mortem Template

Mandatory for large losses or big wins:
- Original intent (investment vs trade, tier/setup)
- Thesis vs reality (what happened vs what was expected)
- Rule adherence audit (sizing, stops, no averaging down, no thesis upgrade)
- Primary error classification (entry timing, sizing, stop discipline, thesis quality, boundary leakage, regime misread)
- One concrete change for next time
- Classification: good loss / bad loss / good win / bad win

### 9.2 Pattern Detection

Over time, surface patterns:
- Most common error type
- Win/loss rate by tier
- Average hold period by book
- Rule violation frequency

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
| **7** | Planned | Pre-trade checklists | Gates action with process |
| **8** | Partial | Decision logging & memory | Institutional memory that compounds |
| **9** | Planned | Post-mortems & review | Closes the learning loop |

---

## What We Will NOT Build

Per the design principles:
- No buy/sell recommendations
- No price targets or alpha scoring
- No "top ideas" ranking
- No alerts that demand action (monitors surface info, human decides)
- No predictions or optimization

The co-pilot exists to **protect process**, not ego.
