import { useEffect, useState } from 'react';
import { useTransactionImport, useAccounts, useSecurities, useTransactions, useTaxLots } from '../hooks/useApi';
import type { Account, TransactionAccountData, ParsedTaxLot } from '../../shared/types';
import { format } from 'date-fns';

interface TransactionImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => void;
}

type Step = 'select-parser' | 'upload-file' | 'preview';

export default function TransactionImportModal({ isOpen, onClose, onImportComplete }: TransactionImportModalProps) {
  const {
    parsers,
    parseResult,
    selectedFile,
    loading,
    error,
    fetchParsers,
    selectFile,
    parseFile,
    clearResult,
  } = useTransactionImport();

  const { accounts, fetchAccounts } = useAccounts();
  const { findBySymbol, createSecurity } = useSecurities();
  const { createTransaction } = useTransactions();
  const { createTaxLot } = useTaxLots();

  const [step, setStep] = useState<Step>('select-parser');
  const [selectedParserId, setSelectedParserId] = useState<string>('');
  const [accountMapping, setAccountMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchParsers();
      fetchAccounts();
    }
  }, [isOpen, fetchParsers, fetchAccounts]);

  useEffect(() => {
    if (parsers.length > 0 && !selectedParserId) {
      setSelectedParserId(parsers[0].id);
    }
  }, [parsers, selectedParserId]);

  const handleClose = () => {
    setStep('select-parser');
    setSelectedParserId('');
    setAccountMapping({});
    setImportError(null);
    clearResult();
    onClose();
  };

  const handleSelectFile = async () => {
    const filePath = await selectFile();
    if (filePath && selectedParserId) {
      const result = await parseFile(selectedParserId, filePath);
      if (result?.success && result.accounts.length > 0) {
        // Initialize account mapping
        const mapping: Record<string, string> = {};
        result.accounts.forEach(acc => {
          mapping[acc.accountIdentifier] = '';
        });
        setAccountMapping(mapping);
        setStep('preview');
      }
    }
  };

  const handleImport = async () => {
    if (!parseResult || !parseResult.accounts.length) return;

    // Check if all accounts are mapped
    const unmappedAccounts = Object.entries(accountMapping).filter(([, appAccountId]) => !appAccountId);
    if (unmappedAccounts.length > 0) {
      setImportError('Please map all brokerage accounts to app accounts before importing.');
      return;
    }

    setImporting(true);
    setImportError(null);

    try {
      for (const brokerageAccount of parseResult.accounts) {
        const appAccountId = accountMapping[brokerageAccount.accountIdentifier];
        if (!appAccountId) continue;

        for (const txData of brokerageAccount.transactions) {
          // Find or create security
          let security = await findBySymbol(txData.symbol);
          if (!security) {
            security = await createSecurity({
              symbol: txData.symbol.toUpperCase(),
              name: txData.name,
              type: 'stock',
              currency: 'USD',
            });
          }

          // Create transaction
          const transaction = await createTransaction({
            accountId: appAccountId,
            securityId: security.id,
            type: txData.type,
            date: txData.date,
            quantity: txData.quantity,
            price: txData.price,
            amount: txData.amount,
            notes: txData.notes,
          });

          // Create tax lots for this transaction
          const relatedTaxLots = brokerageAccount.taxLots.filter(
            lot => lot.symbol === txData.symbol && lot.closedDate === txData.date
          );

          for (const lot of relatedTaxLots) {
            await createTaxLot({
              accountId: appAccountId,
              securityId: security.id,
              transactionId: transaction.id,
              acquisitionDate: lot.acquisitionDate,
              quantity: lot.quantity,
              costBasis: lot.costBasis,
              costPerShare: lot.costPerShare,
              remainingQuantity: 0,
              isOpen: false,
              closedDate: lot.closedDate,
              closedTransactionId: transaction.id,
              realizedGain: lot.realizedGain,
              holdingPeriod: lot.holdingPeriod,
            });
          }
        }
      }

      onImportComplete();
      handleClose();
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(value);
  };

  const getTotalStats = () => {
    if (!parseResult) return { transactions: 0, taxLots: 0, totalGain: 0, shortTerm: 0, longTerm: 0 };

    let transactions = 0;
    let taxLots = 0;
    let totalGain = 0;
    let shortTerm = 0;
    let longTerm = 0;

    parseResult.accounts.forEach(acc => {
      transactions += acc.transactions.length;
      taxLots += acc.taxLots.length;
      acc.taxLots.forEach(lot => {
        totalGain += lot.realizedGain;
        if (lot.holdingPeriod === 'short') {
          shortTerm += lot.realizedGain;
        } else {
          longTerm += lot.realizedGain;
        }
      });
    });

    return { transactions, taxLots, totalGain, shortTerm, longTerm };
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Import Transactions from Brokerage</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center mb-8">
          <div className={`flex items-center ${step === 'select-parser' ? 'text-blue-600' : 'text-gray-400'}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              step === 'select-parser' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
            }`}>1</div>
            <span className="ml-2 text-sm font-medium">Select Parser</span>
          </div>
          <div className="flex-1 h-px bg-gray-200 mx-4" />
          <div className={`flex items-center ${step === 'upload-file' ? 'text-blue-600' : 'text-gray-400'}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              step === 'upload-file' ? 'bg-blue-600 text-white' : step === 'preview' ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-600'
            }`}>2</div>
            <span className="ml-2 text-sm font-medium">Upload File</span>
          </div>
          <div className="flex-1 h-px bg-gray-200 mx-4" />
          <div className={`flex items-center ${step === 'preview' ? 'text-blue-600' : 'text-gray-400'}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              step === 'preview' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
            }`}>3</div>
            <span className="ml-2 text-sm font-medium">Preview & Import</span>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        {importError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
            {importError}
          </div>
        )}

        {/* Step 1: Select Parser */}
        {step === 'select-parser' && (
          <div className="space-y-4">
            <p className="text-gray-600">Select the brokerage format for your transaction file:</p>
            <div className="space-y-2">
              {parsers.map(parser => (
                <label
                  key={parser.id}
                  className={`flex items-start p-4 border rounded-lg cursor-pointer transition-colors ${
                    selectedParserId === parser.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="parser"
                    value={parser.id}
                    checked={selectedParserId === parser.id}
                    onChange={(e) => setSelectedParserId(e.target.value)}
                    className="mt-1 mr-3"
                  />
                  <div>
                    <div className="font-medium text-gray-900">{parser.name}</div>
                    <div className="text-sm text-gray-500">{parser.description}</div>
                    <div className="text-xs text-gray-400 mt-1">Supported: {parser.fileTypes.join(', ')}</div>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex justify-end mt-6">
              <button
                onClick={() => setStep('upload-file')}
                disabled={!selectedParserId}
                className="btn-primary"
              >
                Next: Select File
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Upload File */}
        {step === 'upload-file' && (
          <div className="space-y-4">
            <p className="text-gray-600">
              Select your {parsers.find(p => p.id === selectedParserId)?.name} file:
            </p>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
              {selectedFile ? (
                <div>
                  <div className="text-green-600 mb-2">
                    <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p className="text-gray-700 font-medium">{selectedFile.split('/').pop()}</p>
                  <p className="text-sm text-gray-500 mt-1">{selectedFile}</p>
                </div>
              ) : (
                <div>
                  <svg className="w-12 h-12 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <p className="text-gray-600 mt-2">Click below to select a file</p>
                </div>
              )}
            </div>
            <div className="flex justify-between mt-6">
              <button onClick={() => setStep('select-parser')} className="btn-secondary">
                Back
              </button>
              <button
                onClick={handleSelectFile}
                disabled={loading}
                className="btn-primary"
              >
                {loading ? 'Processing...' : 'Select File & Parse'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Preview & Import */}
        {step === 'preview' && parseResult && (
          <div className="space-y-6">
            {/* Summary */}
            <div className="grid grid-cols-5 gap-4">
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="text-sm text-gray-500">Accounts</div>
                <div className="text-2xl font-semibold text-gray-900">{parseResult.accounts.length}</div>
              </div>
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="text-sm text-gray-500">Transactions</div>
                <div className="text-2xl font-semibold text-gray-900">{getTotalStats().transactions}</div>
              </div>
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="text-sm text-gray-500">Tax Lots</div>
                <div className="text-2xl font-semibold text-gray-900">{getTotalStats().taxLots}</div>
              </div>
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="text-sm text-gray-500">Short-Term G/L</div>
                <div className={`text-2xl font-semibold ${getTotalStats().shortTerm >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(getTotalStats().shortTerm)}
                </div>
              </div>
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="text-sm text-gray-500">Long-Term G/L</div>
                <div className={`text-2xl font-semibold ${getTotalStats().longTerm >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(getTotalStats().longTerm)}
                </div>
              </div>
            </div>

            {/* Account Mapping */}
            <div className="border rounded-lg p-4">
              <h3 className="font-medium text-gray-900 mb-3">Map Brokerage Accounts</h3>
              <div className="space-y-3">
                {parseResult.accounts.map(acc => (
                  <div key={acc.accountIdentifier} className="flex items-center gap-4">
                    <div className="w-1/3">
                      <span className="text-sm font-medium text-gray-700">{acc.accountIdentifier}</span>
                      <span className="text-xs text-gray-400 ml-2">
                        ({acc.transactions.length} transactions, {acc.taxLots.length} lots)
                      </span>
                    </div>
                    <div className="text-gray-400">→</div>
                    <select
                      className="select flex-1"
                      value={accountMapping[acc.accountIdentifier] || ''}
                      onChange={(e) => setAccountMapping(prev => ({
                        ...prev,
                        [acc.accountIdentifier]: e.target.value
                      }))}
                    >
                      <option value="">Select Account</option>
                      {accounts.map(account => (
                        <option key={account.id} value={account.id}>
                          {account.name} ({account.broker})
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {/* Tax Lots Preview */}
            <div className="border rounded-lg overflow-hidden">
              <h3 className="font-medium text-gray-900 p-4 bg-gray-50 border-b">Tax Lots Preview</h3>
              <div className="max-h-64 overflow-y-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="table-header">Account</th>
                      <th className="table-header">Symbol</th>
                      <th className="table-header">Acquired</th>
                      <th className="table-header">Sold</th>
                      <th className="table-header text-right">Qty</th>
                      <th className="table-header text-right">Cost Basis</th>
                      <th className="table-header text-right">Proceeds</th>
                      <th className="table-header text-right">Gain/Loss</th>
                      <th className="table-header">Term</th>
                      <th className="table-header">Wash</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {parseResult.accounts.flatMap(acc =>
                      acc.taxLots.map((lot, idx) => (
                        <tr key={`${acc.accountIdentifier}-${idx}`} className="hover:bg-gray-50">
                          <td className="table-cell text-xs">{acc.accountIdentifier}</td>
                          <td className="table-cell font-medium">{lot.symbol}</td>
                          <td className="table-cell text-xs">{format(new Date(lot.acquisitionDate), 'MM/dd/yy')}</td>
                          <td className="table-cell text-xs">{format(new Date(lot.closedDate), 'MM/dd/yy')}</td>
                          <td className="table-cell text-right">{lot.quantity}</td>
                          <td className="table-cell text-right">{formatCurrency(lot.costBasis)}</td>
                          <td className="table-cell text-right">{formatCurrency(lot.proceeds)}</td>
                          <td className={`table-cell text-right ${lot.realizedGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatCurrency(lot.realizedGain)}
                          </td>
                          <td className="table-cell">
                            <span className={`badge ${lot.holdingPeriod === 'long' ? 'badge-success' : 'badge-warning'}`}>
                              {lot.holdingPeriod === 'long' ? 'Long' : 'Short'}
                            </span>
                          </td>
                          <td className="table-cell">
                            {lot.washSale && (
                              <span className="badge badge-error">Wash</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-between mt-6">
              <button onClick={() => setStep('upload-file')} className="btn-secondary">
                Back
              </button>
              <button
                onClick={handleImport}
                disabled={importing || Object.values(accountMapping).some(v => !v)}
                className="btn-primary"
              >
                {importing ? 'Importing...' : `Import ${getTotalStats().transactions} Transactions`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
