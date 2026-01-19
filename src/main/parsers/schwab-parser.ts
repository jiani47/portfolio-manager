import * as fs from 'fs';
import { BrokerageParser } from './parser-interface';
import { BrokerageParserInfo, BrokerageParseResult, BrokerageAccountData, ParsedPosition } from '../../shared/types';

export class SchwabParser implements BrokerageParser {
  getInfo(): BrokerageParserInfo {
    return {
      id: 'schwab',
      name: 'Charles Schwab',
      description: 'Import positions from Charles Schwab CSV export',
      fileTypes: ['csv'],
      sampleFormat: 'Positions export from Schwab.com',
    };
  }

  canParse(filePath: string, content: string): boolean {
    return filePath.endsWith('.csv') && content.includes('Positions for');
  }

  async parse(filePath: string): Promise<BrokerageParseResult> {
    const errors: string[] = [];
    const accounts: BrokerageAccountData[] = [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);

      let currentAccount: BrokerageAccountData | null = null;
      let headerMap: Map<string, number> = new Map();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip the first line (header with date)
        if (line.startsWith('"Positions for')) {
          continue;
        }

        // Check if this is an account identifier line (e.g., "Monica ...819")
        if (this.isAccountLine(line)) {
          if (currentAccount && currentAccount.positions.length > 0) {
            accounts.push(currentAccount);
          }
          currentAccount = {
            accountIdentifier: line,
            positions: [],
          };
          headerMap = new Map();
          continue;
        }

        // Check if this is a header row
        if (line.startsWith('"Symbol"')) {
          headerMap = this.parseHeaderRow(line);
          continue;
        }

        // Skip rows we don't want
        if (this.shouldSkipRow(line)) {
          continue;
        }

        // Parse data row
        if (currentAccount && headerMap.size > 0 && line.startsWith('"')) {
          try {
            const position = this.parseDataRow(line, headerMap);
            if (position) {
              currentAccount.positions.push(position);
            }
          } catch (err) {
            errors.push(`Error parsing line ${i + 1}: ${(err as Error).message}`);
          }
        }
      }

      // Don't forget the last account
      if (currentAccount && currentAccount.positions.length > 0) {
        accounts.push(currentAccount);
      }

      return {
        success: errors.length === 0 || accounts.length > 0,
        broker: 'schwab',
        accounts,
        errors,
      };
    } catch (err) {
      return {
        success: false,
        broker: 'schwab',
        accounts: [],
        errors: [`Failed to read file: ${(err as Error).message}`],
      };
    }
  }

  private isAccountLine(line: string): boolean {
    // Account lines are like "Monica ...819" or "Jia ...196"
    // They don't start with a quote and contain "..."
    return !line.startsWith('"') && line.includes('...');
  }

  private parseHeaderRow(line: string): Map<string, number> {
    const headerMap = new Map<string, number>();
    const headers = this.parseCSVLine(line);

    headers.forEach((header, index) => {
      // Normalize header names
      const normalized = header
        .replace(/\s*\([^)]*\)\s*/g, '') // Remove parenthetical text
        .trim();
      headerMap.set(normalized, index);
    });

    return headerMap;
  }

  private shouldSkipRow(line: string): boolean {
    return line.startsWith('"Cash & Cash Investments"') ||
           line.startsWith('"Account Total"');
  }

  private parseDataRow(line: string, headerMap: Map<string, number>): ParsedPosition | null {
    const values = this.parseCSVLine(line);

    const symbol = this.getValue(values, headerMap, 'Symbol');
    if (!symbol || symbol === '--') return null;

    const name = this.getValue(values, headerMap, 'Description') || symbol;
    const quantity = this.parseNumber(this.getValue(values, headerMap, 'Qty'));
    const currentPrice = this.parsePrice(this.getValue(values, headerMap, 'Price'));
    const costBasis = this.parsePrice(this.getValue(values, headerMap, 'Cost Basis'));
    const marketValue = this.parsePrice(this.getValue(values, headerMap, 'Mkt Val'));
    const gainPercent = this.parsePercent(this.getValue(values, headerMap, 'Gain %'));
    const gainDollar = this.parsePrice(this.getValue(values, headerMap, 'Gain $'));
    const securityType = this.mapSecurityType(this.getValue(values, headerMap, 'Security Type'));

    if (quantity === 0) return null;

    return {
      symbol,
      name,
      quantity,
      costBasis,
      currentPrice,
      marketValue,
      unrealizedGain: gainDollar,
      unrealizedGainPercent: gainPercent,
      securityType,
    };
  }

  private parseCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // Skip the next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current.trim());
    return values;
  }

  private getValue(values: string[], headerMap: Map<string, number>, header: string): string {
    const index = headerMap.get(header);
    if (index === undefined || index >= values.length) return '';
    return values[index];
  }

  private parseNumber(value: string): number {
    if (!value || value === '--') return 0;
    // Remove commas and parse
    const cleaned = value.replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  private parsePrice(value: string): number {
    if (!value || value === '--') return 0;
    // Handle format like ="$xxx.xx" or "$xxx.xx" or "-$xxx.xx"
    let cleaned = value
      .replace(/^="/, '')     // Remove leading ="
      .replace(/"$/, '')      // Remove trailing "
      .replace(/^\$/, '')     // Remove leading $
      .replace(/,/g, '');     // Remove commas

    // Handle negative values like "-$123.45"
    if (cleaned.includes('-$')) {
      cleaned = '-' + cleaned.replace('-$', '');
    }

    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  private parsePercent(value: string): number {
    if (!value || value === '--') return 0;
    // Handle format like "12.34%" or "-5.67%"
    const cleaned = value.replace(/%/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  private mapSecurityType(type: string): ParsedPosition['securityType'] {
    const typeMap: Record<string, ParsedPosition['securityType']> = {
      'Equity': 'stock',
      'ETFs & Closed End Funds': 'etf',
      'Mutual Fund': 'mutual_fund',
      'Bond': 'bond',
      'Option': 'option',
      'Crypto': 'crypto',
    };
    return typeMap[type] || 'other';
  }
}

export const schwabParser = new SchwabParser();
