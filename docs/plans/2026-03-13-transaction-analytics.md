# Transaction Analytics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Live-query transaction analytics showing win/loss rates by hold period, regime at entry, and entry style — rendered as a new tab on the existing Analytics page.

**Architecture:** A `TransactionAnalyticsService` in the main process computes closed trades from the `transactions` table using FIFO matching (no new DB tables). Results are exposed via IPC to a new "Trade Performance" tab on the Analytics page. CLI command provides the same data.

**Tech Stack:** TypeScript, better-sqlite3 (synchronous), React, Tailwind CSS, Electron IPC

**Key constraint:** The `tax_lots` table is empty. All closed-trade data must be derived from `transactions` (443 buys, 567 sells). FIFO matching is computed on-demand — with ~1K transactions this is instant.

---

### Task 1: Types and FIFO Closed Trade Computation

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/database.ts`

**Context:** The `transactions` table has buy/sell records with `account_id`, `security_id`, `date`, `quantity`, `price`, `amount`. We need to compute closed trades by walking through chronologically per (account, security) and matching sells to buys using FIFO.

**Step 1: Add types to `src/shared/types.ts`**

Add at the end of the file, before any closing braces:

```typescript
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
  holdBucket: 'short' | 'medium' | 'long'; // <30d, 30-90d, 90d+
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
  profitFactor: number; // gross wins / gross losses
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
}
```

**Step 2: Add `getClosedTrades()` method to `src/main/database.ts`**

Add this method to the `Database` class. It queries all buy/sell transactions, groups by (account_id, security_id), and applies FIFO matching.

```typescript
getClosedTrades(): ClosedTrade[] {
  if (!this.db) throw new Error('Database not initialized');

  // Get all buy/sell transactions ordered by date, with symbol
  const rows = this.db.prepare(`
    SELECT t.account_id, t.security_id, s.symbol, t.type, t.date, t.quantity, t.price
    FROM transactions t
    JOIN securities s ON t.security_id = s.id
    WHERE t.type IN ('buy', 'sell')
    ORDER BY t.date ASC, t.type ASC
  `).all() as Array<{
    account_id: string; security_id: string; symbol: string;
    type: string; date: string; quantity: number; price: number;
  }>;

  // Group by (account_id, security_id)
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.account_id}:${row.security_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const closedTrades: ClosedTrade[] = [];

  for (const txns of groups.values()) {
    // FIFO queue of buy lots: { date, price, remaining }
    const buyQueue: Array<{ date: string; price: number; remaining: number }> = [];

    for (const txn of txns) {
      if (txn.type === 'buy') {
        buyQueue.push({ date: txn.date, price: txn.price, remaining: txn.quantity });
      } else if (txn.type === 'sell') {
        let sellRemaining = txn.quantity;
        while (sellRemaining > 0 && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(sellRemaining, lot.remaining);

          const costBasis = matched * lot.price;
          const proceeds = matched * txn.price;
          const realizedGain = proceeds - costBasis;
          const buyDate = new Date(lot.date);
          const sellDate = new Date(txn.date);
          const holdDays = Math.max(0, Math.round((sellDate.getTime() - buyDate.getTime()) / 86400000));

          closedTrades.push({
            symbol: txn.symbol,
            securityId: txn.security_id,
            accountId: txn.account_id,
            buyDate: lot.date,
            sellDate: txn.date,
            quantity: matched,
            buyPrice: lot.price,
            sellPrice: txn.price,
            costBasis,
            proceeds,
            realizedGain,
            realizedGainPct: costBasis > 0 ? (realizedGain / costBasis) * 100 : 0,
            holdDays,
            holdBucket: holdDays < 30 ? 'short' : holdDays < 90 ? 'medium' : 'long',
            isWin: realizedGain > 0,
          });

          lot.remaining -= matched;
          sellRemaining -= matched;
          if (lot.remaining <= 0) buyQueue.shift();
        }
        // If sellRemaining > 0, there were sells without matching buys (e.g., transfers in).
        // Skip these — can't compute cost basis.
      }
    }
  }

  return closedTrades;
}
```

Import `ClosedTrade` from `../../shared/types` at the top of database.ts (add to existing import line).

**Step 3: Verify it compiles**

Run: `npm run build:main`
Expected: Clean compile

**Step 4: Commit**

```bash
git add src/shared/types.ts src/main/database.ts
git commit -m "feat: add closed trade FIFO computation and analytics types"
```

---

### Task 2: TransactionAnalyticsService

**Files:**
- Create: `src/main/transaction-analytics-service.ts`

**Context:** This service wraps `Database.getClosedTrades()` and computes all analytics. It also joins to `daily_rituals` (for regime at entry) and `position_intents` (for entry style). Read `src/main/database.ts` for the Database class API. Read `src/shared/types.ts` for the type definitions added in Task 1.

**Step 1: Create the service**

Create `src/main/transaction-analytics-service.ts`:

```typescript
import type { Database } from './database';
import type {
  ClosedTrade,
  TradeAnalytics,
  TradeAnalyticsSummary,
  TradeBreakdown,
} from '../shared/types';

export class TransactionAnalyticsService {
  constructor(private db: Database) {}

  getTradeAnalytics(): TradeAnalytics {
    const trades = this.db.getClosedTrades();

    return {
      summary: this.computeSummary(trades),
      byHoldPeriod: this.breakdownByHoldPeriod(trades),
      byRegimeAtEntry: this.breakdownByRegimeAtEntry(trades),
      byEntryStyle: this.breakdownByEntryStyle(trades),
      topWinners: [...trades].sort((a, b) => b.realizedGain - a.realizedGain).slice(0, 5),
      topLosers: [...trades].sort((a, b) => a.realizedGain - b.realizedGain).slice(0, 5),
    };
  }

  private computeSummary(trades: ClosedTrade[]): TradeAnalyticsSummary {
    if (trades.length === 0) {
      return {
        totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        totalRealizedGain: 0, avgWin: 0, avgLoss: 0,
        largestWin: 0, largestLoss: 0, profitFactor: 0,
      };
    }

    const wins = trades.filter(t => t.isWin);
    const losses = trades.filter(t => !t.isWin);
    const totalGain = trades.reduce((s, t) => s + t.realizedGain, 0);
    const grossWins = wins.reduce((s, t) => s + t.realizedGain, 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + t.realizedGain, 0));

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalRealizedGain: totalGain,
      avgWin: wins.length > 0 ? grossWins / wins.length : 0,
      avgLoss: losses.length > 0 ? -grossLosses / losses.length : 0,
      largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.realizedGain)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.realizedGain)) : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
    };
  }

  private buildBreakdown(label: string, trades: ClosedTrade[]): TradeBreakdown {
    const wins = trades.filter(t => t.isWin);
    return {
      label,
      count: trades.length,
      wins: wins.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      avgGain: trades.length > 0 ? trades.reduce((s, t) => s + t.realizedGain, 0) / trades.length : 0,
      totalGain: trades.reduce((s, t) => s + t.realizedGain, 0),
    };
  }

  private breakdownByHoldPeriod(trades: ClosedTrade[]): TradeBreakdown[] {
    const buckets: Record<string, ClosedTrade[]> = {
      'Short (<30d)': [],
      'Medium (30-90d)': [],
      'Long (90d+)': [],
    };

    for (const t of trades) {
      if (t.holdBucket === 'short') buckets['Short (<30d)'].push(t);
      else if (t.holdBucket === 'medium') buckets['Medium (30-90d)'].push(t);
      else buckets['Long (90d+)'].push(t);
    }

    return Object.entries(buckets).map(([label, group]) => this.buildBreakdown(label, group));
  }

  private breakdownByRegimeAtEntry(trades: ClosedTrade[]): TradeBreakdown[] {
    // Look up regime_type from daily_rituals for each trade's buy date
    const regimeMap = this.getRegimeMap();
    const buckets: Record<string, ClosedTrade[]> = {};

    for (const t of trades) {
      const regime = regimeMap.get(t.buyDate) || 'Unknown';
      if (!buckets[regime]) buckets[regime] = [];
      buckets[regime].push(t);
    }

    return Object.entries(buckets)
      .map(([label, group]) => this.buildBreakdown(label, group))
      .sort((a, b) => b.count - a.count);
  }

  private breakdownByEntryStyle(trades: ClosedTrade[]): TradeBreakdown[] {
    // Look up entry_style from position_intents via positions for each security
    const styleMap = this.getEntryStyleMap();
    const buckets: Record<string, ClosedTrade[]> = {};

    for (const t of trades) {
      const style = styleMap.get(t.securityId) || 'Unknown';
      if (!buckets[style]) buckets[style] = [];
      buckets[style].push(t);
    }

    return Object.entries(buckets)
      .map(([label, group]) => this.buildBreakdown(label, group))
      .sort((a, b) => b.count - a.count);
  }

  private getRegimeMap(): Map<string, string> {
    // Returns date -> regime_type for all rituals
    const rows = this.db.getRawDb().prepare(
      `SELECT date, regime_type FROM daily_rituals WHERE regime_type IS NOT NULL`
    ).all() as Array<{ date: string; regime_type: string }>;

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.date, row.regime_type);
    }
    return map;
  }

  private getEntryStyleMap(): Map<string, string> {
    // Returns security_id -> entry_style for all positions with intents
    const rows = this.db.getRawDb().prepare(`
      SELECT p.security_id, pi.entry_style
      FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      WHERE pi.entry_style IS NOT NULL
    `).all() as Array<{ security_id: string; entry_style: string }>;

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.security_id, row.entry_style);
    }
    return map;
  }
}
```

**Step 2: Add `getRawDb()` accessor to Database class**

The service needs raw DB access for custom queries. In `src/main/database.ts`, add this method to the Database class (near the top, after the constructor or after `initializeDatabase`):

```typescript
getRawDb(): BetterSqlite3.Database {
  if (!this.db) throw new Error('Database not initialized');
  return this.db;
}
```

Check if `this.db` is typed as `BetterSqlite3.Database` — if the import is `import Database from 'better-sqlite3'`, the type is `Database.Database`. Match the existing pattern in the file.

**Step 3: Verify it compiles**

Run: `npm run build:main`
Expected: Clean compile

**Step 4: Commit**

```bash
git add src/main/transaction-analytics-service.ts src/main/database.ts
git commit -m "feat: add TransactionAnalyticsService with FIFO analytics"
```

---

### Task 3: IPC, Preload, and React Hook

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/hooks/useApi.ts`

**Context:** Follow the same pattern as the existing analytics IPC. Read `src/main/ipc-handlers.ts` for the `setupIpcHandlers` function signature and existing handler patterns. Read `src/main/main.ts` to see how services are instantiated and passed. Read `src/main/preload.ts` for the contextBridge pattern. Read `src/renderer/hooks/useApi.ts` for the `useAnalytics` hook pattern.

**Step 1: Wire up IPC handler**

In `src/main/ipc-handlers.ts`:

1. Add `TransactionAnalyticsService` to the imports from `./transaction-analytics-service`
2. Add `transactionAnalyticsService?: TransactionAnalyticsService` parameter to `setupIpcHandlers()`
3. Add handler near the existing analytics handlers (~line 1108):

```typescript
ipcMain.handle('analytics:trade-performance', () => {
  if (!transactionAnalyticsService) return null;
  return transactionAnalyticsService.getTradeAnalytics();
});
```

**Step 2: Instantiate service in `src/main/main.ts`**

Read `src/main/main.ts` to find where `analyticsService` is created. Add nearby:

```typescript
import { TransactionAnalyticsService } from './transaction-analytics-service';
// ... after db is initialized:
const transactionAnalyticsService = new TransactionAnalyticsService(db);
```

Pass it to `setupIpcHandlers(... transactionAnalyticsService)`.

**Step 3: Expose in preload**

In `src/main/preload.ts`, add near the existing `getPortfolioAnalytics`:

```typescript
getTradeAnalytics: () => ipcRenderer.invoke('analytics:trade-performance'),
```

**Step 4: Add hook and type declaration in `src/renderer/hooks/useApi.ts`**

Add to the `Window.electronAPI` type declaration:

```typescript
getTradeAnalytics: () => Promise<TradeAnalytics | null>;
```

Add the import of `TradeAnalytics` from `../../shared/types`.

Add the hook (near `useAnalytics`):

```typescript
export function useTradeAnalytics() {
  const [data, setData] = useState<TradeAnalytics | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchTradeAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.getTradeAnalytics();
      setData(result);
    } finally {
      setLoading(false);
    }
  }, []);

  return { tradeAnalytics: data, loading, fetchTradeAnalytics };
}
```

**Step 5: Verify it compiles**

Run: `npm run build:main && npm run build:renderer`
Expected: Clean compile

**Step 6: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/main.ts src/main/preload.ts src/renderer/hooks/useApi.ts
git commit -m "feat: wire trade analytics IPC, preload, and React hook"
```

---

### Task 4: Analytics Page — Trade Performance Tab

**Files:**
- Modify: `src/renderer/pages/Analytics.tsx`

**Context:** The Analytics page currently has two tabs: "Portfolio" and "Transactions". Add a third tab: "Trade Performance". Read `src/renderer/pages/Analytics.tsx` to understand the existing tab structure and styling patterns.

**Step 1: Add the Trade Performance tab**

1. Import `useTradeAnalytics` from the hooks
2. Import `TradeAnalytics` type
3. Add `'trade-performance'` to the `activeTab` union type (line 74)
4. Add the tab button in the tab bar (line 152, in the `(['analytics', 'transactions'] as const).map(...)` — change to include `'trade-performance'` with label "Trade Performance")
5. Call the hook: `const { tradeAnalytics, loading: tpLoading, fetchTradeAnalytics } = useTradeAnalytics();`
6. Add useEffect to fetch when tab is active:
```typescript
useEffect(() => {
  if (activeTab === 'trade-performance') fetchTradeAnalytics();
}, [activeTab, fetchTradeAnalytics]);
```

7. Add the trade performance content as a new branch in the ternary (after the transactions tab content). The structure:

```tsx
{activeTab === 'trade-performance' && (
  <>
    {tpLoading ? (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    ) : !tradeAnalytics || tradeAnalytics.summary.totalTrades === 0 ? (
      <div className="card text-center py-12">
        <p className="text-gray-500">No closed trades found.</p>
        <p className="text-sm text-gray-400 mt-1">Analytics will appear once you have sell transactions matched to prior buys.</p>
      </div>
    ) : (
      <div className="space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="card">
            <p className="stat-label">Total Trades</p>
            <p className="stat-value">{tradeAnalytics.summary.totalTrades}</p>
          </div>
          <div className="card">
            <p className="stat-label">Win Rate</p>
            <p className={`stat-value ${tradeAnalytics.summary.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
              {tradeAnalytics.summary.winRate.toFixed(1)}%
            </p>
            <p className="text-xs text-gray-400 mt-1">{tradeAnalytics.summary.wins}W / {tradeAnalytics.summary.losses}L</p>
          </div>
          <div className="card">
            <p className="stat-label">Total P&L</p>
            <p className={`stat-value ${returnColor(tradeAnalytics.summary.totalRealizedGain)}`}>
              {formatCurrency(tradeAnalytics.summary.totalRealizedGain)}
            </p>
          </div>
          <div className="card">
            <p className="stat-label">Avg Win / Loss</p>
            <p className="stat-value text-green-600">{formatCurrency(tradeAnalytics.summary.avgWin)}</p>
            <p className="text-xs text-red-600 mt-1">{formatCurrency(tradeAnalytics.summary.avgLoss)}</p>
          </div>
          <div className="card">
            <p className="stat-label">Profit Factor</p>
            <p className={`stat-value ${tradeAnalytics.summary.profitFactor >= 1 ? 'text-green-600' : 'text-red-600'}`}>
              {tradeAnalytics.summary.profitFactor === Infinity ? '∞' : tradeAnalytics.summary.profitFactor.toFixed(2)}
            </p>
          </div>
        </div>

        {/* Breakdown Tables */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[
            { title: 'By Hold Period', data: tradeAnalytics.byHoldPeriod },
            { title: 'By Regime at Entry', data: tradeAnalytics.byRegimeAtEntry },
            { title: 'By Entry Style', data: tradeAnalytics.byEntryStyle },
          ].map(({ title, data }) => (
            <div key={title} className="card">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-1.5 font-medium text-gray-500">Label</th>
                    <th className="text-right py-1.5 font-medium text-gray-500">Trades</th>
                    <th className="text-right py-1.5 font-medium text-gray-500">Win%</th>
                    <th className="text-right py-1.5 font-medium text-gray-500">Total P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map(row => (
                    <tr key={row.label} className="border-b border-gray-100">
                      <td className="py-1.5 text-gray-900 capitalize">{row.label}</td>
                      <td className="py-1.5 text-right text-gray-700">{row.count}</td>
                      <td className={`py-1.5 text-right font-medium ${row.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                        {row.winRate.toFixed(0)}%
                      </td>
                      <td className={`py-1.5 text-right font-medium ${returnColor(row.totalGain)}`}>
                        {formatCurrency(row.totalGain)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* Top Winners / Losers */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[
            { title: 'Top 5 Winners', trades: tradeAnalytics.topWinners, color: 'text-green-600' },
            { title: 'Top 5 Losers', trades: tradeAnalytics.topLosers, color: 'text-red-600' },
          ].map(({ title, trades, color }) => (
            <div key={title} className="card">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-1.5 font-medium text-gray-500">Symbol</th>
                    <th className="text-right py-1.5 font-medium text-gray-500">Qty</th>
                    <th className="text-right py-1.5 font-medium text-gray-500">Buy</th>
                    <th className="text-right py-1.5 font-medium text-gray-500">Sell</th>
                    <th className="text-right py-1.5 font-medium text-gray-500">P&L</th>
                    <th className="text-right py-1.5 font-medium text-gray-500">Hold</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="py-1.5 font-medium text-gray-900">{t.symbol}</td>
                      <td className="py-1.5 text-right text-gray-700">{t.quantity.toFixed(0)}</td>
                      <td className="py-1.5 text-right text-gray-700">${t.buyPrice.toFixed(2)}</td>
                      <td className="py-1.5 text-right text-gray-700">${t.sellPrice.toFixed(2)}</td>
                      <td className={`py-1.5 text-right font-medium ${color}`}>
                        {formatCurrency(t.realizedGain)}
                      </td>
                      <td className="py-1.5 text-right text-gray-500">{t.holdDays}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    )}
  </>
)}
```

**Step 2: Verify it compiles**

Run: `npm run build:renderer`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/renderer/pages/Analytics.tsx
git commit -m "feat: add Trade Performance tab to Analytics page"
```

---

### Task 5: CLI Command

**Files:**
- Modify: `scripts/pm-cli.sh`

**Context:** Read `scripts/pm-cli.sh` to understand the CLI pattern. The CLI uses direct SQLite queries via `sqlite3` command. The FIFO computation done in TypeScript needs to be replicated in shell/SQL, OR we can call the Electron app's IPC. Since the CLI uses direct DB access (not Electron), we'll implement a simplified version using SQL.

**Step 1: Add `trade-analytics` command**

Add a new case in the main command dispatch (near the existing `analytics` command):

```bash
trade-analytics)
  trade_analytics
  ;;
```

Add the function:

```bash
trade_analytics() {
  # Get closed trades via FIFO from transactions
  # Since FIFO in pure SQL is complex, use a simplified approach:
  # For each symbol, compute avg buy price and compare to sells

  local results
  results=$(sqlite3 "$DB_PATH" "
    WITH buys AS (
      SELECT t.account_id, t.security_id, s.symbol,
             SUM(t.quantity) as total_qty,
             SUM(t.amount) as total_cost
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'buy'
      GROUP BY t.account_id, t.security_id
    ),
    sells AS (
      SELECT t.account_id, t.security_id, s.symbol,
             t.date as sell_date,
             t.quantity,
             t.price as sell_price,
             t.amount as proceeds
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type = 'sell'
    ),
    matched AS (
      SELECT s.symbol, s.sell_date, s.quantity, s.sell_price, s.proceeds,
             CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END as avg_buy_price,
             s.proceeds - (s.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END) as gain
      FROM sells s
      LEFT JOIN buys b ON s.account_id = b.account_id AND s.security_id = b.security_id
    )
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN gain > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN gain <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(100.0 * SUM(CASE WHEN gain > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
      ROUND(SUM(gain), 2) as total_pnl,
      ROUND(AVG(CASE WHEN gain > 0 THEN gain END), 2) as avg_win,
      ROUND(AVG(CASE WHEN gain <= 0 THEN gain END), 2) as avg_loss
    FROM matched;
  ")

  IFS='|' read -r total wins losses win_rate total_pnl avg_win avg_loss <<< "$results"

  echo ""
  echo "=== Trade Performance (avg cost method) ==="
  echo ""
  printf "  %-20s %s\n" "Total Trades:" "$total"
  printf "  %-20s %s (%s W / %s L)\n" "Win Rate:" "${win_rate}%" "$wins" "$losses"
  printf "  %-20s \$%s\n" "Total P&L:" "$total_pnl"
  printf "  %-20s \$%s\n" "Avg Win:" "$avg_win"
  printf "  %-20s \$%s\n" "Avg Loss:" "$avg_loss"
  echo ""
  echo "(Note: CLI uses avg cost method. App uses precise FIFO matching.)"

  # Top 5 winners
  echo ""
  echo "--- Top 5 Winners ---"
  sqlite3 -header -column "$DB_PATH" "
    WITH buys AS (
      SELECT t.account_id, t.security_id,
             SUM(t.quantity) as total_qty, SUM(t.amount) as total_cost
      FROM transactions t WHERE t.type = 'buy'
      GROUP BY t.account_id, t.security_id
    )
    SELECT s.symbol, se.sell_date as date, se.quantity as qty,
           ROUND(se.sell_price, 2) as sell_px,
           ROUND(CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END, 2) as avg_cost,
           ROUND(se.proceeds - (se.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END), 2) as pnl
    FROM (
      SELECT t.account_id, t.security_id, s.symbol, t.date as sell_date,
             t.quantity, t.price as sell_price, t.amount as proceeds
      FROM transactions t JOIN securities s ON t.security_id = s.id WHERE t.type = 'sell'
    ) se
    JOIN securities s ON se.security_id = s.id
    LEFT JOIN buys b ON se.account_id = b.account_id AND se.security_id = b.security_id
    ORDER BY pnl DESC LIMIT 5;
  "

  # Top 5 losers
  echo ""
  echo "--- Top 5 Losers ---"
  sqlite3 -header -column "$DB_PATH" "
    WITH buys AS (
      SELECT t.account_id, t.security_id,
             SUM(t.quantity) as total_qty, SUM(t.amount) as total_cost
      FROM transactions t WHERE t.type = 'buy'
      GROUP BY t.account_id, t.security_id
    )
    SELECT s.symbol, se.sell_date as date, se.quantity as qty,
           ROUND(se.sell_price, 2) as sell_px,
           ROUND(CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END, 2) as avg_cost,
           ROUND(se.proceeds - (se.quantity * CASE WHEN b.total_qty > 0 THEN b.total_cost / b.total_qty ELSE 0 END), 2) as pnl
    FROM (
      SELECT t.account_id, t.security_id, s.symbol, t.date as sell_date,
             t.quantity, t.price as sell_price, t.amount as proceeds
      FROM transactions t JOIN securities s ON t.security_id = s.id WHERE t.type = 'sell'
    ) se
    JOIN securities s ON se.security_id = s.id
    LEFT JOIN buys b ON se.account_id = b.account_id AND se.security_id = b.security_id
    ORDER BY pnl ASC LIMIT 5;
  "
}
```

**Step 2: Test the CLI command**

Run: `./scripts/pm-cli.sh trade-analytics`
Expected: Summary stats and top winners/losers printed

**Step 3: Commit**

```bash
git add scripts/pm-cli.sh
git commit -m "feat: add trade-analytics CLI command"
```

---

### Task 6: Build and Verify

**Files:** None (verification only)

**Step 1: Full build**

Run: `npm run build:main && npm run build:renderer`
Expected: Clean compile, no errors

**Step 2: Test CLI**

Run: `./scripts/pm-cli.sh trade-analytics`
Expected: Summary stats, top winners, top losers printed correctly

**Step 3: Verify in app**

Run: `npm run dev`
Navigate to Analytics page → click "Trade Performance" tab.
Expected: Summary cards, three breakdown tables, top winners/losers tables all render with data.

**Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: trade analytics build/runtime fixes"
```
