import { useEffect, useState, useCallback } from 'react';
import { useSettings, useBackup, useSecurityTags, useFMP, useMassive, useSchwab, useScheduler, useAccounts } from '../hooks/useApi';
import type { Account, AppSettings, BackupConfig, SecurityTag, TaskRunRecord } from '../../shared/types';
import { format } from 'date-fns';
import Import from './Import';

const TAG_COLORS = [
  { value: 'blue', label: 'Blue', class: 'bg-blue-500' },
  { value: 'purple', label: 'Purple', class: 'bg-purple-500' },
  { value: 'orange', label: 'Orange', class: 'bg-orange-500' },
  { value: 'green', label: 'Green', class: 'bg-green-500' },
  { value: 'red', label: 'Red', class: 'bg-red-500' },
  { value: 'gray', label: 'Gray', class: 'bg-gray-500' },
];

export default function Settings() {
  const { settings, loading, error, fetchSettings, updateSettings } = useSettings();
  const { backups, loading: backupsLoading, fetchBackups, createBackup, restoreBackup } = useBackup();
  const { tags, fetchTags, createTag, updateTag, deleteTag } = useSecurityTags();
  const { testConnection: fmpTestConnection, loading: testingFmpConnection } = useFMP();
  const { testConnection: massiveTestConnection, loading: testingMassiveConnection } = useMassive();
  const { status: schwabStatus, loading: schwabLoading, error: schwabError, fetchStatus: fetchSchwabStatus, startOAuth, disconnect: disconnectSchwab, syncPositions, syncTransactions } = useSchwab();
  const { status: schedulerStatus, fetchStatus: fetchSchedulerStatus, runTask, enableTask, disableTask, getTaskHistory } = useScheduler();
  const { accounts, fetchAccounts, createAccount, updateAccount, deleteAccount } = useAccounts();
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [accountFormData, setAccountFormData] = useState({ name: '', broker: '', accountNumber: '', accountType: 'brokerage' as Account['accountType'], book: '' as string, currency: 'USD' });
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskHistory, setTaskHistory] = useState<TaskRunRecord[]>([]);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showTagModal, setShowTagModal] = useState(false);
  const [editingTag, setEditingTag] = useState<SecurityTag | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [schwabMessage, setSchwabMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showSchwabSecret, setShowSchwabSecret] = useState(false);
  const [tagFormData, setTagFormData] = useState({
    name: '',
    displayName: '',
    color: 'blue',
    description: '',
  });

  const [formData, setFormData] = useState<Partial<AppSettings>>({
    theme: 'system',
    currency: 'USD',
    dateFormat: 'MM/dd/yyyy',
    aiProvider: 'none',
    aiApiKey: '',
    dataProvider: 'none',
    dataProviderApiKey: '',
    fmpApiKey: '',
    schwabClientId: '',
    schwabClientSecret: '',
    schwabCallbackUrl: '',
    backup: {
      provider: 'local',
      enabled: false,
      frequency: 'weekly',
    },
  });

  useEffect(() => {
    fetchSettings();
    fetchBackups();
    fetchTags();
    fetchSchwabStatus();
    fetchSchedulerStatus();
    fetchAccounts();
  }, [fetchSettings, fetchBackups, fetchTags, fetchSchwabStatus, fetchSchedulerStatus, fetchAccounts]);

  // Listen for scheduler task events
  useEffect(() => {
    const cleanupStarted = window.electronAPI.onSchedulerTaskStarted(() => {
      fetchSchedulerStatus();
    });
    const cleanupCompleted = window.electronAPI.onSchedulerTaskCompleted(() => {
      fetchSchedulerStatus();
    });
    return () => {
      cleanupStarted();
      cleanupCompleted();
    };
  }, [fetchSchedulerStatus]);

  const handleRunTask = useCallback(async (taskId: string) => {
    setRunningTaskId(taskId);
    try {
      await runTask(taskId);
      await fetchSchedulerStatus();
    } finally {
      setRunningTaskId(null);
    }
  }, [runTask, fetchSchedulerStatus]);

  const handleToggleTaskHistory = useCallback(async (taskId: string) => {
    if (expandedTask === taskId) {
      setExpandedTask(null);
      setTaskHistory([]);
    } else {
      const history = await getTaskHistory(taskId, 5);
      setTaskHistory(history);
      setExpandedTask(taskId);
    }
  }, [expandedTask, getTaskHistory]);

  useEffect(() => {
    if (settings) {
      setFormData({
        theme: settings.theme,
        currency: settings.currency,
        dateFormat: settings.dateFormat,
        aiProvider: settings.aiProvider,
        aiApiKey: settings.aiApiKey || '',
        dataProvider: settings.dataProvider || 'none',
        dataProviderApiKey: settings.dataProviderApiKey || '',
        fmpApiKey: settings.fmpApiKey || '',
        schwabClientId: settings.schwabClientId || '',
        schwabClientSecret: settings.schwabClientSecret || '',
        schwabCallbackUrl: settings.schwabCallbackUrl || '',
        backup: settings.backup,
      });
    }
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await updateSettings(formData);
      setMessage({ type: 'success', text: 'Settings saved successfully!' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save settings: ' + (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateBackup = async () => {
    setBackingUp(true);
    setMessage(null);
    try {
      const result = await createBackup();
      if (result.success) {
        setMessage({ type: 'success', text: 'Backup created successfully!' });
        fetchBackups();
      } else {
        setMessage({ type: 'error', text: 'Failed to create backup' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to create backup: ' + (err as Error).message });
    } finally {
      setBackingUp(false);
    }
  };

  const handleRestoreBackup = async (path: string) => {
    if (!window.confirm('Are you sure you want to restore this backup? Current data will be overwritten.')) {
      return;
    }

    setRestoring(true);
    setMessage(null);
    try {
      const success = await restoreBackup(path);
      if (success) {
        setMessage({ type: 'success', text: 'Backup restored successfully! Please restart the app.' });
      } else {
        setMessage({ type: 'error', text: 'Failed to restore backup' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to restore backup: ' + (err as Error).message });
    } finally {
      setRestoring(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {message && (
        <div
          className={`rounded-lg p-4 ${
            message.type === 'success'
              ? 'bg-green-50 border border-green-200 text-green-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* General Settings */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">General</h2>
        <div className="space-y-4">
          <div>
            <label className="label">Theme</label>
            <select
              className="select w-48"
              value={formData.theme}
              onChange={(e) => setFormData({ ...formData, theme: e.target.value as AppSettings['theme'] })}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div>
            <label className="label">Currency</label>
            <select
              className="select w-48"
              value={formData.currency}
              onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
            >
              <option value="USD">USD ($)</option>
              <option value="EUR">EUR (€)</option>
              <option value="GBP">GBP (£)</option>
              <option value="CAD">CAD ($)</option>
              <option value="JPY">JPY (¥)</option>
            </select>
          </div>
          <div>
            <label className="label">Date Format</label>
            <select
              className="select w-48"
              value={formData.dateFormat}
              onChange={(e) => setFormData({ ...formData, dateFormat: e.target.value })}
            >
              <option value="MM/dd/yyyy">MM/DD/YYYY</option>
              <option value="dd/MM/yyyy">DD/MM/YYYY</option>
              <option value="yyyy-MM-dd">YYYY-MM-DD</option>
            </select>
          </div>
        </div>
      </div>

      {/* Security Tags Settings */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Holdings Tags</h2>
            <p className="text-sm text-gray-500">Categorize your holdings by tier</p>
          </div>
          <button
            onClick={() => {
              setEditingTag(null);
              setTagFormData({ name: '', displayName: '', color: 'blue', description: '' });
              setShowTagModal(true);
            }}
            className="btn-secondary text-sm"
          >
            Add Tag
          </button>
        </div>
        <div className="space-y-2">
          {tags.map(tag => {
            const colorClass = TAG_COLORS.find(c => c.value === tag.color)?.class || 'bg-gray-500';
            return (
              <div key={tag.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className={`w-4 h-4 rounded-full ${colorClass}`} />
                  <div>
                    <div className="font-medium text-gray-900">{tag.displayName}</div>
                    {tag.description && (
                      <div className="text-xs text-gray-500">{tag.description}</div>
                    )}
                  </div>
                  {tag.isSystem && (
                    <span className="text-xs text-gray-400 bg-gray-200 px-2 py-0.5 rounded">System</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setEditingTag(tag);
                      setTagFormData({
                        name: tag.name,
                        displayName: tag.displayName,
                        color: tag.color,
                        description: tag.description || '',
                      });
                      setShowTagModal(true);
                    }}
                    className="text-primary-600 hover:text-primary-700 text-sm"
                  >
                    Edit
                  </button>
                  {!tag.isSystem && (
                    <button
                      onClick={async () => {
                        if (window.confirm('Are you sure you want to delete this tag?')) {
                          try {
                            await deleteTag(tag.id);
                          } catch (err) {
                            console.error('Failed to delete tag:', err);
                          }
                        }
                      }}
                      className="text-red-600 hover:text-red-700 text-sm"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* AI Settings */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">AI Insights</h2>
        <p className="text-sm text-gray-600 mb-4">
          Configure an AI provider to get intelligent insights about your portfolio.
          Your API key is stored locally and never sent anywhere except to the AI provider.
        </p>
        <div className="space-y-4">
          <div>
            <label className="label">AI Provider</label>
            <select
              className="select w-48"
              value={formData.aiProvider}
              onChange={(e) => setFormData({ ...formData, aiProvider: e.target.value as AppSettings['aiProvider'] })}
            >
              <option value="none">None (Basic Insights)</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic (Claude)</option>
            </select>
          </div>
          {formData.aiProvider !== 'none' && (
            <div>
              <label className="label">API Key</label>
              <input
                type="password"
                className="input w-full max-w-md"
                value={formData.aiApiKey}
                onChange={(e) => setFormData({ ...formData, aiApiKey: e.target.value })}
                placeholder={formData.aiProvider === 'openai' ? 'sk-...' : 'sk-ant-...'}
              />
              <p className="text-xs text-gray-500 mt-1">
                {formData.aiProvider === 'openai'
                  ? 'Get your API key from platform.openai.com'
                  : 'Get your API key from console.anthropic.com'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Market Data Settings */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Market Data</h2>
        <p className="text-sm text-gray-600 mb-4">
          Configure a data provider to fetch real-time prices and company information for your holdings.
          Your API key is stored locally.
        </p>
        <div className="space-y-4">
          <div>
            <label className="label">Data Provider</label>
            <select
              className="select w-64"
              value={formData.dataProvider}
              onChange={(e) => {
                setFormData({ ...formData, dataProvider: e.target.value as AppSettings['dataProvider'] });
                setConnectionStatus(null);
              }}
            >
              <option value="none">None</option>
              <option value="fmp">FMP (Financial Modeling Prep)</option>
              <option value="massive">Massive</option>
              <option value="schwab">Schwab (uses connected account)</option>
            </select>
          </div>
          {formData.dataProvider === 'fmp' && (
            <>
              <div>
                <label className="label">API Key</label>
                <div className="flex items-center gap-2 max-w-md">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="input flex-1"
                    value={formData.dataProviderApiKey}
                    onChange={(e) => {
                      setFormData({ ...formData, dataProviderApiKey: e.target.value });
                      setConnectionStatus(null);
                    }}
                    placeholder="Your FMP API key"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Get your free API key from{' '}
                  <a
                    href="https://financialmodelingprep.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 hover:underline"
                  >
                    financialmodelingprep.com
                  </a>
                </p>
              </div>
              <div className="flex items-center gap-4">
                <button
                  onClick={async () => {
                    // Save settings first so the API key is configured
                    await updateSettings({
                      dataProvider: formData.dataProvider,
                      dataProviderApiKey: formData.dataProviderApiKey,
                    });
                    const result = await fmpTestConnection();
                    setConnectionStatus(result);
                  }}
                  disabled={testingFmpConnection || !formData.dataProviderApiKey}
                  className="btn-secondary"
                >
                  {testingFmpConnection ? 'Testing...' : 'Test Connection'}
                </button>
                {connectionStatus && (
                  <span
                    className={`text-sm ${
                      connectionStatus.success ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {connectionStatus.message}
                  </span>
                )}
              </div>
            </>
          )}
          {formData.dataProvider === 'massive' && (
            <>
              <div>
                <label className="label">API Key</label>
                <div className="flex items-center gap-2 max-w-md">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="input flex-1"
                    value={formData.dataProviderApiKey}
                    onChange={(e) => {
                      setFormData({ ...formData, dataProviderApiKey: e.target.value });
                      setConnectionStatus(null);
                    }}
                    placeholder="Your Massive API key"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Get your API key from{' '}
                  <a
                    href="https://massive.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 hover:underline"
                  >
                    massive.com
                  </a>
                  . Supports real-time quotes, historical prices, and intraday data.
                </p>
              </div>
              <div className="flex items-center gap-4">
                <button
                  onClick={async () => {
                    // Save settings first so the API key is configured
                    await updateSettings({
                      dataProvider: formData.dataProvider,
                      dataProviderApiKey: formData.dataProviderApiKey,
                    });
                    const result = await massiveTestConnection();
                    setConnectionStatus(result);
                  }}
                  disabled={testingMassiveConnection || !formData.dataProviderApiKey}
                  className="btn-secondary"
                >
                  {testingMassiveConnection ? 'Testing...' : 'Test Connection'}
                </button>
                {connectionStatus && (
                  <span
                    className={`text-sm ${
                      connectionStatus.success ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {connectionStatus.message}
                  </span>
                )}
              </div>
            </>
          )}
          {formData.dataProvider === 'schwab' && (
            <>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${schwabStatus?.connected ? 'bg-green-500' : 'bg-red-400'}`} />
                  <span className={`text-sm font-medium ${schwabStatus?.connected ? 'text-green-700' : 'text-red-600'}`}>
                    {schwabStatus?.connected ? 'Schwab connected' : 'Schwab not connected'}
                  </span>
                </div>
                {!schwabStatus?.connected && (
                  <p className="text-xs text-gray-500">
                    Set up your Schwab connection in the Brokerage Connection section below, then select Schwab as your data provider.
                  </p>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  Market data uses your Schwab OAuth connection. Data may be delayed 15-20 min depending on account entitlements.
                </p>
              </div>
              <div className="flex items-center gap-4">
                <button
                  onClick={async () => {
                    const result = await window.electronAPI.schwabTestMarketData();
                    setConnectionStatus(result);
                  }}
                  disabled={!schwabStatus?.connected}
                  className="btn-secondary"
                >
                  Test Connection
                </button>
                {connectionStatus && (
                  <span
                    className={`text-sm ${
                      connectionStatus.success ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {connectionStatus.message}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        {formData.dataProvider !== 'fmp' && formData.dataProvider !== 'none' && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-medium text-gray-700 mb-2">FMP API Key (for earnings, technicals, sectors, news)</h3>
            <p className="text-xs text-gray-500 mb-2">
              FMP is used for supplementary data regardless of your quote data provider.
            </p>
            <div className="flex items-center gap-2">
              <input
                type={showApiKey ? 'text' : 'password'}
                className="input flex-1 max-w-md"
                value={formData.fmpApiKey}
                onChange={(e) => {
                  setFormData({ ...formData, fmpApiKey: e.target.value });
                }}
                placeholder="FMP API Key"
              />
            </div>
          </div>
        )}
      </div>

      {/* Brokerage Connection */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Brokerage Connection</h2>
        <p className="text-sm text-gray-600 mb-4">
          Connect your Charles Schwab account to sync positions and transactions directly.
          This is separate from market data providers above -- both can be used simultaneously.
        </p>
        <div className="space-y-4">
          <div>
            <label className="label">Client ID</label>
            <input
              type="text"
              className="input w-full max-w-md"
              value={formData.schwabClientId || ''}
              onChange={(e) => setFormData({ ...formData, schwabClientId: e.target.value })}
              placeholder="Your Schwab API Client ID"
            />
          </div>
          <div>
            <label className="label">Client Secret</label>
            <div className="flex items-center gap-2 max-w-md">
              <input
                type={showSchwabSecret ? 'text' : 'password'}
                className="input flex-1"
                value={formData.schwabClientSecret || ''}
                onChange={(e) => setFormData({ ...formData, schwabClientSecret: e.target.value })}
                placeholder="Your Schwab API Client Secret"
              />
              <button
                type="button"
                onClick={() => setShowSchwabSecret(!showSchwabSecret)}
                className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                {showSchwabSecret ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div>
            <label className="label">Callback URL</label>
            <input
              type="text"
              className="input w-full max-w-md"
              value={formData.schwabCallbackUrl || ''}
              onChange={(e) => setFormData({ ...formData, schwabCallbackUrl: e.target.value })}
              placeholder="https://127.0.0.1:5556/callback"
            />
            <p className="text-xs text-gray-500 mt-1">
              Must match the callback URL registered in your Schwab developer app. HTTPS required.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            {!schwabStatus?.connected ? (
              <button
                onClick={async () => {
                  setSchwabMessage(null);
                  // Save credentials first
                  await updateSettings({
                    schwabClientId: formData.schwabClientId,
                    schwabClientSecret: formData.schwabClientSecret,
                    schwabCallbackUrl: formData.schwabCallbackUrl,
                  });
                  const result = await startOAuth();
                  if (result.success) {
                    setSchwabMessage({ type: 'success', text: result.message });
                  } else {
                    setSchwabMessage({ type: 'error', text: result.message });
                  }
                }}
                disabled={schwabLoading || !formData.schwabClientId || !formData.schwabClientSecret || !formData.schwabCallbackUrl}
                className="btn-primary"
              >
                {schwabLoading ? 'Connecting...' : 'Connect to Schwab'}
              </button>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                  <span className="text-sm text-green-700 font-medium">
                    Connected{schwabStatus.accountCount ? ` (${schwabStatus.accountCount} account${schwabStatus.accountCount !== 1 ? 's' : ''})` : ''}
                  </span>
                </div>
                <button
                  onClick={async () => {
                    setSchwabMessage(null);
                    await disconnectSchwab();
                    setSchwabMessage({ type: 'success', text: 'Disconnected from Schwab' });
                  }}
                  disabled={schwabLoading}
                  className="btn-secondary text-sm"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>

          {schwabStatus?.connected && (
            <div className="flex items-center gap-3 pt-2 border-t border-gray-200">
              <button
                onClick={async () => {
                  setSchwabMessage(null);
                  const result = await syncPositions();
                  if (result.success) {
                    setSchwabMessage({ type: 'success', text: `Synced ${result.positionsSynced} positions across ${result.accountsSynced} account(s)` });
                  } else {
                    setSchwabMessage({ type: 'error', text: result.errors.join('; ') || 'Sync failed' });
                  }
                }}
                disabled={schwabLoading}
                className="btn-secondary"
              >
                {schwabLoading ? 'Syncing...' : 'Sync Positions'}
              </button>
              <button
                onClick={async () => {
                  setSchwabMessage(null);
                  const result = await syncTransactions();
                  if (result.success) {
                    setSchwabMessage({ type: 'success', text: `Synced ${result.transactionsSynced} transactions across ${result.accountsSynced} account(s)` });
                  } else {
                    setSchwabMessage({ type: 'error', text: result.errors.join('; ') || 'Sync failed' });
                  }
                }}
                disabled={schwabLoading}
                className="btn-secondary"
              >
                {schwabLoading ? 'Syncing...' : 'Sync Transactions'}
              </button>
            </div>
          )}

          {schwabMessage && (
            <div
              className={`rounded-lg p-3 text-sm ${
                schwabMessage.type === 'success'
                  ? 'bg-green-50 border border-green-200 text-green-700'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}
            >
              {schwabMessage.text}
            </div>
          )}

          {schwabError && !schwabMessage && (
            <div className="rounded-lg p-3 text-sm bg-red-50 border border-red-200 text-red-700">
              {schwabError}
            </div>
          )}
        </div>
      </div>

      {/* Accounts */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Accounts</h2>
          <button
            onClick={() => {
              setEditingAccount(null);
              setAccountFormData({ name: '', broker: '', accountNumber: '', accountType: 'brokerage', book: '', currency: 'USD' });
              setShowAccountModal(true);
            }}
            className="btn-primary text-sm"
          >
            Add Account
          </button>
        </div>
        {accounts.length === 0 ? (
          <p className="text-sm text-gray-500">No accounts configured.</p>
        ) : (
          <div className="space-y-2">
            {accounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div>
                    <span className="font-medium text-gray-900">{account.name}</span>
                    <span className="text-sm text-gray-500 ml-2">{account.broker}</span>
                    {account.accountNumber && (
                      <span className="text-xs text-gray-400 ml-2">****{account.accountNumber.slice(-4)}</span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    {account.book && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${account.book === 'investing' ? 'bg-blue-100 text-blue-700' : 'bg-yellow-100 text-yellow-700'} capitalize`}>
                        {account.book}
                      </span>
                    )}
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 capitalize">
                      {account.accountType.replace('_', ' ')}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setEditingAccount(account);
                      setAccountFormData({
                        name: account.name,
                        broker: account.broker,
                        accountNumber: account.accountNumber || '',
                        accountType: account.accountType,
                        book: account.book || '',
                        currency: account.currency,
                      });
                      setShowAccountModal(true);
                    }}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Edit
                  </button>
                  <button
                    onClick={async () => {
                      if (window.confirm('Delete this account? This will also delete all associated positions and transactions.')) {
                        await deleteAccount(account.id);
                      }
                    }}
                    className="text-xs text-red-600 hover:text-red-800"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Account Modal */}
      {showAccountModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              {editingAccount ? 'Edit Account' : 'Add Account'}
            </h2>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const submitData = { ...accountFormData, book: accountFormData.book || undefined };
              if (editingAccount) {
                await updateAccount(editingAccount.id, submitData);
              } else {
                await createAccount(submitData);
              }
              setShowAccountModal(false);
              setEditingAccount(null);
            }} className="space-y-4">
              <div>
                <label className="label">Account Name</label>
                <input type="text" className="input" value={accountFormData.name} onChange={(e) => setAccountFormData({ ...accountFormData, name: e.target.value })} placeholder="e.g., Main Brokerage" required />
              </div>
              <div>
                <label className="label">Broker</label>
                <input type="text" className="input" value={accountFormData.broker} onChange={(e) => setAccountFormData({ ...accountFormData, broker: e.target.value })} placeholder="e.g., Schwab" required />
              </div>
              <div>
                <label className="label">Account Number (Optional)</label>
                <input type="text" className="input" value={accountFormData.accountNumber} onChange={(e) => setAccountFormData({ ...accountFormData, accountNumber: e.target.value })} placeholder="For your reference only" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Type</label>
                  <select className="select" value={accountFormData.accountType} onChange={(e) => setAccountFormData({ ...accountFormData, accountType: e.target.value as Account['accountType'] })}>
                    <option value="brokerage">Brokerage</option>
                    <option value="ira">Traditional IRA</option>
                    <option value="roth_ira">Roth IRA</option>
                    <option value="401k">401(k)</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="label">Book</label>
                  <select className="select" value={accountFormData.book} onChange={(e) => setAccountFormData({ ...accountFormData, book: e.target.value })}>
                    <option value="">-</option>
                    <option value="investing">Investing</option>
                    <option value="trading">Trading</option>
                  </select>
                </div>
                <div>
                  <label className="label">Currency</label>
                  <select className="select" value={accountFormData.currency} onChange={(e) => setAccountFormData({ ...accountFormData, currency: e.target.value })}>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="CAD">CAD</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={() => { setShowAccountModal(false); setEditingAccount(null); }} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{editingAccount ? 'Save' : 'Add Account'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Backup Settings */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Backup & Restore</h2>
        <div className="space-y-4">
          <div>
            <label className="label">Backup Provider</label>
            <select
              className="select w-48"
              value={formData.backup?.provider}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  backup: { ...formData.backup!, provider: e.target.value as BackupConfig['provider'] },
                })
              }
            >
              <option value="local">Local Only</option>
              <option value="google_drive">Google Drive</option>
              <option value="dropbox">Dropbox</option>
              <option value="s3">Amazon S3</option>
              <option value="onedrive">OneDrive</option>
            </select>
            {formData.backup?.provider !== 'local' && (
              <p className="text-xs text-gray-500 mt-1">
                Cloud backup integration requires additional setup. Contact support for details.
              </p>
            )}
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.backup?.enabled}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    backup: { ...formData.backup!, enabled: e.target.checked },
                  })
                }
                className="rounded border-gray-300"
              />
              <span className="text-sm">Enable automatic backups</span>
            </label>
          </div>

          {formData.backup?.enabled && (
            <div>
              <label className="label">Backup Frequency</label>
              <select
                className="select w-48"
                value={formData.backup?.frequency}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    backup: { ...formData.backup!, frequency: e.target.value as BackupConfig['frequency'] },
                  })
                }
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleCreateBackup}
              disabled={backingUp}
              className="btn-secondary"
            >
              {backingUp ? 'Creating...' : 'Create Backup Now'}
            </button>
          </div>

          {/* Backup List */}
          {backups.length > 0 && (
            <div className="mt-4">
              <h3 className="font-medium text-gray-900 mb-2">Available Backups</h3>
              <div className="border rounded-lg divide-y">
                {backups.slice(0, 5).map((backup, index) => (
                  <div key={index} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {format(new Date(backup.timestamp), 'MMM d, yyyy h:mm a')}
                      </p>
                      <p className="text-xs text-gray-500">{formatBytes(backup.size)}</p>
                    </div>
                    <button
                      onClick={() => handleRestoreBackup(backup.path)}
                      disabled={restoring}
                      className="text-sm text-primary-600 hover:text-primary-700"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button onClick={handleSave} disabled={saving} className="btn-primary">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {/* About */}
      <div className="card bg-gray-50">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">About Portfolio Manager</h2>
        <p className="text-sm text-gray-600">
          Version 1.0.0
        </p>
        <p className="text-sm text-gray-600 mt-2">
          A personal portfolio management application for tracking investments, transactions,
          and tax lots across multiple brokerage accounts.
        </p>
        <div className="mt-4 text-sm text-gray-500">
          <p>Features:</p>
          <ul className="list-disc list-inside mt-1 space-y-1">
            <li>Multi-account portfolio tracking</li>
            <li>Transaction history and import</li>
            <li>Tax lot management with holding period tracking</li>
            <li>AI-powered portfolio insights</li>
            <li>Local database with cloud backup options</li>
          </ul>
        </div>
      </div>

      {/* Task Scheduler */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Task Scheduler</h2>
          {schedulerStatus && (
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${
                schedulerStatus.running && (Date.now() - schedulerStatus.lastTick) < 180000
                  ? 'bg-green-500'
                  : 'bg-red-500'
              }`} />
              <span className="text-xs text-gray-500">
                {schedulerStatus.running ? 'Running' : 'Stopped'}
              </span>
            </div>
          )}
        </div>

        {schedulerStatus ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Task</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Schedule</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Status</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Last Run</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Duration</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedulerStatus.tasks.map(task => (
                  <>
                    <tr key={task.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2 px-3">
                        <button
                          onClick={() => handleToggleTaskHistory(task.id)}
                          className="font-medium text-gray-900 hover:text-blue-600 text-left"
                        >
                          {task.name}
                        </button>
                      </td>
                      <td className="py-2 px-3 text-gray-500 text-xs">{task.schedule}</td>
                      <td className="py-2 px-3">
                        {task.isRunning ? (
                          <span className="text-blue-600 text-xs font-medium">Running...</span>
                        ) : task.lastRun ? (
                          <span className={`text-xs font-medium ${
                            task.lastRun.status === 'success' ? 'text-green-600' : 'text-red-600'
                          }`}>
                            {task.lastRun.status === 'success' ? 'OK' : 'Failed'}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">Never run</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-gray-600 text-xs">
                        {task.lastRun?.completedAt
                          ? format(new Date(task.lastRun.completedAt), 'MMM d h:mm a')
                          : '—'}
                      </td>
                      <td className="py-2 px-3 text-right text-gray-600 text-xs">
                        {task.lastRun?.durationMs != null
                          ? task.lastRun.durationMs < 1000
                            ? `${task.lastRun.durationMs}ms`
                            : `${(task.lastRun.durationMs / 1000).toFixed(1)}s`
                          : '—'}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button
                          onClick={() => handleRunTask(task.id)}
                          disabled={runningTaskId === task.id || task.isRunning}
                          className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {runningTaskId === task.id ? 'Running...' : 'Run Now'}
                        </button>
                      </td>
                    </tr>
                    {expandedTask === task.id && taskHistory.length > 0 && (
                      <tr key={`${task.id}-history`}>
                        <td colSpan={6} className="px-3 py-2 bg-gray-50">
                          <div className="text-xs space-y-1">
                            <p className="font-medium text-gray-500 mb-1">Recent runs:</p>
                            {taskHistory.map(run => (
                              <div key={run.id} className="flex items-center gap-3 text-gray-600">
                                <span className={run.status === 'success' ? 'text-green-600' : 'text-red-600'}>
                                  {run.status === 'success' ? 'OK' : 'FAIL'}
                                </span>
                                <span>{format(new Date(run.startedAt), 'MMM d h:mm a')}</span>
                                <span className="text-gray-400">
                                  {run.durationMs != null
                                    ? run.durationMs < 1000 ? `${run.durationMs}ms` : `${(run.durationMs / 1000).toFixed(1)}s`
                                    : ''}
                                </span>
                                {run.error && <span className="text-red-500 truncate max-w-xs">{run.error}</span>}
                                {run.result && run.status === 'success' && <span className="text-gray-500 truncate max-w-xs">{run.result}</span>}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">Loading scheduler status...</p>
        )}
      </div>

      {/* Import Data */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Import Data</h2>
        <Import embedded />
      </div>

      {/* Tag Modal */}
      {showTagModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              {editingTag ? 'Edit Tag' : 'Create Tag'}
            </h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  if (editingTag) {
                    await updateTag(editingTag.id, {
                      name: tagFormData.name,
                      displayName: tagFormData.displayName,
                      color: tagFormData.color,
                      description: tagFormData.description || undefined,
                    });
                  } else {
                    await createTag({
                      name: tagFormData.name.toLowerCase().replace(/\s+/g, '_'),
                      displayName: tagFormData.displayName,
                      color: tagFormData.color,
                      description: tagFormData.description || undefined,
                      isSystem: false,
                    });
                  }
                  setShowTagModal(false);
                  setEditingTag(null);
                } catch (err) {
                  console.error('Failed to save tag:', err);
                }
              }}
              className="space-y-4"
            >
              <div>
                <label className="label">Display Name</label>
                <input
                  type="text"
                  className="input"
                  value={tagFormData.displayName}
                  onChange={(e) => setTagFormData({ ...tagFormData, displayName: e.target.value })}
                  placeholder="e.g., Growth"
                  required
                />
              </div>

              <div>
                <label className="label">Color</label>
                <div className="flex gap-2">
                  {TAG_COLORS.map(color => (
                    <button
                      key={color.value}
                      type="button"
                      onClick={() => setTagFormData({ ...tagFormData, color: color.value })}
                      className={`w-8 h-8 rounded-full ${color.class} ${
                        tagFormData.color === color.value ? 'ring-2 ring-offset-2 ring-gray-400' : ''
                      }`}
                      title={color.label}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="label">Description (optional)</label>
                <input
                  type="text"
                  className="input"
                  value={tagFormData.description}
                  onChange={(e) => setTagFormData({ ...tagFormData, description: e.target.value })}
                  placeholder="e.g., High-growth tech companies"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowTagModal(false);
                    setEditingTag(null);
                  }}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  {editingTag ? 'Save Changes' : 'Create Tag'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
