import { describe, it, expect } from 'vitest';
import {
  parseScorecardSection,
  countScorecardStatuses,
  type ScorecardCriterion,
  type ScorecardCounts,
} from './scorecard';

const BULL_SECTION = `## Bull Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
| B1 | Cheap valuation | P/E (TTM) | <25x | confirmed | 2026-03-16 |
| B2 | Cloud growth | YoY growth | >20% | challenged | 2026-03-16 |
| B3 | Buybacks | Share reduction | >2% | pending | 2026-03-16 |
`;

const BEAR_SECTION = `## Bear Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
| R1 | Regulatory risk | Fines | >$1B | not_triggered | 2026-03-16 |
| R2 | Macro weakness | Revenue growth | <5% YoY | watching | 2026-03-16 |
| R3 | Delisting risk | HFCAA | Non-compliance | triggered | 2026-03-16 |
`;

describe('parseScorecardSection', () => {
  it('parses bull criteria from markdown', () => {
    const rows = parseScorecardSection('Bull Criteria', BULL_SECTION);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: 'B1',
      criterion: 'Cheap valuation',
      metric: 'P/E (TTM)',
      threshold: '<25x',
      status: 'confirmed',
      lastChecked: '2026-03-16',
    });
  });

  it('parses bear criteria from markdown', () => {
    const rows = parseScorecardSection('Bear Criteria', BEAR_SECTION);

    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe('R1');
    expect(rows[0].status).toBe('not_triggered');
    expect(rows[2].status).toBe('triggered');
  });

  it('normalizes status to lowercase', () => {
    const md = `## Bull Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
| B1 | Test | M | T | CONFIRMED | 2026-03-16 |
| B2 | Test2 | M | T | Pending | 2026-03-16 |
`;
    const rows = parseScorecardSection('Bull Criteria', md);
    expect(rows[0].status).toBe('confirmed');
    expect(rows[1].status).toBe('pending');
  });

  it('parses tables under subsections (### headers)', () => {
    const md = `## Bull Criteria

### Core Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
| B1 | First | M1 | T1 | confirmed | 2026-03-16 |

### Growth Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
| B2 | Second | M2 | T2 | pending | 2026-03-16 |
| B3 | Third | M3 | T3 | challenged | 2026-03-16 |
`;
    const rows = parseScorecardSection('Bull Criteria', md);
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe('B1');
    expect(rows[1].id).toBe('B2');
    expect(rows[2].id).toBe('B3');
  });

  it('stops at the next ## section', () => {
    const md = BULL_SECTION + BEAR_SECTION;
    const bulls = parseScorecardSection('Bull Criteria', md);
    const bears = parseScorecardSection('Bear Criteria', md);

    expect(bulls).toHaveLength(3);
    expect(bears).toHaveLength(3);
    expect(bulls[0].id).toBe('B1');
    expect(bears[0].id).toBe('R1');
  });

  it('returns empty array when section not found', () => {
    expect(parseScorecardSection('Bull Criteria', '# No scorecard here')).toEqual([]);
  });

  it('returns empty array for empty text', () => {
    expect(parseScorecardSection('Bull Criteria', '')).toEqual([]);
  });

  it('handles rows with extra whitespace', () => {
    const md = `## Bull Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
|  B1  |  Cheap valuation  |  P/E  |  <25x  |  confirmed  |  2026-03-16  |
`;
    const rows = parseScorecardSection('Bull Criteria', md);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('B1');
    expect(rows[0].criterion).toBe('Cheap valuation');
  });

  it('skips rows with fewer than 6 columns', () => {
    const md = `## Bull Criteria

| # | Criterion | Metric | Threshold | Status | Last Checked |
|---|-----------|--------|-----------|--------|--------------|
| B1 | Good | M | T | confirmed | 2026-03-16 |
| B2 | Bad row |
| B3 | Also good | M | T | pending | 2026-03-16 |
`;
    const rows = parseScorecardSection('Bull Criteria', md);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('B1');
    expect(rows[1].id).toBe('B3');
  });
});

describe('countScorecardStatuses', () => {
  it('counts bull statuses', () => {
    const bulls: ScorecardCriterion[] = [
      { id: 'B1', criterion: '', metric: '', threshold: '', status: 'confirmed', lastChecked: '' },
      { id: 'B2', criterion: '', metric: '', threshold: '', status: 'confirmed', lastChecked: '' },
      { id: 'B3', criterion: '', metric: '', threshold: '', status: 'challenged', lastChecked: '' },
      { id: 'B4', criterion: '', metric: '', threshold: '', status: 'pending', lastChecked: '' },
    ];

    const counts = countScorecardStatuses(bulls, 'bull');
    expect(counts.confirmed).toBe(2);
    expect(counts.challenged).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.total).toBe(4);
  });

  it('counts bear statuses', () => {
    const bears: ScorecardCriterion[] = [
      { id: 'R1', criterion: '', metric: '', threshold: '', status: 'triggered', lastChecked: '' },
      { id: 'R2', criterion: '', metric: '', threshold: '', status: 'watching', lastChecked: '' },
      { id: 'R3', criterion: '', metric: '', threshold: '', status: 'not_triggered', lastChecked: '' },
    ];

    const counts = countScorecardStatuses(bears, 'bear');
    expect(counts.triggered).toBe(1);
    expect(counts.watching).toBe(1);
    expect(counts.notTriggered).toBe(1);
    expect(counts.total).toBe(3);
  });

  it('returns zeros for empty array', () => {
    const counts = countScorecardStatuses([], 'bull');
    expect(counts.total).toBe(0);
    expect(counts.confirmed).toBe(0);
  });
});
