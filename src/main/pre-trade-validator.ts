import { Database } from './database';
import { PreTradeCheckRequest, PreTradeCheckResult, PreTradeCheckItem } from '../shared/types';

export class PreTradeValidator {
  constructor(private db: Database) {}

  evaluate(req: PreTradeCheckRequest): PreTradeCheckResult {
    const accounts = this.db.listAccounts();
    const account = accounts.find(a => a.accountNumber === req.accountNumber);
    const book = (account?.book as 'investing' | 'trading') || 'unassigned';

    const items: PreTradeCheckItem[] = [];

    if (req.instruction === 'SELL') {
      items.push(...this.sellChecks(req));
    } else if (book === 'trading') {
      items.push(...this.tradingBuyChecks(req, account?.id));
    } else {
      items.push(...this.investingBuyChecks(req, account?.id));
    }

    return { book, items };
  }

  record(data: {
    orderSymbol: string;
    orderSide: string;
    orderQty: number;
    accountId: string;
    book: string;
    items: PreTradeCheckItem[];
    overrides: string[];
    passed: boolean;
  }): string {
    return this.db.recordPreTradeCheck({
      orderSymbol: data.orderSymbol,
      orderSide: data.orderSide,
      orderQty: data.orderQty,
      accountId: data.accountId,
      book: data.book,
      checksJson: JSON.stringify(data.items),
      overrides: JSON.stringify(data.overrides),
      passed: data.passed,
      createdAt: new Date().toISOString(),
    });
  }

  private sellChecks(req: PreTradeCheckRequest): PreTradeCheckItem[] {
    const items: PreTradeCheckItem[] = [];
    items.push(this.checkRegimeRead());
    items.push(this.checkRapidFlip(req.symbol, 'sell', req.price));
    items.push({
      id: 'sell-reason',
      label: 'I have a clear reason for this sell',
      type: 'manual',
      status: 'warn',
    });
    return items;
  }

  private investingBuyChecks(req: PreTradeCheckRequest, accountId?: string): PreTradeCheckItem[] {
    const items: PreTradeCheckItem[] = [];
    items.push(this.checkIntentExists(req.symbol));
    items.push(this.checkThesisDocumented(req.symbol));
    items.push(this.checkInvalidationDefined(req.symbol));
    items.push(this.checkRegimeRead());
    items.push(this.checkSortingDay());
    items.push(this.checkReentryCooldown(req.symbol));
    items.push(this.checkRapidFlip(req.symbol, 'buy'));
    items.push(this.checkPositionSize(req, 'investing'));
    items.push({
      id: 'invest-hold-months',
      label: 'This is an investment — I expect to hold for months+',
      type: 'manual',
      status: 'warn',
    });
    items.push({
      id: 'invest-drawdown',
      label: 'I would hold through a 20-30% drawdown',
      type: 'manual',
      status: 'warn',
    });
    return items;
  }

  private tradingBuyChecks(req: PreTradeCheckRequest, accountId?: string): PreTradeCheckItem[] {
    const items: PreTradeCheckItem[] = [];
    items.push(this.checkTradingAccount());
    items.push(this.checkRegimeRead());
    items.push(this.checkSortingDay());
    items.push(this.checkReentryCooldown(req.symbol));
    items.push(this.checkRapidFlip(req.symbol, 'buy'));
    items.push(this.checkPositionSize(req, 'trading'));
    items.push({
      id: 'trade-stop-defined',
      label: 'I have a stop level defined — technical, not emotional',
      type: 'manual',
      status: 'warn',
    });
    items.push({
      id: 'trade-time-discipline',
      label: 'I will exit if no progress in 20-30 days',
      type: 'manual',
      status: 'warn',
    });
    items.push({
      id: 'trade-accept-stopout',
      label: 'I accept a stop-out as success — not hoping, not averaging down',
      type: 'manual',
      status: 'warn',
    });
    return items;
  }

  private checkIntentExists(symbol: string): PreTradeCheckItem {
    const securities = this.db.listSecurities();
    const security = securities.find(s => s.symbol === symbol);
    if (!security) {
      return { id: 'intent-exists', label: 'Position intent assigned (tier)', type: 'auto', status: 'warn', detail: 'Security not found in portfolio' };
    }
    const positions = this.db.listPositions();
    const position = positions.find(p => p.securityId === security.id);
    if (!position) {
      return { id: 'intent-exists', label: 'Position intent assigned (tier)', type: 'auto', status: 'warn', detail: 'No existing position — new entry' };
    }
    const intent = this.db.getPositionIntent(position.id);
    if (!intent || !intent.tier) {
      return { id: 'intent-exists', label: 'Position intent assigned (tier)', type: 'auto', status: 'fail', detail: 'No tier assigned' };
    }
    return { id: 'intent-exists', label: `Position intent assigned (${intent.tier})`, type: 'auto', status: 'pass' };
  }

  private checkThesisDocumented(symbol: string): PreTradeCheckItem {
    const securities = this.db.listSecurities();
    const security = securities.find(s => s.symbol === symbol);
    const positions = this.db.listPositions();
    const position = security ? positions.find(p => p.securityId === security.id) : undefined;
    const intent = position ? this.db.getPositionIntent(position.id) : undefined;
    if (intent?.thesis) {
      return { id: 'thesis-documented', label: 'Thesis documented', type: 'auto', status: 'pass' };
    }
    return { id: 'thesis-documented', label: 'Thesis documented', type: 'auto', status: 'fail', detail: 'No thesis in position intent' };
  }

  private checkInvalidationDefined(symbol: string): PreTradeCheckItem {
    const securities = this.db.listSecurities();
    const security = securities.find(s => s.symbol === symbol);
    const positions = this.db.listPositions();
    const position = security ? positions.find(p => p.securityId === security.id) : undefined;
    const intent = position ? this.db.getPositionIntent(position.id) : undefined;
    if (intent?.invalidation) {
      return { id: 'invalidation-defined', label: 'Invalidation conditions defined', type: 'auto', status: 'pass' };
    }
    return { id: 'invalidation-defined', label: 'Invalidation conditions defined', type: 'auto', status: 'fail', detail: 'No invalidation in position intent' };
  }

  private checkRegimeRead(): PreTradeCheckItem {
    const today = new Date().toISOString().split('T')[0];
    const rituals = this.db.listDailyRituals(1);
    const todayRitual = rituals.find(r => r.date === today);
    if (todayRitual?.regimeType) {
      return { id: 'regime-read', label: `Regime read done (${todayRitual.regimeType} day)`, type: 'auto', status: 'pass' };
    }
    return { id: 'regime-read', label: 'Regime read done today', type: 'auto', status: 'fail', detail: 'No regime read recorded for today' };
  }

  private checkSortingDay(): PreTradeCheckItem {
    const today = new Date().toISOString().split('T')[0];
    const rituals = this.db.listDailyRituals(1);
    const todayRitual = rituals.find(r => r.date === today);
    if (!todayRitual?.regimeType) {
      return { id: 'sorting-day', label: 'Sorting day check', type: 'auto', status: 'pass', detail: 'No regime set — skipped' };
    }
    if (todayRitual.regimeType === 'sorting') {
      return { id: 'sorting-day', label: 'Sorting day — adds typically disabled', type: 'auto', status: 'warn', detail: 'Regime is sorting. Proceed only with clear rationale.' };
    }
    return { id: 'sorting-day', label: 'Not a sorting day', type: 'auto', status: 'pass' };
  }

  private checkTradingAccount(): PreTradeCheckItem {
    return { id: 'trading-account', label: 'Placing in trading account', type: 'auto', status: 'pass' };
  }

  /** HARD BLOCK: no re-entry within 14 days of a sell */
  private checkReentryCooldown(symbol: string): PreTradeCheckItem {
    const lastSell = this.db.getLastSellDate(symbol);
    if (!lastSell) {
      return { id: 'reentry-cooldown', label: 'Re-entry cooldown (no prior sells)', type: 'auto', status: 'pass' };
    }
    const daysSinceSell = Math.round((Date.now() - new Date(lastSell).getTime()) / 86400000);
    if (daysSinceSell < 14) {
      return {
        id: 'reentry-cooldown',
        label: `Re-entry cooldown — you sold ${symbol} ${daysSinceSell}d ago`,
        type: 'auto',
        status: 'fail',
        detail: `Last sell: ${lastSell}. BLOCKED: Re-entries within 14d are premature 70% of the time. Wait ${14 - daysSinceSell} more days.`,
      };
    }
    return { id: 'reentry-cooldown', label: `Re-entry cooldown clear (${daysSinceSell}d since last sell)`, type: 'auto', status: 'pass' };
  }

  /** Warn on rapid sell flip only when materializing a loss */
  private checkRapidFlip(symbol: string, side: 'buy' | 'sell', sellPrice?: number): PreTradeCheckItem {
    if (side === 'buy') {
      const lastSell = this.db.getLastSellDate(symbol);
      if (lastSell) {
        const days = Math.round((Date.now() - new Date(lastSell).getTime()) / 86400000);
        if (days <= 5) {
          return {
            id: 'rapid-flip',
            label: `Rapid flip — sold ${symbol} ${days}d ago, now buying back`,
            type: 'auto',
            status: 'warn',
            detail: `Rapid flips on conviction names destroy value. Data shows <5d round-trips have 27-31% win rate.`,
          };
        }
      }
    } else {
      const lastBuy = this.db.getLastBuyDate(symbol);
      if (lastBuy) {
        const days = Math.round((Date.now() - new Date(lastBuy).getTime()) / 86400000);
        if (days <= 5) {
          // Only warn if materializing a loss
          const avgCost = this.getAvgCostBasis(symbol);
          if (avgCost && sellPrice && sellPrice < avgCost) {
            return {
              id: 'rapid-flip',
              label: `Rapid flip at a loss — bought ${symbol} ${days}d ago (avg cost $${avgCost.toFixed(2)}, selling at $${sellPrice.toFixed(2)})`,
              type: 'auto',
              status: 'warn',
              detail: `Selling within 5 days of buying at a loss. Your long holds (90d+) have 57% win rate vs 33% for <30d.`,
            };
          }
        }
      }
    }
    return { id: 'rapid-flip', label: 'No rapid flip detected', type: 'auto', status: 'pass' };
  }

  /** Get average cost basis for a symbol from current positions */
  private getAvgCostBasis(symbol: string): number | null {
    const securities = this.db.listSecurities();
    const security = securities.find(s => s.symbol === symbol);
    if (!security) return null;
    const positions = this.db.listPositions();
    const position = positions.find(p => p.securityId === security.id);
    if (!position || !position.costBasis || !position.quantity || position.quantity === 0) return null;
    return position.costBasis / position.quantity;
  }

  private checkPositionSize(req: PreTradeCheckRequest, book: 'investing' | 'trading'): PreTradeCheckItem {
    const weights = this.db.getPositionWeights();
    const totalMV = weights.reduce((sum, w) => sum + w.marketValue, 0);
    const cashPositions = this.db.listPositions();
    const cashSecurities = this.db.listSecurities().filter(s => s.type === 'cash');
    const cashIds = new Set(cashSecurities.map(s => s.id));
    const cashMV = cashPositions.filter(p => cashIds.has(p.securityId)).reduce((sum, p) => sum + (p.quantity || 0), 0);
    const portfolioTotal = totalMV + cashMV;

    if (portfolioTotal <= 0) {
      return { id: 'position-size', label: 'Position size check', type: 'auto', status: 'pass', detail: 'Cannot compute — no portfolio value' };
    }

    const orderValue = req.quantity * (req.price || 0);
    const existingWeight = weights.find(w => w.symbol === req.symbol);
    const existingMV = existingWeight?.marketValue || 0;
    const afterTradeMV = existingMV + orderValue;
    const afterTradePct = (afterTradeMV / portfolioTotal) * 100;

    if (book === 'trading') {
      const limit = 1;
      if (afterTradePct > limit) {
        return { id: 'position-size', label: `Position size ${afterTradePct.toFixed(1)}% > ${limit}% limit`, type: 'auto', status: 'warn', detail: `After trade: ${afterTradePct.toFixed(1)}% of portfolio` };
      }
      return { id: 'position-size', label: `Position size ${afterTradePct.toFixed(1)}% (≤${limit}%)`, type: 'auto', status: 'pass' };
    }

    const securities = this.db.listSecurities();
    const security = securities.find(s => s.symbol === req.symbol);
    const positions = this.db.listPositions();
    const position = security ? positions.find(p => p.securityId === security.id) : undefined;
    const intent = position ? this.db.getPositionIntent(position.id) : undefined;
    const tier = intent?.tier || 'Starter';

    const tierLimits: Record<string, number> = { Core: 25, Growth: 10, Starter: 5 };
    const limit = tierLimits[tier] || 5;

    if (afterTradePct > limit) {
      return { id: 'position-size', label: `Position size ${afterTradePct.toFixed(1)}% > ${tier} limit (${limit}%)`, type: 'auto', status: 'warn', detail: `After trade: ${afterTradePct.toFixed(1)}% of portfolio` };
    }
    return { id: 'position-size', label: `Position size ${afterTradePct.toFixed(1)}% (≤${limit}% ${tier})`, type: 'auto', status: 'pass' };
  }
}
