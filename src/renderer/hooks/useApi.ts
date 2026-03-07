import { useState, useCallback } from 'react';
import type {
  Account,
  Security,
  Position,
  Transaction,
  TaxLot,
  TransactionFilters,
  TaxLotFilters,
  PortfolioSummary,
  AssetAllocation,
  AppSettings,
  AIInsight,
  BackupInfo,
  BackupResult,
  ExcelImportResult,
  BackupConfig,
  BrokerageParserInfo,
  BrokerageParseResult,
  TransactionParserInfo,
  TransactionParseResult,
  LotDetailsParserInfo,
  LotDetailsParseResult,
  SecurityTag,
  SecurityTagAssignment,
  TradingRule,
  TradingRuleFilters,
  DecisionLog,
  DecisionLogFilters,
  CompanyProfile,
  StockQuote,
  PriceHistory,
  RefreshPricesResult,
  EarningsEvent,
  TickerDetails,
  IntradayPrice,
  SchwabConnectionStatus,
  SchwabSyncResult,
  SchwabOrder,
  SchwabOrderRequest,
  StreamingQuote,
  StreamingState,
  PositionIntent,
  DailyRitual,
  PositionIntentChangeLog,
  Watchlist,
  WatchlistItem,
  Monitor,
} from '../../shared/types';

// Type declaration for the electron API exposed via preload
declare global {
  interface Window {
    electronAPI: {
      // Account operations
      getAccounts: () => Promise<Account[]>;
      createAccount: (account: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Account>;
      updateAccount: (id: string, account: Partial<Account>) => Promise<Account>;
      deleteAccount: (id: string) => Promise<void>;

      // Security operations
      getSecurities: () => Promise<Security[]>;
      createSecurity: (security: Omit<Security, 'id' | 'createdAt'>) => Promise<Security>;
      findSecurityBySymbol: (symbol: string) => Promise<Security | null>;

      // Position operations
      getPositions: (accountId?: string) => Promise<Position[]>;
      createPosition: (position: Omit<Position, 'id'>) => Promise<Position>;
      updatePosition: (id: string, position: Partial<Position>) => Promise<Position>;
      deletePosition: (id: string) => Promise<void>;

      // Transaction operations
      getTransactions: (filters?: TransactionFilters) => Promise<Transaction[]>;
      createTransaction: (transaction: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Transaction>;
      updateTransaction: (id: string, transaction: Partial<Transaction>) => Promise<Transaction>;
      deleteTransaction: (id: string) => Promise<void>;
      importTransactions: (transactions: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>[]) => Promise<number>;

      // Tax lot operations
      getTaxLots: (filters?: TaxLotFilters) => Promise<TaxLot[]>;
      createTaxLot: (taxLot: Omit<TaxLot, 'id' | 'createdAt' | 'updatedAt'>) => Promise<TaxLot>;
      updateTaxLot: (id: string, taxLot: Partial<TaxLot>) => Promise<TaxLot>;
      deleteTaxLot: (id: string) => Promise<void>;
      deleteAllTaxLots: (accountId: string) => Promise<number>;
      deleteTaxLotsBySymbol: (accountId: string, securityId: string) => Promise<number>;

      // File operations
      importExcel: () => Promise<ExcelImportResult | null>;
      exportData: (data: unknown, filename: string) => Promise<boolean>;

      // Backup operations
      createBackup: () => Promise<BackupResult>;
      restoreBackup: (path: string) => Promise<boolean>;
      listBackups: () => Promise<BackupInfo[]>;
      configureBackup: (config: BackupConfig) => Promise<void>;

      // Settings operations
      getSettings: () => Promise<AppSettings>;
      updateSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;

      // AI operations
      generateInsights: () => Promise<AIInsight[]>;
      analyzePortfolio: () => Promise<string>;

      // Portfolio summary
      getPortfolioSummary: () => Promise<PortfolioSummary>;
      getAssetAllocation: () => Promise<AssetAllocation[]>;

      // Brokerage import operations
      listBrokerageParsers: () => Promise<BrokerageParserInfo[]>;
      selectBrokerageFile: () => Promise<string | null>;
      selectBrokerageFiles: () => Promise<string[]>;
      parseBrokerageFile: (parserId: string, filePath: string) => Promise<BrokerageParseResult>;

      // Transaction import operations
      listTransactionParsers: () => Promise<TransactionParserInfo[]>;
      parseTransactionFile: (parserId: string, filePath: string) => Promise<TransactionParseResult>;

      // Lot details import operations
      listLotDetailsParsers: () => Promise<LotDetailsParserInfo[]>;
      parseLotDetailsFile: (parserId: string, filePath: string) => Promise<LotDetailsParseResult>;

      // Holdings tag operations
      getSecurityTags: () => Promise<SecurityTag[]>;
      createSecurityTag: (tag: Omit<SecurityTag, 'id' | 'createdAt'>) => Promise<SecurityTag>;
      updateSecurityTag: (id: string, tag: Partial<SecurityTag>) => Promise<SecurityTag>;
      deleteSecurityTag: (id: string) => Promise<void>;

      // Holdings tag assignment operations
      getSecurityTagAssignments: (securityId?: string) => Promise<SecurityTagAssignment[]>;
      assignTagToSecurity: (securityId: string, tagId: string) => Promise<SecurityTagAssignment>;
      removeTagFromSecurity: (securityId: string, tagId: string) => Promise<void>;
      getTagsForSecurity: (securityId: string) => Promise<SecurityTag[]>;

      // Trading rule operations
      getTradingRules: (filters?: TradingRuleFilters) => Promise<TradingRule[]>;
      createTradingRule: (rule: Omit<TradingRule, 'id' | 'createdAt' | 'updatedAt'>) => Promise<TradingRule>;
      getTradingRule: (id: string) => Promise<TradingRule | null>;
      updateTradingRule: (id: string, rule: Partial<TradingRule>) => Promise<TradingRule>;
      deleteTradingRule: (id: string) => Promise<void>;

      // Position intent operations
      getPositionIntent: (positionId: string) => Promise<PositionIntent | null>;
      upsertPositionIntent: (positionId: string, data: Partial<PositionIntent>) => Promise<PositionIntent>;
      deletePositionIntent: (positionId: string) => Promise<void>;
      listPositionIntents: () => Promise<PositionIntent[]>;

      // Daily ritual operations
      getDailyRitual: (date: string) => Promise<DailyRitual | null>;
      upsertDailyRitual: (date: string, data: Partial<DailyRitual>) => Promise<DailyRitual>;
      listDailyRituals: (limit?: number) => Promise<DailyRitual[]>;

      // Intent change log operations
      listIntentChangeLogs: (positionId?: string) => Promise<PositionIntentChangeLog[]>;
      listIntentChangeLogsByDate: (date: string) => Promise<PositionIntentChangeLog[]>;

      // Watchlist operations
      listWatchlists: () => Promise<Watchlist[]>;
      getWatchlist: (id: string) => Promise<Watchlist | null>;
      createWatchlist: (name: string, description?: string) => Promise<Watchlist>;
      updateWatchlist: (id: string, data: Partial<Watchlist>) => Promise<Watchlist>;
      deleteWatchlist: (id: string) => Promise<void>;
      listWatchlistItems: (watchlistId?: string) => Promise<WatchlistItem[]>;
      addWatchlistItem: (watchlistId: string, data: Partial<WatchlistItem>) => Promise<WatchlistItem>;
      updateWatchlistItem: (id: string, data: Partial<WatchlistItem>) => Promise<WatchlistItem>;
      removeWatchlistItem: (id: string) => Promise<void>;
      getWatchlistSymbols: () => Promise<string[]>;

      // Monitor operations
      listMonitors: (status?: string) => Promise<Monitor[]>;
      getMonitor: (id: string) => Promise<Monitor | null>;
      createMonitor: (data: Partial<Monitor>) => Promise<Monitor>;
      updateMonitorStatus: (id: string, status: string) => Promise<Monitor>;
      deleteMonitor: (id: string) => Promise<void>;
      checkMonitors: (symbol: string, price: number) => Promise<Monitor[]>;
      getTriggeredMonitors: () => Promise<Monitor[]>;

      // Decision log operations
      getDecisionLogs: (filters?: DecisionLogFilters) => Promise<DecisionLog[]>;
      createDecisionLog: (log: Omit<DecisionLog, 'id' | 'createdAt' | 'updatedAt'>) => Promise<DecisionLog>;
      getDecisionLog: (id: string) => Promise<DecisionLog | null>;
      updateDecisionLog: (id: string, log: Partial<DecisionLog>) => Promise<DecisionLog>;
      deleteDecisionLog: (id: string) => Promise<void>;

      // FMP data provider operations
      fmpTestConnection: () => Promise<{ success: boolean; message: string }>;
      fmpGetQuote: (symbol: string) => Promise<StockQuote | null>;
      fmpGetCompanyProfile: (symbol: string) => Promise<CompanyProfile | null>;
      fmpGetPriceHistory: (securityId: string, startDate?: string, endDate?: string) => Promise<PriceHistory[]>;
      fmpRefreshPrices: () => Promise<RefreshPricesResult>;
      fmpFetchHistorical: (symbol: string, days?: number) => Promise<{ success: boolean; count?: number; error?: string }>;
      fmpFetchAllHistorical: (days?: number) => Promise<{ success: boolean; fetched: number; updated: number; errors: string[] }>;
      fmpGetEarningsCalendar: (fromDate?: string, toDate?: string) => Promise<EarningsEvent[]>;
      fmpGetPortfolioEarnings: (fromDate?: string, toDate?: string) => Promise<EarningsEvent[]>;

      // Massive data provider operations
      massiveTestConnection: () => Promise<{ success: boolean; message: string }>;
      massiveGetQuote: (symbol: string) => Promise<StockQuote | null>;
      massiveGetTickerDetails: (symbol: string) => Promise<TickerDetails | null>;
      massiveGetPriceHistory: (securityId: string, startDate?: string, endDate?: string) => Promise<PriceHistory[]>;
      massiveRefreshPrices: () => Promise<RefreshPricesResult>;
      massiveFetchHistorical: (symbol: string, days?: number) => Promise<{ success: boolean; count?: number; error?: string }>;
      massiveFetchAllHistorical: (days?: number) => Promise<{ success: boolean; fetched: number; updated: number; errors: string[] }>;
      massiveGetIntraday: (symbol: string, date?: string) => Promise<IntradayPrice[]>;

      // Unified data provider operations (auto-routes to configured provider)
      dataRefreshPrices: () => Promise<RefreshPricesResult>;
      dataFetchAllHistorical: (days?: number) => Promise<{ success: boolean; fetched: number; updated: number; errors: string[] }>;

      // Schwab brokerage connection operations
      schwabStartOAuth: () => Promise<{ success: boolean; message: string }>;
      schwabGetStatus: () => Promise<SchwabConnectionStatus>;
      schwabDisconnect: () => Promise<{ success: boolean }>;
      schwabSyncPositions: () => Promise<SchwabSyncResult>;
      schwabSyncTransactions: (startDate?: string, endDate?: string) => Promise<SchwabSyncResult>;

      // Schwab order operations
      schwabPlaceOrder: (order: SchwabOrderRequest) => Promise<{ success: boolean; message: string; orderId?: string }>;
      schwabGetOrders: (status?: string) => Promise<SchwabOrder[]>;
      schwabCancelOrder: (accountNumber: string, orderId: string) => Promise<{ success: boolean; message: string }>;

      // Schwab market data operations
      schwabTestMarketData: () => Promise<{ success: boolean; message: string }>;

      // Streaming operations
      onStreamingQuote: (callback: (quote: StreamingQuote) => void) => () => void;
      onStreamingStatus: (callback: (status: string) => void) => () => void;
      streamingStart: (symbols: string[]) => Promise<void>;
      streamingStop: () => Promise<void>;
      streamingGetStatus: () => Promise<StreamingState>;
      streamingUpdateSymbols: (symbols: string[]) => Promise<void>;
    };
  }
}

export function useAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getAccounts();
      setAccounts(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createAccount = useCallback(async (account: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newAccount = await window.electronAPI.createAccount(account);
    setAccounts(prev => [...prev, newAccount]);
    return newAccount;
  }, []);

  const updateAccount = useCallback(async (id: string, account: Partial<Account>) => {
    const updated = await window.electronAPI.updateAccount(id, account);
    setAccounts(prev => prev.map(a => a.id === id ? updated : a));
    return updated;
  }, []);

  const deleteAccount = useCallback(async (id: string) => {
    await window.electronAPI.deleteAccount(id);
    setAccounts(prev => prev.filter(a => a.id !== id));
  }, []);

  return { accounts, loading, error, fetchAccounts, createAccount, updateAccount, deleteAccount };
}

export function useSecurities() {
  const [securities, setSecurities] = useState<Security[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSecurities = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getSecurities();
      setSecurities(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createSecurity = useCallback(async (security: Omit<Security, 'id' | 'createdAt'>) => {
    const newSecurity = await window.electronAPI.createSecurity(security);
    setSecurities(prev => [...prev, newSecurity]);
    return newSecurity;
  }, []);

  const findBySymbol = useCallback(async (symbol: string) => {
    return window.electronAPI.findSecurityBySymbol(symbol);
  }, []);

  return { securities, loading, error, fetchSecurities, createSecurity, findBySymbol };
}

export function usePositions() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPositions = useCallback(async (accountId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getPositions(accountId);
      setPositions(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createPosition = useCallback(async (position: Omit<Position, 'id'>) => {
    const newPosition = await window.electronAPI.createPosition(position);
    setPositions(prev => [...prev, newPosition]);
    return newPosition;
  }, []);

  const updatePosition = useCallback(async (id: string, position: Partial<Position>) => {
    const updated = await window.electronAPI.updatePosition(id, position);
    setPositions(prev => prev.map(p => p.id === id ? updated : p));
    return updated;
  }, []);

  const deletePosition = useCallback(async (id: string) => {
    await window.electronAPI.deletePosition(id);
    setPositions(prev => prev.filter(p => p.id !== id));
  }, []);

  return { positions, loading, error, fetchPositions, createPosition, updatePosition, deletePosition };
}

export function useTransactions() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTransactions = useCallback(async (filters?: TransactionFilters) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getTransactions(filters);
      setTransactions(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createTransaction = useCallback(async (transaction: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newTransaction = await window.electronAPI.createTransaction(transaction);
    setTransactions(prev => [newTransaction, ...prev]);
    return newTransaction;
  }, []);

  const updateTransaction = useCallback(async (id: string, transaction: Partial<Transaction>) => {
    const updated = await window.electronAPI.updateTransaction(id, transaction);
    setTransactions(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  const deleteTransaction = useCallback(async (id: string) => {
    await window.electronAPI.deleteTransaction(id);
    setTransactions(prev => prev.filter(t => t.id !== id));
  }, []);

  const importTransactions = useCallback(async (transactions: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>[]) => {
    const count = await window.electronAPI.importTransactions(transactions);
    await fetchTransactions();
    return count;
  }, [fetchTransactions]);

  return { transactions, loading, error, fetchTransactions, createTransaction, updateTransaction, deleteTransaction, importTransactions };
}

export function useTaxLots() {
  const [taxLots, setTaxLots] = useState<TaxLot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTaxLots = useCallback(async (filters?: TaxLotFilters) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getTaxLots(filters);
      setTaxLots(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createTaxLot = useCallback(async (taxLot: Omit<TaxLot, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newTaxLot = await window.electronAPI.createTaxLot(taxLot);
    setTaxLots(prev => [...prev, newTaxLot]);
    return newTaxLot;
  }, []);

  const updateTaxLot = useCallback(async (id: string, taxLot: Partial<TaxLot>) => {
    const updated = await window.electronAPI.updateTaxLot(id, taxLot);
    setTaxLots(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  const deleteTaxLot = useCallback(async (id: string) => {
    await window.electronAPI.deleteTaxLot(id);
    setTaxLots(prev => prev.filter(t => t.id !== id));
  }, []);

  const deleteAllTaxLots = useCallback(async (accountId: string) => {
    const count = await window.electronAPI.deleteAllTaxLots(accountId);
    setTaxLots(prev => prev.filter(t => t.accountId !== accountId));
    return count;
  }, []);

  const deleteTaxLotsBySymbol = useCallback(async (accountId: string, securityId: string) => {
    const count = await window.electronAPI.deleteTaxLotsBySymbol(accountId, securityId);
    setTaxLots(prev => prev.filter(t => !(t.accountId === accountId && t.securityId === securityId)));
    return count;
  }, []);

  return { taxLots, loading, error, fetchTaxLots, createTaxLot, updateTaxLot, deleteTaxLot, deleteAllTaxLots, deleteTaxLotsBySymbol };
}

export function usePortfolio() {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [allocation, setAllocation] = useState<AssetAllocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryData, allocationData] = await Promise.all([
        window.electronAPI.getPortfolioSummary(),
        window.electronAPI.getAssetAllocation(),
      ]);
      setSummary(summaryData);
      setAllocation(allocationData);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { summary, allocation, loading, error, fetchSummary };
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getSettings();
      setSettings(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const updateSettings = useCallback(async (newSettings: Partial<AppSettings>) => {
    const updated = await window.electronAPI.updateSettings(newSettings);
    setSettings(updated);
    return updated;
  }, []);

  return { settings, loading, error, fetchSettings, updateSettings };
}

export function useBackup() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.listBackups();
      setBackups(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createBackup = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.createBackup();
      if (result.success) {
        await fetchBackups();
      }
      return result;
    } finally {
      setLoading(false);
    }
  }, [fetchBackups]);

  const restoreBackup = useCallback(async (path: string) => {
    setLoading(true);
    try {
      return await window.electronAPI.restoreBackup(path);
    } finally {
      setLoading(false);
    }
  }, []);

  const configureBackup = useCallback(async (config: BackupConfig) => {
    await window.electronAPI.configureBackup(config);
  }, []);

  return { backups, loading, error, fetchBackups, createBackup, restoreBackup, configureBackup };
}

export function useAI() {
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [analysis, setAnalysis] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateInsights = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.generateInsights();
      setInsights(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const analyzePortfolio = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.analyzePortfolio();
      setAnalysis(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { insights, analysis, loading, error, generateInsights, analyzePortfolio };
}

export function useFileImport() {
  const [importing, setImporting] = useState(false);

  const importExcel = useCallback(async () => {
    setImporting(true);
    try {
      return await window.electronAPI.importExcel();
    } finally {
      setImporting(false);
    }
  }, []);

  const exportData = useCallback(async (data: unknown, filename: string) => {
    return await window.electronAPI.exportData(data, filename);
  }, []);

  return { importing, importExcel, exportData };
}

export function useBrokerageImport() {
  const [parsers, setParsers] = useState<BrokerageParserInfo[]>([]);
  const [parseResult, setParseResult] = useState<BrokerageParseResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchParsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.listBrokerageParsers();
      setParsers(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectFile = useCallback(async () => {
    setError(null);
    try {
      const filePath = await window.electronAPI.selectBrokerageFile();
      setSelectedFile(filePath);
      return filePath;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  const parseFile = useCallback(async (parserId: string, filePath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.parseBrokerageFile(parserId, filePath);
      setParseResult(result);
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join(', '));
      }
      return result;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const clearResult = useCallback(() => {
    setParseResult(null);
    setSelectedFile(null);
    setError(null);
  }, []);

  return {
    parsers,
    parseResult,
    selectedFile,
    loading,
    error,
    fetchParsers,
    selectFile,
    parseFile,
    clearResult,
  };
}

export function useTransactionImport() {
  const [parsers, setParsers] = useState<TransactionParserInfo[]>([]);
  const [parseResult, setParseResult] = useState<TransactionParseResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchParsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.listTransactionParsers();
      setParsers(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectFile = useCallback(async () => {
    setError(null);
    try {
      const filePath = await window.electronAPI.selectBrokerageFile();
      setSelectedFile(filePath);
      return filePath;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  const parseFile = useCallback(async (parserId: string, filePath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.parseTransactionFile(parserId, filePath);
      setParseResult(result);
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join(', '));
      }
      return result;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const clearResult = useCallback(() => {
    setParseResult(null);
    setSelectedFile(null);
    setError(null);
  }, []);

  return {
    parsers,
    parseResult,
    selectedFile,
    loading,
    error,
    fetchParsers,
    selectFile,
    parseFile,
    clearResult,
  };
}

export function useLotDetailsImport() {
  const [parsers, setParsers] = useState<LotDetailsParserInfo[]>([]);
  const [parseResults, setParseResults] = useState<LotDetailsParseResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchParsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.listLotDetailsParsers();
      setParsers(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectFiles = useCallback(async () => {
    setError(null);
    try {
      const filePaths = await window.electronAPI.selectBrokerageFiles();
      return filePaths;
    } catch (err) {
      setError((err as Error).message);
      return [];
    }
  }, []);

  const parseLotDetailsFiles = useCallback(async (parserId: string, filePaths: string[]) => {
    setLoading(true);
    setError(null);
    const results: LotDetailsParseResult[] = [];
    const errors: string[] = [];

    try {
      for (const filePath of filePaths) {
        const result = await window.electronAPI.parseLotDetailsFile(parserId, filePath);
        if (!result.success && result.errors.length > 0) {
          errors.push(`${result.symbol || filePath}: ${result.errors.join(', ')}`);
        } else {
          results.push(result);
        }
      }

      if (results.length > 0) {
        setParseResults(prev => [...prev, ...results]);
      }

      if (errors.length > 0) {
        setError(errors.join('; '));
      }

      return results;
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const clearResults = useCallback(() => {
    setParseResults([]);
    setError(null);
  }, []);

  return {
    parsers,
    parseResults,
    loading,
    error,
    fetchParsers,
    selectFiles,
    parseLotDetailsFiles,
    clearResults,
  };
}

export function useSecurityTags() {
  const [tags, setTags] = useState<SecurityTag[]>([]);
  const [assignments, setAssignments] = useState<SecurityTagAssignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTags = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getSecurityTags();
      setTags(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAssignments = useCallback(async (securityId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getSecurityTagAssignments(securityId);
      setAssignments(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createTag = useCallback(async (tag: Omit<SecurityTag, 'id' | 'createdAt'>) => {
    const newTag = await window.electronAPI.createSecurityTag(tag);
    setTags(prev => [...prev, newTag]);
    return newTag;
  }, []);

  const updateTag = useCallback(async (id: string, tag: Partial<SecurityTag>) => {
    const updated = await window.electronAPI.updateSecurityTag(id, tag);
    setTags(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  const deleteTag = useCallback(async (id: string) => {
    await window.electronAPI.deleteSecurityTag(id);
    setTags(prev => prev.filter(t => t.id !== id));
  }, []);

  const assignTag = useCallback(async (securityId: string, tagId: string) => {
    const assignment = await window.electronAPI.assignTagToSecurity(securityId, tagId);
    setAssignments(prev => [...prev.filter(a => !(a.securityId === securityId && a.tagId === tagId)), assignment]);
    return assignment;
  }, []);

  const removeTag = useCallback(async (securityId: string, tagId: string) => {
    await window.electronAPI.removeTagFromSecurity(securityId, tagId);
    setAssignments(prev => prev.filter(a => !(a.securityId === securityId && a.tagId === tagId)));
  }, []);

  const getTagsForSecurity = useCallback(async (securityId: string) => {
    return window.electronAPI.getTagsForSecurity(securityId);
  }, []);

  return {
    tags,
    assignments,
    loading,
    error,
    fetchTags,
    fetchAssignments,
    createTag,
    updateTag,
    deleteTag,
    assignTag,
    removeTag,
    getTagsForSecurity,
  };
}

export function useTradingRules() {
  const [rules, setRules] = useState<TradingRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRules = useCallback(async (filters?: TradingRuleFilters) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getTradingRules(filters);
      setRules(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createRule = useCallback(async (rule: Omit<TradingRule, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newRule = await window.electronAPI.createTradingRule(rule);
    setRules(prev => [newRule, ...prev]);
    return newRule;
  }, []);

  const updateRule = useCallback(async (id: string, rule: Partial<TradingRule>) => {
    const updated = await window.electronAPI.updateTradingRule(id, rule);
    setRules(prev => prev.map(r => r.id === id ? updated : r));
    return updated;
  }, []);

  const deleteRule = useCallback(async (id: string) => {
    await window.electronAPI.deleteTradingRule(id);
    setRules(prev => prev.filter(r => r.id !== id));
  }, []);

  const toggleRule = useCallback(async (id: string, isEnabled: boolean) => {
    return updateRule(id, { isEnabled });
  }, [updateRule]);

  return {
    rules,
    loading,
    error,
    fetchRules,
    createRule,
    updateRule,
    deleteRule,
    toggleRule,
  };
}

export function useDecisionLogs() {
  const [logs, setLogs] = useState<DecisionLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = useCallback(async (filters?: DecisionLogFilters) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.getDecisionLogs(filters);
      setLogs(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createLog = useCallback(async (log: Omit<DecisionLog, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newLog = await window.electronAPI.createDecisionLog(log);
    setLogs(prev => [newLog, ...prev]);
    return newLog;
  }, []);

  const updateLog = useCallback(async (id: string, log: Partial<DecisionLog>) => {
    const updated = await window.electronAPI.updateDecisionLog(id, log);
    setLogs(prev => prev.map(l => l.id === id ? updated : l));
    return updated;
  }, []);

  const deleteLog = useCallback(async (id: string) => {
    await window.electronAPI.deleteDecisionLog(id);
    setLogs(prev => prev.filter(l => l.id !== id));
  }, []);

  return {
    logs,
    loading,
    error,
    fetchLogs,
    createLog,
    updateLog,
    deleteLog,
  };
}

export function useFMP() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testConnection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.fmpTestConnection();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, message };
    } finally {
      setLoading(false);
    }
  }, []);

  const getQuote = useCallback(async (symbol: string) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.fmpGetQuote(symbol);
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const getCompanyProfile = useCallback(async (symbol: string) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.fmpGetCompanyProfile(symbol);
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const getPriceHistory = useCallback(async (securityId: string, startDate?: string, endDate?: string) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.fmpGetPriceHistory(securityId, startDate, endDate);
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPrices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.fmpRefreshPrices();
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return {
        success: false,
        updated: 0,
        failed: 0,
        errors: [message],
        prices: {},
      } as RefreshPricesResult;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistorical = useCallback(async (symbol: string, days: number = 30) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.fmpFetchHistorical(symbol, days);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAllHistorical = useCallback(async (days: number = 30) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.fmpFetchAllHistorical(days);
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, fetched: 0, updated: 0, errors: [message] };
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    testConnection,
    getQuote,
    getCompanyProfile,
    getPriceHistory,
    refreshPrices,
    fetchHistorical,
    fetchAllHistorical,
  };
}

export function useEarnings() {
  const [earnings, setEarnings] = useState<EarningsEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEarningsCalendar = useCallback(async (fromDate?: string, toDate?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.fmpGetEarningsCalendar(fromDate, toDate);
      setEarnings(data);
      return data;
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPortfolioEarnings = useCallback(async (fromDate?: string, toDate?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.fmpGetPortfolioEarnings(fromDate, toDate);
      setEarnings(data);
      return data;
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    earnings,
    loading,
    error,
    fetchEarningsCalendar,
    fetchPortfolioEarnings,
  };
}

export function useMassive() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testConnection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.massiveTestConnection();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, message };
    } finally {
      setLoading(false);
    }
  }, []);

  const getQuote = useCallback(async (symbol: string) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.massiveGetQuote(symbol);
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const getTickerDetails = useCallback(async (symbol: string) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.massiveGetTickerDetails(symbol);
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const getPriceHistory = useCallback(async (securityId: string, startDate?: string, endDate?: string) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.massiveGetPriceHistory(securityId, startDate, endDate);
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPrices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.massiveRefreshPrices();
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return {
        success: false,
        updated: 0,
        failed: 0,
        errors: [message],
        prices: {},
      } as RefreshPricesResult;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistorical = useCallback(async (symbol: string, days: number = 30) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.massiveFetchHistorical(symbol, days);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAllHistorical = useCallback(async (days: number = 30) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.massiveFetchAllHistorical(days);
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, fetched: 0, updated: 0, errors: [message] };
    } finally {
      setLoading(false);
    }
  }, []);

  const getIntradayPrices = useCallback(async (symbol: string, date?: string) => {
    setLoading(true);
    setError(null);
    try {
      return await window.electronAPI.massiveGetIntraday(symbol, date);
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    testConnection,
    getQuote,
    getTickerDetails,
    getPriceHistory,
    refreshPrices,
    fetchHistorical,
    fetchAllHistorical,
    getIntradayPrices,
  };
}

export function useDataProvider() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delayed, setDelayed] = useState<boolean | undefined>(undefined);

  const refreshPrices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.dataRefreshPrices();
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      setDelayed(result.delayed);
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return {
        success: false,
        updated: 0,
        failed: 0,
        errors: [message],
        prices: {},
      } as RefreshPricesResult;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAllHistorical = useCallback(async (days: number = 30) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.dataFetchAllHistorical(days);
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, fetched: 0, updated: 0, errors: [message] };
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    delayed,
    refreshPrices,
    fetchAllHistorical,
  };
}

export function useSchwab() {
  const [status, setStatus] = useState<SchwabConnectionStatus | null>(null);
  const [orders, setOrders] = useState<SchwabOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await window.electronAPI.schwabGetStatus();
      setStatus(data);
      return data;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  const startOAuth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.schwabStartOAuth();
      if (!result.success) {
        setError(result.message);
      }
      await fetchStatus();
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, message };
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  const disconnect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await window.electronAPI.schwabDisconnect();
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  const syncPositions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.schwabSyncPositions();
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, accountsSynced: 0, positionsSynced: 0, transactionsSynced: 0, errors: [message] } as SchwabSyncResult;
    } finally {
      setLoading(false);
    }
  }, []);

  const syncTransactions = useCallback(async (startDate?: string, endDate?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.schwabSyncTransactions(startDate, endDate);
      if (!result.success && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, accountsSynced: 0, positionsSynced: 0, transactionsSynced: 0, errors: [message] } as SchwabSyncResult;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchOrders = useCallback(async (statusFilter?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.schwabGetOrders(statusFilter);
      setOrders(data);
      return data;
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const placeOrder = useCallback(async (order: SchwabOrderRequest) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.schwabPlaceOrder(order);
      if (!result.success) {
        setError(result.message);
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, message };
    } finally {
      setLoading(false);
    }
  }, []);

  const cancelOrder = useCallback(async (accountNumber: string, orderId: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.schwabCancelOrder(accountNumber, orderId);
      if (!result.success) {
        setError(result.message);
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { success: false, message };
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    status,
    orders,
    loading,
    error,
    fetchStatus,
    startOAuth,
    disconnect,
    syncPositions,
    syncTransactions,
    fetchOrders,
    placeOrder,
    cancelOrder,
  };
}

export function usePositionIntents() {
  const [intents, setIntents] = useState<Map<string, PositionIntent>>(new Map());
  const [loading, setLoading] = useState(false);

  const fetchIntents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.electronAPI.listPositionIntents();
      const map = new Map<string, PositionIntent>();
      for (const intent of data) {
        map.set(intent.positionId, intent);
      }
      setIntents(map);
    } catch (err) {
      console.error('Failed to fetch intents:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const upsertIntent = useCallback(async (positionId: string, data: Partial<PositionIntent>) => {
    const result = await window.electronAPI.upsertPositionIntent(positionId, data);
    setIntents(prev => {
      const next = new Map(prev);
      next.set(positionId, result);
      return next;
    });
    return result;
  }, []);

  const deleteIntent = useCallback(async (positionId: string) => {
    await window.electronAPI.deletePositionIntent(positionId);
    setIntents(prev => {
      const next = new Map(prev);
      next.delete(positionId);
      return next;
    });
  }, []);

  return { intents, loading, fetchIntents, upsertIntent, deleteIntent };
}

export function useDailyRituals() {
  const [rituals, setRituals] = useState<DailyRitual[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchRituals = useCallback(async (limit?: number) => {
    setLoading(true);
    try {
      const data = await window.electronAPI.listDailyRituals(limit);
      setRituals(data);
    } catch (err) {
      console.error('Failed to fetch rituals:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const getRitual = useCallback(async (date: string) => {
    return window.electronAPI.getDailyRitual(date);
  }, []);

  const upsertRitual = useCallback(async (date: string, data: Partial<DailyRitual>) => {
    const result = await window.electronAPI.upsertDailyRitual(date, data);
    setRituals(prev => {
      const idx = prev.findIndex(r => r.date === date);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = result;
        return next;
      }
      return [result, ...prev];
    });
    return result;
  }, []);

  return { rituals, loading, fetchRituals, getRitual, upsertRitual };
}

export function useIntentChangeLogs() {
  const [logs, setLogs] = useState<PositionIntentChangeLog[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(async (positionId?: string) => {
    setLoading(true);
    try {
      const data = await window.electronAPI.listIntentChangeLogs(positionId);
      setLogs(data);
    } catch (err) {
      console.error('Failed to fetch intent change logs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLogsByDate = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const data = await window.electronAPI.listIntentChangeLogsByDate(date);
      setLogs(data);
    } catch (err) {
      console.error('Failed to fetch intent change logs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  return { logs, loading, fetchLogs, fetchLogsByDate };
}

export function useWatchlists() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchWatchlists = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.electronAPI.listWatchlists();
      setWatchlists(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchItems = useCallback(async (watchlistId?: string) => {
    const data = await window.electronAPI.listWatchlistItems(watchlistId);
    setItems(data);
  }, []);

  const createWatchlist = useCallback(async (name: string, description?: string) => {
    const wl = await window.electronAPI.createWatchlist(name, description);
    setWatchlists(prev => [...prev, wl]);
    return wl;
  }, []);

  const deleteWatchlist = useCallback(async (id: string) => {
    await window.electronAPI.deleteWatchlist(id);
    setWatchlists(prev => prev.filter(w => w.id !== id));
  }, []);

  const addItem = useCallback(async (watchlistId: string, data: Partial<WatchlistItem>) => {
    const item = await window.electronAPI.addWatchlistItem(watchlistId, data);
    setItems(prev => [...prev, item]);
    return item;
  }, []);

  const updateItem = useCallback(async (id: string, data: Partial<WatchlistItem>) => {
    const updated = await window.electronAPI.updateWatchlistItem(id, data);
    setItems(prev => prev.map(i => i.id === id ? updated : i));
    return updated;
  }, []);

  const removeItem = useCallback(async (id: string) => {
    await window.electronAPI.removeWatchlistItem(id);
    setItems(prev => prev.filter(i => i.id !== id));
  }, []);

  return { watchlists, items, loading, fetchWatchlists, fetchItems, createWatchlist, deleteWatchlist, addItem, updateItem, removeItem };
}

export function useMonitors() {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchMonitors = useCallback(async (status?: string) => {
    setLoading(true);
    try {
      const data = await window.electronAPI.listMonitors(status);
      setMonitors(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const createMonitor = useCallback(async (data: Partial<Monitor>) => {
    const m = await window.electronAPI.createMonitor(data);
    setMonitors(prev => [...prev, m]);
    return m;
  }, []);

  const dismissMonitor = useCallback(async (id: string) => {
    const updated = await window.electronAPI.updateMonitorStatus(id, 'dismissed');
    setMonitors(prev => prev.map(m => m.id === id ? updated : m));
  }, []);

  const resetMonitor = useCallback(async (id: string) => {
    const updated = await window.electronAPI.updateMonitorStatus(id, 'active');
    setMonitors(prev => prev.map(m => m.id === id ? updated : m));
  }, []);

  const deleteMonitor = useCallback(async (id: string) => {
    await window.electronAPI.deleteMonitor(id);
    setMonitors(prev => prev.filter(m => m.id !== id));
  }, []);

  return { monitors, loading, fetchMonitors, createMonitor, dismissMonitor, resetMonitor, deleteMonitor };
}
