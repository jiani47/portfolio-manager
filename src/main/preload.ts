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

  // Position intent operations
  getPositionIntent: (positionId: string) => ipcRenderer.invoke('db:position-intents:get', positionId),
  upsertPositionIntent: (positionId: string, data: unknown) => ipcRenderer.invoke('db:position-intents:upsert', positionId, data),
  deletePositionIntent: (positionId: string) => ipcRenderer.invoke('db:position-intents:delete', positionId),
  listPositionIntents: () => ipcRenderer.invoke('db:position-intents:list'),

  // Daily ritual operations
  getDailyRitual: (date: string) => ipcRenderer.invoke('db:daily-rituals:get', date),
  upsertDailyRitual: (date: string, data: unknown) => ipcRenderer.invoke('db:daily-rituals:upsert', date, data),
  listDailyRituals: (limit?: number) => ipcRenderer.invoke('db:daily-rituals:list', limit),

  // Intent change log operations
  listIntentChangeLogs: (positionId?: string) => ipcRenderer.invoke('db:intent-change-logs:list', positionId),
  listIntentChangeLogsByDate: (date: string) => ipcRenderer.invoke('db:intent-change-logs:list-by-date', date),

  // Watchlist operations
  listWatchlists: () => ipcRenderer.invoke('db:watchlists:list'),
  getWatchlist: (id: string) => ipcRenderer.invoke('db:watchlists:get', id),
  createWatchlist: (name: string, description?: string) => ipcRenderer.invoke('db:watchlists:create', name, description),
  updateWatchlist: (id: string, data: unknown) => ipcRenderer.invoke('db:watchlists:update', id, data),
  deleteWatchlist: (id: string) => ipcRenderer.invoke('db:watchlists:delete', id),
  listWatchlistItems: (watchlistId?: string) => ipcRenderer.invoke('db:watchlist-items:list', watchlistId),
  addWatchlistItem: (watchlistId: string, data: unknown) => ipcRenderer.invoke('db:watchlist-items:add', watchlistId, data),
  updateWatchlistItem: (id: string, data: unknown) => ipcRenderer.invoke('db:watchlist-items:update', id, data),
  removeWatchlistItem: (id: string) => ipcRenderer.invoke('db:watchlist-items:remove', id),
  getWatchlistSymbols: () => ipcRenderer.invoke('db:watchlist-items:symbols'),

  // Monitor operations
  listMonitors: (status?: string) => ipcRenderer.invoke('db:monitors:list', status),
  getMonitor: (id: string) => ipcRenderer.invoke('db:monitors:get', id),
  createMonitor: (data: unknown) => ipcRenderer.invoke('db:monitors:create', data),
  updateMonitorStatus: (id: string, status: string) => ipcRenderer.invoke('db:monitors:update-status', id, status),
  deleteMonitor: (id: string) => ipcRenderer.invoke('db:monitors:delete', id),
  checkMonitors: (symbol: string, price: number) => ipcRenderer.invoke('db:monitors:check', symbol, price),
  getTriggeredMonitors: () => ipcRenderer.invoke('db:monitors:triggered'),
  getDueReminderMonitors: () => ipcRenderer.invoke('db:monitors:due-reminders'),
  getEarningsMonitors: () => ipcRenderer.invoke('db:monitors:earnings'),

  // Analytics
  getPortfolioAnalytics: (days?: number) => ipcRenderer.invoke('analytics:portfolio', days),
  getPositionBetas: (days?: number) => ipcRenderer.invoke('analytics:position-betas', days),
  getTradeAnalytics: (days?: number) => ipcRenderer.invoke('analytics:trade-performance', days),
  getTradeJournal: (opts?: { symbol?: string; days?: number }) => ipcRenderer.invoke('analytics:trade-journal', opts),
  getDecisionMemory: (symbol: string) => ipcRenderer.invoke('analytics:decision-memory', symbol),
  getCorrelationMatrix: (days?: number) => ipcRenderer.invoke('analytics:correlation-matrix', days),
  getConcentrationAnalysis: () => ipcRenderer.invoke('analytics:concentration'),

  // Sector performance
  getSectorPerformance: () => ipcRenderer.invoke('fmp:sector-performance'),

  // Price levels (support/resistance)
  getPriceLevels: (symbol?: string) => ipcRenderer.invoke('db:price-levels', symbol),
  refreshPriceLevels: (symbols?: string[]) => ipcRenderer.invoke('db:price-levels:refresh', symbols),
  createPriceLevel: (symbol: string, levelType: 'support' | 'resistance', price: number, strength?: number, source?: string) =>
    ipcRenderer.invoke('db:price-levels:create', symbol, levelType, price, strength, source),
  updatePriceLevel: (id: string, data: { price?: number; strength?: number; levelType?: 'support' | 'resistance' }) =>
    ipcRenderer.invoke('db:price-levels:update', id, data),
  deletePriceLevel: (id: string) => ipcRenderer.invoke('db:price-levels:delete', id),

  // Price history by symbol
  getPriceHistoryBySymbol: (symbol: string, days?: number) =>
    ipcRenderer.invoke('db:price-history-by-symbol', symbol, days),

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

  // Massive data provider operations
  massiveTestConnection: () => ipcRenderer.invoke('massive:test-connection'),
  massiveGetQuote: (symbol: string) => ipcRenderer.invoke('massive:get-quote', symbol),
  massiveGetTickerDetails: (symbol: string) => ipcRenderer.invoke('massive:get-ticker-details', symbol),
  massiveGetPriceHistory: (securityId: string, startDate?: string, endDate?: string) =>
    ipcRenderer.invoke('massive:get-price-history', securityId, startDate, endDate),
  massiveRefreshPrices: () => ipcRenderer.invoke('massive:refresh-prices'),
  massiveFetchHistorical: (symbol: string, days?: number) =>
    ipcRenderer.invoke('massive:fetch-historical', symbol, days),
  massiveFetchAllHistorical: (days?: number) =>
    ipcRenderer.invoke('massive:fetch-all-historical', days),
  massiveGetIntraday: (symbol: string, date?: string) =>
    ipcRenderer.invoke('massive:get-intraday', symbol, date),

  // Unified data provider operations (auto-routes to configured provider)
  dataRefreshPrices: () => ipcRenderer.invoke('data:refresh-prices'),
  dataFetchAllHistorical: (days?: number) => ipcRenderer.invoke('data:fetch-all-historical', days),

  // Schwab brokerage connection operations
  schwabStartOAuth: () => ipcRenderer.invoke('schwab:start-oauth'),
  schwabGetStatus: () => ipcRenderer.invoke('schwab:get-status'),
  schwabDisconnect: () => ipcRenderer.invoke('schwab:disconnect'),
  schwabSyncPositions: () => ipcRenderer.invoke('schwab:sync-positions'),
  schwabSyncTransactions: (startDate?: string, endDate?: string) => ipcRenderer.invoke('schwab:sync-transactions', startDate, endDate),

  // Schwab order operations
  schwabPlaceOrder: (order: unknown) => ipcRenderer.invoke('schwab:place-order', order),
  schwabGetOrders: (status?: string) => ipcRenderer.invoke('schwab:get-orders', status),
  schwabCancelOrder: (accountNumber: string, orderId: string) => ipcRenderer.invoke('schwab:cancel-order', accountNumber, orderId),
  schwabTestMarketData: () => ipcRenderer.invoke('schwab:test-market-data'),

  // Pre-trade checklist
  preTradeEvaluate: (req: unknown) => ipcRenderer.invoke('pre-trade:evaluate', req),
  preTradeRecord: (data: unknown) => ipcRenderer.invoke('pre-trade:record', data),

  // Streaming events (main -> renderer push)
  onStreamingQuote: (callback: (quote: unknown) => void) => {
    const handler = (_event: unknown, quote: unknown) => callback(quote);
    ipcRenderer.on('streaming:quote', handler);
    return () => { ipcRenderer.removeListener('streaming:quote', handler); };
  },
  onStreamingStatus: (callback: (status: string) => void) => {
    const handler = (_event: unknown, status: string) => callback(status);
    ipcRenderer.on('streaming:status', handler);
    return () => { ipcRenderer.removeListener('streaming:status', handler); };
  },
  onPositionsSynced: (callback: (data: { positionsSynced: number; accountsSynced: number }) => void) => {
    const handler = (_event: unknown, data: { positionsSynced: number; accountsSynced: number }) => callback(data);
    ipcRenderer.on('positions:synced', handler);
    return () => { ipcRenderer.removeListener('positions:synced', handler); };
  },

  // EMS Basket operations
  emsListBaskets: () => ipcRenderer.invoke('ems:baskets:list'),
  emsGetBasket: (name: string) => ipcRenderer.invoke('ems:baskets:get', name),

  // Entry plan operations
  getEntryPlanBySymbol: (symbol: string) => ipcRenderer.invoke('db:entry-plans:get-by-symbol', symbol),
  listEntryPlans: (opts?: { status?: string; symbol?: string }) => ipcRenderer.invoke('db:entry-plans:list', opts),
  createEntryPlan: (data: unknown) => ipcRenderer.invoke('db:entry-plans:create', data),
  cancelEntryPlan: (id: string) => ipcRenderer.invoke('db:entry-plans:cancel', id),

  // Post-mortem operations
  listPostMortems: (opts?: { symbol?: string; outcome?: string; limit?: number }) => ipcRenderer.invoke('db:post-mortems:list', opts),
  getPostMortem: (id: string) => ipcRenderer.invoke('db:post-mortems:get', id),
  createPostMortem: (data: unknown) => ipcRenderer.invoke('db:post-mortems:create', data),
  updatePostMortem: (id: string, data: unknown) => ipcRenderer.invoke('db:post-mortems:update', id, data),
  deletePostMortem: (id: string) => ipcRenderer.invoke('db:post-mortems:delete', id),

  // Earnings review operations
  listEarningsReviews: (opts?: { symbol?: string; pending?: boolean; limit?: number }) => ipcRenderer.invoke('db:earnings-reviews:list', opts),
  createEarningsReview: (data: unknown) => ipcRenderer.invoke('db:earnings-reviews:create', data),
  updateEarningsReview: (id: string, data: unknown) => ipcRenderer.invoke('db:earnings-reviews:update', id, data),
  getPendingEarningsReviews: () => ipcRenderer.invoke('db:earnings-reviews:pending'),

  // Broker P&L operations
  getBrokerPLSummary: () => ipcRenderer.invoke('db:broker-pl:summary'),
  getBrokerPLBySymbol: (symbol: string) => ipcRenderer.invoke('db:broker-pl:by-symbol', symbol),

  // Portfolio snapshot operations
  getSnapshotDailyTotals: (days?: number) => ipcRenderer.invoke('db:snapshots:daily-totals', days),
  getPositionSnapshotHistory: (symbol: string, days?: number) => ipcRenderer.invoke('db:snapshots:position-history', symbol, days),

  // Valuation metrics
  getValuationMetrics: () => ipcRenderer.invoke('db:valuations:list'),

  // Config helpers
  getFmpApiKey: () => ipcRenderer.invoke('config:get-fmp-key'),

  // Streaming control (renderer -> main)
  streamingStart: (symbols: string[]) => ipcRenderer.invoke('streaming:start', symbols),
  streamingStop: () => ipcRenderer.invoke('streaming:stop'),
  streamingGetStatus: () => ipcRenderer.invoke('streaming:get-status'),
  streamingGetQuotes: () => ipcRenderer.invoke('streaming:get-quotes'),
  streamingUpdateSymbols: (symbols: string[]) => ipcRenderer.invoke('streaming:update-symbols', symbols),

  // News operations
  getRecentNews: (hours?: number) => ipcRenderer.invoke('db:news:recent', hours),
  getNewsBySymbol: (symbol: string, limit?: number) => ipcRenderer.invoke('db:news:by-symbol', symbol, limit),

  // Scheduler operations
  schedulerGetStatus: () => ipcRenderer.invoke('scheduler:get-status'),
  schedulerGetHeartbeat: () => ipcRenderer.invoke('scheduler:get-heartbeat'),
  schedulerRunTask: (taskId: string) => ipcRenderer.invoke('scheduler:run-task', taskId),
  schedulerEnableTask: (taskId: string) => ipcRenderer.invoke('scheduler:enable-task', taskId),
  schedulerDisableTask: (taskId: string) => ipcRenderer.invoke('scheduler:disable-task', taskId),
  schedulerGetTaskHistory: (taskId: string, limit?: number) => ipcRenderer.invoke('scheduler:get-task-history', taskId, limit),

  // Scheduler events (main -> renderer push)
  onSchedulerTaskStarted: (callback: (data: { taskId: string; startedAt: string }) => void) => {
    const handler = (_event: unknown, data: { taskId: string; startedAt: string }) => callback(data);
    ipcRenderer.on('scheduler:task-started', handler);
    return () => { ipcRenderer.removeListener('scheduler:task-started', handler); };
  },
  onSchedulerTaskCompleted: (callback: (data: { taskId: string; status: string; result: string }) => void) => {
    const handler = (_event: unknown, data: { taskId: string; status: string; result: string }) => callback(data);
    ipcRenderer.on('scheduler:task-completed', handler);
    return () => { ipcRenderer.removeListener('scheduler:task-completed', handler); };
  },
});
