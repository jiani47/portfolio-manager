import { AppSettings, StockQuote, PriceHistory, IntradayPrice, TickerDetails } from '../shared/types';

/**
 * Massive API Service
 *
 * Endpoints used:
 * - Ticker Details: GET /v3/reference/tickers/{ticker}
 * - Snapshot/Quote: GET /v2/snapshot/locale/us/markets/stocks/tickers/{stocksTicker}
 * - Aggregates: GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}
 *
 * Auth: ?apiKey=KEY or Authorization: Bearer KEY
 * Rate limit: 5 calls per minute
 */
export class MassiveService {
  private apiKey: string | null = null;
  private baseUrl = 'https://api.massive.com';

  // Rate limiting: 5 calls per minute
  private readonly RATE_LIMIT = 5;
  private readonly RATE_WINDOW_MS = 60 * 1000; // 1 minute
  private callTimestamps: number[] = [];

  async configure(settings: AppSettings): Promise<void> {
    if (settings.dataProvider === 'massive' && settings.dataProviderApiKey) {
      this.apiKey = settings.dataProviderApiKey;
      console.log('[Massive] Service configured');
    } else {
      this.apiKey = null;
    }
  }

  isConfigured(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    // Remove timestamps older than the rate window
    this.callTimestamps = this.callTimestamps.filter(ts => now - ts < this.RATE_WINDOW_MS);

    if (this.callTimestamps.length >= this.RATE_LIMIT) {
      // Need to wait until the oldest call expires
      const oldestCall = this.callTimestamps[0];
      const waitTime = this.RATE_WINDOW_MS - (now - oldestCall) + 100; // +100ms buffer
      console.log(`[Massive] Rate limit reached, waiting ${Math.ceil(waitTime / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      // Clean up again after waiting
      this.callTimestamps = this.callTimestamps.filter(ts => Date.now() - ts < this.RATE_WINDOW_MS);
    }

    this.callTimestamps.push(Date.now());
  }

  private async fetchApi(endpoint: string): Promise<any> {
    if (!this.apiKey) {
      throw new Error('API key not configured');
    }

    // Apply rate limiting
    await this.waitForRateLimit();

    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${this.baseUrl}${endpoint}${separator}apiKey=${this.apiKey}`;
    console.log('[Massive] Fetching:', url.replace(this.apiKey, '***'));

    const response = await fetch(url);
    console.log('[Massive] Response:', response.status, response.statusText);

    if (!response.ok) {
      const text = await response.text();
      console.error('[Massive] Error body:', text);
      throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    return data;
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.apiKey) {
      return { success: false, message: 'API key not configured' };
    }

    try {
      // Test with ticker details endpoint (available on free plans)
      const data = await this.fetchApi('/v3/reference/tickers/AAPL');
      console.log('[Massive] Test response status:', data?.status);

      if (data?.status === 'OK' && data?.results) {
        return { success: true, message: 'Connection successful' };
      }

      return { success: false, message: `Unexpected response: ${data?.status || 'no status'}` };
    } catch (error) {
      console.error('[Massive] testConnection error:', error);
      return { success: false, message: `Connection failed: ${(error as Error).message}` };
    }
  }

  async getTickerDetails(symbol: string): Promise<TickerDetails | null> {
    if (!this.apiKey) {
      return null;
    }

    try {
      // GET /v3/reference/tickers/{ticker}
      const data = await this.fetchApi(`/v3/reference/tickers/${encodeURIComponent(symbol.toUpperCase())}`);

      if (data?.status !== 'OK' || !data?.results) {
        return null;
      }

      const r = data.results;
      return {
        symbol: r.ticker || symbol,
        name: r.name || '',
        type: r.type || '',
        market: r.market || '',
        locale: r.locale || '',
        primaryExchange: r.primary_exchange || '',
        currencyName: r.currency_name || '',
        cik: r.cik,
        sicCode: r.sic_code,
        sicDescription: r.sic_description,
        marketCap: r.market_cap,
        phoneNumber: r.phone_number,
        address: r.address
          ? `${r.address.address1 || ''}, ${r.address.city || ''}, ${r.address.state || ''} ${r.address.postal_code || ''}`.trim()
          : undefined,
        description: r.description,
        homepageUrl: r.homepage_url,
        totalEmployees: r.total_employees,
        listDate: r.list_date,
      };
    } catch (error) {
      console.error(`[Massive] getTickerDetails error for ${symbol}:`, error);
      return null;
    }
  }

  async getQuote(symbol: string): Promise<StockQuote | null> {
    if (!this.apiKey) {
      return null;
    }

    // Try snapshot endpoint first (requires paid plan)
    try {
      const data = await this.fetchApi(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol.toUpperCase())}`);

      if (data?.status === 'OK' && data?.ticker) {
        const t = data.ticker;
        const price = t.day?.c || t.prevDay?.c || 0;
        const previousClose = t.prevDay?.c || 0;
        const change = price - previousClose;
        const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

        return {
          symbol: t.ticker || symbol,
          price,
          change,
          changePercent,
          volume: t.day?.v,
          previousClose,
        };
      }
    } catch (error) {
      console.log(`[Massive] Snapshot failed for ${symbol}, falling back to historical:`, (error as Error).message);
    }

    // Fallback: use previous day's close from aggregates (available on free plans)
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 5); // Get last 5 days to ensure we have data

      const fromStr = from.toISOString().split('T')[0];
      const toStr = to.toISOString().split('T')[0];

      const data = await this.fetchApi(
        `/v2/aggs/ticker/${encodeURIComponent(symbol.toUpperCase())}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=2`
      );

      if (data?.status === 'OK' && data?.results?.length > 0) {
        const latest = data.results[0];
        const previous = data.results[1] || data.results[0];
        const price = latest.c;
        const previousClose = previous.c;
        const change = price - previousClose;
        const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

        return {
          symbol: symbol.toUpperCase(),
          price,
          change,
          changePercent,
          volume: latest.v,
          previousClose,
        };
      }
    } catch (error) {
      console.error(`[Massive] getQuote fallback error for ${symbol}:`, error);
    }

    return null;
  }

  async getQuotes(symbols: string[]): Promise<Map<string, StockQuote>> {
    const result = new Map<string, StockQuote>();

    if (!this.apiKey || symbols.length === 0) {
      return result;
    }

    // Fetch sequentially due to strict rate limiting (5 calls/min)
    // Each getQuote may use 1-2 API calls (snapshot + fallback)
    for (const symbol of symbols) {
      const quote = await this.getQuote(symbol);
      if (quote) {
        result.set(symbol, quote);
      }
    }

    return result;
  }

  async getHistoricalPrices(symbol: string, days: number = 30): Promise<Omit<PriceHistory, 'id'>[]> {
    if (!this.apiKey) {
      return [];
    }

    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - days);

      const fromStr = from.toISOString().split('T')[0];
      const toStr = to.toISOString().split('T')[0];

      // GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}
      const data = await this.fetchApi(
        `/v2/aggs/ticker/${encodeURIComponent(symbol.toUpperCase())}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc`
      );

      if (data?.status !== 'OK' || !data?.results || data.results.length === 0) {
        console.log(`[Massive] No historical data for ${symbol}`);
        return [];
      }

      console.log(`[Massive] Got ${data.results.length} historical bars for ${symbol}`);
      const now = new Date().toISOString();

      return data.results.map((bar: any) => ({
        securityId: '', // Filled by caller
        date: new Date(bar.t).toISOString().split('T')[0],
        openPrice: bar.o,
        highPrice: bar.h,
        lowPrice: bar.l,
        closePrice: bar.c,
        volume: bar.v,
        fetchedAt: now,
      }));
    } catch (error) {
      console.error(`[Massive] getHistoricalPrices error for ${symbol}:`, error);
      return [];
    }
  }

  async fetchHistoricalForAll(
    symbolSecurityMap: Map<string, string>,
    days: number = 30
  ): Promise<{ priceHistory: Omit<PriceHistory, 'id'>[]; errors: string[] }> {
    const priceHistory: Omit<PriceHistory, 'id'>[] = [];
    const errors: string[] = [];

    if (!this.apiKey) {
      errors.push('Massive API key not configured');
      return { priceHistory, errors };
    }

    for (const [symbol, securityId] of symbolSecurityMap) {
      try {
        const history = await this.getHistoricalPrices(symbol, days);
        if (history.length === 0) {
          errors.push(`No historical data for ${symbol}`);
        } else {
          for (const price of history) {
            priceHistory.push({ ...price, securityId });
          }
        }
      } catch (err) {
        errors.push(`Failed to fetch ${symbol}: ${(err as Error).message}`);
      }
    }

    return { priceHistory, errors };
  }

  async getIntradayPrices(symbol: string, date?: string): Promise<IntradayPrice[]> {
    if (!this.apiKey) {
      return [];
    }

    try {
      const targetDate = date || new Date().toISOString().split('T')[0];

      // GET /v2/aggs/ticker/{stocksTicker}/range/1/minute/{from}/{to}
      const data = await this.fetchApi(
        `/v2/aggs/ticker/${encodeURIComponent(symbol.toUpperCase())}/range/1/minute/${targetDate}/${targetDate}?adjusted=true&sort=asc`
      );

      if (data?.status !== 'OK' || !data?.results || data.results.length === 0) {
        return [];
      }

      console.log(`[Massive] Got ${data.results.length} intraday bars for ${symbol}`);

      return data.results.map((bar: any) => ({
        timestamp: new Date(bar.t).toISOString(),
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
        vwap: bar.vw,
      }));
    } catch (error) {
      console.error(`[Massive] getIntradayPrices error for ${symbol}:`, error);
      return [];
    }
  }

  async refreshPrices(
    symbolSecurityMap: Map<string, string>
  ): Promise<{
    prices: Map<string, number>;
    priceHistory: Omit<PriceHistory, 'id'>[];
    errors: string[];
  }> {
    const prices = new Map<string, number>();
    const priceHistory: Omit<PriceHistory, 'id'>[] = [];
    const errors: string[] = [];

    if (!this.apiKey || symbolSecurityMap.size === 0) {
      if (!this.apiKey) {
        errors.push('Massive API key not configured');
      }
      return { prices, priceHistory, errors };
    }

    const symbols = Array.from(symbolSecurityMap.keys());

    try {
      const quotes = await this.getQuotes(symbols);
      const now = new Date().toISOString();
      const today = now.split('T')[0];

      for (const [symbol, securityId] of symbolSecurityMap) {
        const quote = quotes.get(symbol);
        if (quote && quote.price > 0) {
          prices.set(symbol, quote.price);

          priceHistory.push({
            securityId,
            date: today,
            closePrice: quote.price,
            volume: quote.volume,
            fetchedAt: now,
          });
        } else {
          errors.push(`No price data for ${symbol}`);
        }
      }
    } catch (error) {
      errors.push(`Failed to fetch prices: ${(error as Error).message}`);
    }

    return { prices, priceHistory, errors };
  }
}
