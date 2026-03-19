# Portfolio Manager — Product Roadmap

The goal is to build a **state-aware judgment assistant** (PM co-pilot) that protects process, enforces discipline, and provides memory — without ever making buy/sell recommendations.

Design principles (from daily-pm-checklist.md):
- Automation = **friction + memory**, not speed
- The co-pilot **slows you down**, it doesn't push trades
- Human retains all decisions on regime, tier, thesis, and action
- **App/CLI parity rule:** Every feature must be available in both the Electron app and CLI. No exceptions unless explicitly documented with rationale in this roadmap. CLI-only features create governance leaks — if you can trade through the app without seeing a CLI-only check, the check doesn't exist.

**Completed phases archived in [`roadmap_archive.md`](roadmap_archive.md):** Phases 1–9, 13–15.

---

## Phase 10: Portfolio Optimization & Exposure Analysis

**Goal:** Quantitative analysis of portfolio construction. Identify concentration risks, factor exposures, and diversification opportunities.

### 10.1 Correlation & Factor Analysis — ✅ Done

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

### 10.5 Position Sizing & Lifecycle Management — ✅ Done

- [x] **Hold duration enforcement:** Pre-trade warning when selling before `target_hold_period` expires (`checkHoldDuration`)
- [x] **Churn detection:** Flag 3+ round-trips in 90 days (`checkChurn`)
- [x] **Add-size guardrails:** Flag oversized adds relative to remaining room in tier allocation (`checkAddSize`)
- [x] **Target sizing:** Computes target shares/$ from tier limits + portfolio size. Supports custom target (shares or %)
- [x] **Entry plan suggestions:** S/R-based tranches with ATR-adjusted weighting (high vol = more weight at lower supports)
- [x] **New position support:** Works for watchlist symbols not yet held
- [x] CLI: `pm-cli.sh size <symbol> [target]` — target as share count (e.g. 100) or allocation % (e.g. 3%)

---

## Phase 11: Equity Research Engine

**Goal:** Structured research workflow that builds deep, living thesis documents. Not recommendations — evidence collection and thesis validation.

### 11.1 Research Templates

- Standardized research framework: business model, moat analysis, financials, risks, valuation
- Auto-populated data sections (financials from API, technicals from price_history)
- Peer comparison tables (same sector/industry)
- Research stored in `docs/positions/<SYMBOL>/`

### 11.2 Thesis Scoring Visual Dashboard

- Visual thesis health dashboard per position in app (CLI scoring done in Phase 15)
- Alert when thesis score changes materially

### 11.3 Earnings Workflow — ✅ Done

### 11.4 Research Integration

- Link research docs to position intents and monitors
- Surface relevant research during pre-trade checklist
- "Your thesis for KKR mentions credit cycle risk — here's the latest research from 2026-03-12"

### 11.5 Valuation Framework

**Motivation:** Entry/exit decisions lack quantitative price anchoring. We have S/R levels (technical) but no fundamental fair value range. Need: forward PE, trailing PE, PEG, expected growth → derived fair price range.

- Fetch from FMP: forward PE, trailing (T12) PE, PEG ratio, analyst expected annual growth rate
- Store in `valuation_metrics` table: symbol, date, fwd_pe, t12_pe, peg, expected_growth_pct, fetched_at
- Compute fair price range: low (sector median PE × EPS), mid (historical avg PE × fwd EPS), high (growth-justified PE × fwd EPS)
- `pm-cli.sh valuation [symbol]` — show current vs fair price range with over/undervalued %
- `pm-cli.sh valuations` — portfolio-wide table: symbol, price, fwd PE, PEG, fair range, status
- Surface in pre-trade checklist: "ROKU at $85 is 15% above fair range mid ($74)"
- Surface in morning briefing: positions trading significantly outside fair range
- Refresh during `pm-cli.sh refresh` (daily, cached)
- App: valuation column in Holdings table, fair range bar in position detail

---

## Phase 12: Risk Analysis & Monitoring

**Goal:** Continuous portfolio risk monitoring with proactive alerts when risk parameters change.

### 12.1 Risk Dashboard — ✅ Done

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

## Backlog / Future Ideas

- **4.6** Remote control capability (trigger actions via push notification reply)
- **Factor exposure decomposition** (growth vs value, large vs small) — deferred from 10.1

---

## Implementation Priority

| Phase | Status | What | Why |
|-------|--------|------|-----|
| **10.5** | ✅ Done | Position sizing & lifecycle | Target sizing, ATR tranches, new position support |
| **11.5** | Planned | Valuation framework | Fundamental price anchoring for entry/exit |
| **11.1** | Planned | Research templates | Structured thesis building |
| **11.2** | Planned | Thesis scoring in app | Visual dashboard (CLI done) |
| **11.4** | Planned | Research integration | Surface research in pre-trade flow |
| **10.2** | Planned | Portfolio optimization | Efficient frontier, what-if scenarios |
| **10.3** | Planned | Stress testing | Historical replays, factor shocks, VaR |
| **10.4** | Planned | Rebalancing suggestions | Tax-efficient drift correction |
| **12.2** | Planned | Risk budgeting | Per-tier risk allocation |
| **12.3** | Planned | Regime-aware risk | Different params by regime type |

---

## What We Will NOT Build

Per the design principles:
- No buy/sell recommendations — optimization suggests alternatives, human decides
- No price targets or alpha scoring
- No "top ideas" ranking
- No alerts that demand action (monitors surface info, human decides)
- No predictions — scenarios show possibilities, not forecasts

The co-pilot exists to **protect process**, not ego.
