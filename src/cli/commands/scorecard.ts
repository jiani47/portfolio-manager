/**
 * CLI scorecard command — parse thesis markdown for bull/bear criteria.
 */
import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseScorecardSection,
  countScorecardStatuses,
  type ScorecardCriterion,
  type ScorecardCounts,
} from '../../shared/analytics/scorecard';

export interface ScorecardResult {
  symbol: string;
  bulls: ScorecardCriterion[];
  bears: ScorecardCriterion[];
  bullCounts: ScorecardCounts;
  bearCounts: ScorecardCounts;
}

/** Run from file on disk (CLI entry point). */
export function run(args: string[], _db: Database.Database): ScorecardResult {
  const symbol = args[0];
  if (!symbol) throw new Error('Usage: scorecard <symbol>');

  const thesisPath = path.join(process.cwd(), 'docs', 'positions', symbol, 'thesis.md');
  if (!fs.existsSync(thesisPath)) throw new Error(`Thesis file not found: ${thesisPath}`);

  const content = fs.readFileSync(thesisPath, 'utf-8');
  return runFromContent(symbol, content);
}

/** Run from provided markdown content (testable without filesystem). */
export function runFromContent(symbol: string, content: string): ScorecardResult {
  const bulls = parseScorecardSection('Bull Criteria', content);
  const bears = parseScorecardSection('Bear Criteria', content);

  return {
    symbol,
    bulls,
    bears,
    bullCounts: countScorecardStatuses(bulls, 'bull'),
    bearCounts: countScorecardStatuses(bears, 'bear'),
  };
}
