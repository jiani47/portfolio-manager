# Phase 6.1 + 6.3: Support/Resistance & Risk/Reward — Design

## Goal

Compute support and resistance levels from price_history swing highs/lows. Store in DB for fast query. Show risk/reward ratios. Surface in briefing when price approaches a key level.

## Data Model

```sql
CREATE TABLE IF NOT EXISTS price_levels (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  level_type TEXT NOT NULL,        -- 'support' | 'resistance'
  price REAL NOT NULL,
  strength INTEGER DEFAULT 1,      -- how many times tested
  source TEXT NOT NULL,             -- 'swing' | 'manual'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(symbol, level_type, price)
);
CREATE INDEX IF NOT EXISTS idx_price_levels_symbol ON price_levels(symbol);
```

## Computation Logic

From price_history (6 months lookback):
- Swing high: day where high > highs of 5 days before and after
- Swing low: day where low < lows of 5 days before and after
- Cluster nearby levels within 2% — merge, increment strength
- Keep up to 5 support + 5 resistance per symbol (ranked by proximity to current price)

## CLI Commands

- `pm-cli.sh levels [symbol]` — show S/R levels with current price and risk/reward
- `pm-cli.sh levels-refresh [symbol]` — recompute from price_history

## Briefing Integration

Flag when price within 3% of a key level. Show in technical signals section.

## Risk/Reward

- Upside = nearest resistance - current price
- Downside = current price - nearest support
- R:R = upside / downside
- Flag R:R < 1

## No App Changes

Pure CLI. Stored in DB for fast lookup.
