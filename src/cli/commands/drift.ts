/**
 * CLI drift command — loads positions from DB, computes allocation drift.
 * Orchestration only: repository for data, analytics for computation.
 */
import type Database from 'better-sqlite3';
import { PositionRepository } from '../../shared/repositories/position-repository';
import { calculateAllocationDrift, type AllocationRow } from '../../shared/analytics/allocation';

export function run(_args: string[], db: Database.Database): AllocationRow[] {
  const repo = new PositionRepository(db);
  const positions = repo.getAllForAllocation();
  return calculateAllocationDrift({ positions });
}
