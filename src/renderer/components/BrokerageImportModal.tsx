import { useState, useEffect } from 'react';
import { useBrokerageImport, useAccounts, useSecurities, usePositions } from '../hooks/useApi';
import type { Account, BrokerageAccountData } from '../../shared/types';

interface BrokerageImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type Step = 'select-parser' | 'upload-file' | 'preview-import';

export default function BrokerageImportModal({ isOpen, onClose, onSuccess }: BrokerageImportModalProps) {
  const [step, setStep] = useState<Step>('select-parser');
  const [selectedParserId, setSelectedParserId] = useState<string>('');
  const [accountMappings, setAccountMappings] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

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
  } = useBrokerageImport();

  const { accounts, fetchAccounts } = useAccounts();
  const { createSecurity, findBySymbol } = useSecurities();
  const { createPosition } = usePositions();

  useEffect(() => {
    if (isOpen) {
      fetchParsers();
      fetchAccounts();
    }
  }, [isOpen, fetchParsers, fetchAccounts]);

  useEffect(() => {
    if (!isOpen) {
      setStep('select-parser');
      setSelectedParserId('');
      setAccountMappings({});
      setImporting(false);
      setImportError(null);
      clearResult();
    }
  }, [isOpen, clearResult]);

  const handleSelectParser = (parserId: string) => {
    setSelectedParserId(parserId);
  };

  const handleNextFromParser = () => {
    if (selectedParserId) {
      setStep('upload-file');
    }
  };

  const handleSelectFile = async () => {
    const filePath = await selectFile();
    if (filePath && selectedParserId) {
      const result = await parseFile(selectedParserId, filePath);
      if (result && result.success && result.accounts.length > 0) {
        // Initialize account mappings with empty values
        const initialMappings: Record<string, string> = {};
        result.accounts.forEach(acc => {
          initialMappings[acc.accountIdentifier] = '';
        });
        setAccountMappings(initialMappings);
        setStep('preview-import');
      }
    }
  };

  const handleAccountMapping = (brokerageAccount: string, appAccountId: string) => {
    setAccountMappings(prev => ({
      ...prev,
      [brokerageAccount]: appAccountId,
    }));
  };

  const handleImport = async () => {
    if (!parseResult) return;

    // Validate all accounts are mapped
    const unmappedAccounts = Object.entries(accountMappings).filter(([_, appId]) => !appId);
    if (unmappedAccounts.length > 0) {
      setImportError('Please map all brokerage accounts to app accounts before importing.');
      return;
    }

    setImporting(true);
    setImportError(null);

    try {
      for (const brokerageAccount of parseResult.accounts) {
        const appAccountId = accountMappings[brokerageAccount.accountIdentifier];
        if (!appAccountId) continue;

        for (const position of brokerageAccount.positions) {
          // Find or create security
          let security = await findBySymbol(position.symbol);
          if (!security) {
            security = await createSecurity({
              symbol: position.symbol.toUpperCase(),
              name: position.name,
              type: position.securityType,
              currency: 'USD',
            });
          }

          // Create position
          await createPosition({
            accountId: appAccountId,
            securityId: security.id,
            quantity: position.quantity,
            costBasis: position.costBasis,
            currentPrice: position.currentPrice,
            marketValue: position.marketValue,
            unrealizedGain: position.unrealizedGain,
            unrealizedGainPercent: position.unrealizedGainPercent,
            lastUpdated: new Date().toISOString(),
          });
        }
      }

      onSuccess();
      onClose();
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Import from Brokerage</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Step indicators */}
          <div className="flex items-center mt-4 space-x-4">
            <StepIndicator
              number={1}
              label="Select Brokerage"
              active={step === 'select-parser'}
              completed={step === 'upload-file' || step === 'preview-import'}
            />
            <div className="flex-1 h-px bg-gray-200" />
            <StepIndicator
              number={2}
              label="Upload File"
              active={step === 'upload-file'}
              completed={step === 'preview-import'}
            />
            <div className="flex-1 h-px bg-gray-200" />
            <StepIndicator
              number={3}
              label="Review & Import"
              active={step === 'preview-import'}
              completed={false}
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {step === 'select-parser' && (
            <SelectParserStep
              parsers={parsers}
              selectedParserId={selectedParserId}
              onSelect={handleSelectParser}
              loading={loading}
            />
          )}

          {step === 'upload-file' && (
            <UploadFileStep
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
              loading={loading}
              error={error}
            />
          )}

          {step === 'preview-import' && parseResult && (
            <PreviewImportStep
              parseResult={parseResult}
              accounts={accounts}
              accountMappings={accountMappings}
              onAccountMapping={handleAccountMapping}
              formatCurrency={formatCurrency}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-between">
          <button
            onClick={() => {
              if (step === 'upload-file') setStep('select-parser');
              else if (step === 'preview-import') setStep('upload-file');
              else onClose();
            }}
            className="btn-secondary"
          >
            {step === 'select-parser' ? 'Cancel' : 'Back'}
          </button>

          <div className="flex gap-3">
            {(error || importError) && (
              <div className="text-red-600 text-sm self-center mr-4">
                {error || importError}
              </div>
            )}

            {step === 'select-parser' && (
              <button
                onClick={handleNextFromParser}
                disabled={!selectedParserId}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            )}

            {step === 'upload-file' && (
              <button
                onClick={handleSelectFile}
                disabled={loading}
                className="btn-primary disabled:opacity-50"
              >
                {loading ? 'Parsing...' : 'Select File'}
              </button>
            )}

            {step === 'preview-import' && (
              <button
                onClick={handleImport}
                disabled={importing || Object.values(accountMappings).some(v => !v)}
                className="btn-primary disabled:opacity-50"
              >
                {importing ? 'Importing...' : 'Import Positions'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface StepIndicatorProps {
  number: number;
  label: string;
  active: boolean;
  completed: boolean;
}

function StepIndicator({ number, label, active, completed }: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
          completed
            ? 'bg-primary-600 text-white'
            : active
            ? 'bg-primary-100 text-primary-700 border-2 border-primary-600'
            : 'bg-gray-100 text-gray-500'
        }`}
      >
        {completed ? (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          number
        )}
      </div>
      <span className={`text-sm ${active ? 'text-gray-900 font-medium' : 'text-gray-500'}`}>
        {label}
      </span>
    </div>
  );
}

interface SelectParserStepProps {
  parsers: { id: string; name: string; description: string }[];
  selectedParserId: string;
  onSelect: (id: string) => void;
  loading: boolean;
}

function SelectParserStep({ parsers, selectedParserId, onSelect, loading }: SelectParserStepProps) {
  if (loading) {
    return <div className="text-center text-gray-500">Loading available parsers...</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-gray-600">Select your brokerage to import positions from:</p>
      <div className="grid grid-cols-2 gap-4">
        {parsers.map((parser) => (
          <button
            key={parser.id}
            onClick={() => onSelect(parser.id)}
            className={`p-4 border rounded-lg text-left transition-all ${
              selectedParserId === parser.id
                ? 'border-primary-500 bg-primary-50 ring-2 ring-primary-500'
                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <h3 className="font-medium text-gray-900">{parser.name}</h3>
            <p className="text-sm text-gray-500 mt-1">{parser.description}</p>
          </button>
        ))}
      </div>
      {parsers.length === 0 && (
        <p className="text-gray-500 text-center py-8">No parsers available.</p>
      )}
    </div>
  );
}

interface UploadFileStepProps {
  selectedFile: string | null;
  onSelectFile: () => void;
  loading: boolean;
  error: string | null;
}

function UploadFileStep({ selectedFile, onSelectFile, loading, error }: UploadFileStepProps) {
  return (
    <div className="space-y-4">
      <p className="text-gray-600">
        Export your positions from your brokerage as a CSV file, then select it here.
      </p>
      <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
        {selectedFile ? (
          <div className="text-gray-700">
            <p className="font-medium">Selected file:</p>
            <p className="text-sm text-gray-500 mt-1">{selectedFile}</p>
          </div>
        ) : (
          <div>
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <p className="mt-2 text-sm text-gray-600">
              Click "Select File" to choose your brokerage export file
            </p>
          </div>
        )}
      </div>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}
    </div>
  );
}

interface PreviewImportStepProps {
  parseResult: {
    accounts: BrokerageAccountData[];
    errors: string[];
  };
  accounts: Account[];
  accountMappings: Record<string, string>;
  onAccountMapping: (brokerageAccount: string, appAccountId: string) => void;
  formatCurrency: (value: number) => string;
}

function PreviewImportStep({
  parseResult,
  accounts,
  accountMappings,
  onAccountMapping,
  formatCurrency,
}: PreviewImportStepProps) {
  return (
    <div className="space-y-6">
      {parseResult.errors.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-lg">
          <p className="font-medium">Warnings:</p>
          <ul className="list-disc list-inside text-sm mt-1">
            {parseResult.errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {parseResult.accounts.map((brokerageAccount) => (
        <div key={brokerageAccount.accountIdentifier} className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="bg-gray-50 px-4 py-3 flex items-center justify-between">
            <h3 className="font-medium text-gray-900">
              {brokerageAccount.accountIdentifier}
            </h3>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600">Import to:</label>
              <select
                className="select w-48"
                value={accountMappings[brokerageAccount.accountIdentifier] || ''}
                onChange={(e) => onAccountMapping(brokerageAccount.accountIdentifier, e.target.value)}
              >
                <option value="">Select Account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="table-header">Symbol</th>
                  <th className="table-header">Name</th>
                  <th className="table-header">Type</th>
                  <th className="table-header text-right">Quantity</th>
                  <th className="table-header text-right">Price</th>
                  <th className="table-header text-right">Cost Basis</th>
                  <th className="table-header text-right">Market Value</th>
                  <th className="table-header text-right">Gain/Loss</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {brokerageAccount.positions.map((position, idx) => (
                  <tr key={`${position.symbol}-${idx}`} className="hover:bg-gray-50">
                    <td className="table-cell font-medium">{position.symbol}</td>
                    <td className="table-cell text-gray-500 max-w-xs truncate">{position.name}</td>
                    <td className="table-cell">
                      <span className="badge badge-info capitalize">{position.securityType}</span>
                    </td>
                    <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                    <td className="table-cell text-right">{formatCurrency(position.currentPrice)}</td>
                    <td className="table-cell text-right">{formatCurrency(position.costBasis)}</td>
                    <td className="table-cell text-right">{formatCurrency(position.marketValue)}</td>
                    <td className="table-cell text-right">
                      <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                        {formatCurrency(position.unrealizedGain)}
                        <span className="text-xs ml-1">
                          ({position.unrealizedGainPercent >= 0 ? '+' : ''}{position.unrealizedGainPercent.toFixed(2)}%)
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bg-gray-50 px-4 py-2 text-sm text-gray-600">
            {brokerageAccount.positions.length} positions
          </div>
        </div>
      ))}
    </div>
  );
}
