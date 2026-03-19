import { BrowserWindow } from 'electron';
import Store from 'electron-store';
import { exec } from 'child_process';
import { Database } from './database';
import { FMPService } from './fmp-service';
import { SchwabService } from './schwab-service';
import {
  AppSettings,
  TaskRunRecord,
  TaskStatus,
  SchedulerStatus,
  SchedulerHeartbeat,
  TaskResult,
} from '../shared/types';

function sendNtfyNotification(title: string, message: string, priority: string = 'default') {
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const confPath = path.join(os.homedir(), '.pm-cli.conf');
    if (!fs.existsSync(confPath)) return;
    const content = fs.readFileSync(confPath, 'utf-8');
    const match = content.match(/^NTFY_TOPIC=(.+)$/m);
    const topic = match ? match[1].trim() : null;
    if (!topic) return;
    const safeTitle = title.replace(/"/g, '\\"');
    const safeMessage = message.replace(/"/g, '\\"');
    exec(`curl -s -H "Title: ${safeTitle}" -H "Priority: ${priority}" -d "${safeMessage}" "ntfy.sh/${topic}"`, (err) => {
      if (err) console.error('ntfy notification failed:', err);
    });
  } catch {
    // Graceful no-op if config unreadable
  }
}

interface TaskDefinition {
  id: string;
  name: string;
  schedule: TaskSchedule;
  execute: () => Promise<TaskResult>;
  enabled: boolean;
}

interface TaskSchedule {
  type: 'after_market_close' | 'daily' | 'interval';
  afterMarketDelayMinutes?: number;
  dailyHourET?: number;
  intervalMs?: number;
  wakingHoursOnly?: boolean;
}

const CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds

export class SchedulerService {
  private db: Database;
  private fmpService: FMPService;
  private schwabService: SchwabService;
  private store: Store<{ settings: AppSettings }>;
  private getMainWindow: () => BrowserWindow | null;

  private tasks: TaskDefinition[] = [];
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private startedAt: string | null = null;
  private lastTick = 0;
  private runningTasks = new Set<string>();
  private retryScheduled = new Set<string>();

  constructor(
    db: Database,
    fmpService: FMPService,
    schwabService: SchwabService,
    store: Store<{ settings: AppSettings }>,
    getMainWindow: () => BrowserWindow | null
  ) {
    this.db = db;
    this.fmpService = fmpService;
    this.schwabService = schwabService;
    this.store = store;
    this.getMainWindow = getMainWindow;

    this.registerTasks();
  }

  private registerTasks(): void {
    this.tasks = [
      {
        id: 'eod-backfill',
        name: 'Price Backfill',
        schedule: { type: 'after_market_close', afterMarketDelayMinutes: 5 },
        execute: () => this.executeBackfill(),
        enabled: true,
      },
      {
        id: 'eod-snapshot',
        name: 'Portfolio Snapshot',
        schedule: { type: 'after_market_close', afterMarketDelayMinutes: 15 },
        execute: () => this.executeSnapshot(),
        enabled: true,
      },
      {
        id: 'eod-levels',
        name: 'S/R Level Refresh',
        schedule: { type: 'after_market_close', afterMarketDelayMinutes: 20 },
        execute: () => this.executeLevelsRefresh(),
        enabled: true,
      },
      {
        id: 'eod-sectors',
        name: 'Sector Performance',
        schedule: { type: 'after_market_close', afterMarketDelayMinutes: 30 },
        execute: () => this.executeSectorPerformance(),
        enabled: true,
      },
      {
        id: 'daily-earnings',
        name: 'Earnings Calendar',
        schedule: { type: 'daily', dailyHourET: 7 },
        execute: () => this.executeEarnings(),
        enabled: true,
      },
      {
        id: 'daily-valuations',
        name: 'Valuation Metrics',
        schedule: { type: 'daily', dailyHourET: 7 },
        execute: () => this.executeValuations(),
        enabled: true,
      },
      {
        id: 'daily-news',
        name: 'News Refresh',
        schedule: { type: 'interval', intervalMs: 10 * 60 * 1000, wakingHoursOnly: true },
        execute: () => this.executeNews(),
        enabled: true,
      },
      {
        id: 'ems-date-check',
        name: 'EMS Date Trigger Check',
        schedule: { type: 'daily', dailyHourET: 10 },
        execute: () => this.executeEmsDateCheck(),
        enabled: true,
      },
      {
        id: 'ems-eod-reconcile',
        name: 'EMS EOD Reconcile',
        schedule: { type: 'after_market_close', afterMarketDelayMinutes: 30 },
        execute: () => this.executeEmsEodReconcile(),
        enabled: true,
      },
    ];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.lastTick = Date.now();

    console.log('Scheduler: started');

    // Check immediately for catch-up
    this.checkTasks();

    // Start periodic check
    this.checkTimer = setInterval(() => {
      this.checkTasks();
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    console.log('Scheduler: stopped');
  }

  destroy(): void {
    this.stop();
  }

  getStatus(): SchedulerStatus {
    return {
      running: this.running,
      startedAt: this.startedAt || '',
      lastTick: this.lastTick,
      tasks: this.tasks.map(t => this.getTaskStatus(t)),
    };
  }

  getHeartbeat(): SchedulerHeartbeat {
    return {
      alive: this.running && (Date.now() - this.lastTick) < CHECK_INTERVAL_MS * 3,
      lastTick: this.lastTick,
      uptime: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : 0,
    };
  }

  async runTaskNow(taskId: string): Promise<TaskResult> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return { success: false, message: `Unknown task: ${taskId}` };
    return this.runTask(task);
  }

  enableTask(taskId: string): void {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) task.enabled = true;
  }

  disableTask(taskId: string): void {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) task.enabled = false;
  }

  getTaskHistory(taskId: string, limit?: number): TaskRunRecord[] {
    return this.db.getTaskRunHistory(taskId, limit);
  }

  // --- Time helpers ---

  private getETTime(): { weekday: string; hour: number; minute: number; timeInMinutes: number } {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'short',
    });

    const parts = formatter.formatToParts(now);
    const weekday = parts.find(p => p.type === 'weekday')?.value || '';
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

    return { weekday, hour, minute, timeInMinutes: hour * 60 + minute };
  }

  private isWeekday(): boolean {
    const { weekday } = this.getETTime();
    return !['Sat', 'Sun'].includes(weekday);
  }

  private isMarketClosed(): boolean {
    const { timeInMinutes } = this.getETTime();
    return timeInMinutes >= 16 * 60; // After 4pm ET
  }

  private isWakingHours(): boolean {
    const { hour } = this.getETTime();
    return hour >= 7 || hour < 1;
  }

  // --- Task scheduling logic ---

  private getTaskStatus(task: TaskDefinition): TaskStatus {
    const lastRun = this.db.getLastTaskRun(task.id);
    return {
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      schedule: this.describeSchedule(task.schedule),
      lastRun: lastRun || undefined,
      nextRunAt: this.computeNextRun(task),
      isRunning: this.runningTasks.has(task.id),
    };
  }

  private describeSchedule(schedule: TaskSchedule): string {
    switch (schedule.type) {
      case 'after_market_close':
        return `After market close +${schedule.afterMarketDelayMinutes}min`;
      case 'daily':
        return `Daily at ${schedule.dailyHourET}:00 ET`;
      case 'interval': {
        const ms = schedule.intervalMs || 0;
        const label = ms >= 3600000 ? `${ms / 3600000}h` : `${ms / 60000}min`;
        return `Every ${label}${schedule.wakingHoursOnly ? ' (waking hours)' : ''}`;
      }
    }
  }

  private computeNextRun(task: TaskDefinition): string | undefined {
    if (!task.enabled) return undefined;
    // Simple approximation — not worth full cron math
    const lastRun = this.db.getLastTaskRun(task.id);
    if (task.schedule.type === 'interval' && lastRun?.completedAt) {
      const nextMs = new Date(lastRun.completedAt).getTime() + (task.schedule.intervalMs || 0);
      return new Date(nextMs).toISOString();
    }
    return undefined; // EOD/daily tasks: "next trading day"
  }

  private shouldRunTask(task: TaskDefinition): boolean {
    if (!task.enabled || this.runningTasks.has(task.id)) return false;

    const { schedule } = task;

    switch (schedule.type) {
      case 'after_market_close': {
        if (!this.isWeekday()) return false;
        if (!this.isMarketClosed()) return false;
        if (this.db.didTaskRunToday(task.id)) return false;
        // Check if enough time has passed since market close (4pm ET)
        const { timeInMinutes } = this.getETTime();
        const runAfter = 16 * 60 + (schedule.afterMarketDelayMinutes || 0);
        return timeInMinutes >= runAfter;
      }

      case 'daily': {
        if (this.db.didTaskRunToday(task.id)) return false;
        const { hour } = this.getETTime();
        return hour >= (schedule.dailyHourET || 0);
      }

      case 'interval': {
        if (schedule.wakingHoursOnly && !this.isWakingHours()) return false;
        const lastRun = this.db.getLastTaskRun(task.id);
        if (!lastRun?.completedAt) return true; // Never run
        const elapsed = Date.now() - new Date(lastRun.completedAt).getTime();
        return elapsed >= (schedule.intervalMs || 0);
      }
    }
  }

  private async checkTasks(): Promise<void> {
    this.lastTick = Date.now();

    for (const task of this.tasks) {
      if (this.shouldRunTask(task)) {
        const result = await this.runTask(task);

        // Retry once after 5 minutes for EOD/daily tasks on failure
        if (!result.success && task.schedule.type !== 'interval' && !this.retryScheduled.has(task.id)) {
          this.retryScheduled.add(task.id);
          console.log(`Scheduler: will retry ${task.id} in 5 minutes`);
          setTimeout(async () => {
            this.retryScheduled.delete(task.id);
            // Only retry if it still hasn't succeeded today
            if (!this.db.didTaskRunToday(task.id)) {
              console.log(`Scheduler: retrying ${task.id}`);
              await this.runTask(task);
            }
          }, 5 * 60 * 1000);
        }
      }
    }
  }

  private async runTask(task: TaskDefinition): Promise<TaskResult> {
    if (this.runningTasks.has(task.id)) {
      return { success: false, message: `${task.name} is already running` };
    }

    this.runningTasks.add(task.id);
    const runId = this.db.recordTaskStart(task.id);
    this.notifyRenderer('scheduler:task-started', { taskId: task.id, startedAt: new Date().toISOString() });

    console.log(`Scheduler: running ${task.id}`);

    try {
      // 5-minute timeout
      const result = await Promise.race([
        task.execute(),
        new Promise<TaskResult>((_, reject) =>
          setTimeout(() => reject(new Error('Task timed out after 5 minutes')), 5 * 60 * 1000)
        ),
      ]);

      this.db.recordTaskComplete(runId, result.success ? 'success' : 'failure', result.message, result.success ? undefined : result.message);
      console.log(`Scheduler: ${task.id} completed — ${result.success ? 'success' : 'failure'}: ${result.message}`);
      this.notifyRenderer('scheduler:task-completed', { taskId: task.id, status: result.success ? 'success' : 'failure', result: result.message });
      this.runningTasks.delete(task.id);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.db.recordTaskComplete(runId, 'failure', undefined, errorMsg);
      console.error(`Scheduler: ${task.id} failed:`, errorMsg);
      this.notifyRenderer('scheduler:task-completed', { taskId: task.id, status: 'failure', result: errorMsg });
      this.runningTasks.delete(task.id);
      return { success: false, message: errorMsg };
    }
  }

  private notifyRenderer(channel: string, data: unknown): void {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  // --- Task implementations ---

  private async executeBackfill(): Promise<TaskResult> {
    const settings = this.store.get('settings');
    const positions = this.db.listPositions();
    const securities = this.db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    const symbolSecurityMap = new Map<string, string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash') {
        symbolSecurityMap.set(security.symbol, security.id);
      }
    }

    if (symbolSecurityMap.size === 0) {
      return { success: true, message: 'No positions to backfill' };
    }

    const days = 5; // Last 5 trading days

    let priceHistory: Omit<import('../shared/types').PriceHistory, 'id'>[] = [];
    let errors: string[] = [];

    if (settings.dataProvider === 'schwab' && this.schwabService.isConnected()) {
      const result = await this.schwabService.fetchHistoricalForAll(symbolSecurityMap, days);
      priceHistory = result.priceHistory;
      errors = result.errors;
    } else if (settings.dataProvider === 'fmp' && this.fmpService.isConfigured()) {
      const result = await this.fmpService.fetchHistoricalForAll(symbolSecurityMap, days);
      priceHistory = result.priceHistory;
      errors = result.errors;
    } else {
      return { success: false, message: 'No data provider configured' };
    }

    const saved = priceHistory.length > 0 ? this.db.savePriceHistoryBatch(priceHistory) : 0;
    return {
      success: errors.length === 0,
      message: `Backfilled ${saved} candles for ${symbolSecurityMap.size} symbols${errors.length > 0 ? `, ${errors.length} errors` : ''}`,
    };
  }

  private async executeSnapshot(): Promise<TaskResult> {
    try {
      const result = this.db.takeEodSnapshot();
      return {
        success: true,
        message: `Snapshot: ${result.count} positions, MV $${result.totalMV.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeLevelsRefresh(): Promise<TaskResult> {
    try {
      this.db.refreshPriceLevels();
      return { success: true, message: 'S/R levels refreshed for all symbols' };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeSectorPerformance(): Promise<TaskResult> {
    try {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const confPath = path.join(os.homedir(), '.pm-cli.conf');
      const content = fs.readFileSync(confPath, 'utf-8');
      const match = content.match(/^FMP_API_KEY=(.+)$/m);
      const apiKey = match ? match[1].trim() : null;
      if (!apiKey) return { success: false, message: 'No FMP API key configured' };

      const today = new Date().toISOString().split('T')[0];
      const resp = await fetch(
        `https://financialmodelingprep.com/stable/sector-performance-snapshot?date=${today}&exchange=NYSE&apikey=${apiKey}`
      );
      const data = await resp.json();
      const count = Array.isArray(data) ? data.length : 0;
      return { success: true, message: `Fetched ${count} sectors for ${today}` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private getPortfolioAndWatchlistSymbols(): string[] {
    const positions = this.db.listPositions();
    const securities = this.db.listSecurities();
    const securityMap = new Map(securities.map(s => [s.id, s]));

    const symbolSet = new Set<string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (security && security.type !== 'cash') {
        symbolSet.add(security.symbol);
      }
    }

    try {
      const watchlistItems = this.db.listWatchlistItems();
      for (const item of watchlistItems) {
        symbolSet.add(item.symbol);
      }
    } catch {
      // Watchlist table may not exist yet
    }

    return Array.from(symbolSet);
  }

  private async executeEarnings(): Promise<TaskResult> {
    try {
      const symbols = this.getPortfolioAndWatchlistSymbols();

      if (symbols.length === 0) {
        return { success: true, message: 'No symbols for earnings check' };
      }

      const today = new Date();
      const twoWeeksOut = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
      const fromDate = today.toISOString().split('T')[0];
      const toDate = twoWeeksOut.toISOString().split('T')[0];

      const earnings = await this.fmpService.getEarningsForSymbols(symbols, fromDate, toDate);
      if (earnings.length > 0) {
        this.db.syncEarningsMonitors(earnings);
      }
      return { success: true, message: `Found ${earnings.length} upcoming earnings events` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeValuations(): Promise<TaskResult> {
    try {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const confPath = path.join(os.homedir(), '.pm-cli.conf');
      const content = fs.readFileSync(confPath, 'utf-8');
      const match = content.match(/^FMP_API_KEY=(.+)$/m);
      const apiKey = match ? match[1].trim() : null;
      if (!apiKey) return { success: false, message: 'No FMP API key configured' };

      const symbols = this.getPortfolioAndWatchlistSymbols();
      if (symbols.length === 0) return { success: true, message: 'No symbols for valuations' };

      const today = new Date().toISOString().split('T')[0];
      let count = 0;

      // ADR detection cache
      const adrCache = new Map<string, boolean>();
      const checkAdr = async (sym: string): Promise<boolean> => {
        if (adrCache.has(sym)) return adrCache.get(sym)!;
        try {
          const resp = await fetch(
            `https://financialmodelingprep.com/stable/profile?symbol=${sym}&apikey=${apiKey}`
          );
          const data = resp.ok ? await resp.json() : [];
          const isAdr = Array.isArray(data) && data.length > 0 && !!(data[0] as any).isAdr;
          adrCache.set(sym, isAdr);
          return isAdr;
        } catch {
          adrCache.set(sym, false);
          return false;
        }
      };

      for (const symbol of symbols) {
        try {
          const isAdr = await checkAdr(symbol);
          const price = this.db.getLatestPriceBySymbol(symbol);
          if (!price) continue;

          // Fetch ratios TTM (reliable for ADRs — computed from USD price)
          const ratiosResp = await fetch(
            `https://financialmodelingprep.com/stable/ratios-ttm?symbol=${symbol}&apikey=${apiKey}`
          );
          const ratios = ratiosResp.ok ? await ratiosResp.json() : [];
          const r = Array.isArray(ratios) && ratios.length > 0 ? (ratios as any[])[0] : {} as any;

          const t12Pe = r.priceToEarningsRatioTTM || 0;
          const peg = r.priceToEarningsGrowthRatioTTM || 0;
          const fwdPeg = r.forwardPriceToEarningsGrowthRatioTTM || 0;
          const ps = r.priceToSalesRatioTTM || 0;
          const t12Eps = t12Pe > 0 ? price / t12Pe : null;

          // Fetch analyst estimates — skip forward PE for ADRs (EPS in local currency)
          const estResp = await fetch(
            `https://financialmodelingprep.com/stable/analyst-estimates?symbol=${symbol}&period=annual&limit=8&apikey=${apiKey}`
          );
          const estimates = estResp.ok ? await estResp.json() : [];
          const sorted = Array.isArray(estimates) ? (estimates as any[]).sort((a: any, b: any) => a.date.localeCompare(b.date)) : [];
          const future = sorted.filter((e: any) => e.date > today && e.epsAvg > 0);

          let fwdEps: number | null = null, fwdPe: number | null = null, fwdFyEnd: string | null = null;
          let nextEps: number | null = null, nextFyEnd: string | null = null;
          let epsGrowth: number | null = null, numAnalysts: number | null = null;

          if (future.length >= 1) {
            fwdFyEnd = future[0].date.substring(0, 10);
            numAnalysts = future[0].numAnalystsEps || 0;
            if (!isAdr) {
              fwdEps = future[0].epsAvg;
              fwdPe = price / fwdEps!;
            }
          }
          if (future.length >= 2) {
            // EPS growth % valid for ADRs (same currency cancels)
            epsGrowth = (future[1].epsAvg - future[0].epsAvg) / future[0].epsAvg * 100;
            if (!isAdr) {
              nextEps = future[1].epsAvg;
              nextFyEnd = future[1].date.substring(0, 10);
            }
          }

          // Fair price range
          let fairLow: number | null = null, fairMid: number | null = null, fairHigh: number | null = null;
          if (isAdr && t12Pe > 0 && t12Eps) {
            // ADR: use trailing PE (USD-based)
            if (t12Pe > 30) {
              fairLow = t12Eps * t12Pe * 0.75;
              fairMid = t12Eps * t12Pe * 0.90;
              fairHigh = t12Eps * t12Pe * 1.10;
            } else {
              fairLow = t12Eps * t12Pe * 0.85;
              fairMid = t12Eps * t12Pe * 1.0;
              fairHigh = t12Eps * t12Pe * 1.15;
            }
          } else if (fwdEps && fwdPe) {
            if (fwdPe > 30) {
              fairLow = fwdEps * fwdPe * 0.75;
              fairMid = fwdEps * fwdPe * 0.90;
              fairHigh = fwdEps * fwdPe * 1.10;
            } else {
              fairLow = fwdEps * fwdPe * 0.85;
              fairMid = fwdEps * fwdPe * 1.0;
              fairHigh = fwdEps * fwdPe * 1.15;
            }
            if (epsGrowth && epsGrowth > 0) {
              const peg1Price = fwdEps * epsGrowth;
              if (peg1Price > fairHigh) fairHigh = peg1Price;
            }
          }

          // PEG rating
          let pegRating: string | null = null;
          if (fwdPeg > 0) {
            if (fwdPeg < 0.8) pegRating = 'CHEAP';
            else if (fwdPeg < 1.2) pegRating = 'FAIR';
            else if (fwdPeg < 2.0) pegRating = 'RICH';
            else pegRating = 'PRICEY';
          }

          this.db.saveValuationMetric({
            symbol, date: today, trailingPe: t12Pe, forwardPe: fwdPe, peg, forwardPeg: fwdPeg,
            psRatio: ps, trailingEps: t12Eps, forwardEps: fwdEps, forwardEpsFyEnd: fwdFyEnd,
            nextEps, nextEpsFyEnd: nextFyEnd, epsGrowthPct: epsGrowth, numAnalysts,
            fairLow, fairMid, fairHigh, pegRating,
          });
          count++;
        } catch {
          // Skip failed symbols
        }
      }

      return { success: true, message: `Updated ${count} valuations` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeNews(): Promise<TaskResult> {
    try {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const confPath = path.join(os.homedir(), '.pm-cli.conf');
      const content = fs.readFileSync(confPath, 'utf-8');
      const match = content.match(/^FMP_API_KEY=(.+)$/m);
      const apiKey = match ? match[1].trim() : null;
      if (!apiKey) return { success: false, message: 'No FMP API key configured' };

      // Get portfolio + watchlist symbols
      const symbols = this.getPortfolioAndWatchlistSymbols();

      if (symbols.length === 0) {
        return { success: true, message: 'No symbols for news fetch' };
      }

      // Fetch news for portfolio symbols (batch of 10 at a time)
      let totalArticles = 0;
      for (let i = 0; i < symbols.length; i += 10) {
        const batch = symbols.slice(i, i + 10).join(',');
        const resp = await fetch(
          `https://financialmodelingprep.com/stable/news?tickers=${batch}&limit=5&apikey=${apiKey}`
        );
        const data = await resp.json();
        if (Array.isArray(data)) totalArticles += data.length;
      }

      return { success: true, message: `Fetched ${totalArticles} news articles` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeEmsDateCheck(): Promise<TaskResult> {
    try {
      const pending = this.db.getDateTriggeredPending();
      if (pending.length === 0) {
        return { success: true, message: 'No date-triggered tranches due' };
      }

      for (const tranche of pending) {
        this.db.triggerTranche(tranche.id);
      }

      this.notifyRenderer('ems:tranches-triggered', { count: pending.length });
      sendNtfyNotification('EMS Orders Triggered', `${pending.length} order${pending.length > 1 ? 's' : ''} ready for confirmation`, 'high');

      return {
        success: true,
        message: `Triggered ${pending.length} date-based tranche${pending.length > 1 ? 's' : ''}`,
      };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeEmsEodReconcile(): Promise<TaskResult> {
    try {
      const submitted = this.db.getSubmittedTranches();
      if (submitted.length === 0) {
        return { success: true, message: 'No submitted tranches to reconcile' };
      }

      if (!this.schwabService.isConnected()) {
        return { success: false, message: 'Schwab service not connected' };
      }

      // Fetch all orders from Schwab
      const orders = await this.schwabService.getOrdersForAllAccounts();
      const orderMap = new Map(orders.map(o => [o.orderId, o]));

      let filled = 0;
      let expired = 0;
      let skipped = 0;

      for (const tranche of submitted) {
        if (!tranche.brokerageOrderId) {
          skipped++;
          continue;
        }

        const order = orderMap.get(tranche.brokerageOrderId);
        if (!order) {
          // Order not found — may be GTC from a previous day, skip
          skipped++;
          continue;
        }

        const status = order.status.toUpperCase();
        if (status === 'FILLED') {
          this.db.fillTranche(tranche.id, {
            filledQty: order.filledQuantity,
            filledPrice: order.price || tranche.limitPrice || tranche.triggerPrice,
            brokerageOrderStatus: 'FILLED',
          });
          filled++;
        } else if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(status)) {
          this.db.expireTranche(tranche.id);
          expired++;
        } else {
          // WORKING or other active status — leave as-is
          skipped++;
        }
      }

      const summary = `Reconciled ${submitted.length} tranches: ${filled} filled, ${expired} expired/canceled, ${skipped} skipped`;
      this.notifyRenderer('ems:reconcile-complete', { filled, expired, skipped, total: submitted.length });
      sendNtfyNotification('EMS EOD Reconcile', `${filled} filled, ${expired} expired`, 'default');

      return { success: true, message: summary };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
