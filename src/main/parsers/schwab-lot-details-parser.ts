import * as fs from 'fs';
import { ParsedOpenLot, LotDetailsParseResult, LotDetailsParserInfo } from '../../shared/types';

export interface LotDetailsParser {
  getInfo(): LotDetailsParserInfo;
  canParse(filePath: string, content: string): boolean;
  parse(filePath: string): LotDetailsParseResult;
}

function parsePrice(value: string): number {
  if (!value || value === '-' || value === '--') {
    return 0;
  }
  // Remove $ sign and commas, then parse
  const cleaned = value.replace(/[$,]/g, '').trim();
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

function parseQuantity(value: string): number {
  if (!value || value === '-' || value === '--') {
    return 0;
  }
  const cleaned = value.replace(/,/g, '').trim();
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

function parseDate(dateStr: string): string {
  // Input: "12/18/2025" (MM/DD/YYYY)
  // Output: "2025-12-18" (ISO format)
  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) {
    return dateStr; // Return as-is if can't parse
  }
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function parseHoldingPeriod(value: string): 'short' | 'long' {
  if (!value) return 'short';
  const lower = value.toLowerCase().trim();
  if (lower.includes('long')) {
    return 'long';
  }
  return 'short';
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

interface ColumnMap {
  openDate: number;
  quantity: number;
  costPerShare: number;
  costBasis: number;
  holdingPeriod: number;
  disallowedLoss: number;
}

function buildColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {
    openDate: -1,
    quantity: -1,
    costPerShare: -1,
    costBasis: -1,
    holdingPeriod: -1,
    disallowedLoss: -1,
  };

  headers.forEach((header, index) => {
    const h = header.toLowerCase().trim();
    if (h === 'open date') {
      map.openDate = index;
    } else if (h === 'quantity') {
      map.quantity = index;
    } else if (h === 'cost/share') {
      map.costPerShare = index;
    } else if (h === 'cost basis') {
      map.costBasis = index;
    } else if (h === 'holding period') {
      map.holdingPeriod = index;
    } else if (h === 'disallowed loss') {
      map.disallowedLoss = index;
    }
  });

  return map;
}

class SchwabLotDetailsParser implements LotDetailsParser {
  getInfo(): LotDetailsParserInfo {
    return {
      id: 'schwab-lot-details',
      name: 'Schwab Lot Details',
      description: 'Parse Schwab Lot Details CSV export',
      fileTypes: ['csv'],
    };
  }

  canParse(filePath: string, content: string): boolean {
    // Check if file is CSV and contains Schwab lot details header pattern
    if (!filePath.toLowerCase().endsWith('.csv')) {
      return false;
    }
    // Look for the pattern "Lot Details for" in the first line
    const firstLine = content.split('\n')[0] || '';
    return firstLine.includes('Lot Details for');
  }

  parse(filePath: string): LotDetailsParseResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const errors: string[] = [];
    const lots: ParsedOpenLot[] = [];

    if (lines.length < 3) {
      return {
        success: false,
        broker: 'Schwab',
        symbol: '',
        accountIdentifier: '',
        lots: [],
        errors: ['File does not contain enough lines'],
      };
    }

    // Parse header line to extract symbol and account
    // Format: "NVDA Lot Details for  ...819 as of 10:48 PM ET, 01/19/2026"
    const headerLine = parseCSVLine(lines[0])[0] || '';
    const headerMatch = headerLine.match(/^(\w+)\s+Lot Details for\s+\.{3}(\w+)/);

    let symbol = '';
    let accountIdentifier = '';

    if (headerMatch) {
      symbol = headerMatch[1].toUpperCase();
      accountIdentifier = headerMatch[2];
    } else {
      errors.push(`Could not parse header line: ${headerLine}`);
    }

    // Line 2 (index 2) contains the column headers
    const columnHeaders = parseCSVLine(lines[2]);
    const colMap = buildColumnMap(columnHeaders);

    // Validate that we found required columns
    if (colMap.openDate === -1) {
      errors.push('Missing required column: Open Date');
    }
    if (colMap.quantity === -1) {
      errors.push('Missing required column: Quantity');
    }
    if (colMap.costPerShare === -1) {
      errors.push('Missing required column: Cost/Share');
    }
    if (colMap.costBasis === -1) {
      errors.push('Missing required column: Cost Basis');
    }

    if (errors.length > 0) {
      return {
        success: false,
        broker: 'Schwab',
        symbol,
        accountIdentifier,
        lots: [],
        errors,
      };
    }

    // Data starts at line 3 (index 3)
    for (let i = 3; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);

      // Skip Total row
      if (fields[0]?.toLowerCase() === 'total') {
        continue;
      }

      const openDate = fields[colMap.openDate] || '';
      const quantity = parseQuantity(fields[colMap.quantity]);
      const costPerShare = parsePrice(fields[colMap.costPerShare]);
      const costBasis = parsePrice(fields[colMap.costBasis]);
      const holdingPeriod = colMap.holdingPeriod >= 0
        ? parseHoldingPeriod(fields[colMap.holdingPeriod])
        : 'short';
      const disallowedLoss = colMap.disallowedLoss >= 0
        ? parsePrice(fields[colMap.disallowedLoss])
        : 0;

      if (!openDate || quantity === 0) {
        continue; // Skip invalid rows
      }

      const lot: ParsedOpenLot = {
        symbol,
        accountIdentifier,
        openDate: parseDate(openDate),
        quantity,
        costPerShare,
        costBasis,
        holdingPeriod,
      };

      if (disallowedLoss > 0) {
        lot.disallowedLoss = disallowedLoss;
      }

      lots.push(lot);
    }

    return {
      success: lots.length > 0,
      broker: 'Schwab',
      symbol,
      accountIdentifier,
      lots,
      errors: lots.length === 0 ? ['No valid lots found in file'] : [],
    };
  }
}

export const schwabLotDetailsParser = new SchwabLotDetailsParser();
