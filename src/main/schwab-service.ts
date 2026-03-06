import { shell } from 'electron';
import * as https from 'https';
import * as url from 'url';
import Store from 'electron-store';
import { AppSettings, SchwabTokens, SchwabSyncResult, SchwabConnectionStatus, SchwabOrderRequest, SchwabOrder, StockQuote, PriceHistory } from '../shared/types';
import { Database } from './database';

// Schwab API response types
interface SchwabAccountNumber {
  accountNumber: string;
  hashValue: string;
}

interface SchwabAccount {
  securitiesAccount: {
    accountNumber: string;
    type: string;
    positions?: SchwabPosition[];
  };
}

interface SchwabPosition {
  shortQuantity: number;
  longQuantity: number;
  instrument: {
    assetType: string;
    cusip?: string;
    symbol: string;
    description?: string;
  };
  marketValue: number;
  averagePrice: number;
  currentDayProfitLoss?: number;
  currentDayProfitLossPercentage?: number;
}

interface SchwabTransaction {
  activityId: number;
  time: string;
  type: string;
  status: string;
  subAccount: string;
  tradeDate: string;
  netAmount: number;
  transferItems?: SchwabTransferItem[];
}

interface SchwabTransferItem {
  instrument: {
    assetType: string;
    symbol: string;
    description?: string;
  };
  amount: number;
  cost: number;
  price: number;
  feeType?: string;
}

const SCHWAB_API_BASE = 'https://api.schwabapi.com';
const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';

export class SchwabService {
  private store: Store<{ settings: AppSettings }>;
  private clientId: string | null = null;
  private clientSecret: string | null = null;
  private callbackUrl: string | null = null;
  private tokens: SchwabTokens | null = null;
  private accountHashes: Map<string, string> = new Map();

  // Market data rate limiting: 120 calls per minute
  private readonly MARKET_RATE_LIMIT = 120;
  private readonly MARKET_RATE_WINDOW_MS = 60 * 1000;
  private marketCallTimestamps: number[] = [];

  constructor(store: Store<{ settings: AppSettings }>) {
    this.store = store;
  }

  configure(settings: AppSettings): void {
    this.clientId = settings.schwabClientId || null;
    this.clientSecret = settings.schwabClientSecret || null;
    this.callbackUrl = settings.schwabCallbackUrl || null;
    this.tokens = settings.schwabTokens || null;
  }

  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret && this.callbackUrl);
  }

  isConnected(): boolean {
    return !!(this.tokens && this.tokens.refreshTokenExpiresAt > Date.now());
  }

  getConnectionStatus(): SchwabConnectionStatus {
    if (!this.isConfigured()) {
      return { connected: false, message: 'Schwab credentials not configured' };
    }
    if (!this.tokens) {
      return { connected: false, message: 'Not connected. Click "Connect to Schwab" to authorize.' };
    }
    if (this.tokens.refreshTokenExpiresAt <= Date.now()) {
      return { connected: false, message: 'Session expired. Please reconnect.' };
    }
    return {
      connected: true,
      message: 'Connected to Schwab',
      accountCount: this.accountHashes.size || undefined,
    };
  }

  async startOAuth(): Promise<{ success: boolean; message: string }> {
    if (!this.clientId || !this.clientSecret || !this.callbackUrl) {
      return { success: false, message: 'Schwab credentials not configured' };
    }

    try {
      const parsedCallback = new url.URL(this.callbackUrl);
      const port = parseInt(parsedCallback.port, 10) || 443;

      // Generate self-signed cert for HTTPS callback server
      const selfsigned = require('selfsigned');
      const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
      const pems = selfsigned.generate(attrs, {
        keySize: 2048,
        days: 1,
        algorithm: 'sha256',
      });

      // Start local HTTPS server to receive the callback
      const authCode = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.close();
          reject(new Error('OAuth timeout - no callback received within 5 minutes'));
        }, 5 * 60 * 1000);

        const server = https.createServer(
          { key: pems.private, cert: pems.cert },
          (req, res) => {
            const reqUrl = new url.URL(req.url || '', `https://127.0.0.1:${port}`);
            const code = reqUrl.searchParams.get('code');

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<html><body><h2>Authorization successful!</h2><p>You can close this window and return to Portfolio Manager.</p></body></html>');
              clearTimeout(timeout);
              server.close();
              resolve(code);
            } else {
              const error = reqUrl.searchParams.get('error') || 'No authorization code received';
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`<html><body><h2>Authorization failed</h2><p>${error}</p></body></html>`);
              clearTimeout(timeout);
              server.close();
              reject(new Error(error));
            }
          }
        );

        server.listen(port, '127.0.0.1', () => {
          // Open browser to Schwab authorization URL
          const authUrl = `${SCHWAB_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(this.clientId!)}&redirect_uri=${encodeURIComponent(this.callbackUrl!)}`;
          shell.openExternal(authUrl);
        });

        server.on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`Failed to start callback server: ${err.message}`));
        });
      });

      // Exchange auth code for tokens
      await this.exchangeCodeForTokens(authCode);

      // Fetch account numbers to verify connection
      await this.getAccountNumbers();

      return { success: true, message: `Connected to Schwab (${this.accountHashes.size} account${this.accountHashes.size !== 1 ? 's' : ''})` };
    } catch (err) {
      return { success: false, message: `OAuth failed: ${(err as Error).message}` };
    }
  }

  private async exchangeCodeForTokens(code: string): Promise<void> {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await fetch(SCHWAB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl!,
      }).toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    this.saveTokens(data);
  }

  async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('SCHWAB_REAUTH_REQUIRED');
    }

    if (this.tokens.refreshTokenExpiresAt <= Date.now()) {
      this.tokens = null;
      this.saveTokensToStore();
      throw new Error('SCHWAB_REAUTH_REQUIRED');
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await fetch(SCHWAB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 400) {
        this.tokens = null;
        this.saveTokensToStore();
        throw new Error('SCHWAB_REAUTH_REQUIRED');
      }
      throw new Error(`Token refresh failed (${response.status})`);
    }

    const data = await response.json();
    this.saveTokens(data);
  }

  private saveTokens(data: Record<string, unknown>): void {
    const now = Date.now();
    this.tokens = {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token as string,
      accessTokenExpiresAt: now + ((data.expires_in as number) || 1800) * 1000,
      refreshTokenExpiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days
      scope: data.scope as string | undefined,
      tokenType: (data.token_type as string) || 'Bearer',
    };
    this.saveTokensToStore();
  }

  private saveTokensToStore(): void {
    const settings = this.store.get('settings');
    settings.schwabTokens = this.tokens || undefined;
    this.store.set('settings', settings);
  }

  disconnect(): void {
    this.tokens = null;
    this.accountHashes.clear();
    this.saveTokensToStore();
  }

  private async fetchApi(path: string, options?: RequestInit): Promise<Response> {
    if (!this.tokens) {
      throw new Error('SCHWAB_REAUTH_REQUIRED');
    }

    // Auto-refresh if access token is expired (with 60s buffer)
    if (this.tokens.accessTokenExpiresAt <= Date.now() + 60000) {
      await this.refreshAccessToken();
    }

    const response = await fetch(`${SCHWAB_API_BASE}${path}`, {
      ...options,
      headers: {
        'Authorization': `${this.tokens!.tokenType} ${this.tokens!.accessToken}`,
        'Accept': 'application/json',
        ...options?.headers,
      },
    });

    if (response.status === 401) {
      // Try one refresh
      await this.refreshAccessToken();
      return fetch(`${SCHWAB_API_BASE}${path}`, {
        ...options,
        headers: {
          'Authorization': `${this.tokens!.tokenType} ${this.tokens!.accessToken}`,
          'Accept': 'application/json',
          ...options?.headers,
        },
      });
    }

    return response;
  }

  async getAccountNumbers(): Promise<SchwabAccountNumber[]> {
    const response = await this.fetchApi('/trader/v1/accounts/accountNumbers');
    if (!response.ok) {
      throw new Error(`Failed to fetch account numbers (${response.status})`);
    }
    const accounts: SchwabAccountNumber[] = await response.json();
    this.accountHashes.clear();
    for (const acct of accounts) {
      this.accountHashes.set(acct.accountNumber, acct.hashValue);
    }
    return accounts;
  }

  async getAccountsWithPositions(): Promise<SchwabAccount[]> {
    const response = await this.fetchApi('/trader/v1/accounts?fields=positions');
    if (!response.ok) {
      throw new Error(`Failed to fetch accounts (${response.status})`);
    }
    return response.json();
  }

  async getTransactions(accountHash: string, startDate: string, endDate: string): Promise<SchwabTransaction[]> {
    const params = new URLSearchParams({
      startDate,
      endDate,
      types: 'TRADE,DIVIDEND_OR_INTEREST,RECEIVE_AND_DELIVER',
    });
    const response = await this.fetchApi(`/trader/v1/accounts/${accountHash}/transactions?${params}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch transactions (${response.status})`);
    }
    return response.json();
  }

  // --- Sync Methods ---

  async syncPositions(db: Database): Promise<SchwabSyncResult> {
    const errors: string[] = [];
    let accountsSynced = 0;
    let positionsSynced = 0;

    try {
      // Ensure we have account hashes
      if (this.accountHashes.size === 0) {
        await this.getAccountNumbers();
      }

      const accounts = await this.getAccountsWithPositions();

      for (const acctData of accounts) {
        const schwabAcct = acctData.securitiesAccount;
        try {
          // Find or create account
          const account = this.findOrCreateAccount(db, schwabAcct.accountNumber, schwabAcct.type);
          accountsSynced++;

          if (!schwabAcct.positions) continue;

          for (const pos of schwabAcct.positions) {
            try {
              const quantity = pos.longQuantity - pos.shortQuantity;
              if (quantity === 0) continue;

              const securityType = this.mapSecurityType(pos.instrument.assetType);
              const symbol = pos.instrument.symbol;

              // Find or create security
              let security = db.findSecurityBySymbol(symbol);
              if (!security) {
                security = db.createSecurity({
                  symbol,
                  name: pos.instrument.description || symbol,
                  type: securityType,
                  currency: 'USD',
                });
              }

              // Upsert position
              const existingPosition = db.findPositionByAccountAndSecurity(account.id, security.id);
              const costBasis = pos.averagePrice * Math.abs(quantity);

              if (existingPosition) {
                db.updatePosition(existingPosition.id, {
                  quantity,
                  costBasis,
                  lastUpdated: new Date().toISOString(),
                });
              } else {
                db.createPosition({
                  accountId: account.id,
                  securityId: security.id,
                  quantity,
                  costBasis,
                  lastUpdated: new Date().toISOString(),
                });
              }

              positionsSynced++;
            } catch (err) {
              errors.push(`Position ${pos.instrument.symbol}: ${(err as Error).message}`);
            }
          }
        } catch (err) {
          errors.push(`Account ${schwabAcct.accountNumber}: ${(err as Error).message}`);
        }
      }

      return { success: true, accountsSynced, positionsSynced, transactionsSynced: 0, errors };
    } catch (err) {
      return {
        success: false,
        accountsSynced,
        positionsSynced,
        transactionsSynced: 0,
        errors: [...errors, (err as Error).message],
      };
    }
  }

  async syncTransactions(db: Database, startDate?: string, endDate?: string): Promise<SchwabSyncResult> {
    const errors: string[] = [];
    let accountsSynced = 0;
    let transactionsSynced = 0;

    try {
      // Ensure we have account hashes
      if (this.accountHashes.size === 0) {
        await this.getAccountNumbers();
      }

      const end = endDate || new Date().toISOString().split('T')[0] + 'T23:59:59.000Z';
      const start = startDate || (() => {
        const d = new Date();
        d.setDate(d.getDate() - 90);
        return d.toISOString().split('T')[0] + 'T00:00:00.000Z';
      })();

      for (const [accountNumber, accountHash] of this.accountHashes) {
        try {
          const account = this.findOrCreateAccount(db, accountNumber, 'BROKERAGE');
          accountsSynced++;

          const transactions = await this.getTransactions(accountHash, start, end);

          for (const txn of transactions) {
            try {
              const items = txn.transferItems || [];
              if (items.length === 0) continue;

              for (const item of items) {
                const symbol = item.instrument?.symbol;
                if (!symbol) continue;

                const securityType = this.mapSecurityType(item.instrument.assetType);

                // Find or create security
                let security = db.findSecurityBySymbol(symbol);
                if (!security) {
                  security = db.createSecurity({
                    symbol,
                    name: item.instrument.description || symbol,
                    type: securityType,
                    currency: 'USD',
                  });
                }

                const txnType = this.mapTransactionType(txn.type, txn.netAmount);
                const date = txn.tradeDate || txn.time;

                // Deduplicate: check for existing transaction
                const existing = db.listTransactions({
                  accountId: account.id,
                  securityId: security.id,
                  type: txnType,
                  startDate: date.split('T')[0],
                  endDate: date.split('T')[0],
                });

                const isDuplicate = existing.some(
                  (t) => Math.abs(t.amount - txn.netAmount) < 0.01
                );

                if (!isDuplicate) {
                  db.createTransaction({
                    accountId: account.id,
                    securityId: security.id,
                    type: txnType,
                    date: date.split('T')[0],
                    quantity: Math.abs(item.amount || 0),
                    price: item.price || 0,
                    amount: txn.netAmount,
                    fees: 0,
                  });
                  transactionsSynced++;
                }
              }
            } catch (err) {
              errors.push(`Transaction ${txn.activityId}: ${(err as Error).message}`);
            }
          }
        } catch (err) {
          errors.push(`Account ${accountNumber}: ${(err as Error).message}`);
        }
      }

      return { success: true, accountsSynced, positionsSynced: 0, transactionsSynced, errors };
    } catch (err) {
      return {
        success: false,
        accountsSynced,
        positionsSynced: 0,
        transactionsSynced,
        errors: [...errors, (err as Error).message],
      };
    }
  }

  // --- Order Methods ---

  async placeOrder(accountNumber: string, order: SchwabOrderRequest): Promise<{ success: boolean; message: string; orderId?: string }> {
    try {
      if (this.accountHashes.size === 0) {
        await this.getAccountNumbers();
      }
      const hash = this.accountHashes.get(accountNumber);
      if (!hash) {
        return { success: false, message: `Account not found: ${accountNumber}` };
      }

      const orderBody: Record<string, unknown> = {
        orderType: order.orderType,
        session: 'NORMAL',
        duration: order.duration,
        orderStrategyType: 'SINGLE',
        orderLegCollection: [
          {
            instruction: order.instruction,
            quantity: order.quantity,
            instrument: {
              symbol: order.symbol,
              assetType: 'EQUITY',
            },
          },
        ],
      };

      if (order.orderType === 'LIMIT' || order.orderType === 'STOP_LIMIT') {
        orderBody.price = order.price;
      }
      if (order.orderType === 'STOP' || order.orderType === 'STOP_LIMIT') {
        orderBody.stopPrice = order.stopPrice;
      }

      const response = await this.fetchApi(`/trader/v1/accounts/${hash}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderBody),
      });

      if (response.status === 201) {
        const location = response.headers.get('Location') || '';
        const orderId = location.split('/').pop() || '';
        return { success: true, message: 'Order placed successfully', orderId };
      }

      const errorText = await response.text();
      return { success: false, message: `Order failed (${response.status}): ${errorText}` };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }

  async getOrders(accountHash: string, status?: string): Promise<SchwabOrder[]> {
    const params = new URLSearchParams();
    if (status) {
      params.set('status', status);
    }
    // Default to orders from the last 60 days
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 60);
    params.set('fromEnteredTime', fromDate.toISOString());
    params.set('toEnteredTime', new Date().toISOString());

    const query = params.toString();
    const response = await this.fetchApi(`/trader/v1/accounts/${accountHash}/orders${query ? `?${query}` : ''}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch orders (${response.status})`);
    }
    const rawOrders: Record<string, unknown>[] = await response.json();

    // Find account number for this hash
    let accountNumber = '';
    for (const [num, h] of this.accountHashes) {
      if (h === accountHash) {
        accountNumber = num;
        break;
      }
    }

    return rawOrders.map((o) => this.parseOrder(o, accountNumber, accountHash));
  }

  async getOrdersForAllAccounts(status?: string): Promise<SchwabOrder[]> {
    if (this.accountHashes.size === 0) {
      await this.getAccountNumbers();
    }

    const allOrders: SchwabOrder[] = [];
    for (const [, accountHash] of this.accountHashes) {
      try {
        const orders = await this.getOrders(accountHash, status);
        allOrders.push(...orders);
      } catch {
        // Skip accounts that fail
      }
    }

    // Sort by entered time descending
    allOrders.sort((a, b) => new Date(b.enteredTime).getTime() - new Date(a.enteredTime).getTime());
    return allOrders;
  }

  async cancelOrder(accountNumber: string, orderId: string): Promise<{ success: boolean; message: string }> {
    try {
      if (this.accountHashes.size === 0) {
        await this.getAccountNumbers();
      }
      const hash = this.accountHashes.get(accountNumber);
      if (!hash) {
        return { success: false, message: `Account not found: ${accountNumber}` };
      }

      const response = await this.fetchApi(`/trader/v1/accounts/${hash}/orders/${orderId}`, {
        method: 'DELETE',
      });

      if (response.ok || response.status === 200 || response.status === 204) {
        return { success: true, message: 'Order canceled successfully' };
      }

      const errorText = await response.text();
      return { success: false, message: `Cancel failed (${response.status}): ${errorText}` };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }

  private parseOrder(raw: Record<string, unknown>, accountNumber: string, accountHash: string): SchwabOrder {
    const legs = (raw.orderLegCollection as Record<string, unknown>[]) || [];
    const firstLeg = legs[0] || {};
    const instrument = (firstLeg.instrument as Record<string, unknown>) || {};

    return {
      orderId: String(raw.orderId || ''),
      accountNumber,
      accountHash,
      status: String(raw.status || ''),
      symbol: String(instrument.symbol || ''),
      instruction: String(firstLeg.instruction || ''),
      quantity: Number(raw.quantity || 0),
      filledQuantity: Number(raw.filledQuantity || 0),
      price: raw.price != null ? Number(raw.price) : undefined,
      orderType: String(raw.orderType || ''),
      duration: String(raw.duration || ''),
      enteredTime: String(raw.enteredTime || ''),
      closedTime: raw.closeTime ? String(raw.closeTime) : undefined,
      description: raw.description ? String(raw.description) : undefined,
    };
  }

  // --- Market Data Methods ---

  private async waitForMarketRateLimit(): Promise<void> {
    const now = Date.now();
    this.marketCallTimestamps = this.marketCallTimestamps.filter(ts => now - ts < this.MARKET_RATE_WINDOW_MS);

    if (this.marketCallTimestamps.length >= this.MARKET_RATE_LIMIT) {
      const oldestCall = this.marketCallTimestamps[0];
      const waitTime = this.MARKET_RATE_WINDOW_MS - (now - oldestCall) + 100;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.marketCallTimestamps = this.marketCallTimestamps.filter(ts => Date.now() - ts < this.MARKET_RATE_WINDOW_MS);
    }

    this.marketCallTimestamps.push(Date.now());
  }

  async getMarketQuote(symbol: string): Promise<StockQuote | null> {
    try {
      await this.waitForMarketRateLimit();
      const response = await this.fetchApi(`/marketdata/v1/${encodeURIComponent(symbol)}/quotes`);
      if (!response.ok) return null;

      const data = await response.json();
      const entry = data[symbol.toUpperCase()];
      if (!entry) return null;

      const q = entry.quote || entry;
      return {
        symbol: symbol.toUpperCase(),
        price: q.lastPrice ?? q.mark ?? 0,
        change: q.netChange ?? 0,
        changePercent: q.netPercentChange ?? 0,
        volume: q.totalVolume,
        previousClose: q.closePrice,
        delayed: q.delayed ?? q.isDelayed ?? undefined,
      };
    } catch {
      return null;
    }
  }

  async getMarketQuotes(symbols: string[]): Promise<{ quotes: Map<string, StockQuote>; delayed: boolean }> {
    const quotes = new Map<string, StockQuote>();
    let anyDelayed = false;

    // Batch into groups of 40 to avoid URL length limits
    const batchSize = 40;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      try {
        await this.waitForMarketRateLimit();
        const symbolsParam = batch.map(s => encodeURIComponent(s)).join(',');
        const response = await this.fetchApi(`/marketdata/v1/quotes?symbols=${symbolsParam}`);
        if (!response.ok) continue;

        const data = await response.json();
        for (const sym of batch) {
          const entry = data[sym.toUpperCase()];
          if (!entry) continue;
          const q = entry.quote || entry;
          const isDelayed = q.delayed ?? q.isDelayed ?? false;
          if (isDelayed) anyDelayed = true;

          quotes.set(sym.toUpperCase(), {
            symbol: sym.toUpperCase(),
            price: q.lastPrice ?? q.mark ?? 0,
            change: q.netChange ?? 0,
            changePercent: q.netPercentChange ?? 0,
            volume: q.totalVolume,
            previousClose: q.closePrice,
            delayed: isDelayed,
          });
        }
      } catch {
        // Skip failed batches
      }
    }

    return { quotes, delayed: anyDelayed };
  }

  async getMarketPriceHistory(symbol: string, days: number = 30): Promise<Omit<PriceHistory, 'id'>[]> {
    try {
      await this.waitForMarketRateLimit();
      const period = Math.max(1, Math.ceil(days / 30));
      const response = await this.fetchApi(
        `/marketdata/v1/pricehistory?symbol=${encodeURIComponent(symbol)}&periodType=month&period=${period}&frequencyType=daily&frequency=1`
      );
      if (!response.ok) return [];

      const data = await response.json();
      const candles = data.candles || [];
      const now = new Date().toISOString();

      return candles.map((c: { open: number; high: number; low: number; close: number; volume: number; datetime: number }) => ({
        securityId: '', // Caller must set this
        date: new Date(c.datetime).toISOString().split('T')[0],
        openPrice: c.open,
        highPrice: c.high,
        lowPrice: c.low,
        closePrice: c.close,
        volume: c.volume,
        fetchedAt: now,
      }));
    } catch {
      return [];
    }
  }

  async refreshPrices(symbolSecurityMap: Map<string, string>): Promise<{
    prices: Map<string, number>;
    priceHistory: Omit<PriceHistory, 'id'>[];
    errors: string[];
    delayed: boolean;
  }> {
    const prices = new Map<string, number>();
    const priceHistory: Omit<PriceHistory, 'id'>[] = [];
    const errors: string[] = [];

    try {
      const symbols = Array.from(symbolSecurityMap.keys());
      const { quotes, delayed } = await this.getMarketQuotes(symbols);
      const today = new Date().toISOString().split('T')[0];
      const now = new Date().toISOString();

      for (const [symbol, securityId] of symbolSecurityMap) {
        const quote = quotes.get(symbol.toUpperCase());
        if (quote && quote.price > 0) {
          prices.set(symbol, quote.price);
          priceHistory.push({
            securityId,
            date: today,
            closePrice: quote.price,
            volume: quote.volume,
            fetchedAt: now,
          });
        }
      }

      return { prices, priceHistory, errors, delayed };
    } catch (err) {
      errors.push((err as Error).message);
      return { prices, priceHistory, errors, delayed: false };
    }
  }

  async fetchHistoricalForAll(symbolSecurityMap: Map<string, string>, days: number = 30): Promise<{
    priceHistory: Omit<PriceHistory, 'id'>[];
    errors: string[];
  }> {
    const allPriceHistory: Omit<PriceHistory, 'id'>[] = [];
    const errors: string[] = [];

    for (const [symbol, securityId] of symbolSecurityMap) {
      try {
        const history = await this.getMarketPriceHistory(symbol, days);
        for (const record of history) {
          allPriceHistory.push({ ...record, securityId });
        }
      } catch (err) {
        errors.push(`${symbol}: ${(err as Error).message}`);
      }
    }

    return { priceHistory: allPriceHistory, errors };
  }

  async testMarketDataConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.isConnected()) {
      return { success: false, message: 'Schwab not connected. Please connect in Brokerage Connection settings.' };
    }

    try {
      const quote = await this.getMarketQuote('AAPL');
      if (quote && quote.price > 0) {
        const delayedText = quote.delayed ? ' (delayed)' : ' (real-time)';
        return { success: true, message: `Market data working${delayedText}. AAPL: $${quote.price.toFixed(2)}` };
      }
      return { success: false, message: 'Could not fetch market data. Check your Schwab app permissions.' };
    } catch (err) {
      return { success: false, message: `Market data test failed: ${(err as Error).message}` };
    }
  }

  // --- Streaming support ---

  async getUserPreference(): Promise<Record<string, unknown>> {
    const response = await this.fetchApi('/trader/v1/userPreference');
    if (!response.ok) {
      throw new Error(`Failed to fetch user preference (${response.status})`);
    }
    return response.json();
  }

  getAccessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  async ensureTokenFresh(): Promise<void> {
    if (!this.tokens) throw new Error('SCHWAB_REAUTH_REQUIRED');
    if (this.tokens.accessTokenExpiresAt <= Date.now() + 60000) {
      await this.refreshAccessToken();
    }
  }

  // --- Helpers ---

  private findOrCreateAccount(db: Database, accountNumber: string, schwabType: string) {
    const accounts = db.listAccounts();
    let account = accounts.find(
      (a) => a.accountNumber === accountNumber && a.broker === 'Schwab'
    );

    if (!account) {
      account = db.createAccount({
        name: `Schwab ${accountNumber.slice(-4)}`,
        broker: 'Schwab',
        accountNumber,
        accountType: this.mapAccountType(schwabType),
        currency: 'USD',
      });
    }

    return account;
  }

  private mapSecurityType(assetType: string): 'stock' | 'etf' | 'mutual_fund' | 'bond' | 'option' | 'cash' | 'other' {
    switch (assetType) {
      case 'EQUITY': return 'stock';
      case 'MUTUAL_FUND': return 'mutual_fund';
      case 'ETF': return 'etf';
      case 'OPTION': return 'option';
      case 'FIXED_INCOME': return 'bond';
      case 'CASH_EQUIVALENT': return 'cash';
      default: return 'other';
    }
  }

  private mapAccountType(schwabType: string): 'brokerage' | 'ira' | 'roth_ira' | '401k' | 'other' {
    switch (schwabType) {
      case 'BROKERAGE':
      case 'INDIVIDUAL':
        return 'brokerage';
      case 'TRADITIONAL_IRA':
        return 'ira';
      case 'ROTH_IRA':
        return 'roth_ira';
      case '401K':
        return '401k';
      default:
        return 'other';
    }
  }

  private mapTransactionType(schwabType: string, amount: number): 'buy' | 'sell' | 'dividend' | 'interest' | 'transfer_in' | 'transfer_out' {
    switch (schwabType) {
      case 'TRADE':
        return amount < 0 ? 'buy' : 'sell';
      case 'DIVIDEND_OR_INTEREST':
        return amount > 0 ? 'dividend' : 'interest';
      case 'RECEIVE_AND_DELIVER':
        return amount >= 0 ? 'transfer_in' : 'transfer_out';
      default:
        return amount >= 0 ? 'transfer_in' : 'transfer_out';
    }
  }
}
