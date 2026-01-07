import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Account operations
  getAccounts: () => ipcRenderer.invoke('db:accounts:list'),
  createAccount: (account: unknown) => ipcRenderer.invoke('db:accounts:create', account),
  updateAccount: (id: string, account: unknown) => ipcRenderer.invoke('db:accounts:update', id, account),
  deleteAccount: (id: string) => ipcRenderer.invoke('db:accounts:delete', id),

  // Security operations
  getSecurities: () => ipcRenderer.invoke('db:securities:list'),
  createSecurity: (security: unknown) => ipcRenderer.invoke('db:securities:create', security),
  findSecurityBySymbol: (symbol: string) => ipcRenderer.invoke('db:securities:findBySymbol', symbol),

  // Position operations
  getPositions: (accountId?: string) => ipcRenderer.invoke('db:positions:list', accountId),
  createPosition: (position: unknown) => ipcRenderer.invoke('db:positions:create', position),
  updatePosition: (id: string, position: unknown) => ipcRenderer.invoke('db:positions:update', id, position),
  deletePosition: (id: string) => ipcRenderer.invoke('db:positions:delete', id),

  // Transaction operations
  getTransactions: (filters?: unknown) => ipcRenderer.invoke('db:transactions:list', filters),
  createTransaction: (transaction: unknown) => ipcRenderer.invoke('db:transactions:create', transaction),
  updateTransaction: (id: string, transaction: unknown) => ipcRenderer.invoke('db:transactions:update', id, transaction),
  deleteTransaction: (id: string) => ipcRenderer.invoke('db:transactions:delete', id),
  importTransactions: (transactions: unknown[]) => ipcRenderer.invoke('db:transactions:import', transactions),

  // Tax lot operations
  getTaxLots: (filters?: unknown) => ipcRenderer.invoke('db:taxlots:list', filters),
  createTaxLot: (taxLot: unknown) => ipcRenderer.invoke('db:taxlots:create', taxLot),
  updateTaxLot: (id: string, taxLot: unknown) => ipcRenderer.invoke('db:taxlots:update', id, taxLot),

  // File operations
  importExcel: () => ipcRenderer.invoke('file:import-excel'),
  exportData: (data: unknown, filename: string) => ipcRenderer.invoke('file:export-data', data, filename),

  // Backup operations
  createBackup: () => ipcRenderer.invoke('backup:create'),
  restoreBackup: (path: string) => ipcRenderer.invoke('backup:restore', path),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  configureBackup: (config: unknown) => ipcRenderer.invoke('backup:configure', config),

  // Settings operations
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings: unknown) => ipcRenderer.invoke('settings:update', settings),

  // AI operations
  generateInsights: () => ipcRenderer.invoke('ai:generate-insights'),
  analyzePortfolio: () => ipcRenderer.invoke('ai:analyze-portfolio'),

  // Portfolio summary
  getPortfolioSummary: () => ipcRenderer.invoke('db:portfolio:summary'),
  getAssetAllocation: () => ipcRenderer.invoke('db:portfolio:allocation'),
});
