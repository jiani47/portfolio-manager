// Core entity types for the portfolio manager

export interface Account {
  id: string;
  name: string;
  broker: string;
  accountNumber?: string;
  accountType: 'brokerage' | 'ira' | 'roth_ira' | '401k' | 'other';
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface Security {
  id: string;
  symbol: string;
  name: string;
  type: 'stock' | 'etf' | 'mutual_fund' | 'bond' | 'option' | 'crypto' | 'other';
  currency: string;
  exchange?: string;
  createdAt: string;
}

export interface Position {
  id: string;
  accountId: string;
  securityId: string;
  quantity: number;
  costBasis: number;
  currentPrice?: number;
  marketValue?: number;
  unrealizedGain?: number;
  unrealizedGainPercent?: number;
  lastUpdated: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  securityId: string;
  type: 'buy' | 'sell' | 'dividend' | 'interest' | 'transfer_in' | 'transfer_out' | 'split' | 'spinoff' | 'fee';
  date: string;
  quantity: number;
  price: number;
  amount: number;
  fees?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaxLot {
  id: string;
  accountId: string;
  securityId: string;
  transactionId: string;
  acquisitionDate: string;
  quantity: number;
  costBasis: number;
  costPerShare: number;
  remainingQuantity: number;
  isOpen: boolean;
  closedDate?: string;
  closedTransactionId?: string;
  realizedGain?: number;
  holdingPeriod?: 'short' | 'long';
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioSummary {
  totalValue: number;
  totalCostBasis: number;
  totalUnrealizedGain: number;
  totalUnrealizedGainPercent: number;
  dayChange: number;
  dayChangePercent: number;
  positionCount: number;
  accountCount: number;
}

export interface AssetAllocation {
  category: string;
  value: number;
  percentage: number;
  positions: Position[];
}

export interface BackupConfig {
  provider: 'local' | 'google_drive' | 'dropbox' | 's3' | 'onedrive';
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly' | 'manual';
  lastBackup?: string;
  nextBackup?: string;
  credentials?: Record<string, string>;
  path?: string;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  currency: string;
  dateFormat: string;
  backup: BackupConfig;
  aiProvider: 'openai' | 'anthropic' | 'none';
  aiApiKey?: string;
}

export interface AIInsight {
  id: string;
  type: 'performance' | 'risk' | 'tax' | 'allocation' | 'activity';
  title: string;
  summary: string;
  details: string;
  severity: 'info' | 'warning' | 'critical';
  createdAt: string;
  dismissed: boolean;
}

// IPC channel types
export interface IPCChannels {
  // Database operations
  'db:accounts:list': () => Account[];
  'db:accounts:create': (account: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>) => Account;
  'db:accounts:update': (id: string, account: Partial<Account>) => Account;
  'db:accounts:delete': (id: string) => void;

  'db:securities:list': () => Security[];
  'db:securities:create': (security: Omit<Security, 'id' | 'createdAt'>) => Security;
  'db:securities:findBySymbol': (symbol: string) => Security | null;

  'db:positions:list': (accountId?: string) => Position[];
  'db:positions:create': (position: Omit<Position, 'id'>) => Position;
  'db:positions:update': (id: string, position: Partial<Position>) => Position;

  'db:transactions:list': (filters?: TransactionFilters) => Transaction[];
  'db:transactions:create': (transaction: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>) => Transaction;
  'db:transactions:import': (transactions: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>[]) => number;

  'db:taxlots:list': (filters?: TaxLotFilters) => TaxLot[];
  'db:taxlots:create': (taxLot: Omit<TaxLot, 'id' | 'createdAt' | 'updatedAt'>) => TaxLot;

  // File operations
  'file:import-excel': () => ExcelImportResult | null;
  'file:export-data': (data: unknown, filename: string) => boolean;

  // Backup operations
  'backup:create': () => BackupResult;
  'backup:restore': (path: string) => boolean;
  'backup:list': () => BackupInfo[];
  'backup:configure': (config: BackupConfig) => void;

  // Settings
  'settings:get': () => AppSettings;
  'settings:update': (settings: Partial<AppSettings>) => AppSettings;

  // AI insights
  'ai:generate-insights': () => AIInsight[];
  'ai:analyze-portfolio': () => string;

  // Brokerage import
  'parsers:list': () => BrokerageParserInfo[];
  'file:select-brokerage-file': () => string | null;
  'file:parse-brokerage': (parserId: string, filePath: string) => BrokerageParseResult;

  // Transaction import
  'transaction-parsers:list': () => TransactionParserInfo[];
  'file:parse-transactions': (parserId: string, filePath: string) => TransactionParseResult;
}

export interface TransactionFilters {
  accountId?: string;
  securityId?: string;
  type?: Transaction['type'];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface TaxLotFilters {
  accountId?: string;
  securityId?: string;
  isOpen?: boolean;
}

export interface ExcelImportResult {
  success: boolean;
  rowsImported: number;
  errors: string[];
  data: unknown[];
}

export interface BackupResult {
  success: boolean;
  path: string;
  timestamp: string;
  size: number;
}

export interface BackupInfo {
  path: string;
  timestamp: string;
  size: number;
}

// Brokerage import types
export interface ParsedPosition {
  symbol: string;
  name: string;
  quantity: number;
  costBasis: number;
  currentPrice: number;
  marketValue: number;
  unrealizedGain: number;
  unrealizedGainPercent: number;
  securityType: 'stock' | 'etf' | 'mutual_fund' | 'bond' | 'option' | 'crypto' | 'other';
}

export interface BrokerageParseResult {
  success: boolean;
  broker: string;
  accounts: BrokerageAccountData[];
  errors: string[];
}

export interface BrokerageAccountData {
  accountIdentifier: string;
  positions: ParsedPosition[];
}

export interface BrokerageParserInfo {
  id: string;
  name: string;
  description: string;
  fileTypes: string[];
  sampleFormat?: string;
}

// Transaction import types
export interface ParsedTransaction {
  symbol: string;
  name: string;
  type: 'sell';  // Realized gains are always sells
  date: string;  // Closed Date
  quantity: number;
  price: number;  // Proceeds Per Share
  amount: number;  // Proceeds
  notes?: string;  // Wash sale info
}

export interface ParsedTaxLot {
  symbol: string;
  acquisitionDate: string;  // Opened Date
  closedDate: string;  // Closed Date
  quantity: number;
  costBasis: number;
  costPerShare: number;
  proceedsPerShare: number;
  proceeds: number;
  realizedGain: number;
  realizedGainPercent: number;
  holdingPeriod: 'short' | 'long';
  washSale?: boolean;
  disallowedLoss?: number;
}

export interface TransactionParseResult {
  success: boolean;
  broker: string;
  accounts: TransactionAccountData[];
  errors: string[];
}

export interface TransactionAccountData {
  accountIdentifier: string;
  transactions: ParsedTransaction[];
  taxLots: ParsedTaxLot[];
}

export interface TransactionParserInfo {
  id: string;
  name: string;
  description: string;
  fileTypes: string[];
}
