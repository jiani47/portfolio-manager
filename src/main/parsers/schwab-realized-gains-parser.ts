import * as fs from 'fs';
import { TransactionParser } from './parser-interface';
import { TransactionParserInfo, TransactionParseResult, TransactionAccountData, ParsedTransaction, ParsedTaxLot } from '../../shared/types';

export class SchwabRealizedGainsParser implements TransactionParser {
  getInfo(): TransactionParserInfo {
    return {
      id: 'schwab-realized-gains',
      name: 'Schwab Realized Gains',
      description: 'Import realized gain/loss transactions from Charles Schwab CSV export',
      fileTypes: ['csv'],
    };
  }

  canParse(filePath: string, content: string): boolean {
    return filePath.endsWith('.csv') && content.includes('Realized Gain/Loss');
  }

  async parse(filePath: string): Promise<TransactionParseResult> {
    const errors: string[] = [];
    const accounts: TransactionAccountData[] = [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);

      let currentAccount: TransactionAccountData | null = null;
      let headerMap: Map<string, number> = new Map();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip the first line (header with date)
        if (line.startsWith('"Realized Gain/Loss')) {
          continue;
        }

        // Check if this is an account identifier line (e.g., "Monica ...819")
        if (this.isAccountLine(line)) {
          if (currentAccount && (currentAccount.transactions.length > 0 || currentAccount.taxLots.length > 0)) {
            accounts.push(currentAccount);
          }
          currentAccount = {
            accountIdentifier: line.replace(/"/g, '').trim(),
            transactions: [],
            taxLots: [],
          };
          headerMap = new Map();
          continue;
        }

        // Check if this is a header row
        if (line.startsWith('"Symbol"')) {
          headerMap = this.parseHeaderRow(line);
          continue;
        }

        // Skip empty data rows
        if (this.isEmptyDataRow(line)) {
          continue;
        }

        // Parse data row
        if (currentAccount && headerMap.size > 0 && line.startsWith('"')) {
          try {
            const result = this.parseDataRow(line, headerMap);
            if (result) {
              currentAccount.taxLots.push(result.taxLot);
              // Only add transaction if we haven't already added one for this symbol/date combo
              const existingTx = currentAccount.transactions.find(
                t => t.symbol === result.transaction.symbol && t.date === result.transaction.date
              );
              if (!existingTx) {
                currentAccount.transactions.push(result.transaction);
              } else {
                // Aggregate quantity and amount into existing transaction
                existingTx.quantity += result.transaction.quantity;
                existingTx.amount += result.transaction.amount;
              }
            }
          } catch (err) {
            errors.push(`Error parsing line ${i + 1}: ${(err as Error).message}`);
          }
        }
      }

      // Don't forget the last account
      if (currentAccount && (currentAccount.transactions.length > 0 || currentAccount.taxLots.length > 0)) {
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
    // Account lines are like "Monica ...819","","",...
    // The first field contains "..." and is a name/account identifier
    // Parse the first field and check if it contains "..."
    const values = this.parseCSVLine(line);
    if (values.length === 0) return false;
    const firstField = values[0];
    // Account identifiers contain "..." and are not headers or data
    return firstField.includes('...') && !firstField.includes('Symbol') && !firstField.includes('Realized');
  }

  private isEmptyDataRow(line: string): boolean {
    // Empty data rows start with "","" or just have empty values
    return line === '""' || line.startsWith('"","","","","","","","","","","","","","","","","","","","","","","","",""');
  }

  private parseHeaderRow(line: string): Map<string, number> {
    const headerMap = new Map<string, number>();
    const headers = this.parseCSVLine(line);

    headers.forEach((header, index) => {
      // Store with original name
      headerMap.set(header.trim(), index);
    });

    return headerMap;
  }

  private parseDataRow(line: string, headerMap: Map<string, number>): { transaction: ParsedTransaction; taxLot: ParsedTaxLot } | null {
    const values = this.parseCSVLine(line);

    const symbol = this.getValue(values, headerMap, 'Symbol');
    if (!symbol || symbol === '--') return null;

    const name = this.getValue(values, headerMap, 'Name') || symbol;
    const closedDate = this.parseDate(this.getValue(values, headerMap, 'Closed Date'));
    const openedDate = this.parseDate(this.getValue(values, headerMap, 'Opened Date'));
    const quantity = this.parseNumber(this.getValue(values, headerMap, 'Quantity'));
    const proceedsPerShare = this.parsePrice(this.getValue(values, headerMap, 'Proceeds Per Share'));
    const costPerShare = this.parsePrice(this.getValue(values, headerMap, 'Cost Per Share'));
    const proceeds = this.parsePrice(this.getValue(values, headerMap, 'Proceeds'));
    const costBasis = this.parsePrice(this.getValue(values, headerMap, 'Cost Basis (CB)'));
    const gainLoss = this.parsePrice(this.getValue(values, headerMap, 'Gain/Loss ($)'));
    const gainLossPercent = this.parsePercent(this.getValue(values, headerMap, 'Gain/Loss (%)'));
    const termStr = this.getValue(values, headerMap, 'Term');
    const washSale = this.getValue(values, headerMap, 'Wash Sale?') === 'Yes';
    const disallowedLoss = this.parsePrice(this.getValue(values, headerMap, 'Disallowed Loss'));

    if (quantity === 0) return null;

    const holdingPeriod: 'short' | 'long' = termStr.toLowerCase().includes('long') ? 'long' : 'short';

    const transaction: ParsedTransaction = {
      symbol,
      name,
      type: 'sell',
      date: closedDate,
      quantity,
      price: proceedsPerShare,
      amount: proceeds,
      washSale: washSale || undefined,
      disallowedLoss: disallowedLoss > 0 ? disallowedLoss : undefined,
    };

    const taxLot: ParsedTaxLot = {
      symbol,
      acquisitionDate: openedDate,
      closedDate,
      quantity,
      costBasis,
      costPerShare,
      proceedsPerShare,
      proceeds,
      realizedGain: gainLoss,
      realizedGainPercent: gainLossPercent,
      holdingPeriod,
      washSale: washSale || undefined,
      disallowedLoss: disallowedLoss > 0 ? disallowedLoss : undefined,
    };

    return { transaction, taxLot };
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

  private parseDate(value: string): string {
    if (!value || value === '--') return '';
    // Format is MM/DD/YYYY, convert to YYYY-MM-DD
    const parts = value.split('/');
    if (parts.length === 3) {
      const [month, day, year] = parts;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return value;
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
    // Handle format like "$xxx.xx" or "-$xxx.xx"
    let cleaned = value
      .replace(/^\$/, '')     // Remove leading $
      .replace(/,/g, '');     // Remove commas

    // Handle negative values like "-$123.45"
    if (cleaned.includes('-$')) {
      cleaned = '-' + cleaned.replace('-$', '');
    } else if (cleaned.startsWith('-')) {
      // Already negative format
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
}

export const schwabRealizedGainsParser = new SchwabRealizedGainsParser();
