# Portfolio Manager — Product Roadmap

The goal is to build a **state-aware judgment assistant** (PM co-pilot) that protects process, enforces discipline, and provides memory — without ever making buy/sell recommendations.

Design principles:
- Automation = **friction + memory**, not speed
- The co-pilot **slows you down**, it doesn't push trades
- Human retains all decisions on regime, tier, thesis, and action
- Tools should be **connected into workflows**, not standalone commands

**Completed phases archived in [`roadmap_archive.md`](roadmap_archive.md):** Phases 1–9, 13–15.

---

## Operating Model — 6 Workflow Modes

All features are organized by which workflow mode they serve.

### Mode 1: Portfolio Maintenance (daily) — ✅ Well-covered

Morning routine → review → spot anomalies → research → update scorecards/thesis/monitors/basket

**Built**: morning, briefing, triage, sectors, ritual-set, news, technicals, levels, valuation/valuations, observe, scorecard/scorecard-update (auto-syncs thesis doc + checks basket conflicts), note/notes, thesis-export, earnings-review, monitors, drift, basket/basket-resize (auto on refresh), confluence in briefing, valuation alerts in briefing, trading position alerts in briefing, push notifications

### Mode 2: Pure Trading (trading account) — ✅ Framework complete

Monitor trades → scan watchlist → size/time/risk → enter → track

**Built**: trade-setup (guided analysis), trade-enter (composite: check→buy→log→stop), trade-open/close, trades, trade-stats (P&L dashboard), screen (composite scoring), confluence (2+ signals), pre-trade checklist with mandatory stop, briefing expiry alerts

### Mode 3: Idea Exploration (ad-hoc) — ✅ Adequate

New idea → research → add to watchlist → wait for setup

**Built**: research (auto-populated brief from FMP), valuation/technicals/levels/news for any symbol, watchlist system (9 themed lists), note (sectioned research log), size (works for watchlist names)

### Mode 4: Execution Support — ✅ Strong

Pre-trade governance → dynamic sizing → order → tracking → thesis sync

**Built**: pre-trade checklist (12+ checks), basket/basket-add/basket-confirm/basket-fill, basket-resize (dynamic from target %), drift (with MV columns), post-rebalance projection, S/R in pre-trade, panic sell detection, valuation gate, decision memory, conflict surfacing, scorecard→basket sync

### Mode 5: Analytics & Governance (low frequency) — ✅ Well-covered

Post-trade analysis → post-mortems → attribution → reconciliation

**Built**: post-mortem, trade-journal, attribution, analytics (beta/Sharpe/drawdown), correlations, broker-pl/reconcile, snapshots, trade-stats, app pages (Analytics, Post-Mortems, Earnings Reviews, Portfolio History, Broker P&L)

### Mode 6: Pre-Trade Research & Idea Generation — ✅ Foundation done

Structured research → evidence collection → thesis building → conviction scoring

**Built**: research (auto-populated brief), note/notes (sectioned append-only), thesis-export (7-table assembly), scorecard system, observations, valuation framework

---

## Remaining Roadmap

### Phase 10: Portfolio Optimization (deprioritized)

#### 10.1 Correlation & Factor Analysis — ✅ Done
#### 10.5 Position Sizing & Lifecycle — ✅ Done

#### 10.2 Portfolio Optimization — Planned
- Efficient frontier, what-if scenarios, Sharpe-improving suggestions

#### 10.3 Stress Testing — Planned
- Historical replays, factor shocks, VaR

#### 10.4 Rebalancing Suggestions — Partially done
- [x] Drift analysis with MV columns
- [x] Dynamic basket sizing from target %
- [ ] Tax-efficient suggestions (wash sale detection)

### Phase 11: Equity Research Engine

#### 11.1 Research Templates — ✅ Done
- [x] `research <symbol>` — auto-populated from FMP (financials, key metrics, estimates)
- [x] Research notes by section (business_model, moat, risks, catalyst, etc.)
- [x] Peer comparison tables (same sector/industry) — `peers <symbol>`

#### 11.2 Thesis Scoring Visual Dashboard — Planned
- Visual dashboard in app (CLI scoring done)

#### 11.3 Earnings Workflow — ✅ Done

#### 11.4 Research Integration — ✅ Done
- [x] Scorecard→thesis doc auto-sync
- [x] Scorecard→basket conflict detection
- [x] Surface research notes + observations in pre-trade checklist

#### 11.5 Valuation Framework — ✅ Done
- [x] CLI: valuation, valuations, screen, confluence
- [x] Auto-fetched daily for 68 symbols (portfolio + watchlist)
- [x] ADR handling (skip forward PE, use trailing PE)
- [x] Valuation alerts in briefing (tier mismatches)
- [x] Valuation gate in pre-trade checklist
- [x] App: valuation column on Holdings + Valuation tab on Analytics
- [x] Fair price range in intent modal

### Phase 12: Risk Analysis (deprioritized)

#### 12.1 Risk Dashboard — ✅ Done
#### 12.2 Risk Budgeting — Planned
#### 12.3 Regime-Aware Risk — Planned

### Phase 16: Workflow Connections — ✅ Foundation done

#### 16.1 Triage — ✅ Done
- Prioritized action list (CRITICAL/HIGH/MEDIUM/INFO)
- Integrated into `morning` composite
- Each item has actionable command

#### 16.2 Trade Entry Flow — ✅ Done
- `trade-enter` chains: pre-trade check → buy → log trade → prompt stop
- `trade-setup` provides analysis before entry

#### 16.3 Thesis ↔ Basket Sync — ✅ Done
- Scorecard-update auto-updates thesis doc
- Scorecard-update checks for basket conflicts (bear triggered + active buy orders)
- Earnings-review auto-exports thesis snapshot
- Basket auto-resizes on refresh

#### 16.4 Earnings Mode — ✅ Done
- `earnings-prep <symbol>` composite: position, valuation, scorecard, observations, research notes, news, technical levels
- Suggested post-earnings commands in footer

#### 16.5 Regime-Filtered Screening — ✅ Done
- [x] `confluence`, `scan-trades`, `screen` filter/flag names in regime-punished sectors
- [x] Briefing confluence section separates actionable vs regime-blocked
- [x] App confluence panel dims regime-blocked cards with REGIME badge
- [x] Sector alias fuzzy-matching (free-text regime_punishing → canonical sector names)

### Phase 17: Trading Account — ✅ Done

- [x] `trading_positions` table (entry thesis, stop, time limit, P&L)
- [x] `trade-open/close/trades` commands
- [x] `trade-stats` P&L dashboard (win rate, avg R/R, hold period stats)
- [x] `trade-setup` guided analysis (valuation + S/R + sizing + commands)
- [x] `trade-enter` composite (pre-trade → buy → log → stop prompt)
- [x] Mandatory stop in pre-trade checklist (hard gate)
- [x] Expiry alerts in morning briefing
- [x] Pre-trade boundary violation message distinguishes buy vs sell

---

## Implementation Priority

| Item | Status | Mode | Impact |
|------|--------|------|--------|
| **16.5** Regime-filtered screening | ✅ Done | 2 | High — prevents fighting the tape |
| **16.4** Earnings mode composite | ✅ Done | 1 | Medium — convenience |
| **11.4** Research in pre-trade | ✅ Done | 4 | Medium — surface notes during trades |
| **11.1** Peer comparison | ✅ Done | 6 | Low — research quality |
| **11.2** Thesis dashboard in app | Planned | 1 | Low — CLI works |
| **10.2** Portfolio optimization | Planned | 5 | Deprioritized |
| **10.3** Stress testing | Planned | 5 | Deprioritized |
| **12.2** Risk budgeting | Planned | 5 | Deprioritized |
| **12.3** Regime-aware risk | Planned | 5 | Deprioritized |

---

## What We Will NOT Build

Per the design principles:
- No buy/sell recommendations — optimization suggests alternatives, human decides
- No price targets or alpha scoring
- No "top ideas" ranking
- No alerts that demand action (monitors surface info, human decides)
- No predictions — scenarios show possibilities, not forecasts
- No automated trading — manual execution with governance support

The co-pilot exists to **protect process**, not ego.
