import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../shared/repositories/__tests__/fixture';
import { runFromContent } from '../scorecard';

const THESIS_MD = `# GOOG — Alphabet

**Tier:** Core
**Conviction:** A

## Bull Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
| B1 | Search dominance | Market share | >85% | confirmed | 2026-03-16 |
| B2 | Cloud growth | GCP YoY | >25% | confirmed | 2026-03-16 |
| B3 | AI integration | Gemini adoption | Enterprise uptake | pending | 2026-03-16 |

## Bear Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
| R1 | Antitrust | DOJ ruling | Forced breakup | not_triggered | 2026-03-16 |
| R2 | Ad revenue decline | YoY growth | <5% | watching | 2026-03-16 |
`;

describe('scorecard CLI command', () => {
  it('parses bull and bear criteria from thesis markdown', () => {
    const result = runFromContent('GOOG', THESIS_MD);

    expect(result.symbol).toBe('GOOG');
    expect(result.bulls).toHaveLength(3);
    expect(result.bears).toHaveLength(2);
  });

  it('counts bull statuses correctly', () => {
    const result = runFromContent('GOOG', THESIS_MD);

    expect(result.bullCounts.confirmed).toBe(2);
    expect(result.bullCounts.pending).toBe(1);
    expect(result.bullCounts.challenged).toBe(0);
    expect(result.bullCounts.total).toBe(3);
  });

  it('counts bear statuses correctly', () => {
    const result = runFromContent('GOOG', THESIS_MD);

    expect(result.bearCounts.notTriggered).toBe(1);
    expect(result.bearCounts.watching).toBe(1);
    expect(result.bearCounts.triggered).toBe(0);
    expect(result.bearCounts.total).toBe(2);
  });

  it('handles empty thesis gracefully', () => {
    const result = runFromContent('GOOG', '# GOOG\nNo scorecard here.');

    expect(result.bulls).toHaveLength(0);
    expect(result.bears).toHaveLength(0);
    expect(result.bullCounts.total).toBe(0);
  });
});
