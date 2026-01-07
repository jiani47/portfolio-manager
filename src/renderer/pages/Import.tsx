import { useState, useEffect } from 'react';
import { useFileImport, useAccounts, useSecurities, useTransactions, usePositions, useTaxLots } from '../hooks/useApi';
import type { Transaction, Security } from '../../shared/types';

type ImportType = 'transactions' | 'positions' | 'taxlots';

interface ColumnMapping {
  date?: string;
  symbol?: string;
  type?: string;
  quantity?: string;
  price?: string;
  amount?: string;
  fees?: string;
  notes?: string;
  costBasis?: string;
  currentPrice?: string;
  acquisitionDate?: string;
}

export default function Import() {
  const { importing, importExcel } = useFileImport();
  const { accounts, fetchAccounts } = useAccounts();
  const { createSecurity, findBySymbol } = useSecurities();
  const { importTransactions } = useTransactions();
  const { createPosition, fetchPositions } = usePositions();
  const { createTaxLot, fetchTaxLots } = useTaxLots();

  const [importType, setImportType] = useState<ImportType>('transactions');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [importedData, setImportedData] = useState<unknown[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({});
  const [importStatus, setImportStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const handleImportExcel = async () => {
    const result = await importExcel();
    if (result && result.success && result.data.length > 0) {
      setImportedData(result.data);
      const firstRow = result.data[0] as Record<string, unknown>;
      setColumns(Object.keys(firstRow));
      setColumnMapping({});
      setImportStatus(null);
    } else if (result && !result.success) {
      setImportStatus({ success: false, message: result.errors.join(', ') });
    }
  };

  const handleMappingChange = (field: keyof ColumnMapping, column: string) => {
    setColumnMapping(prev => ({ ...prev, [field]: column || undefined }));
  };

  const handleProcessImport = async () => {
    if (!selectedAccount) {
      setImportStatus({ success: false, message: 'Please select an account' });
      return;
    }

    setProcessing(true);
    setImportStatus(null);

    try {
      if (importType === 'transactions') {
        await processTransactions();
      } else if (importType === 'positions') {
        await processPositions();
      } else if (importType === 'taxlots') {
        await processTaxLots();
      }
    } catch (error) {
      setImportStatus({ success: false, message: (error as Error).message });
    } finally {
      setProcessing(false);
    }
  };

  const processTransactions = async () => {
    const transactions: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>[] = [];
    const errors: string[] = [];

    for (let i = 0; i < importedData.length; i++) {
      const row = importedData[i] as Record<string, unknown>;
      try {
        const symbol = String(row[columnMapping.symbol || ''] || '').toUpperCase();
        if (!symbol) {
          errors.push(`Row ${i + 1}: Missing symbol`);
          continue;
        }

        // Find or create security
        let security = await findBySymbol(symbol);
        if (!security) {
          security = await createSecurity({
            symbol,
            name: symbol,
            type: 'stock',
            currency: 'USD',
          });
        }

        const quantity = parseFloat(String(row[columnMapping.quantity || ''] || 0));
        const price = parseFloat(String(row[columnMapping.price || ''] || 0));
        const amount = columnMapping.amount
          ? parseFloat(String(row[columnMapping.amount] || 0))
          : quantity * price;

        transactions.push({
          accountId: selectedAccount,
          securityId: security.id,
          type: (String(row[columnMapping.type || ''] || 'buy').toLowerCase() as Transaction['type']) || 'buy',
          date: String(row[columnMapping.date || ''] || new Date().toISOString()),
          quantity,
          price,
          amount,
          fees: columnMapping.fees ? parseFloat(String(row[columnMapping.fees] || 0)) : undefined,
          notes: columnMapping.notes ? String(row[columnMapping.notes] || '') : undefined,
        });
      } catch (error) {
        errors.push(`Row ${i + 1}: ${(error as Error).message}`);
      }
    }

    if (transactions.length > 0) {
      const count = await importTransactions(transactions);
      setImportStatus({
        success: true,
        message: `Successfully imported ${count} transactions.${errors.length > 0 ? ` ${errors.length} rows skipped.` : ''}`,
      });
    } else {
      setImportStatus({ success: false, message: errors.join('\n') });
    }

    setImportedData([]);
    setColumns([]);
  };

  const processPositions = async () => {
    let successCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < importedData.length; i++) {
      const row = importedData[i] as Record<string, unknown>;
      try {
        const symbol = String(row[columnMapping.symbol || ''] || '').toUpperCase();
        if (!symbol) {
          errors.push(`Row ${i + 1}: Missing symbol`);
          continue;
        }

        let security = await findBySymbol(symbol);
        if (!security) {
          security = await createSecurity({
            symbol,
            name: symbol,
            type: 'stock',
            currency: 'USD',
          });
        }

        const quantity = parseFloat(String(row[columnMapping.quantity || ''] || 0));
        const costBasis = parseFloat(String(row[columnMapping.costBasis || ''] || 0));
        const currentPrice = columnMapping.currentPrice
          ? parseFloat(String(row[columnMapping.currentPrice] || 0)) || undefined
          : undefined;

        const marketValue = currentPrice ? quantity * currentPrice : undefined;
        const unrealizedGain = marketValue ? marketValue - costBasis : undefined;
        const unrealizedGainPercent = unrealizedGain && costBasis > 0 ? (unrealizedGain / costBasis) * 100 : undefined;

        await createPosition({
          accountId: selectedAccount,
          securityId: security.id,
          quantity,
          costBasis,
          currentPrice,
          marketValue,
          unrealizedGain,
          unrealizedGainPercent,
          lastUpdated: new Date().toISOString(),
        });
        successCount++;
      } catch (error) {
        errors.push(`Row ${i + 1}: ${(error as Error).message}`);
      }
    }

    setImportStatus({
      success: successCount > 0,
      message: `Successfully imported ${successCount} positions.${errors.length > 0 ? ` ${errors.length} rows skipped.` : ''}`,
    });

    fetchPositions();
    setImportedData([]);
    setColumns([]);
  };

  const processTaxLots = async () => {
    let successCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < importedData.length; i++) {
      const row = importedData[i] as Record<string, unknown>;
      try {
        const symbol = String(row[columnMapping.symbol || ''] || '').toUpperCase();
        if (!symbol) {
          errors.push(`Row ${i + 1}: Missing symbol`);
          continue;
        }

        let security = await findBySymbol(symbol);
        if (!security) {
          security = await createSecurity({
            symbol,
            name: symbol,
            type: 'stock',
            currency: 'USD',
          });
        }

        const quantity = parseFloat(String(row[columnMapping.quantity || ''] || 0));
        const costBasis = parseFloat(String(row[columnMapping.costBasis || ''] || 0));
        const costPerShare = costBasis / quantity;
        const acquisitionDate = String(row[columnMapping.acquisitionDate || ''] || new Date().toISOString());

        await createTaxLot({
          accountId: selectedAccount,
          securityId: security.id,
          transactionId: 'imported',
          acquisitionDate,
          quantity,
          costBasis,
          costPerShare,
          remainingQuantity: quantity,
          isOpen: true,
        });
        successCount++;
      } catch (error) {
        errors.push(`Row ${i + 1}: ${(error as Error).message}`);
      }
    }

    setImportStatus({
      success: successCount > 0,
      message: `Successfully imported ${successCount} tax lots.${errors.length > 0 ? ` ${errors.length} rows skipped.` : ''}`,
    });

    fetchTaxLots();
    setImportedData([]);
    setColumns([]);
  };

  const requiredFields: Record<ImportType, (keyof ColumnMapping)[]> = {
    transactions: ['date', 'symbol', 'quantity', 'price'],
    positions: ['symbol', 'quantity', 'costBasis'],
    taxlots: ['symbol', 'quantity', 'costBasis', 'acquisitionDate'],
  };

  const optionalFields: Record<ImportType, (keyof ColumnMapping)[]> = {
    transactions: ['type', 'amount', 'fees', 'notes'],
    positions: ['currentPrice'],
    taxlots: [],
  };

  const fieldLabels: Record<keyof ColumnMapping, string> = {
    date: 'Date',
    symbol: 'Symbol',
    type: 'Transaction Type',
    quantity: 'Quantity',
    price: 'Price',
    amount: 'Amount',
    fees: 'Fees',
    notes: 'Notes',
    costBasis: 'Cost Basis',
    currentPrice: 'Current Price',
    acquisitionDate: 'Acquisition Date',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Import Data</h1>
      </div>

      {/* Import Type Selection */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Step 1: Select Import Type</h2>
        <div className="flex gap-4">
          {(['transactions', 'positions', 'taxlots'] as ImportType[]).map((type) => (
            <button
              key={type}
              onClick={() => {
                setImportType(type);
                setColumnMapping({});
              }}
              className={`px-4 py-2 rounded-lg border ${
                importType === type
                  ? 'border-primary-600 bg-primary-50 text-primary-700'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              {type === 'transactions' && 'Transactions'}
              {type === 'positions' && 'Positions'}
              {type === 'taxlots' && 'Tax Lots'}
            </button>
          ))}
        </div>
      </div>

      {/* Account Selection */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Step 2: Select Account</h2>
        <select
          className="select w-64"
          value={selectedAccount}
          onChange={(e) => setSelectedAccount(e.target.value)}
        >
          <option value="">Select Account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} ({account.broker})
            </option>
          ))}
        </select>
      </div>

      {/* File Upload */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Step 3: Import File</h2>
        <p className="text-sm text-gray-600 mb-4">
          Upload an Excel file (.xlsx, .xls) or CSV file with your data.
        </p>
        <button
          onClick={handleImportExcel}
          disabled={importing}
          className="btn-primary"
        >
          {importing ? 'Importing...' : 'Select File to Import'}
        </button>
      </div>

      {/* Column Mapping */}
      {columns.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Step 4: Map Columns</h2>
          <p className="text-sm text-gray-600 mb-4">
            Match your file columns to the required fields. Found {importedData.length} rows.
          </p>

          <div className="space-y-4">
            <div>
              <h3 className="font-medium text-gray-900 mb-2">Required Fields</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {requiredFields[importType].map((field) => (
                  <div key={field}>
                    <label className="label">{fieldLabels[field]} *</label>
                    <select
                      className="select"
                      value={columnMapping[field] || ''}
                      onChange={(e) => handleMappingChange(field, e.target.value)}
                    >
                      <option value="">Select Column</option>
                      {columns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {optionalFields[importType].length > 0 && (
              <div>
                <h3 className="font-medium text-gray-900 mb-2">Optional Fields</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {optionalFields[importType].map((field) => (
                    <div key={field}>
                      <label className="label">{fieldLabels[field]}</label>
                      <select
                        className="select"
                        value={columnMapping[field] || ''}
                        onChange={(e) => handleMappingChange(field, e.target.value)}
                      >
                        <option value="">Select Column</option>
                        {columns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="mt-6">
            <h3 className="font-medium text-gray-900 mb-2">Data Preview (First 5 rows)</h3>
            <div className="overflow-x-auto border rounded-lg">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {columns.map((col) => (
                      <th key={col} className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {importedData.slice(0, 5).map((row, i) => (
                    <tr key={i}>
                      {columns.map((col) => (
                        <td key={col} className="px-3 py-2 whitespace-nowrap text-gray-700">
                          {String((row as Record<string, unknown>)[col] || '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Process Button */}
          <div className="mt-6 flex items-center gap-4">
            <button
              onClick={handleProcessImport}
              disabled={processing || !requiredFields[importType].every(f => columnMapping[f])}
              className="btn-primary"
            >
              {processing ? 'Processing...' : `Import ${importedData.length} Rows`}
            </button>
            <button
              onClick={() => {
                setImportedData([]);
                setColumns([]);
                setColumnMapping({});
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Status Message */}
      {importStatus && (
        <div
          className={`rounded-lg p-4 ${
            importStatus.success
              ? 'bg-green-50 border border-green-200 text-green-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}
        >
          {importStatus.message}
        </div>
      )}

      {/* Help */}
      <div className="card bg-gray-50">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Tips for Importing Data</h2>
        <ul className="text-sm text-gray-600 space-y-1">
          <li>• Make sure your file has column headers in the first row</li>
          <li>• Dates should be in a recognizable format (e.g., MM/DD/YYYY, YYYY-MM-DD)</li>
          <li>• Transaction types should be: buy, sell, dividend, interest, transfer_in, transfer_out, split, spinoff, fee</li>
          <li>• Numbers should not include currency symbols or commas</li>
          <li>• Symbols will be automatically converted to uppercase</li>
        </ul>
      </div>
    </div>
  );
}
