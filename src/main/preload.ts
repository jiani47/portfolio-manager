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
  deleteTaxLot: (id: string) => ipcRenderer.invoke('db:taxlots:delete', id),
  deleteAllTaxLots: (accountId: string) => ipcRenderer.invoke('db:taxlots:deleteAll', accountId),
  deleteTaxLotsBySymbol: (accountId: string, securityId: string) => ipcRenderer.invoke('db:taxlots:deleteBySymbol', accountId, securityId),

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

  // Brokerage import operations
  listBrokerageParsers: () => ipcRenderer.invoke('parsers:list'),
  selectBrokerageFile: () => ipcRenderer.invoke('file:select-brokerage-file'),
  selectBrokerageFiles: () => ipcRenderer.invoke('file:select-brokerage-files'),
  parseBrokerageFile: (parserId: string, filePath: string) => ipcRenderer.invoke('file:parse-brokerage', parserId, filePath),

  // Transaction import operations
  listTransactionParsers: () => ipcRenderer.invoke('transaction-parsers:list'),
  parseTransactionFile: (parserId: string, filePath: string) => ipcRenderer.invoke('file:parse-transactions', parserId, filePath),

  // Lot details import operations
  listLotDetailsParsers: () => ipcRenderer.invoke('lot-details-parsers:list'),
  parseLotDetailsFile: (parserId: string, filePath: string) => ipcRenderer.invoke('file:parse-lot-details', parserId, filePath),

  // Security tag operations
  getSecurityTags: () => ipcRenderer.invoke('db:security-tags:list'),
  createSecurityTag: (tag: unknown) => ipcRenderer.invoke('db:security-tags:create', tag),
  updateSecurityTag: (id: string, tag: unknown) => ipcRenderer.invoke('db:security-tags:update', id, tag),
  deleteSecurityTag: (id: string) => ipcRenderer.invoke('db:security-tags:delete', id),

  // Security tag assignment operations
  getSecurityTagAssignments: (securityId?: string) => ipcRenderer.invoke('db:security-tag-assignments:list', securityId),
  assignTagToSecurity: (securityId: string, tagId: string) => ipcRenderer.invoke('db:security-tag-assignments:assign', securityId, tagId),
  removeTagFromSecurity: (securityId: string, tagId: string) => ipcRenderer.invoke('db:security-tag-assignments:remove', securityId, tagId),
  getTagsForSecurity: (securityId: string) => ipcRenderer.invoke('db:security-tag-assignments:get-tags-for-security', securityId),

  // Trading rule operations
  getTradingRules: (filters?: unknown) => ipcRenderer.invoke('db:trading-rules:list', filters),
  createTradingRule: (rule: unknown) => ipcRenderer.invoke('db:trading-rules:create', rule),
  getTradingRule: (id: string) => ipcRenderer.invoke('db:trading-rules:get', id),
  updateTradingRule: (id: string, rule: unknown) => ipcRenderer.invoke('db:trading-rules:update', id, rule),
  deleteTradingRule: (id: string) => ipcRenderer.invoke('db:trading-rules:delete', id),

  // Decision log operations
  getDecisionLogs: (filters?: unknown) => ipcRenderer.invoke('db:decision-logs:list', filters),
  createDecisionLog: (log: unknown) => ipcRenderer.invoke('db:decision-logs:create', log),
  getDecisionLog: (id: string) => ipcRenderer.invoke('db:decision-logs:get', id),
  updateDecisionLog: (id: string, log: unknown) => ipcRenderer.invoke('db:decision-logs:update', id, log),
  deleteDecisionLog: (id: string) => ipcRenderer.invoke('db:decision-logs:delete', id),

  // FMP data provider operations
  fmpTestConnection: () => ipcRenderer.invoke('fmp:test-connection'),
  fmpGetQuote: (symbol: string) => ipcRenderer.invoke('fmp:get-quote', symbol),
  fmpGetCompanyProfile: (symbol: string) => ipcRenderer.invoke('fmp:get-company-profile', symbol),
  fmpGetPriceHistory: (securityId: string, startDate?: string, endDate?: string) =>
    ipcRenderer.invoke('fmp:get-price-history', securityId, startDate, endDate),
  fmpRefreshPrices: () => ipcRenderer.invoke('fmp:refresh-prices'),
  fmpFetchHistorical: (symbol: string, days?: number) =>
    ipcRenderer.invoke('fmp:fetch-historical', symbol, days),
  fmpFetchAllHistorical: (days?: number) =>
    ipcRenderer.invoke('fmp:fetch-all-historical', days),
  fmpGetEarningsCalendar: (fromDate?: string, toDate?: string) =>
    ipcRenderer.invoke('fmp:get-earnings-calendar', fromDate, toDate),
  fmpGetPortfolioEarnings: (fromDate?: string, toDate?: string) =>
    ipcRenderer.invoke('fmp:get-portfolio-earnings', fromDate, toDate),
});
