import { IpcMain, dialog } from 'electron';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import Store from 'electron-store';
import { Database } from './database';
import { BackupService } from './backup-service';
import { AIService } from './ai-service';
import { FMPService } from './fmp-service';
import { MassiveService } from './massive-service';
import { SchwabService } from './schwab-service';
import { SchwabStreamService } from './schwab-stream-service';
import { parserRegistry, transactionParserRegistry, lotDetailsParserRegistry } from './parsers';
import { AppSettings, ExcelImportResult, RefreshPricesResult } from '../shared/types';

export function setupIpcHandlers(
  ipcMain: IpcMain,
  db: Database,
  backupService: BackupService,
  aiService: AIService,
  fmpService: FMPService,
  massiveService: MassiveService,
  schwabService: SchwabService,
  streamService: SchwabStreamService | null,
  store: Store<{ settings: AppSettings }>
): void {
  // Account handlers
  ipcMain.handle('db:accounts:list', () => db.listAccounts());
  ipcMain.handle('db:accounts:create', (_, account) => db.createAccount(account));
  ipcMain.handle('db:accounts:update', (_, id, account) => db.updateAccount(id, account));
  ipcMain.handle('db:accounts:delete', (_, id) => db.deleteAccount(id));

  // Security handlers
  ipcMain.handle('db:securities:list', () => db.listSecurities());
  ipcMain.handle('db:securities:create', (_, security) => db.createSecurity(security));
  ipcMain.handle('db:securities:findBySymbol', (_, symbol) => db.findSecurityBySymbol(symbol));

  // Position handlers - uses calculated MTM values from price_history
  ipcMain.handle('db:positions:list', (_, accountId) => db.listPositionsWithMTM(accountId));
  ipcMain.handle('db:positions:create', (_, position) => db.createPosition(position));
  ipcMain.handle('db:positions:update', (_, id, position) => db.updatePosition(id, position));
  ipcMain.handle('db:positions:delete', (_, id) => db.deletePosition(id));

  // Transaction handlers
  ipcMain.handle('db:transactions:list', (_, filters) => db.listTransactions(filters));
  ipcMain.handle('db:transactions:create', (_, transaction) => db.createTransaction(transaction));
  ipcMain.handle('db:transactions:update', (_, id, transaction) => db.updateTransaction(id, transaction));
  ipcMain.handle('db:transactions:delete', (_, id) => db.deleteTransaction(id));
  ipcMain.handle('db:transactions:import', (_, transactions) => db.importTransactions(transactions));

  // Tax lot handlers
  ipcMain.handle('db:taxlots:list', (_, filters) => db.listTaxLots(filters));
  ipcMain.handle('db:taxlots:create', (_, taxLot) => db.createTaxLot(taxLot));
  ipcMain.handle('db:taxlots:update', (_, id, taxLot) => db.updateTaxLot(id, taxLot));
  ipcMain.handle('db:taxlots:delete', (_, id) => db.deleteTaxLot(id));
  ipcMain.handle('db:taxlots:deleteAll', (_, accountId) => db.deleteAllTaxLots(accountId));
  ipcMain.handle('db:taxlots:deleteBySymbol', (_, accountId, securityId) => db.deleteTaxLotsBySymbol(accountId, securityId));

  // Portfolio handlers
  ipcMain.handle('db:portfolio:summary', () => db.getPortfolioSummary());
  ipcMain.handle('db:portfolio:allocation', () => db.getAssetAllocation());

  // File import handler
  ipcMain.handle('file:import-excel', async (): Promise<ExcelImportResult | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Excel Files', extensions: ['xlsx', 'xls', 'csv'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    try {
      const filePath = result.filePaths[0];
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);

      return {
        success: true,
        rowsImported: data.length,
        errors: [],
        data,
      };
    } catch (error) {
      return {
        success: false,
        rowsImported: 0,
        errors: [(error as Error).message],
        data: [],
      };
    }
  });

  // File export handler
  ipcMain.handle('file:export-data', async (_, data, filename) => {
    const result = await dialog.showSaveDialog({
      defaultPath: filename,
      filters: [
        { name: 'Excel Files', extensions: ['xlsx'] },
        { name: 'CSV Files', extensions: ['csv'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return false;
    }

    try {
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
      XLSX.writeFile(workbook, result.filePath);
      return true;
    } catch (error) {
      console.error('Export error:', error);
      return false;
    }
  });

  // Backup handlers
  ipcMain.handle('backup:create', async () => backupService.createBackup());
  ipcMain.handle('backup:restore', async (_, path) => backupService.restoreBackup(path));
  ipcMain.handle('backup:list', () => backupService.listBackups());
  ipcMain.handle('backup:configure', (_, config) => {
    const settings = store.get('settings');
    settings.backup = config;
    store.set('settings', settings);
    backupService.configure(config);
  });

  // Settings handlers
  ipcMain.handle('settings:get', () => store.get('settings'));
  ipcMain.handle('settings:update', async (_, newSettings) => {
    const settings = store.get('settings');
    const updated = { ...settings, ...newSettings };
    store.set('settings', updated);

    // Update AI service if API settings changed
    if (newSettings.aiProvider || newSettings.aiApiKey) {
      aiService.configure(updated);
    }

    // Update FMP service if data provider settings changed
    if (newSettings.dataProvider !== undefined || newSettings.dataProviderApiKey !== undefined) {
      fmpService.configure(updated);
      await massiveService.configure(updated);
    }

    // Update Schwab service if credentials changed
    if (newSettings.schwabClientId !== undefined || newSettings.schwabClientSecret !== undefined || newSettings.schwabCallbackUrl !== undefined) {
      schwabService.configure(updated);
    }

    return updated;
  });

  // AI handlers
  ipcMain.handle('ai:generate-insights', async () => {
    const positions = db.listPositions();
    const transactions = db.listTransactions({ limit: 100 });
    const taxLots = db.listTaxLots();
    const securities = db.listSecurities();
    const accounts = db.listAccounts();

    return aiService.generateInsights({
      positions,
      transactions,
      taxLots,
      securities,
      accounts,
    });
  });

  ipcMain.handle('ai:analyze-portfolio', async () => {
    const positions = db.listPositions();
    const transactions = db.listTransactions({ limit: 100 });
    const summary = db.getPortfolioSummary();
    const allocation = db.getAssetAllocation();
    const securities = db.listSecurities();

    return aiService.analyzePortfolio({
      positions,
      transactions,
      summary,
      allocation,
      securities,
    });
  });

  // Brokerage import handlers
  ipcMain.handle('parsers:list', () => parserRegistry.listParsers());

  ipcMain.handle('file:select-brokerage-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('file:select-brokerage-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    return result.filePaths;
  });

  ipcMain.handle('file:parse-brokerage', async (_, parserId: string, filePath: string) => {
    const parser = parserRegistry.getParser(parserId);
    if (!parser) {
      return {
        success: false,
        broker: parserId,
        accounts: [],
        errors: [`Parser not found: ${parserId}`],
      };
    }

    // Read file content for canParse check
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!parser.canParse(filePath, content)) {
      return {
        success: false,
        broker: parserId,
        accounts: [],
        errors: ['File format not recognized by this parser'],
      };
    }

    return parser.parse(filePath);
  });

  // Transaction import handlers
  ipcMain.handle('transaction-parsers:list', () => transactionParserRegistry.listParsers());

  ipcMain.handle('file:parse-transactions', async (_, parserId: string, filePath: string) => {
    const parser = transactionParserRegistry.getParser(parserId);
    if (!parser) {
      return {
        success: false,
        broker: parserId,
        accounts: [],
        errors: [`Transaction parser not found: ${parserId}`],
      };
    }

    // Read file content for canParse check
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!parser.canParse(filePath, content)) {
      return {
        success: false,
        broker: parserId,
        accounts: [],
        errors: ['File format not recognized by this parser'],
      };
    }

    return parser.parse(filePath);
  });

  // Lot details import handlers
  ipcMain.handle('lot-details-parsers:list', () => lotDetailsParserRegistry.listParsers());

  ipcMain.handle('file:parse-lot-details', async (_, parserId: string, filePath: string) => {
    const parser = lotDetailsParserRegistry.getParser(parserId);
    if (!parser) {
      return {
        success: false,
        broker: parserId,
        symbol: '',
        accountIdentifier: '',
        lots: [],
        errors: [`Lot details parser not found: ${parserId}`],
      };
    }

    // Read file content for canParse check
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!parser.canParse(filePath, content)) {
      return {
        success: false,
        broker: parserId,
        symbol: '',
        accountIdentifier: '',
        lots: [],
        errors: ['File format not recognized by this parser'],
      };
    }

    return parser.parse(filePath);
  });

  // Security tag handlers
  ipcMain.handle('db:security-tags:list', () => db.listSecurityTags());
  ipcMain.handle('db:security-tags:create', (_, tag) => db.createSecurityTag(tag));
  ipcMain.handle('db:security-tags:update', (_, id, tag) => db.updateSecurityTag(id, tag));
  ipcMain.handle('db:security-tags:delete', (_, id) => db.deleteSecurityTag(id));

  // Security tag assignment handlers
  ipcMain.handle('db:security-tag-assignments:list', (_, securityId) => db.listSecurityTagAssignments(securityId));
  ipcMain.handle('db:security-tag-assignments:assign', (_, securityId, tagId) => db.assignTagToSecurity(securityId, tagId));
  ipcMain.handle('db:security-tag-assignments:remove', (_, securityId, tagId) => db.removeTagFromSecurity(securityId, tagId));
  ipcMain.handle('db:security-tag-assignments:get-tags-for-security', (_, securityId) => db.getTagsForSecurity(securityId));

  // Trading rule handlers
  ipcMain.handle('db:trading-rules:list', (_, filters) => db.listTradingRules(filters));
  ipcMain.handle('db:trading-rules:create', (_, rule) => db.createTradingRule(rule));
  ipcMain.handle('db:trading-rules:get', (_, id) => db.getTradingRuleById(id));
  ipcMain.handle('db:trading-rules:update', (_, id, rule) => db.updateTradingRule(id, rule));
  ipcMain.handle('db:trading-rules:delete', (_, id) => db.deleteTradingRule(id));

  // Position intent handlers
  ipcMain.handle('db:position-intents:get', (_, positionId) => db.getPositionIntent(positionId));
  ipcMain.handle('db:position-intents:upsert', (_, positionId, data) => db.upsertPositionIntent(positionId, data));
  ipcMain.handle('db:position-intents:delete', (_, positionId) => db.deletePositionIntent(positionId));
  ipcMain.handle('db:position-intents:list', () => db.listPositionIntents());

  // Daily ritual handlers
  ipcMain.handle('db:daily-rituals:get', (_, date) => db.getDailyRitual(date));
  ipcMain.handle('db:daily-rituals:upsert', (_, date, data) => db.upsertDailyRitual(date, data));
  ipcMain.handle('db:daily-rituals:list', (_, limit) => db.listDailyRituals(limit));

  // Intent change log handlers
  ipcMain.handle('db:intent-change-logs:list', (_, positionId) => db.listIntentChangeLogs(positionId));
  ipcMain.handle('db:intent-change-logs:list-by-date', (_, date) => db.listIntentChangeLogsByDate(date));

  // Watchlist handlers
  ipcMain.handle('db:watchlists:list', () => db.listWatchlists());
  ipcMain.handle('db:watchlists:get', (_, id) => db.getWatchlist(id));
  ipcMain.handle('db:watchlists:create', (_, name, description) => db.createWatchlist(name, description));
  ipcMain.handle('db:watchlists:update', (_, id, data) => db.updateWatchlist(id, data));
  ipcMain.handle('db:watchlists:delete', (_, id) => db.deleteWatchlist(id));
  ipcMain.handle('db:watchlist-items:list', (_, watchlistId) => db.listWatchlistItems(watchlistId));
  ipcMain.handle('db:watchlist-items:add', (_, watchlistId, data) => db.addWatchlistItem(watchlistId, data));
  ipcMain.handle('db:watchlist-items:update', (_, id, data) => db.updateWatchlistItem(id, data));
  ipcMain.handle('db:watchlist-items:remove', (_, id) => db.removeWatchlistItem(id));
  ipcMain.handle('db:watchlist-items:symbols', () => db.getWatchlistSymbols());

  // Monitor handlers
  ipcMain.handle('db:monitors:list', (_, status) => db.listMonitors(status));
  ipcMain.handle('db:monitors:get', (_, id) => db.getMonitor(id));
  ipcMain.handle('db:monitors:create', (_, data) => db.createMonitor(data));
  ipcMain.handle('db:monitors:update-status', (_, id, status) => db.updateMonitorStatus(id, status));
  ipcMain.handle('db:monitors:delete', (_, id) => db.deleteMonitor(id));
  ipcMain.handle('db:monitors:check', (_, symbol, price) => db.checkMonitors(symbol, price));
  ipcMain.handle('db:monitors:triggered', () => db.getTriggeredMonitors());

  // Decision log handlers
  ipcMain.handle('db:decision-logs:list', (_, filters) => db.listDecisionLogs(filters));
  ipcMain.handle('db:decision-logs:create', (_, log) => db.createDecisionLog(log));
  ipcMain.handle('db:decision-logs:get', (_, id) => db.getDecisionLogById(id));
  ipcMain.handle('db:decision-logs:update', (_, id, log) => db.updateDecisionLog(id, log));
  ipcMain.handle('db:decision-logs:delete', (_, id) => db.deleteDecisionLog(id));

  // FMP data provider handlers
  ipcMain.handle('fmp:test-connection', async () => {
    return fmpService.testConnection();
  });

  ipcMain.handle('fmp:get-quote', async (_, symbol: string) => {
    return fmpService.getQuote(symbol);
  });

  ipcMain.handle('fmp:get-company-profile', async (_, symbol: string) => {
    const profile = await fmpService.getCompanyProfile(symbol);
    if (profile) {
      // Also update the security in the database if it exists
      const security = db.findSecurityBySymbol(symbol);
      if (security) {
        db.updateSecurityProfile(security.id, {
          sector: profile.sector,
          industry: profile.industry,
          description: profile.description,
          website: profile.website,
          ceo: profile.ceo,
          marketCap: profile.marketCap,
        });
      }
    }
    return profile;
  });

  ipcMain.handle('fmp:get-price-history', async (_, securityId: string, startDate?: string, endDate?: string) => {
    return db.getPriceHistory(securityId, startDate, endDate);
  });

  ipcMain.handle('fmp:refresh-prices', async (): Promise<RefreshPricesResult> => {
    // Get all positions with their securities
    const positions = db.listPositions();
    const securities = db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    // Build symbol -> securityId map for non-cash positions
    const symbolSecurityMap = new Map<string, string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash') {
        symbolSecurityMap.set(security.symbol, security.id);
      }
    }

    if (symbolSecurityMap.size === 0) {
      return {
        success: true,
        updated: 0,
        failed: 0,
        errors: [],
        prices: {},
      };
    }

    // Check if we already have recent prices (within last 3 days to account for weekends)
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3);
    const threeDaysAgoStr = threeDaysAgo.toISOString().split('T')[0];

    const symbolsNeedingUpdate: Map<string, string> = new Map();

    for (const [symbol, securityId] of symbolSecurityMap) {
      // Check if we have price data from the last 3 days
      const latestPrice = db.getLatestPrice(securityId);
      if (!latestPrice || latestPrice.date < threeDaysAgoStr) {
        symbolsNeedingUpdate.set(symbol, securityId);
      }
    }

    // If all prices are recent, return them (MTM calculated on-the-fly when loading positions)
    if (symbolsNeedingUpdate.size === 0) {
      const pricesObj: Record<string, number> = {};
      let count = 0;

      for (const [symbol, securityId] of symbolSecurityMap) {
        const latestPrice = db.getLatestPrice(securityId);
        if (latestPrice) {
          pricesObj[symbol] = latestPrice.closePrice;
          count++;
        }
      }

      return {
        success: true,
        updated: count,
        failed: 0,
        errors: ['Using recent cached prices'],
        prices: pricesObj,
      };
    }

    // Fetch new prices from FMP
    const { prices, priceHistory, errors } = await fmpService.refreshPrices(symbolsNeedingUpdate);

    // Save price history to database
    if (priceHistory.length > 0) {
      db.savePriceHistoryBatch(priceHistory);
    }

    // For symbols where quotes failed, try to use historical data
    const symbolsMissingPrices: string[] = [];
    for (const [symbol] of symbolsNeedingUpdate) {
      if (!prices.has(symbol)) {
        symbolsMissingPrices.push(symbol);
      }
    }

    // Fetch historical data for symbols that didn't get quotes (weekend/holiday fallback)
    if (symbolsMissingPrices.length > 0) {
      const historicalMap = new Map<string, string>();
      for (const symbol of symbolsMissingPrices) {
        const securityId = symbolSecurityMap.get(symbol);
        if (securityId) {
          historicalMap.set(symbol, securityId);
        }
      }

      const historicalResult = await fmpService.fetchHistoricalForAll(historicalMap, 5);
      if (historicalResult.priceHistory.length > 0) {
        db.savePriceHistoryBatch(historicalResult.priceHistory);
      }
    }

    // Build response with prices (MTM calculated on-the-fly when loading positions)
    let updated = 0;
    let failed = 0;
    const pricesObj: Record<string, number> = {};

    for (const [symbol, securityId] of symbolSecurityMap) {
      // First try real-time price, then fall back to historical
      let newPrice = prices.get(symbol);

      if (newPrice === undefined || newPrice <= 0) {
        const latestHistorical = db.getLatestPrice(securityId);
        if (latestHistorical) {
          newPrice = latestHistorical.closePrice;
        }
      }

      if (newPrice !== undefined && newPrice > 0) {
        pricesObj[symbol] = newPrice;
        updated++;
      } else {
        failed++;
      }
    }

    return {
      success: errors.length === 0 || updated > 0,
      updated,
      failed,
      errors,
      prices: pricesObj,
    };
  });

  ipcMain.handle('fmp:fetch-historical', async (_, symbol: string, days: number = 30) => {
    const security = db.findSecurityBySymbol(symbol);
    if (!security) {
      return { success: false, error: `Security not found: ${symbol}` };
    }

    const prices = await fmpService.getHistoricalPrices(symbol, days);
    if (prices.length === 0) {
      return { success: false, error: `No historical data for ${symbol}` };
    }

    // Add securityId to each price record
    const pricesWithSecurityId = prices.map(p => ({
      ...p,
      securityId: security.id,
    }));

    const count = db.savePriceHistoryBatch(pricesWithSecurityId);
    return { success: true, count };
  });

  ipcMain.handle('fmp:fetch-all-historical', async (_, days: number = 30) => {
    // 1. Get all non-cash positions/securities
    const positions = db.listPositions();
    const securities = db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    // 2. Build symbol -> securityId map for non-cash securities
    const symbolSecurityMap = new Map<string, string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash') {
        symbolSecurityMap.set(security.symbol, security.id);
      }
    }

    if (symbolSecurityMap.size === 0) {
      return { success: true, fetched: 0, updated: 0, errors: [] };
    }

    // 3. Fetch historical data for all symbols
    const { priceHistory, errors } = await fmpService.fetchHistoricalForAll(symbolSecurityMap, days);

    // 4. Save to database (MTM calculated on-the-fly when loading positions)
    const fetched = priceHistory.length > 0 ? db.savePriceHistoryBatch(priceHistory) : 0;

    // Count how many securities now have prices
    let updated = 0;
    for (const [, securityId] of symbolSecurityMap) {
      const latestPrice = db.getLatestPrice(securityId);
      if (latestPrice) {
        updated++;
      }
    }

    return {
      success: errors.length === 0,
      fetched,
      updated,
      errors,
    };
  });

  // Earnings calendar handlers
  ipcMain.handle('fmp:get-earnings-calendar', async (_, fromDate?: string, toDate?: string) => {
    return fmpService.getEarningsCalendar(fromDate, toDate);
  });

  ipcMain.handle('fmp:get-portfolio-earnings', async (_, fromDate?: string, toDate?: string) => {
    // Get all unique symbols from positions
    const positions = db.listPositions();
    const securities = db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    const symbols: string[] = [];
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash' && !symbols.includes(security.symbol)) {
        symbols.push(security.symbol);
      }
    }

    if (symbols.length === 0) {
      return [];
    }

    return fmpService.getEarningsForSymbols(symbols, fromDate, toDate);
  });

  // Massive data provider handlers
  ipcMain.handle('massive:test-connection', async () => {
    return massiveService.testConnection();
  });

  ipcMain.handle('massive:get-quote', async (_, symbol: string) => {
    return massiveService.getQuote(symbol);
  });

  ipcMain.handle('massive:get-ticker-details', async (_, symbol: string) => {
    const details = await massiveService.getTickerDetails(symbol);
    if (details) {
      // Also update the security in the database if it exists
      const security = db.findSecurityBySymbol(symbol);
      if (security) {
        db.updateSecurityProfile(security.id, {
          description: details.description,
          website: details.homepageUrl,
          marketCap: details.marketCap,
        });
      }
    }
    return details;
  });

  ipcMain.handle('massive:get-price-history', async (_, securityId: string, startDate?: string, endDate?: string) => {
    return db.getPriceHistory(securityId, startDate, endDate);
  });

  ipcMain.handle('massive:refresh-prices', async (): Promise<RefreshPricesResult> => {
    // Get all positions with their securities
    const positions = db.listPositions();
    const securities = db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    // Build symbol -> securityId map for non-cash positions
    const symbolSecurityMap = new Map<string, string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash') {
        symbolSecurityMap.set(security.symbol, security.id);
      }
    }

    if (symbolSecurityMap.size === 0) {
      return {
        success: true,
        updated: 0,
        failed: 0,
        errors: [],
        prices: {},
      };
    }

    // Check if we already have recent prices (within last 3 days to account for weekends)
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3);
    const threeDaysAgoStr = threeDaysAgo.toISOString().split('T')[0];

    const symbolsNeedingUpdate: Map<string, string> = new Map();

    for (const [symbol, securityId] of symbolSecurityMap) {
      // Check if we have price data from the last 3 days
      const latestPrice = db.getLatestPrice(securityId);
      if (!latestPrice || latestPrice.date < threeDaysAgoStr) {
        symbolsNeedingUpdate.set(symbol, securityId);
      }
    }

    // If all prices are recent, return them (MTM calculated on-the-fly when loading positions)
    if (symbolsNeedingUpdate.size === 0) {
      const pricesObj: Record<string, number> = {};
      let count = 0;

      for (const [symbol, securityId] of symbolSecurityMap) {
        const latestPrice = db.getLatestPrice(securityId);
        if (latestPrice) {
          pricesObj[symbol] = latestPrice.closePrice;
          count++;
        }
      }

      return {
        success: true,
        updated: count,
        failed: 0,
        errors: ['Using recent cached prices'],
        prices: pricesObj,
      };
    }

    // Fetch new prices from Massive
    const { prices, priceHistory, errors } = await massiveService.refreshPrices(symbolsNeedingUpdate);

    // Save price history to database
    if (priceHistory.length > 0) {
      db.savePriceHistoryBatch(priceHistory);
    }

    // For symbols where quotes failed, try to use historical data
    const symbolsMissingPrices: string[] = [];
    for (const [symbol] of symbolsNeedingUpdate) {
      if (!prices.has(symbol)) {
        symbolsMissingPrices.push(symbol);
      }
    }

    // Fetch historical data for symbols that didn't get quotes (weekend/holiday fallback)
    if (symbolsMissingPrices.length > 0) {
      const historicalMap = new Map<string, string>();
      for (const symbol of symbolsMissingPrices) {
        const securityId = symbolSecurityMap.get(symbol);
        if (securityId) {
          historicalMap.set(symbol, securityId);
        }
      }

      const historicalResult = await massiveService.fetchHistoricalForAll(historicalMap, 5);
      if (historicalResult.priceHistory.length > 0) {
        db.savePriceHistoryBatch(historicalResult.priceHistory);
      }
    }

    // Build response with prices (MTM calculated on-the-fly when loading positions)
    let updated = 0;
    let failed = 0;
    const pricesObj: Record<string, number> = {};

    for (const [symbol, securityId] of symbolSecurityMap) {
      // First try real-time price, then fall back to historical
      let newPrice = prices.get(symbol);

      if (newPrice === undefined || newPrice <= 0) {
        const latestHistorical = db.getLatestPrice(securityId);
        if (latestHistorical) {
          newPrice = latestHistorical.closePrice;
        }
      }

      if (newPrice !== undefined && newPrice > 0) {
        pricesObj[symbol] = newPrice;
        updated++;
      } else {
        failed++;
      }
    }

    return {
      success: errors.length === 0 || updated > 0,
      updated,
      failed,
      errors,
      prices: pricesObj,
    };
  });

  ipcMain.handle('massive:fetch-historical', async (_, symbol: string, days: number = 30) => {
    const security = db.findSecurityBySymbol(symbol);
    if (!security) {
      return { success: false, error: `Security not found: ${symbol}` };
    }

    const prices = await massiveService.getHistoricalPrices(symbol, days);
    if (prices.length === 0) {
      return { success: false, error: `No historical data for ${symbol}` };
    }

    // Add securityId to each price record
    const pricesWithSecurityId = prices.map(p => ({
      ...p,
      securityId: security.id,
    }));

    const count = db.savePriceHistoryBatch(pricesWithSecurityId);
    return { success: true, count };
  });

  ipcMain.handle('massive:fetch-all-historical', async (_, days: number = 30) => {
    // 1. Get all non-cash positions/securities
    const positions = db.listPositions();
    const securities = db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    // 2. Build symbol -> securityId map for non-cash securities
    const symbolSecurityMap = new Map<string, string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash') {
        symbolSecurityMap.set(security.symbol, security.id);
      }
    }

    if (symbolSecurityMap.size === 0) {
      return { success: true, fetched: 0, updated: 0, errors: [] };
    }

    // 3. Fetch historical data for all symbols
    const { priceHistory, errors } = await massiveService.fetchHistoricalForAll(symbolSecurityMap, days);

    // 4. Save to database (MTM calculated on-the-fly when loading positions)
    const fetched = priceHistory.length > 0 ? db.savePriceHistoryBatch(priceHistory) : 0;

    // Count how many securities now have prices
    let updated = 0;
    for (const [, securityId] of symbolSecurityMap) {
      const latestPrice = db.getLatestPrice(securityId);
      if (latestPrice) {
        updated++;
      }
    }

    return {
      success: errors.length === 0,
      fetched,
      updated,
      errors,
    };
  });

  ipcMain.handle('massive:get-intraday', async (_, symbol: string, date?: string) => {
    return massiveService.getIntradayPrices(symbol, date);
  });

  // Unified data provider handlers - automatically route to configured provider
  ipcMain.handle('data:refresh-prices', async (): Promise<RefreshPricesResult> => {
    const settings = store.get('settings');

    // Get all positions with their securities
    const positions = db.listPositions();
    const securities = db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    const symbolSecurityMap = new Map<string, string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash') {
        symbolSecurityMap.set(security.symbol, security.id);
      }
    }

    if (symbolSecurityMap.size === 0) {
      return { success: true, updated: 0, failed: 0, errors: [], prices: {} };
    }

    let prices: Map<string, number>;
    let priceHistory: Omit<import('../shared/types').PriceHistory, 'id'>[];
    let errors: string[];
    let delayed: boolean | undefined;

    if (settings.dataProvider === 'schwab' && schwabService.isConnected()) {
      const result = await schwabService.refreshPrices(symbolSecurityMap);
      prices = result.prices;
      priceHistory = result.priceHistory;
      errors = result.errors;
      delayed = result.delayed;
    } else if (settings.dataProvider === 'massive' && massiveService.isConfigured()) {
      const result = await massiveService.refreshPrices(symbolSecurityMap);
      prices = result.prices;
      priceHistory = result.priceHistory;
      errors = result.errors;
    } else if (settings.dataProvider === 'fmp' && fmpService.isConfigured()) {
      const result = await fmpService.refreshPrices(symbolSecurityMap);
      prices = result.prices;
      priceHistory = result.priceHistory;
      errors = result.errors;
    } else {
      return {
        success: false,
        updated: 0,
        failed: 0,
        errors: ['No data provider configured'],
        prices: {},
      };
    }

    // Save price history to database (MTM calculated on-the-fly when loading positions)
    if (priceHistory.length > 0) {
      db.savePriceHistoryBatch(priceHistory);
    }

    // Build response with prices
    let updated = 0;
    let failed = 0;
    const pricesObj: Record<string, number> = {};

    for (const [symbol, securityId] of symbolSecurityMap) {
      let newPrice = prices.get(symbol);
      if (newPrice === undefined || newPrice <= 0) {
        const latestHistorical = db.getLatestPrice(securityId);
        if (latestHistorical) newPrice = latestHistorical.closePrice;
      }

      if (newPrice !== undefined && newPrice > 0) {
        pricesObj[symbol] = newPrice;
        updated++;
      } else {
        failed++;
      }
    }

    return { success: errors.length === 0 || updated > 0, updated, failed, errors, prices: pricesObj, delayed };
  });

  ipcMain.handle('data:fetch-all-historical', async (_, days: number = 30) => {
    const settings = store.get('settings');

    const positions = db.listPositions();
    const securities = db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    const symbolSecurityMap = new Map<string, string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash') {
        symbolSecurityMap.set(security.symbol, security.id);
      }
    }

    if (symbolSecurityMap.size === 0) {
      return { success: true, fetched: 0, updated: 0, errors: [] };
    }

    let priceHistory: Omit<import('../shared/types').PriceHistory, 'id'>[] = [];
    let errors: string[] = [];

    if (settings.dataProvider === 'schwab' && schwabService.isConnected()) {
      const result = await schwabService.fetchHistoricalForAll(symbolSecurityMap, days);
      priceHistory = result.priceHistory;
      errors = result.errors;
    } else if (settings.dataProvider === 'massive' && massiveService.isConfigured()) {
      const result = await massiveService.fetchHistoricalForAll(symbolSecurityMap, days);
      priceHistory = result.priceHistory;
      errors = result.errors;
    } else if (settings.dataProvider === 'fmp' && fmpService.isConfigured()) {
      const result = await fmpService.fetchHistoricalForAll(symbolSecurityMap, days);
      priceHistory = result.priceHistory;
      errors = result.errors;
    } else {
      return { success: false, fetched: 0, updated: 0, errors: ['No data provider configured'] };
    }

    // Save to database (MTM calculated on-the-fly when loading positions)
    const fetched = priceHistory.length > 0 ? db.savePriceHistoryBatch(priceHistory) : 0;

    // Count how many securities now have prices
    let updated = 0;
    for (const [, securityId] of symbolSecurityMap) {
      const latestPrice = db.getLatestPrice(securityId);
      if (latestPrice) {
        updated++;
      }
    }

    return { success: errors.length === 0, fetched, updated, errors };
  });

  // Schwab brokerage connection handlers
  ipcMain.handle('schwab:start-oauth', async () => {
    return schwabService.startOAuth();
  });

  ipcMain.handle('schwab:get-status', () => {
    return schwabService.getConnectionStatus();
  });

  ipcMain.handle('schwab:disconnect', () => {
    schwabService.disconnect();
    return { success: true };
  });

  ipcMain.handle('schwab:sync-positions', async () => {
    return schwabService.syncPositions(db);
  });

  ipcMain.handle('schwab:sync-transactions', async (_, startDate?: string, endDate?: string) => {
    return schwabService.syncTransactions(db, startDate, endDate);
  });

  // Schwab order handlers
  ipcMain.handle('schwab:place-order', async (_, order) => {
    return schwabService.placeOrder(order.accountNumber, order);
  });

  ipcMain.handle('schwab:get-orders', async (_, status?) => {
    return schwabService.getOrdersForAllAccounts(status);
  });

  ipcMain.handle('schwab:cancel-order', async (_, accountNumber, orderId) => {
    return schwabService.cancelOrder(accountNumber, orderId);
  });

  // Schwab market data handler
  ipcMain.handle('schwab:test-market-data', async () => {
    return schwabService.testMarketDataConnection();
  });

  // Streaming handlers
  ipcMain.handle('streaming:start', async (_, symbols: string[]) => {
    if (!streamService) return { success: false, message: 'Streaming not available' };
    await streamService.connect(symbols);
    return { success: true };
  });

  ipcMain.handle('streaming:stop', async () => {
    streamService?.disconnect();
  });

  ipcMain.handle('streaming:get-status', () => {
    if (!streamService) return { status: 'disconnected', subscribedCount: 0 };
    return streamService.getStatus();
  });

  ipcMain.handle('streaming:update-symbols', async (_, symbols: string[]) => {
    streamService?.updateSymbols(symbols);
  });
}
