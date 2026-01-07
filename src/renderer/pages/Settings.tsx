import { useEffect, useState } from 'react';
import { useSettings, useBackup } from '../hooks/useApi';
import type { AppSettings, BackupConfig } from '../../shared/types';
import { format } from 'date-fns';

export default function Settings() {
  const { settings, loading, error, fetchSettings, updateSettings } = useSettings();
  const { backups, loading: backupsLoading, fetchBackups, createBackup, restoreBackup } = useBackup();
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [formData, setFormData] = useState<Partial<AppSettings>>({
    theme: 'system',
    currency: 'USD',
    dateFormat: 'MM/dd/yyyy',
    aiProvider: 'none',
    aiApiKey: '',
    backup: {
      provider: 'local',
      enabled: false,
      frequency: 'weekly',
    },
  });

  useEffect(() => {
    fetchSettings();
    fetchBackups();
  }, [fetchSettings, fetchBackups]);

  useEffect(() => {
    if (settings) {
      setFormData({
        theme: settings.theme,
        currency: settings.currency,
        dateFormat: settings.dateFormat,
        aiProvider: settings.aiProvider,
        aiApiKey: settings.aiApiKey || '',
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
    </div>
  );
}
