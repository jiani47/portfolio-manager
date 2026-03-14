// Core entity types for the portfolio manager

export interface Account {
  id: string;
  name: string;
  broker: string;
  accountNumber?: string;
  accountType: 'brokerage' | 'ira' | 'roth_ira' | '401k' | 'other';
  book?: 'investing' | 'trading';
  cashBalance?: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface PositionIntent {
  id: string;
  positionId: string;
  tier?: string;
  thesis?: string;
  invalidation?: string;
  entryStyle?: string;
  targetHoldPeriod?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Security {
  id: string;
  symbol: string;
  name: string;
  type: 'stock' | 'etf' | 'mutual_fund' | 'bond' | 'option' | 'crypto' | 'cash' | 'other';
  currency: string;
  exchange?: string;
  // Company profile data from FMP
  sector?: string;
  industry?: string;
  description?: string;
  website?: string;
  ceo?: string;
  marketCap?: number;
  profileUpdatedAt?: string;
  createdAt: string;
}

export interface Position {
  id: string;
  accountId: string;
  securityId: string;
  quantity: number;
  costBasis: number;
  // Computed fields (calculated on-the-fly from price_history, not stored in DB)
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
  washSale?: boolean;
  disallowedLoss?: number;
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
  dataProvider: 'fmp' | 'massive' | 'schwab' | 'none';
  dataProviderApiKey?: string;
  schwabClientId?: string;
  schwabClientSecret?: string;
  schwabCallbackUrl?: string;
  schwabTokens?: SchwabTokens;
}

export interface SchwabTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  scope?: string;
  tokenType: string;
}

export interface SchwabSyncResult {
  success: boolean;
  accountsSynced: number;
  positionsSynced: number;
  transactionsSynced: number;
  errors: string[];
}

export interface SchwabConnectionStatus {
  connected: boolean;
  lastSync?: string;
  accountCount?: number;
  message: string;
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

// Price history type for storing historical prices
export interface PriceHistory {
  id: string;
  securityId: string;
  date: string;           // YYYY-MM-DD
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  closePrice: number;
  volume?: number;
  fetchedAt: string;      // When we fetched this data
}

// Company profile from FMP API
export interface CompanyProfile {
  symbol: string;
  companyName: string;
  sector?: string;
  industry?: string;
  description?: string;
  website?: string;
  ceo?: string;
  marketCap?: number;
}

// Quote data from FMP API
export interface StockQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume?: number;
  previousClose?: number;
  delayed?: boolean;
}

// Refresh prices result
export interface RefreshPricesResult {
  success: boolean;
  updated: number;
  failed: number;
  errors: string[];
  prices: Map<string, number> | Record<string, number>;
  delayed?: boolean;
}

// Streaming quote from Schwab WebSocket
export interface StreamingQuote {
  symbol: string;
  bid?: number;
  ask?: number;
  last: number;
  volume?: number;
  high?: number;
  low?: number;
  close?: number;
  open?: number;
  netChange?: number;
  netChangePct?: number;
  timestamp: number;
}

export type StreamingStatus = 'disconnected' | 'connecting' | 'connected' | 'outside_hours' | 'error';

export interface StreamingState {
  status: StreamingStatus;
  subscribedCount: number;
  connectedSince?: number;
  error?: string;
}

// Earnings calendar event from FMP
export interface EarningsEvent {
  symbol: string;
  date: string;           // YYYY-MM-DD
  time?: 'bmo' | 'amc' | 'dmh' | '';  // before market open, after market close, during market hours
  epsEstimated?: number;
  epsActual?: number;
  revenueEstimated?: number;
  revenueActual?: number;
  fiscalDateEnding?: string;
  updatedFromDate?: string;
}

// Ticker details from Massive API
export interface TickerDetails {
  symbol: string;
  name: string;
  type: string;
  market: string;
  locale: string;
  primaryExchange: string;
  currencyName: string;
  cik?: string;
  sicCode?: string;
  sicDescription?: string;
  marketCap?: number;
  phoneNumber?: string;
  address?: string;
  description?: string;
  homepageUrl?: string;
  totalEmployees?: number;
  listDate?: string;
}

// Intraday price (minute bars) from Massive API
export interface IntradayPrice {
  timestamp: string;  // ISO timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;      // Volume-weighted avg price
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

  // Lot details import (direct from brokerage)
  'lot-details-parsers:list': () => LotDetailsParserInfo[];
  'file:parse-lot-details': (parserId: string, filePath: string) => LotDetailsParseResult;
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
  securityType: 'stock' | 'etf' | 'mutual_fund' | 'bond' | 'option' | 'crypto' | 'cash' | 'other';
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
  notes?: string;
  washSale?: boolean;
  disallowedLoss?: number;
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

// Lot details import types (direct import from brokerage)
export interface ParsedOpenLot {
  symbol: string;
  accountIdentifier: string;
  openDate: string;         // acquisition date (ISO format)
  quantity: number;
  costPerShare: number;
  costBasis: number;
  holdingPeriod: 'short' | 'long';
  disallowedLoss?: number;  // wash sale adjustment
}

export interface LotDetailsParseResult {
  success: boolean;
  broker: string;
  symbol: string;
  accountIdentifier: string;
  lots: ParsedOpenLot[];
  errors: string[];
}

export interface LotDetailsParserInfo {
  id: string;
  name: string;
  description: string;
  fileTypes: string[];
}

// Security tag types
export interface SecurityTag {
  id: string;
  name: string;
  displayName: string;
  color: string;
  description?: string;
  isSystem: boolean;
  createdAt: string;
}

export interface SecurityTagAssignment {
  id: string;
  securityId: string;
  tagId: string;
  createdAt: string;
}

// Trading rule types
export type RuleType = 'add' | 'trim' | 'exit' | 'hold';
export type ConditionType = 'price_drop_pct' | 'position_size_pct' | 'loss_pct' | 'holding_period_days';
export type ConditionOperator = 'gte' | 'lte' | 'eq' | 'gt' | 'lt';
export type ActionType = 'buy' | 'sell' | 'alert';

export interface TradingRule {
  id: string;
  name: string;
  description?: string;
  securityId?: string;
  ruleType: RuleType;
  conditionType: ConditionType;
  conditionOperator: ConditionOperator;
  conditionValue: number;
  actionType: ActionType;
  actionValue?: number;
  isEnabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface TradingRuleFilters {
  securityId?: string | null;
  ruleType?: RuleType;
  isEnabled?: boolean;
}

// Decision log types
export type DecisionType = 'buy' | 'sell' | 'hold' | 'research';

export interface DecisionLog {
  id: string;
  securityId: string;
  decisionDate: string;
  decisionType: DecisionType;
  background?: string;
  decision: string;
  execution?: string;
  transactionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DecisionLogFilters {
  securityId?: string;
  decisionType?: DecisionType;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
}

// Daily ritual types
export interface DailyRitual {
  id: string;
  date: string;
  regimeRewarding?: string;
  regimePunishing?: string;
  regimeType?: 'trend' | 'sorting';
  regimeNotes?: string;
  actionChosen?: 'reduce' | 'retier' | 'add' | 'nothing';
  actionDetail?: string;
  journal?: string;
  createdAt: string;
  updatedAt: string;
}

// Position intent change log types
export interface PositionIntentChangeLog {
  id: string;
  positionId: string;
  ritualDate?: string;
  fieldChanged: string;
  oldValue?: string;
  newValue?: string;
  reason?: string;
  createdAt: string;
}

// Watchlist types
export interface Watchlist {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistItem {
  id: string;
  watchlistId: string;
  symbol: string;
  securityId?: string;
  notes?: string;
  targetEntryPrice?: number;
  targetExitPrice?: number;
  thesisSnippet?: string;
  lastPrice?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Monitor {
  id: string;
  symbol: string;
  direction: 'above' | 'below';
  priceLevel: number;
  label: string;
  actionType: 'informational' | 'action_required';
  status: 'active' | 'triggered' | 'dismissed';
  monitorType?: 'price' | 'earnings' | 'fundamental';
  linkedPositionId?: string;
  linkedWatchlistItemId?: string;
  triggeredAt?: string;
  reminderDate?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Schwab order types
export interface SchwabOrderRequest {
  accountNumber: string;
  symbol: string;
  instruction: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  price?: number;
  stopPrice?: number;
  duration: 'DAY' | 'GTC' | 'FILL_OR_KILL';
}

export interface SchwabOrder {
  orderId: string;
  accountNumber: string;
  accountHash: string;
  status: string;
  symbol: string;
  instruction: string;
  quantity: number;
  filledQuantity: number;
  price?: number;
  orderType: string;
  duration: string;
  enteredTime: string;
  closedTime?: string;
  description?: string;
}

// Portfolio analytics
export interface PortfolioAnalytics {
  beta: number;
  weightedBeta: number;
  weightedBetaWithCash: number;
  volatility: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownDate: string;
  currentDrawdown: number;
  annualizedReturn: number;
  totalReturn: number;
  benchmarkReturn: number;
  dataPoints: number;
  periodDays: number;
}

export interface PositionBeta {
  symbol: string;
  beta: number;
  correlation: number;
  weight: number;
  weightedBeta: number;
}

export interface PriceLevel {
  id: string;
  symbol: string;
  levelType: 'support' | 'resistance';
  price: number;
  strength: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

// News types
export interface NewsArticle {
  symbol: string;
  title: string;
  snippet: string | null;
  source: string | null;
  url: string | null;
  publishedAt: string;
}

// Scheduler types
export interface TaskRunRecord {
  id: string;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'failure';
  result?: string;
  error?: string;
  durationMs?: number;
}

export interface TaskStatus {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  lastRun?: TaskRunRecord;
  nextRunAt?: string;
  isRunning: boolean;
}

export interface SchedulerStatus {
  running: boolean;
  startedAt: string;
  lastTick: number;
  tasks: TaskStatus[];
}

export interface SchedulerHeartbeat {
  alive: boolean;
  lastTick: number;
  uptime: number;
}

export interface TaskResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

// Pre-trade checklist
export interface PreTradeCheckItem {
  id: string;
  label: string;
  type: 'auto' | 'manual';
  status: 'pass' | 'fail' | 'warn';
  detail?: string;
}

export interface PreTradeCheckRequest {
  symbol: string;
  instruction: 'BUY' | 'SELL';
  quantity: number;
  accountNumber: string;
  price?: number;
}

export interface PreTradeCheckResult {
  book: 'investing' | 'trading' | 'unassigned';
  items: PreTradeCheckItem[];
}

export interface PreTradeCheckRecord {
  id: string;
  orderSymbol: string;
  orderSide: string;
  orderQty: number;
  accountId: string;
  book: string;
  checksJson: string;
  overrides: string;
  passed: boolean;
  createdAt: string;
}

// --- Transaction Analytics (Phase 9B) ---

export interface ClosedTrade {
  symbol: string;
  securityId: string;
  accountId: string;
  buyDate: string;
  sellDate: string;
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  costBasis: number;
  proceeds: number;
  realizedGain: number;
  realizedGainPct: number;
  holdDays: number;
  holdBucket: 'short' | 'medium' | 'long';
  isWin: boolean;
}

export interface TradeAnalyticsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalRealizedGain: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;
}

export interface TradeBreakdown {
  label: string;
  count: number;
  wins: number;
  winRate: number;
  avgGain: number;
  totalGain: number;
}

export interface TradeAnalytics {
  summary: TradeAnalyticsSummary;
  byHoldPeriod: TradeBreakdown[];
  byRegimeAtEntry: TradeBreakdown[];
  byEntryStyle: TradeBreakdown[];
  topWinners: ClosedTrade[];
  topLosers: ClosedTrade[];
  patterns?: TradePatterns;
}

export interface SymbolPattern {
  symbol: string;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalGain: number;
  avgHoldDays: number;
  avgGainPct: number;
  flag?: string;
}

export interface TimingPattern {
  label: string;
  description: string;
  severity: 'info' | 'warn' | 'strength';
  detail: string;
}

export interface TradePatterns {
  symbolPatterns: SymbolPattern[];
  timingPatterns: TimingPattern[];
  holdPeriodInsight: string;
  overallInsight: string;
}
