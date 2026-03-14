import WebSocket from 'ws';
import { BrowserWindow, Notification } from 'electron';
import Store from 'electron-store';
import { SchwabService } from './schwab-service';
import { Database } from './database';
import { logger } from './logger';
import { AppSettings, StreamingQuote, StreamingStatus, StreamingState, PriceHistory } from '../shared/types';

const EQUITY_FIELDS: Record<number, keyof Omit<StreamingQuote, 'symbol' | 'timestamp'>> = {
  1: 'bid',
  2: 'ask',
  3: 'last',
  8: 'volume',
  10: 'high',
  11: 'low',
  12: 'close',
  17: 'open',
  18: 'netChange',
  42: 'netChangePct',
};

const SUBSCRIBE_FIELDS = '0,1,2,3,8,10,11,12,17,18,42';

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const POSITION_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MARKET_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
const EXTENDED_HOURS_POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_RECONNECT_FAILURES = 5;
const MAX_RECONNECT_DELAY_MS = 60 * 1000;

export class SchwabStreamService {
  private schwabService: SchwabService;
  private db: Database;
  private store: Store<{ settings: AppSettings }>;
  private getMainWindow: () => BrowserWindow | null;

  private ws: WebSocket | null = null;
  private requestId = 0;
  private subscribedSymbols: string[] = [];
  private status: StreamingStatus = 'disconnected';
  private latestQuotes = new Map<string, StreamingQuote>();
  private symbolSecurityMap = new Map<string, string>(); // symbol -> securityId

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private marketCheckTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private positionSyncTimer: ReturnType<typeof setInterval> | null = null;
  private extendedHoursPollTimer: ReturnType<typeof setInterval> | null = null;
  private levelsRefreshedToday = false;
  private consecutiveFailures = 0;
  private reconnectDelay = 2000;
  private connectedSince: number | undefined;

  // Streamer connection info
  private streamerCustomerId = '';
  private streamerCorrelId = '';

  constructor(
    schwabService: SchwabService,
    db: Database,
    store: Store<{ settings: AppSettings }>,
    getMainWindow: () => BrowserWindow | null
  ) {
    this.schwabService = schwabService;
    this.db = db;
    this.store = store;
    this.getMainWindow = getMainWindow;
  }

  startMarketHoursScheduler(): void {
    // Bootstrap quotes from DB so renderer has prices immediately
    this.loadQuotesFromDb();
    // Check immediately, then every 30 seconds
    this.checkMarketAndConnect();
    this.marketCheckTimer = setInterval(() => {
      this.checkMarketAndConnect();
    }, MARKET_CHECK_INTERVAL_MS);
  }

  private loadQuotesFromDb(): void {
    try {
      const prices = this.db.getLatestPrices();
      if (prices.length === 0) return;
      logger.info(`[quotes:bootstrap] Loading ${prices.length} quotes from DB`);
      const mainWindow = this.getMainWindow();
      for (const p of prices) {
        const quote: StreamingQuote = {
          symbol: p.symbol,
          last: p.closePrice,
          open: p.openPrice ?? undefined,
          high: p.highPrice ?? undefined,
          low: p.lowPrice ?? undefined,
          volume: p.volume ?? undefined,
          close: p.closePrice,
          timestamp: new Date(p.fetchedAt).getTime(),
        };
        this.latestQuotes.set(p.symbol, quote);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('streaming:quote', quote);
        }
      }
      logger.info(`[quotes:bootstrap] Sent ${prices.length} quotes to renderer`);
    } catch (err) {
      console.error('Failed to bootstrap quotes from DB:', err);
    }
  }

  stopMarketHoursScheduler(): void {
    if (this.marketCheckTimer) {
      clearInterval(this.marketCheckTimer);
      this.marketCheckTimer = null;
    }
  }

  private checkMarketAndConnect(): void {
    const settings = this.store.get('settings');
    const isSchwabProvider = settings?.dataProvider === 'schwab';
    const isConnectedToSchwab = this.schwabService.isConnected();
    const marketOpen = this.isMarketOpen();
    const extendedHours = this.isExtendedHours();

    if (marketOpen && isSchwabProvider && isConnectedToSchwab) {
      // Regular market hours: use WebSocket streaming
      this.stopExtendedHoursPolling();
      this.levelsRefreshedToday = false; // Reset for next market close
      if (this.status === 'disconnected' || this.status === 'outside_hours') {
        this.connectWithPortfolioSymbols();
      }
    } else if (!marketOpen && (this.status === 'connected' || this.status === 'connecting')) {
      this.disconnect();
      this.setStatus('outside_hours');
      // Refresh S/R levels once at market close
      if (!this.levelsRefreshedToday) {
        this.levelsRefreshedToday = true;
        console.log('Market closed — refreshing S/R levels');
        try {
          this.db.refreshPriceLevels();
        } catch (err) {
          console.error('Failed to refresh price levels:', err);
        }
      }
      // Start extended hours polling if applicable
      if (extendedHours && isSchwabProvider && isConnectedToSchwab) {
        this.startExtendedHoursPolling();
      }
    } else if (!marketOpen && isSchwabProvider && isConnectedToSchwab) {
      if (extendedHours) {
        this.startExtendedHoursPolling();
      } else {
        this.stopExtendedHoursPolling();
      }
      if (this.status === 'disconnected') {
        this.setStatus('outside_hours');
      }
    } else if (!marketOpen && this.status === 'disconnected') {
      this.setStatus('outside_hours');
    }
  }

  isMarketOpen(): boolean {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'short',
    });

    const parts = formatter.formatToParts(now);
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

    // Mon-Fri only
    if (!weekday || ['Sat', 'Sun'].includes(weekday)) return false;

    const timeInMinutes = hour * 60 + minute;
    const marketOpen = 9 * 60 + 30; // 9:30 ET
    const marketClose = 16 * 60; // 16:00 ET

    return timeInMinutes >= marketOpen && timeInMinutes < marketClose;
  }

  private isExtendedHours(): boolean {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'short',
    });

    const parts = formatter.formatToParts(now);
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

    if (!weekday || ['Sat', 'Sun'].includes(weekday)) return false;

    const timeInMinutes = hour * 60 + minute;
    const preMarketOpen = 4 * 60;       // 4:00 AM ET
    const marketOpen = 9 * 60 + 30;     // 9:30 AM ET
    const marketClose = 16 * 60;        // 4:00 PM ET
    const postMarketClose = 20 * 60;    // 8:00 PM ET

    return (timeInMinutes >= preMarketOpen && timeInMinutes < marketOpen) ||
           (timeInMinutes >= marketClose && timeInMinutes < postMarketClose);
  }

  private startExtendedHoursPolling(): void {
    if (this.extendedHoursPollTimer) return; // Already polling

    console.log('Schwab: starting extended hours polling (every 60s)');
    this.pollExtendedHoursQuotes(); // Poll immediately
    this.extendedHoursPollTimer = setInterval(() => {
      this.pollExtendedHoursQuotes();
    }, EXTENDED_HOURS_POLL_INTERVAL_MS);
  }

  private stopExtendedHoursPolling(): void {
    if (this.extendedHoursPollTimer) {
      clearInterval(this.extendedHoursPollTimer);
      this.extendedHoursPollTimer = null;
      console.log('Schwab: stopped extended hours polling');
    }
  }

  private async pollExtendedHoursQuotes(): Promise<void> {
    try {
      // Build symbol list from portfolio
      const positions = this.db.listPositions();
      const securities = this.db.listSecurities();
      const securityMap = new Map(securities.map(s => [s.id, s]));

      const symbols: string[] = [];
      this.symbolSecurityMap.clear();

      for (const pos of positions) {
        const security = securityMap.get(pos.securityId);
        if (security && security.type !== 'cash' && security.type !== 'option') {
          if (!this.symbolSecurityMap.has(security.symbol)) {
            symbols.push(security.symbol);
            this.symbolSecurityMap.set(security.symbol, security.id);
          }
        }
      }

      for (const idx of ['SPY', 'QQQ']) {
        if (!symbols.includes(idx)) symbols.push(idx);
      }

      if (symbols.length === 0) return;

      // Fetch quotes via REST API — includes extendedHoursQuote
      await this.schwabService.ensureTokenFresh();

      const batchSize = 40;
      const mainWindow = this.getMainWindow();

      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        try {
          const symbolsParam = batch.map(s => encodeURIComponent(s)).join(',');
          const response = await this.schwabService.fetchMarketDataApi(
            `/marketdata/v1/quotes?symbols=${symbolsParam}&fields=quote,extended`
          );
          if (!response.ok) continue;

          const data = await response.json();

          for (const sym of batch) {
            const entry = data[sym.toUpperCase()];
            if (!entry) continue;

            const regularQuote = entry.quote || entry;
            const extQuote = entry.extended || entry.extendedHoursQuote;

            // Use extended hours price if available, otherwise regular
            const last = extQuote?.lastPrice ?? regularQuote?.lastPrice ?? regularQuote?.mark ?? 0;
            const netChange = extQuote?.netChange ?? regularQuote?.netChange ?? 0;
            const netChangePct = extQuote?.netPercentChange ?? regularQuote?.netPercentChange ?? 0;

            if (last === 0) continue;

            const quote: StreamingQuote = {
              symbol: sym.toUpperCase(),
              last,
              netChange,
              netChangePct,
              bid: extQuote?.bidPrice ?? regularQuote?.bidPrice,
              ask: extQuote?.askPrice ?? regularQuote?.askPrice,
              volume: extQuote?.totalVolume ?? regularQuote?.totalVolume,
              high: regularQuote?.highPrice,
              low: regularQuote?.lowPrice,
              close: regularQuote?.closePrice,
              open: regularQuote?.openPrice,
              timestamp: Date.now(),
            };

            this.latestQuotes.set(sym.toUpperCase(), quote);
            logger.debug(`[quotes:poll] ${sym.toUpperCase()} $${quote.last.toFixed(2)}`);

            // Check monitors
            if (this.db && quote.last > 0) {
              try {
                const triggered = this.db.checkMonitors(sym.toUpperCase(), quote.last);
                for (const monitor of triggered) {
                  const icon = monitor.direction === 'below' ? '⬇️' : '⬆️';
                  const notification = new Notification({
                    title: `${monitor.actionType === 'action_required' ? '⚠️ ' : ''}Monitor Alert: ${sym.toUpperCase()}`,
                    body: `${icon} ${sym.toUpperCase()} $${quote.last.toFixed(2)} crossed ${monitor.direction} $${monitor.priceLevel} — ${monitor.label}`,
                  });
                  notification.show();

                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('monitor:triggered', monitor);
                  }
                }
              } catch (e) {
                console.error('Monitor check error:', e);
              }
            }

            // Push to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('streaming:quote', quote);
            }
          }
        } catch {
          // Skip failed batches
        }
      }

      console.log(`Schwab extended hours: polled ${symbols.length} quotes`);
    } catch (err) {
      console.error('Extended hours poll error:', err);
    }
  }

  private async connectWithPortfolioSymbols(): Promise<void> {
    try {
      // Get all non-cash securities from positions
      const positions = this.db.listPositions();
      const securities = this.db.listSecurities();
      const securityMap = new Map(securities.map(s => [s.id, s]));

      const symbols: string[] = [];
      this.symbolSecurityMap.clear();

      for (const pos of positions) {
        const security = securityMap.get(pos.securityId);
        if (security && security.type !== 'cash' && security.type !== 'option') {
          if (!this.symbolSecurityMap.has(security.symbol)) {
            symbols.push(security.symbol);
            this.symbolSecurityMap.set(security.symbol, security.id);
          }
        }
      }

      if (symbols.length === 0) return;

      // Add market index proxies for dashboard
      for (const idx of ['SPY', 'QQQ']) {
        if (!symbols.includes(idx)) {
          symbols.push(idx);
        }
      }

      await this.connect(symbols);
    } catch (err) {
      console.error('Failed to connect streaming:', err);
      this.setStatus('error');
    }
  }

  async connect(symbols: string[]): Promise<void> {
    if (this.status === 'connecting' || this.status === 'connected') return;

    this.setStatus('connecting');

    try {
      // Ensure token is fresh
      await this.schwabService.ensureTokenFresh();

      // Get streamer info
      const prefs = await this.schwabService.getUserPreference();
      const streamerInfo = (prefs as any).streamerInfo?.[0];
      if (!streamerInfo?.streamerSocketUrl) {
        throw new Error('No streamer info available');
      }

      this.streamerCustomerId = streamerInfo.schwabClientCustomerId;
      this.streamerCorrelId = streamerInfo.schwabClientCorrelId;

      const wsUrl = streamerInfo.streamerSocketUrl;
      const channel = streamerInfo.schwabClientChannel;
      const functionId = streamerInfo.schwabClientFunctionId;
      const accessToken = this.schwabService.getAccessToken();

      if (!accessToken) throw new Error('No access token available');

      this.subscribedSymbols = symbols.slice(0, 500); // Schwab limit

      // Open WebSocket
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('Schwab WebSocket connected, sending LOGIN...');
        this.sendMessage({
          service: 'ADMIN',
          requestid: String(this.nextRequestId()),
          command: 'LOGIN',
          SchwabClientCustomerId: this.streamerCustomerId,
          SchwabClientCorrelId: this.streamerCorrelId,
          parameters: {
            Authorization: accessToken,
            SchwabClientChannel: channel,
            SchwabClientFunctionId: functionId,
          },
        });
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`Schwab WebSocket closed: ${code} ${reason.toString()}`);
        this.ws = null;
        this.clearSnapshotTimer();

        if (this.status === 'connected' || this.status === 'connecting') {
          this.setStatus('disconnected');
          if (this.isMarketOpen()) {
            this.scheduleReconnect();
          }
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error('Schwab WebSocket error:', err.message);
      });
    } catch (err) {
      console.error('Schwab stream connect failed:', err);
      this.setStatus('error');
      if (this.isMarketOpen()) {
        this.scheduleReconnect();
      }
    }
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.clearSnapshotTimer();
    this.clearPositionSyncTimer();
    this.stopExtendedHoursPolling();

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.sendMessage({
            service: 'ADMIN',
            requestid: String(this.nextRequestId()),
            command: 'LOGOUT',
            SchwabClientCustomerId: this.streamerCustomerId,
            SchwabClientCorrelId: this.streamerCorrelId,
          });
        }
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.consecutiveFailures = 0;
    this.reconnectDelay = 2000;
    this.connectedSince = undefined;
    this.setStatus('disconnected');
  }

  updateSymbols(newSymbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.subscribedSymbols = newSymbols.slice(0, 500);

    // Update security map
    const securities = this.db.listSecurities();
    for (const sec of securities) {
      if (newSymbols.includes(sec.symbol)) {
        this.symbolSecurityMap.set(sec.symbol, sec.id);
      }
    }

    // Re-subscribe with new symbol list
    this.sendMessage({
      service: 'LEVELONE_EQUITIES',
      requestid: String(this.nextRequestId()),
      command: 'SUBS',
      SchwabClientCustomerId: this.streamerCustomerId,
      SchwabClientCorrelId: this.streamerCorrelId,
      parameters: {
        keys: this.subscribedSymbols.join(','),
        fields: SUBSCRIBE_FIELDS,
      },
    });
  }

  getLatestQuotes(): StreamingQuote[] {
    return Array.from(this.latestQuotes.values());
  }

  getStatus(): StreamingState {
    return {
      status: this.status,
      subscribedCount: this.subscribedSymbols.length,
      connectedSince: this.connectedSince,
      error: this.status === 'error' ? `Failed after ${this.consecutiveFailures} retries` : undefined,
    };
  }

  // --- Message handling ---

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      // Handle login/subscription responses
      if (msg.response) {
        for (const resp of msg.response) {
          this.handleResponse(resp);
        }
      }

      // Handle data pushes
      if (msg.data) {
        for (const d of msg.data) {
          if (d.service === 'LEVELONE_EQUITIES' && d.content) {
            this.handleQuoteData(d.content, d.timestamp);
          }
        }
      }

      // Handle heartbeat/notify
      if (msg.notify) {
        // Heartbeat — no action needed
      }
    } catch (err) {
      console.error('Failed to parse streaming message:', err);
    }
  }

  private handleResponse(resp: Record<string, unknown>): void {
    const service = resp.service as string;
    const command = resp.command as string;
    const content = resp.content as Record<string, unknown> | undefined;
    const code = content?.code as number;

    if (service === 'ADMIN' && command === 'LOGIN') {
      if (code === 0) {
        console.log('Schwab streaming: LOGIN successful');
        this.consecutiveFailures = 0;
        this.reconnectDelay = 2000;
        this.connectedSince = Date.now();
        this.setStatus('connected');

        // Subscribe to equities
        this.sendMessage({
          service: 'LEVELONE_EQUITIES',
          requestid: String(this.nextRequestId()),
          command: 'SUBS',
          SchwabClientCustomerId: this.streamerCustomerId,
          SchwabClientCorrelId: this.streamerCorrelId,
          parameters: {
            keys: this.subscribedSymbols.join(','),
            fields: SUBSCRIBE_FIELDS,
          },
        });

        // Start snapshot timer and position sync
        this.startSnapshotTimer();
        this.startPositionSyncTimer();
      } else {
        console.error(`Schwab streaming LOGIN failed: code=${code}, msg=${content?.msg}`);
        this.ws?.close();
        this.setStatus('error');
      }
    } else if (service === 'LEVELONE_EQUITIES' && command === 'SUBS') {
      if (code === 0) {
        console.log(`Schwab streaming: subscribed to ${this.subscribedSymbols.length} symbols`);
      } else {
        console.error(`Schwab streaming SUBS failed: code=${code}, msg=${content?.msg}`);
      }
    }
  }

  private handleQuoteData(content: Array<Record<string, unknown>>, timestamp?: number): void {
    const mainWindow = this.getMainWindow();

    for (const item of content) {
      const symbol = item.key as string;
      if (!symbol) continue;

      const quote: StreamingQuote = {
        symbol,
        last: 0,
        timestamp: timestamp || Date.now(),
      };

      // Map numeric field keys to named properties
      for (const [fieldNum, fieldName] of Object.entries(EQUITY_FIELDS)) {
        const value = item[fieldNum];
        if (value !== undefined && typeof value === 'number') {
          (quote as unknown as Record<string, unknown>)[fieldName] = value;
        }
      }

      // Only emit if we have a last price
      if (quote.last === 0 && item['3'] === undefined) continue;

      this.latestQuotes.set(symbol, quote);
      logger.debug(`[quotes:stream] ${symbol} $${quote.last.toFixed(2)} vol=${quote.volume ?? '-'}`);

      // Check monitors for this symbol
      if (this.db && quote.last > 0) {
        try {
          const triggered = this.db.checkMonitors(symbol, quote.last);
          for (const monitor of triggered) {
            const icon = monitor.direction === 'below' ? '⬇️' : '⬆️';
            const notification = new Notification({
              title: `${monitor.actionType === 'action_required' ? '⚠️ ' : ''}Monitor Alert: ${symbol}`,
              body: `${icon} ${symbol} $${quote.last.toFixed(2)} crossed ${monitor.direction} $${monitor.priceLevel} — ${monitor.label}`,
            });
            notification.show();

            // Also notify renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('monitor:triggered', monitor);
            }
          }
        } catch (e) {
          console.error('Monitor check error:', e);
        }
      }

      // Push to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('streaming:quote', quote);
      }
    }
  }

  // --- Snapshots ---

  private startSnapshotTimer(): void {
    this.clearSnapshotTimer();
    this.snapshotTimer = setInterval(() => {
      this.saveSnapshots();
    }, SNAPSHOT_INTERVAL_MS);
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private saveSnapshots(): void {
    if (this.latestQuotes.size === 0) return;

    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    const priceHistory: Omit<PriceHistory, 'id'>[] = [];

    for (const [symbol, quote] of this.latestQuotes) {
      const securityId = this.symbolSecurityMap.get(symbol);
      if (!securityId) continue;

      priceHistory.push({
        securityId,
        date: today,
        openPrice: quote.open,
        highPrice: quote.high,
        lowPrice: quote.low,
        closePrice: quote.last,
        volume: quote.volume,
        fetchedAt: now,
      });
    }

    if (priceHistory.length > 0) {
      try {
        this.db.savePriceHistoryBatch(priceHistory);
        console.log(`Schwab streaming: saved ${priceHistory.length} price snapshots`);
      } catch (err) {
        console.error('Failed to save streaming snapshots:', err);
      }
    }
  }

  // --- Position Sync ---

  private startPositionSyncTimer(): void {
    this.clearPositionSyncTimer();
    // Sync immediately on connect, then every 5 minutes
    this.syncPositions();
    this.positionSyncTimer = setInterval(() => {
      this.syncPositions();
    }, POSITION_SYNC_INTERVAL_MS);
  }

  private clearPositionSyncTimer(): void {
    if (this.positionSyncTimer) {
      clearInterval(this.positionSyncTimer);
      this.positionSyncTimer = null;
    }
  }

  private async syncPositions(): Promise<void> {
    try {
      const result = await this.schwabService.syncPositions(this.db);
      if (result.success) {
        console.log(`Position sync: ${result.positionsSynced} positions across ${result.accountsSynced} accounts`);
        // Notify renderer to refresh its data
        const mainWindow = this.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('positions:synced', {
            positionsSynced: result.positionsSynced,
            accountsSynced: result.accountsSynced,
          });
        }
      } else {
        console.error('Position sync failed:', result.errors);
      }
    } catch (err) {
      console.error('Position sync error:', err);
    }
  }

  // --- Reconnection ---

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    this.consecutiveFailures++;
    if (this.consecutiveFailures > MAX_RECONNECT_FAILURES) {
      console.error(`Schwab streaming: giving up after ${MAX_RECONNECT_FAILURES} failures`);
      this.setStatus('error');
      return;
    }

    console.log(`Schwab streaming: reconnecting in ${this.reconnectDelay}ms (attempt ${this.consecutiveFailures})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWithPortfolioSymbols();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // --- Utilities ---

  private setStatus(status: StreamingStatus): void {
    this.status = status;
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('streaming:status', status);
    }
  }

  private sendMessage(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private nextRequestId(): number {
    return this.requestId++;
  }

  destroy(): void {
    this.stopMarketHoursScheduler();
    this.disconnect();
  }
}
