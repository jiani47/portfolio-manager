/**
 * Scorecard parser — thesis markdown → bull/bear criteria.
 * Pure functions, no filesystem dependency (takes markdown text as input).
 */

export interface ScorecardCriterion {
  id: string;
  criterion: string;
  metric: string;
  threshold: string;
  status: string;
  lastChecked: string;
}

export interface ScorecardCounts {
  total: number;
  confirmed: number;
  challenged: number;
  pending: number;
  triggered: number;
  watching: number;
  notTriggered: number;
}

/**
 * Parse all markdown table rows under a ## section header.
 * Handles subsections (### headers) within the section.
 * Expects 6-column table: #, Criterion, Metric, Threshold, Status, Last Checked.
 */
export function parseScorecardSection(sectionHeader: string, text: string): ScorecardCriterion[] {
  if (!text) return [];

  // Extract full section between ## header and next ## header (or end)
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionPattern = new RegExp(
    `## ${escaped}\\s*\\n(.*?)(?=\\n## |$)`,
    's', // dotAll
  );
  const sectionMatch = text.match(sectionPattern);
  if (!sectionMatch) return [];

  const sectionText = sectionMatch[1];

  // Find all markdown tables: header row + separator + data rows
  const tablePattern = /\|[^\n]+\|\s*\n\s*\|[-| ]+\|\s*\n((?:\s*\|[^\n]+\|\s*\n?)*)/g;
  const rows: ScorecardCriterion[] = [];

  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tablePattern.exec(sectionText)) !== null) {
    const dataBlock = tableMatch[1].trim();
    if (!dataBlock) continue;

    for (const line of dataBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Strip leading/trailing pipes, split by pipe
      const cells = trimmed.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (cells.length < 6) continue;

      rows.push({
        id: cells[0],
        criterion: cells[1],
        metric: cells[2],
        threshold: cells[3],
        status: cells[4].toLowerCase().trim(),
        lastChecked: cells[5],
      });
    }
  }

  return rows;
}

/**
 * Count statuses for a set of scorecard criteria.
 */
export function countScorecardStatuses(
  criteria: ScorecardCriterion[],
  type: 'bull' | 'bear',
): ScorecardCounts {
  const counts: ScorecardCounts = {
    total: criteria.length,
    confirmed: 0,
    challenged: 0,
    pending: 0,
    triggered: 0,
    watching: 0,
    notTriggered: 0,
  };

  for (const c of criteria) {
    switch (c.status) {
      case 'confirmed': counts.confirmed++; break;
      case 'challenged': counts.challenged++; break;
      case 'pending': counts.pending++; break;
      case 'triggered': counts.triggered++; break;
      case 'watching': counts.watching++; break;
      case 'not_triggered': counts.notTriggered++; break;
    }
  }

  return counts;
}
