# Fintech / Lending Company Audit Checklist

**Purpose:** Structured forensic review for fintech holdings that originate, sell, or service loans. Applied when bear criteria trigger, short reports surface, or pre-entry for new positions.

**Applies to:** AFRM, FUTU (margin lending), and any future fintech/lending position (Chime, HOOD if they have lending).

**Frequency:** Pre-entry for new positions. On-demand when bear criteria move to "watching" or "triggered."

---

## Phase 1: Pull the Data

### SEC Filings (EDGAR)
- [ ] Latest 10-K (annual — most complete)
- [ ] Latest 10-Q (quarterly — more recent)
- [ ] Recent 8-Ks (earnings releases, material events)
- [ ] Any SEC comment letters (search EDGAR EFTS for correspondence)

### Key 10-K Notes to Read
| Note | What to check | Red flag |
|------|--------------|----------|
| **Loans / Fair Value of Loans** | FV markup over UPB (should be near par for seasoned portfolio) | FV/UPB consistently >105% |
| **Fair Value Measurements** | Discount rate vs risk-free rate, default assumptions, recovery assumptions | Discount rate at or below Treasury yield |
| **Debt** | All borrowing facilities, "Other financing," any new line items | New categories appearing, lines not reconciling QoQ |
| **VIEs / Securitization** | Consolidated vs non-consolidated VIEs, retained interests, servicing rights | Large non-consolidated VIE exposure while retaining servicing + first-loss |
| **Credit Losses / Charge-offs** | On-B/S charge-off rate, delinquency tables, transferred loan charge-offs | Reported rate diverging from serviced-portfolio rate |
| **Revenue** | Loan platform fees, gain on sale, servicing rights recognized | SRA % materially above peers (>2% is a flag) |
| **Equity** | Share count trajectory, equity offerings, convertible notes | Shares growing faster than earnings |

### FMP / Public Data Cross-Check
- [ ] Diluted shares outstanding — 3-year trend (accelerating?)
- [ ] EPS trajectory — growing or shrinking despite revenue growth?
- [ ] FCF vs Net Income — large persistent gap?
- [ ] Equity raised vs net income — ratio >3x is a flag
- [ ] SBC as % of revenue

---

## Phase 2: The Seven Questions

Answer each for the company under review:

### Q1: What is the REAL charge-off rate?
- Reported on-balance-sheet charge-off rate: ____%
- Add: losses on delinquent loan sales (pre-charge-off disposals): ____%
- Add: charge-offs on transferred/off-B/S loans still serviced: ____%
- **Adjusted charge-off rate:** ____%
- **Gap:** ____% (if >50% higher than reported, major red flag)

### Q2: Is Fair Value realistic?
- Personal loan FV/UPB: ____% (reasonable: 100-103%)
- Student loan FV/UPB: ____% (if applicable)
- Discount rate used: ____% vs 10-year Treasury: ____%
- **Spread over Treasury:** ____bps (negative spread = indefensible)
- Default rate in FV model: ____% vs adjusted actual: ____%
- Recovery rate assumed: ____% (reasonable: 10-20% for unsecured consumer)

### Q3: Are loan sales real sales?
- Does the company retain servicing? Yes/No
- Does the company retain first-loss (residual/Class R)? Yes/No
- Is the buyer financing provided by the seller? Yes/No
- Same-day sale-and-pledge-back in UCC filings? Yes/No
- **ASC 860 test:** If any of the above are Yes, the "sale" may be a secured borrowing

### Q4: Is the Loan Platform Business real fee income?
- LPB fee as % of loans originated: ____%
- Does the company retain credit exposure after "transfer"? Yes/No
- Does the company retain >5% first-loss residual? Yes/No
- Counterparty default ceiling vs company's actual default rate: ____% vs ____%
- **If company absorbs losses above counterparty ceiling → not a fee business, it's a credit guarantee**

### Q5: Is the equity treadmill running?
- Shares outstanding growth: ____% (1yr), ____% (2yr)
- Net income: $____M
- Equity raised: $____M
- **Ratio (equity raised / net income):** ____ (>3x = treadmill)
- FCF: $____M (negative while reporting profit = cash hole)
- EPS trend: growing / flat / declining despite revenue growth?
- **Key test:** Is the company profitable enough to fund its own growth, or does it need external equity?

### Q6: Are executives cashing out?
- Insider sales (Form 4): $____M in last 12 months
- Prepaid variable forward contracts: $____M
- Public statements about "not selling": Yes/No
- **Contradiction test:** Are executives extracting cash through instruments economically equivalent to sales while claiming they haven't sold?

### Q7: What does the auditor see?
- Auditor name: ____________
- Any SEC comment letters? Topics?
- Any change in audit opinion or emphasis paragraphs?
- Any material weakness in internal controls?
- Rating agency actions (Fitch, DBRS, Moody's) — assumptions trending up or down?

---

## Phase 3: Score the Impact

For each finding, estimate the EBITDA / earnings impact:

| Finding | Impact ($M) | % of Reported EBITDA | Plausibility of Defense |
|---------|------------|---------------------|----------------------|
| Charge-off adjustment | | | |
| FV markup adjustment | | | |
| Loan sale reclassification | | | |
| LPB reclassification | | | |
| Capitalized expenses | | | |
| Unrecorded liabilities | | | |
| **Total adjustment** | | | |

### Severity Classification
- **<10% of EBITDA:** Aggressive but immaterial
- **10-30% of EBITDA:** Materially aggressive — warrants downgrade
- **30-50% of EBITDA:** Thesis-breaking — exit or reduce significantly
- **>50% of EBITDA:** Potential fraud — exit immediately

---

## Phase 4: Defense Test

For each finding, write the CFO's defense and rate it:

| Finding | CFO Defense | Plausible? | Fatal Flaw |
|---------|-----------|------------|------------|
| | | | |

**Key question:** Even if every defense is "technically legal," does the aggregate pattern of aggressive accounting create unacceptable risk?

---

## Phase 5: First-Principles Decision

- [ ] Would I buy this stock today at the current price knowing everything I've found?
- [ ] If no → exit
- [ ] If yes but with caveats → what conviction level? Update scorecard.
- [ ] What would change my mind? (specific, measurable, time-bound)

---

## Reference: SOFI Audit (2026-03-17)

The first application of this checklist. Full analysis in `docs/positions/SOFI/thesis.md`.

| Question | SOFI Finding |
|----------|-------------|
| Q1 Real charge-off | 6.1% vs reported 2.89% — verified from 10-K |
| Q2 Fair Value | PL at 106.4% of UPB, SL discount below Treasury |
| Q3 Real sales? | Same-day pledge-back, retained first-loss, failed ASC 860 |
| Q4 LPB real fees? | $482M fees, retains 100% residual, counterparty ceiling below actual defaults |
| Q5 Treadmill? | $3.5B raised on $481M earnings, EPS declining, -$4B FCF |
| Q6 Cashing out? | $58M via forward contracts while claiming "not sold" |
| Q7 Auditor? | Deloitte — SEC comment letter Sep 2024, Fitch raising assumptions every deal |
| **Total impact** | ~$950M / 90% of reported EBITDA |
| **Outcome** | Exited at $17.40, +14% gain |

## Reference: AFRM Audit (2026-03-17)

Full analysis in `docs/positions/AFRM/20260317-financial-audits.md`.

| Question | AFRM Finding |
|----------|-------------|
| Q1 Real charge-off | 7.4% annualized, honestly reported through allowance (amortized cost) |
| Q2 Fair Value | 108% FV/carrying — disclosure only, not in P&L. Discount 430bps over Treasury |
| Q3 Real sales? | Genuine sales, <1% retained risk, 5% regulatory retention |
| Q4 LPB real fees? | N/A — merchant fees + interest income, no hidden credit guarantee |
| Q5 Treadmill? | FCF positive $438M, no equity raises, GAAP profitable, 4.5%/yr SBC dilution |
| Q6 Cashing out? | Levchin exercising options at $49, no forward contracts |
| Q7 Auditor? | Deloitte — no issues flagged |
| **Total impact** | ~$0 / 0% — no hidden accounting |
| **Outcome** | Starter tier confirmed, accounting clean |

## Reference: CHYM Audit (2026-03-17)

Full analysis in `docs/positions/CHYM/20260317-financial-audits.md` (if created).

| Question | CHYM Finding |
|----------|-------------|
| Q1 Real losses? | $407M transaction/risk losses (19% of revenue), 42% reserve on MyPay loans, growing 85% YoY |
| Q2 Fair Value | Product obligation discount 3.68% (below Treasury) — actually conservative direction |
| Q3 Real sales? | N/A — bank partner model, no securitization |
| Q4 Fee income? | Payments (69%) genuine interchange; MyPay "1% loss rate" is % of origination volume |
| Q5 Treadmill? | $1B net loss (IPO SBC catch-up), normalizing $280-340M/yr SBC. $3.4B accumulated deficit |
| Q6 Cashing out? | No forward contracts, standard IPO selling stockholder sales |
| Q7 Auditor? | PwC — first public filing, no history |
| **Total impact** | ~$0 / 0% — no hidden accounting, risks are structural not accounting |
| **Outcome** | Watchlist candidate — check back after GAAP profitability in 2026 |

## Reference: FUTU Audit (2026-03-17)

Full analysis in `docs/positions/FUTU/20260317-financial-audits.md`.

| Question | FUTU Finding |
|----------|-------------|
| Q1 Real losses? | 0.58% reserve on collateralized margin loans — allowance grew 4.4x but appropriate for book growth |
| Q2 Fair Value | Loans at amortized cost, investments Level 1/2 — no FV manipulation possible |
| Q3 Real sales? | N/A — no loan sales, margin loans stay on B/S |
| Q4 Fee income? | 46% commissions (genuine), 46% NIM on collateralized margin, 8% services |
| Q5 Treadmill? | Anti-treadmill: 1.5% SBC, buybacks, 49.5% net margin, $1.45B NI, no equity raises |
| Q6 Cashing out? | No forward contracts. Supervoting control (governance risk, not extraction) |
| Q7 Auditor? | PwC — SOX 404(b) clean, BBB- credit rating, VIE structure immaterial but existential risk |
| **Total impact** | ~$0 / 0% — cleanest financials of all four audits |
| **Outcome** | Growth tier B- conviction confirmed, $140 entry target reasonable |

---

## Peer Comparison Benchmarks

Useful reference points for "what's normal" in fintech lending:

| Metric | Normal Range | Aggressive | Red Flag |
|--------|-------------|------------|----------|
| Personal loan charge-off rate | 3-5% | 5-7% | >7% or large gap with serviced portfolio |
| FV/UPB ratio | 100-103% | 103-106% | >106% |
| Discount rate spread over Treasury | +100-200bps | +0-100bps | Negative spread |
| Servicing rights (% of UPB sold) | 0.7-1.2% | 1.5-3% | >4% |
| Equity raised / Net income ratio | <1x | 1-3x | >3x |
| FCF / Net income ratio | >0.5x | 0-0.5x | Negative FCF on positive NI |
| Shares outstanding growth (annual) | <5% | 5-15% | >15% accelerating |
