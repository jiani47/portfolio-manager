import { Database } from './database';
import { PreTradeCheckRequest, PreTradeCheckResult, PreTradeCheckItem } from '../shared/types';
import * as fs from 'fs';
import * as path from 'path';

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
    items.push(this.checkSRLevels(req.symbol, 'SELL', req.price));
    items.push(this.checkPanicSell(req.symbol, req.price));
    items.push(this.checkHoldDuration(req.symbol));
    // Boundary check for investing sells (churn detection)
    const sellAccounts = this.db.listAccounts();
    const sellAccount = sellAccounts.find(a => a.accountNumber === req.accountNumber);
    const sellBook = (sellAccount?.book as string) || 'unassigned';
    if (sellBook === 'investing') {
      items.push(this.checkBoundaryViolation(req.symbol, sellBook));
    }
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
    items.push(this.checkThesisFile(req.symbol, 'investing'));
    items.push(this.checkThesisDocumented(req.symbol));
    items.push(this.checkInvalidationDefined(req.symbol));
    items.push(this.checkRegimeRead());
    items.push(this.checkSortingDay());
    items.push(this.checkReentryCooldown(req.symbol));
    items.push(this.checkRapidFlip(req.symbol, 'buy'));
    items.push(this.checkPositionSize(req, 'investing'));
    items.push(this.checkActionConflict(req.instruction));
    items.push(this.checkBoundaryViolation(req.symbol, 'investing'));
    items.push(this.checkChurn(req.symbol));
    items.push(this.checkAddSize(req));
    items.push(this.checkSRLevels(req.symbol, 'BUY', req.price));
    items.push(this.checkGapUp(req.symbol));
    items.push(this.checkPendingEarningsReview(req.symbol));
    items.push(this.checkEntryPlan(req.symbol, req.instruction, req.quantity, req.price));
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
    items.push(this.checkThesisFile(req.symbol, 'trading'));
    items.push(this.checkRegimeRead());
    items.push(this.checkSortingDay());
    items.push(this.checkReentryCooldown(req.symbol));
    items.push(this.checkRapidFlip(req.symbol, 'buy'));
    items.push(this.checkPositionSize(req, 'trading'));
    items.push(this.checkActionConflict(req.instruction));
    items.push(this.checkBoundaryViolation(req.symbol, 'trading', req));
    items.push(this.checkChurn(req.symbol));
    items.push(this.checkSRLevels(req.symbol, 'BUY', req.price));
    items.push(this.checkGapUp(req.symbol));
    items.push(this.checkPendingEarningsReview(req.symbol));
    items.push(this.checkEntryPlan(req.symbol, req.instruction, req.quantity, req.price));
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

  /** Warn if today's ritual action conflicts with this trade */
  private checkActionConflict(instruction: string): PreTradeCheckItem {
    const today = new Date().toISOString().split('T')[0];
    const rituals = this.db.listDailyRituals(1);
    const todayRitual = rituals.find(r => r.date === today);
    if (!todayRitual?.actionChosen) {
      return { id: 'action-conflict', label: 'Action alignment', type: 'auto', status: 'pass', detail: 'No action chosen today' };
    }
    if (todayRitual.actionChosen === 'reduce' && instruction === 'BUY') {
      return { id: 'action-conflict', label: `Today's action is "reduce" — buying conflicts`, type: 'auto', status: 'warn', detail: `You chose "reduce" today. This buy contradicts that decision.` };
    }
    if (todayRitual.actionChosen === 'nothing' && instruction !== 'SELL') {
      return { id: 'action-conflict', label: `Today's action is "nothing" — this trade conflicts`, type: 'auto', status: 'warn', detail: 'You chose to do nothing today.' };
    }
    return { id: 'action-conflict', label: `Action aligned (${todayRitual.actionChosen})`, type: 'auto', status: 'pass' };
  }

  /** Warn when buying near resistance or selling near support */
  private checkSRLevels(symbol: string, instruction: string, price?: number): PreTradeCheckItem {
    const levels = this.db.getPriceLevels(symbol);
    if (!levels || levels.length === 0) {
      return { id: 'sr-levels', label: 'S/R level check', type: 'auto', status: 'pass', detail: 'No S/R levels computed' };
    }

    let currentPrice = price;
    if (!currentPrice) {
      const latestPrices = this.db.getLatestPrices();
      const priceData = latestPrices.find((p: any) => p.symbol === symbol);
      currentPrice = priceData?.closePrice;
    }
    if (!currentPrice) {
      return { id: 'sr-levels', label: 'S/R level check', type: 'auto', status: 'pass', detail: 'No price data available' };
    }

    if (instruction === 'BUY') {
      // Find nearest resistance above current price
      const resistanceLevels = levels
        .filter(l => l.levelType === 'resistance' && l.price > currentPrice!)
        .sort((a, b) => a.price - b.price);
      if (resistanceLevels.length > 0) {
        const nearest = resistanceLevels[0];
        const pctAway = ((nearest.price - currentPrice) / currentPrice) * 100;
        if (pctAway < 3) {
          return {
            id: 'sr-levels',
            label: `Buying within ${pctAway.toFixed(1)}% of resistance at $${nearest.price} (strength ${nearest.strength})`,
            type: 'auto',
            status: 'warn',
            detail: `Nearest resistance: $${nearest.price} (strength ${nearest.strength}), ${pctAway.toFixed(1)}% above current price`,
          };
        }
      }
    } else {
      // SELL: find nearest support below current price
      const supportLevels = levels
        .filter(l => l.levelType === 'support' && l.price < currentPrice!)
        .sort((a, b) => b.price - a.price);
      if (supportLevels.length > 0) {
        const nearest = supportLevels[0];
        const pctAway = ((currentPrice - nearest.price) / currentPrice) * 100;
        if (pctAway < 3) {
          return {
            id: 'sr-levels',
            label: `Selling within ${pctAway.toFixed(1)}% of support at $${nearest.price} (strength ${nearest.strength})`,
            type: 'auto',
            status: 'warn',
            detail: `Nearest support: $${nearest.price} (strength ${nearest.strength}), ${pctAway.toFixed(1)}% below current price`,
          };
        }
      }
    }

    return { id: 'sr-levels', label: 'S/R level check clear', type: 'auto', status: 'pass' };
  }

  /** Warn on recent gap-up: mean reversion risk elevated */
  private checkGapUp(symbol: string): PreTradeCheckItem {
    const recentPrices = this.db.getPriceHistoryBySymbol(symbol, 6);
    if (recentPrices.length < 2) {
      return { id: 'gap-up', label: 'Gap-up check', type: 'auto', status: 'pass', detail: 'Not enough price data' };
    }

    // Check consecutive days for a gap-up (open > prev close by >5%)
    for (let i = 1; i < recentPrices.length; i++) {
      const prevClose = recentPrices[i - 1].closePrice;
      const currOpen = recentPrices[i].openPrice;
      if (!prevClose || !currOpen) continue;

      const gapPct = ((currOpen - prevClose) / prevClose) * 100;
      if (gapPct > 5) {
        // Find nearest resistance for additional context
        let resistanceDetail = '';
        const levels = this.db.getPriceLevels(symbol);
        const latestClose = recentPrices[recentPrices.length - 1].closePrice;
        if (latestClose && levels.length > 0) {
          const resistanceLevels = levels
            .filter(l => l.levelType === 'resistance' && l.price > latestClose)
            .sort((a, b) => a.price - b.price);
          if (resistanceLevels.length > 0) {
            const nearest = resistanceLevels[0];
            const distPct = ((nearest.price - latestClose) / latestClose) * 100;
            resistanceDetail = ` Nearest resistance: $${nearest.price} (${distPct.toFixed(1)}% away).`;
          }
        }

        return {
          id: 'gap-up',
          label: `${symbol} gapped up ${gapPct.toFixed(1)}% on ${recentPrices[i].date}`,
          type: 'auto',
          status: 'warn',
          detail: `${symbol} gapped up ${gapPct.toFixed(1)}% on ${recentPrices[i].date}. Mean reversion risk elevated.${resistanceDetail}`,
        };
      }
    }

    return { id: 'gap-up', label: 'No recent gap-up detected', type: 'auto', status: 'pass' };
  }

  /** Detect trading/investing boundary violations */
  private checkBoundaryViolation(symbol: string, book: string, req?: PreTradeCheckRequest): PreTradeCheckItem {
    if (book === 'investing') {
      // Churn detection: count sells (proxy for round-trips) in last 90 days
      const sellCount = this.db.getRoundTripCount(symbol, 90);
      if (sellCount >= 3) {
        return {
          id: 'boundary-violation',
          label: `Boundary violation — ${sellCount} sells on ${symbol} in 90 days`,
          type: 'auto',
          status: 'warn',
          detail: `You've round-tripped ${symbol} ${sellCount} times in 90 days. This is an investing position — if you believe the thesis, hold.`,
        };
      }
      return { id: 'boundary-violation', label: `Boundary check (investing, ${sellCount} sells in 90d)`, type: 'auto', status: 'pass' };
    }

    if (book === 'trading' && req) {
      // Check if position would be investing-sized (>2% of portfolio)
      const weights = this.db.getPositionWeights();
      const totalMV = weights.reduce((sum, w) => sum + w.marketValue, 0);
      const cashPositions = this.db.listPositions();
      const cashSecurities = this.db.listSecurities().filter(s => s.type === 'cash');
      const cashIds = new Set(cashSecurities.map(s => s.id));
      const cashMV = cashPositions.filter(p => cashIds.has(p.securityId)).reduce((sum, p) => sum + (p.quantity || 0), 0);
      const portfolioTotal = totalMV + cashMV;

      if (portfolioTotal > 0) {
        const orderValue = req.quantity * (req.price || 0);
        const existingWeight = weights.find(w => w.symbol === req.symbol);
        const existingMV = existingWeight?.marketValue || 0;
        const afterTradeMV = existingMV + orderValue;
        const afterTradePct = (afterTradeMV / portfolioTotal) * 100;

        if (afterTradePct > 2) {
          return {
            id: 'boundary-violation',
            label: `Position ${afterTradePct.toFixed(1)}% — investing-sized for trading account`,
            type: 'auto',
            status: 'warn',
            detail: `This position is investing-sized for a trading account. Consider the investing book.`,
          };
        }
        return { id: 'boundary-violation', label: `Trading position size OK (${afterTradePct.toFixed(1)}%)`, type: 'auto', status: 'pass' };
      }
    }

    return { id: 'boundary-violation', label: 'Boundary check', type: 'auto', status: 'pass' };
  }

  /** Hard gate: thesis doc must exist for investment positions */
  private checkThesisFile(symbol: string, book: string): PreTradeCheckItem {
    const thesisPath = path.join(process.cwd(), 'docs', 'positions', symbol.toUpperCase(), 'thesis.md');
    const exists = fs.existsSync(thesisPath);

    if (exists) {
      return { id: 'thesis-file', label: 'Thesis doc exists', type: 'auto', status: 'pass' };
    }

    if (book === 'investing') {
      return {
        id: 'thesis-file',
        label: 'Thesis doc missing — required for investment positions',
        type: 'auto',
        status: 'fail',
        detail: `Investment positions require a thesis doc. Create docs/positions/${symbol.toUpperCase()}/thesis.md first.`,
      };
    }

    return {
      id: 'thesis-file',
      label: 'No thesis doc — confirm pure technical/momentum trade',
      type: 'auto',
      status: 'warn',
      detail: `No thesis doc found. Confirm this is a pure technical/momentum trade.`,
    };
  }

  /** Detect panic sell pattern: red day + near support + past bad sells */
  private checkPanicSell(symbol: string, price?: number): PreTradeCheckItem {
    // Get last two price history entries to determine if red day
    const recentPrices = this.db.getPriceHistoryBySymbol(symbol, 2);
    if (recentPrices.length < 2) {
      return { id: 'panic-sell', label: 'Panic sell check', type: 'auto', status: 'pass', detail: 'Not enough price data' };
    }

    // getPriceHistoryBySymbol returns in chronological order (oldest first)
    const previousClose = recentPrices[0].closePrice;
    const currentClose = recentPrices[1].closePrice;

    if (!previousClose || currentClose >= previousClose) {
      return { id: 'panic-sell', label: 'Panic sell check — not a red day', type: 'auto', status: 'pass' };
    }

    // It's a red day — check if near support
    const usePrice = price || currentClose;
    const levels = this.db.getPriceLevels(symbol);
    const supportLevels = levels
      .filter(l => l.levelType === 'support' && l.price < usePrice)
      .sort((a, b) => b.price - a.price);

    if (supportLevels.length === 0) {
      return { id: 'panic-sell', label: 'Panic sell check — no support below', type: 'auto', status: 'pass' };
    }

    const nearest = supportLevels[0];
    const pctAway = ((usePrice - nearest.price) / usePrice) * 100;

    if (pctAway >= 3) {
      return { id: 'panic-sell', label: `Panic sell check — not near support (${pctAway.toFixed(1)}% away)`, type: 'auto', status: 'pass' };
    }

    // Panic pattern detected — surface past bad sells
    let pastLessons = '';
    try {
      const postMortems = this.db.listPostMortems({ limit: 50 });
      const badSells = postMortems.filter(
        (pm: any) => pm.executionQuality === 'bad' && pm.outcome === 'loss'
      );
      if (badSells.length > 0) {
        const lessons = badSells.slice(0, 3).map((pm: any) => pm.lessonLearned).filter(Boolean);
        if (lessons.length > 0) {
          pastLessons = ` Past lessons: ${lessons.join('; ')}`;
        }
      }
    } catch {
      // Post-mortem lookup failed — still warn
    }

    return {
      id: 'panic-sell',
      label: `Panic sell pattern — red day, within ${pctAway.toFixed(1)}% of support at $${nearest.price}`,
      type: 'auto',
      status: 'warn',
      detail: `Red day (${currentClose} < prev ${previousClose}) and selling near support.${pastLessons}`,
    };
  }

  /** Check if selling before target hold period has elapsed */
  private checkHoldDuration(symbol: string): PreTradeCheckItem {
    const securities = this.db.listSecurities();
    const security = securities.find(s => s.symbol === symbol);
    if (!security) {
      return { id: 'hold-duration', label: 'Hold duration check', type: 'auto', status: 'pass', detail: 'Security not found' };
    }
    const positions = this.db.listPositions();
    const position = positions.find(p => p.securityId === security.id);
    if (!position) {
      return { id: 'hold-duration', label: 'Hold duration check', type: 'auto', status: 'pass', detail: 'No existing position' };
    }
    const intent = this.db.getPositionIntent(position.id);
    if (!intent?.targetHoldPeriod) {
      return { id: 'hold-duration', label: 'Hold duration (no target set)', type: 'auto', status: 'pass' };
    }

    const firstBuy = this.db.getFirstBuyDate(symbol);
    if (!firstBuy) {
      return { id: 'hold-duration', label: 'Hold duration (no buy history)', type: 'auto', status: 'pass' };
    }

    const daysHeld = Math.round((Date.now() - new Date(firstBuy).getTime()) / 86400000);
    const targetDays = this.parseHoldPeriodToDays(intent.targetHoldPeriod);

    if (targetDays === 0) {
      return { id: 'hold-duration', label: `Hold duration (unparseable: ${intent.targetHoldPeriod})`, type: 'auto', status: 'pass' };
    }

    if (daysHeld < targetDays) {
      const remaining = targetDays - daysHeld;
      return {
        id: 'hold-duration',
        label: `Hold duration — target is "${intent.targetHoldPeriod}" but only held ${daysHeld}d`,
        type: 'auto',
        status: 'warn',
        detail: `You set a ${intent.targetHoldPeriod} hold. It's been ${daysHeld} days. ${remaining} days left.`,
      };
    }

    return { id: 'hold-duration', label: `Hold duration met (${daysHeld}d, target: ${intent.targetHoldPeriod})`, type: 'auto', status: 'pass' };
  }

  /** Parse hold period string like "6 months", "1 year", "3 months" to days */
  private parseHoldPeriodToDays(period: string): number {
    const match = period.toLowerCase().match(/(\d+)\s*(month|year|week|day)/);
    if (!match) return 0;
    const n = parseInt(match[1], 10);
    const unit = match[2];
    if (unit.startsWith('year')) return n * 365;
    if (unit.startsWith('month')) return n * 30;
    if (unit.startsWith('week')) return n * 7;
    return n; // days
  }

  /** Detect excessive round-tripping (churn) on a symbol */
  private checkChurn(symbol: string): PreTradeCheckItem {
    const sellCount = this.db.getRoundTripCount(symbol, 90);
    if (sellCount >= 3) {
      return {
        id: 'churn-detection',
        label: `Churn detected — ${sellCount} round-trips on ${symbol} in 90 days`,
        type: 'auto',
        status: 'warn',
        detail: `You've round-tripped ${symbol} ${sellCount} times in 90 days. Constant build-trim-rebuild destroys value.`,
      };
    }
    return { id: 'churn-detection', label: `No churn (${sellCount} sells in 90d)`, type: 'auto', status: 'pass' };
  }

  /** Warn if there is a pending earnings review (challenged or neutral, no decision yet) */
  private checkPendingEarningsReview(symbol: string): PreTradeCheckItem {
    try {
      const pendingReviews = this.db.listEarningsReviews({ symbol, pending: true });
      if (pendingReviews.length === 0) {
        return { id: 'pending-earnings-review', label: 'No pending earnings reviews', type: 'auto', status: 'pass' };
      }

      const review = pendingReviews[0];
      if (review.thesisImpact === 'challenged' || review.invalidationTriggered) {
        return {
          id: 'pending-earnings-review',
          label: `Pending earnings review for ${symbol} — thesis ${review.thesisImpact}`,
          type: 'auto',
          status: 'fail',
          detail: `${review.quarter} earnings review pending (thesis ${review.thesisImpact}${review.invalidationTriggered ? ', invalidation triggered' : ''}). Complete review before trading. Deadline: ${review.decisionDeadline || 'not set'}`,
        };
      }

      return {
        id: 'pending-earnings-review',
        label: `Pending earnings review for ${symbol} (${review.quarter}, ${review.thesisImpact})`,
        type: 'auto',
        status: 'warn',
        detail: `${review.quarter} earnings review has no decision yet. Consider completing it.`,
      };
    } catch {
      return { id: 'pending-earnings-review', label: 'Earnings review check', type: 'auto', status: 'pass', detail: 'Could not check — table may not exist yet' };
    }
  }

  /** Check if a buy aligns with an active entry plan */
  private checkEntryPlan(symbol: string, instruction: string, quantity: number, price?: number): PreTradeCheckItem {
    if (instruction !== 'BUY') {
      return { id: 'entry-plan', label: 'Entry plan check', type: 'auto', status: 'pass', detail: 'Not a buy order' };
    }

    try {
      const plan = this.db.getEntryPlanBySymbol(symbol);
      if (!plan || !plan.tranches || plan.tranches.length === 0) {
        return { id: 'entry-plan', label: 'No active entry plan', type: 'auto', status: 'pass' };
      }

      const pendingTranches = plan.tranches.filter(t => t.status === 'pending');
      const targetPct = plan.targetAllocationPct ? `${plan.targetAllocationPct}%` : 'unset';

      // Check if order matches any pending tranche
      const tolerance = 0.02; // 2% price tolerance
      const matchingTranche = pendingTranches.find(t => {
        const priceMatch = price
          ? Math.abs(price - t.triggerPrice) / t.triggerPrice <= tolerance
          : false;
        const qtyMatch = quantity === t.shares;
        return priceMatch && qtyMatch;
      });

      if (matchingTranche) {
        return {
          id: 'entry-plan',
          label: `Matches tranche ${matchingTranche.trancheNumber} of entry plan`,
          type: 'auto',
          status: 'pass',
          detail: `Active entry plan: target ${targetPct}, ${pendingTranches.length} pending tranches. This buy matches tranche ${matchingTranche.trancheNumber} (${matchingTranche.shares} shares at $${matchingTranche.triggerPrice.toFixed(2)}).`,
        };
      }

      // Order exists but doesn't match any tranche
      const trancheDesc = pendingTranches.map(t => `T${t.trancheNumber}: ${t.shares}@$${t.triggerPrice.toFixed(2)}`).join(', ');
      return {
        id: 'entry-plan',
        label: `Buy deviates from entry plan (target ${targetPct})`,
        type: 'auto',
        status: 'warn',
        detail: `Active entry plan has ${pendingTranches.length} pending tranches: ${trancheDesc}. This buy (${quantity} shares${price ? ` at $${price.toFixed(2)}` : ''}) doesn't match any tranche.`,
      };
    } catch {
      return { id: 'entry-plan', label: 'Entry plan check', type: 'auto', status: 'pass', detail: 'Could not check — table may not exist yet' };
    }
  }

  /** Check if add size is outsized relative to remaining tier room */
  private checkAddSize(req: PreTradeCheckRequest): PreTradeCheckItem {
    const weights = this.db.getPositionWeights();
    const totalMV = weights.reduce((sum, w) => sum + w.marketValue, 0);
    const cashPositions = this.db.listPositions();
    const cashSecurities = this.db.listSecurities().filter(s => s.type === 'cash');
    const cashIds = new Set(cashSecurities.map(s => s.id));
    const cashMV = cashPositions.filter(p => cashIds.has(p.securityId)).reduce((sum, p) => sum + (p.quantity || 0), 0);
    const portfolioTotal = totalMV + cashMV;

    if (portfolioTotal <= 0) {
      return { id: 'add-size', label: 'Add size check', type: 'auto', status: 'pass', detail: 'Cannot compute — no portfolio value' };
    }

    // Get position tier and current weight
    const securities = this.db.listSecurities();
    const security = securities.find(s => s.symbol === req.symbol);
    const positions = this.db.listPositions();
    const position = security ? positions.find(p => p.securityId === security.id) : undefined;
    const intent = position ? this.db.getPositionIntent(position.id) : undefined;
    const tier = intent?.tier || 'Starter';

    const tierLimits: Record<string, number> = { Core: 25, Growth: 10, Starter: 5 };
    const tierLimit = tierLimits[tier] || 5;

    const existingWeight = weights.find(w => w.symbol === req.symbol);
    const currentPct = existingWeight ? (existingWeight.marketValue / portfolioTotal) * 100 : 0;
    const remainingRoom = tierLimit - currentPct;

    if (remainingRoom <= 0) {
      return { id: 'add-size', label: `Add size — no room in ${tier} allocation`, type: 'auto', status: 'warn', detail: `Current weight ${currentPct.toFixed(1)}% already at/above ${tier} limit (${tierLimit}%)` };
    }

    const orderValue = req.quantity * (req.price || 0);
    const orderPct = (orderValue / portfolioTotal) * 100;
    const orderPctOfRoom = (orderPct / remainingRoom) * 100;

    if (orderPctOfRoom > 50 && remainingRoom < 3) {
      return {
        id: 'add-size',
        label: `Add uses ${orderPctOfRoom.toFixed(0)}% of remaining ${tier} room`,
        type: 'auto',
        status: 'warn',
        detail: `This add uses ${orderPctOfRoom.toFixed(0)}% of remaining room in ${tier} allocation (${remainingRoom.toFixed(1)}% remaining). Consider smaller tranches.`,
      };
    }

    return { id: 'add-size', label: `Add size OK (${remainingRoom.toFixed(1)}% room in ${tier})`, type: 'auto', status: 'pass' };
  }
}
