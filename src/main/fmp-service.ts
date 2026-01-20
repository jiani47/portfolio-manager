import { AppSettings, CompanyProfile, StockQuote, PriceHistory, EarningsEvent } from '../shared/types';

// FMP API response types
interface FMPQuoteResponse {
  symbol: string;
  name?: string;
  price: number;
  change: number;
  changesPercentage: number;
  volume?: number;
  previousClose?: number;
}

interface FMPProfileResponse {
  symbol: string;
  companyName: string;
  sector?: string;
  industry?: string;
  description?: string;
  website?: string;
  ceo?: string;
  mktCap?: number;
}

interface FMPHistoricalResponse {
  symbol: string;
  historical: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

interface FMPEarningsResponse {
  symbol: string;
  date: string;
  time?: string;
  epsEstimated?: number;
  eps?: number;
  revenueEstimated?: number;
  revenue?: number;
  fiscalDateEnding?: string;
  updatedFromDate?: string;
}

export class FMPService {
  private apiKey: string | null = null;
  private baseUrl = 'https://financialmodelingprep.com/stable';

  configure(settings: AppSettings): void {
    if (settings.dataProvider === 'fmp' && settings.dataProviderApiKey) {
      this.apiKey = settings.dataProviderApiKey;
    } else {
      this.apiKey = null;
    }
  }

  isConfigured(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.apiKey) {
      return { success: false, message: 'API key not configured' };
    }

    try {
      // Test with a simple quote request
      const response = await fetch(
        `${this.baseUrl}/quote?symbol=AAPL&apikey=${this.apiKey}`
      );

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { success: false, message: 'Invalid API key' };
        }
        return { success: false, message: `API error: ${response.status}` };
      }

      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return { success: true, message: 'Connection successful' };
      }

      return { success: false, message: 'Unexpected response format' };
    } catch (error) {
      return { success: false, message: `Connection failed: ${(error as Error).message}` };
    }
  }

  async getCompanyProfile(symbol: string): Promise<CompanyProfile | null> {
    if (!this.apiKey) {
      console.warn('FMP API key not configured');
      return null;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/profile?symbol=${encodeURIComponent(symbol)}&apikey=${this.apiKey}`
      );

      if (!response.ok) {
        console.error(`FMP profile error for ${symbol}: ${response.status}`);
        return null;
      }

      const data: FMPProfileResponse[] = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        return null;
      }

      const profile = data[0];
      return {
        symbol: profile.symbol,
        companyName: profile.companyName,
        sector: profile.sector,
        industry: profile.industry,
        description: profile.description,
        website: profile.website,
        ceo: profile.ceo,
        marketCap: profile.mktCap,
      };
    } catch (error) {
      console.error(`FMP profile error for ${symbol}:`, error);
      return null;
    }
  }

  async getQuote(symbol: string): Promise<StockQuote | null> {
    if (!this.apiKey) {
      console.warn('FMP API key not configured');
      return null;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${this.apiKey}`
      );

      if (!response.ok) {
        console.error(`FMP quote error for ${symbol}: ${response.status}`);
        return null;
      }

      const data: FMPQuoteResponse[] = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        return null;
      }

      const quote = data[0];
      return {
        symbol: quote.symbol,
        price: quote.price,
        change: quote.change,
        changePercent: quote.changesPercentage,
        volume: quote.volume,
        previousClose: quote.previousClose,
      };
    } catch (error) {
      console.error(`FMP quote error for ${symbol}:`, error);
      return null;
    }
  }

  async getQuotes(symbols: string[]): Promise<Map<string, StockQuote>> {
    const result = new Map<string, StockQuote>();

    if (!this.apiKey || symbols.length === 0) {
      return result;
    }

    try {
      // FMP supports comma-separated symbols for batch quotes
      const symbolList = symbols.join(',');
      const response = await fetch(
        `${this.baseUrl}/quote?symbol=${encodeURIComponent(symbolList)}&apikey=${this.apiKey}`
      );

      if (!response.ok) {
        console.error(`FMP batch quote error: ${response.status}`);
        return result;
      }

      const data: FMPQuoteResponse[] = await response.json();
      if (!Array.isArray(data)) {
        return result;
      }

      for (const quote of data) {
        result.set(quote.symbol, {
          symbol: quote.symbol,
          price: quote.price,
          change: quote.change,
          changePercent: quote.changesPercentage,
          volume: quote.volume,
          previousClose: quote.previousClose,
        });
      }
    } catch (error) {
      console.error('FMP batch quote error:', error);
    }

    return result;
  }

  async getHistoricalPrices(symbol: string, days: number = 30): Promise<Omit<PriceHistory, 'id'>[]> {
    if (!this.apiKey) {
      console.warn('FMP API key not configured');
      return [];
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&apikey=${this.apiKey}`
      );

      if (!response.ok) {
        console.error(`FMP historical error for ${symbol}: ${response.status}`);
        return [];
      }

      const data: FMPHistoricalResponse = await response.json();
      if (!data.historical || !Array.isArray(data.historical)) {
        return [];
      }

      const now = new Date().toISOString();

      // Limit to requested number of days and map to PriceHistory format
      return data.historical.slice(0, days).map(item => ({
        securityId: '', // To be filled by caller
        date: item.date,
        openPrice: item.open,
        highPrice: item.high,
        lowPrice: item.low,
        closePrice: item.close,
        volume: item.volume,
        fetchedAt: now,
      }));
    } catch (error) {
      console.error(`FMP historical error for ${symbol}:`, error);
      return [];
    }
  }

  async refreshPrices(
    symbolSecurityMap: Map<string, string> // Map<symbol, securityId>
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
        errors.push('FMP API key not configured');
      }
      return { prices, priceHistory, errors };
    }

    const symbols = Array.from(symbolSecurityMap.keys());

    try {
      // Batch fetch quotes
      const quotes = await this.getQuotes(symbols);
      const now = new Date().toISOString();
      const today = now.split('T')[0]; // YYYY-MM-DD

      for (const [symbol, securityId] of symbolSecurityMap) {
        const quote = quotes.get(symbol);
        if (quote && quote.price > 0) {
          prices.set(symbol, quote.price);

          // Create price history entry for today
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

  async getEarningsCalendar(fromDate?: string, toDate?: string): Promise<EarningsEvent[]> {
    if (!this.apiKey) {
      console.warn('FMP API key not configured');
      return [];
    }

    try {
      let url = `${this.baseUrl}/earnings-calendar?apikey=${this.apiKey}`;
      if (fromDate) {
        url += `&from=${fromDate}`;
      }
      if (toDate) {
        url += `&to=${toDate}`;
      }

      const response = await fetch(url);

      if (!response.ok) {
        console.error(`FMP earnings calendar error: ${response.status}`);
        return [];
      }

      const data: FMPEarningsResponse[] = await response.json();
      if (!Array.isArray(data)) {
        return [];
      }

      return data.map(item => ({
        symbol: item.symbol,
        date: item.date,
        time: this.normalizeEarningsTime(item.time),
        epsEstimated: item.epsEstimated,
        epsActual: item.eps,
        revenueEstimated: item.revenueEstimated,
        revenueActual: item.revenue,
        fiscalDateEnding: item.fiscalDateEnding,
        updatedFromDate: item.updatedFromDate,
      }));
    } catch (error) {
      console.error('FMP earnings calendar error:', error);
      return [];
    }
  }

  async getEarningsForSymbols(symbols: string[], fromDate?: string, toDate?: string): Promise<EarningsEvent[]> {
    // Get full earnings calendar and filter by symbols
    const allEarnings = await this.getEarningsCalendar(fromDate, toDate);
    const symbolSet = new Set(symbols.map(s => s.toUpperCase()));
    return allEarnings.filter(e => symbolSet.has(e.symbol.toUpperCase()));
  }

  private normalizeEarningsTime(time?: string): EarningsEvent['time'] {
    if (!time) return '';
    const t = time.toLowerCase();
    if (t.includes('bmo') || t.includes('before')) return 'bmo';
    if (t.includes('amc') || t.includes('after')) return 'amc';
    if (t.includes('dmh') || t.includes('during')) return 'dmh';
    return '';
  }
}
