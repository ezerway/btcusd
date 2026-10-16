import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  Active5mMarket,
  Position,
  QuantSignal,
  StrategyConfig,
  TradeRecord,
  WindowHistoryItem,
} from '../types.ts';

import type { PolymarketSdkService } from '../sdk/polymarketSdk.ts';

interface PersistedState {
  config: StrategyConfig;
  cashBalanceUsd: number;
  initialBankrollUsd: number;
  positions: Position[];
  trades: TradeRecord[];
  windowHistory: WindowHistoryItem[];
  equityCurve: Array<{ t: number; equity: number }>;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

export class ExecutionEngine extends EventEmitter {
  public config: StrategyConfig;
  public cashBalanceUsd: number;
  public initialBankrollUsd: number;
  public positions: Position[] = [];
  public trades: TradeRecord[] = [];
  public windowHistory: WindowHistoryItem[] = [];
  public equityCurve: Array<{ t: number; equity: number }> = [];
  private polymarketSdk: PolymarketSdkService;

  constructor(polymarketSdk: PolymarketSdkService) {
    super();
    this.polymarketSdk = polymarketSdk;
    this.config = this.getDefaultConfig();
    this.initialBankrollUsd = 1000;
    this.cashBalanceUsd = 1000;
    this.loadState();
  }

  public getDefaultConfig(): StrategyConfig {
    return {
      executionMode: 'PAPER',
      bankrollUsd: 1000,
      minEdgePct: 3.0,
      minOracleLeadUsd: 10.0,
      kellyFraction: 0.25,
      maxSingleOrderUsd: 50,
      enableFinalMinuteSnipe: true,
      feeRateBps: 50, // 0.50% effective fee/slippage buffer
    };
  }

  public hasPolymarketKeys(): boolean {
    return this.polymarketSdk.authStatus.authenticated;
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        if (parsed.config) {
          this.config = { ...this.getDefaultConfig(), ...parsed.config };
        }
        if (typeof parsed.cashBalanceUsd === 'number') {
          this.cashBalanceUsd = parsed.cashBalanceUsd;
        }
        if (typeof parsed.initialBankrollUsd === 'number') {
          this.initialBankrollUsd = parsed.initialBankrollUsd;
        }
        if (Array.isArray(parsed.positions)) {
          this.positions = parsed.positions;
        }
        if (Array.isArray(parsed.trades)) {
          this.trades = parsed.trades.slice(0, 250);
        }
        if (Array.isArray(parsed.windowHistory)) {
          this.windowHistory = parsed.windowHistory.slice(0, 100);
        }
        if (Array.isArray(parsed.equityCurve)) {
          this.equityCurve = parsed.equityCurve.slice(-300);
        }
      }
    } catch {
      // Ignore corrupt state file and start fresh
    }

    if (this.equityCurve.length === 0) {
      this.equityCurve.push({ t: Date.now(), equity: this.getTotalEquity() });
    }
  }

  public saveState(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const state: PersistedState = {
        config: this.config,
        cashBalanceUsd: Number(this.cashBalanceUsd.toFixed(2)),
        initialBankrollUsd: this.initialBankrollUsd,
        positions: this.positions,
        trades: this.trades.slice(0, 250),
        windowHistory: this.windowHistory.slice(0, 100),
        equityCurve: this.equityCurve.slice(-300),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // ignore disk errors
    }
  }

  public updateConfig(partial: Partial<StrategyConfig>): StrategyConfig {
    this.config = {
      ...this.config,
      ...partial,
    };
    if (this.config.executionMode === 'LIVE_CLOB' && !this.hasPolymarketKeys()) {
      this.config.executionMode = 'PAPER';
      this.emit('alert', {
        level: 'warning',
        title: 'Polymarket API Keys Missing',
        message:
          'Configure POLYMARKET_API_KEY, POLYMARKET_SECRET, and POLYMARKET_PASSPHRASE in .env to enable Live CLOB orders. Kept in Paper Trading mode.',
      });
    }
    this.saveState();
    return this.config;
  }

  public resetPaperAccount(newBankroll = 1000): void {
    this.initialBankrollUsd = newBankroll;
    this.cashBalanceUsd = newBankroll;
    this.config.bankrollUsd = newBankroll;
    this.positions = [];
    this.trades = [];
    this.windowHistory = [];
    this.equityCurve = [{ t: Date.now(), equity: newBankroll }];
    this.saveState();
    this.emit('alert', {
      level: 'info',
      title: 'Paper Portfolio Reset',
      message: `Account reset to $${newBankroll.toFixed(2)} starting balance.`,
    });
  }

  public getTotalEquity(): number {
    const openMarkValue = this.positions.reduce(
      (sum, pos) => sum + pos.shares * pos.currentMarkPrice,
      0
    );
    return Number((this.cashBalanceUsd + openMarkValue).toFixed(2));
  }

  public getPerformanceStats() {
    const closedTrades = this.trades.filter((t) => t.side === 'SELL' || t.side === 'SETTLE');
    const wins = closedTrades.filter((t) => (t.pnlUsd || 0) > 0);
    const losses = closedTrades.filter((t) => (t.pnlUsd || 0) <= 0);
    const totalRealizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const unrealizedPnl = this.positions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);
    const totalEquity = this.getTotalEquity();
    const totalReturnPct =
      this.initialBankrollUsd > 0
        ? ((totalEquity - this.initialBankrollUsd) / this.initialBankrollUsd) * 100
        : 0;

    return {
      initialBankrollUsd: this.initialBankrollUsd,
      cashBalanceUsd: Number(this.cashBalanceUsd.toFixed(2)),
      totalEquityUsd: totalEquity,
      totalRealizedPnlUsd: Number(totalRealizedPnl.toFixed(2)),
      unrealizedPnlUsd: Number(unrealizedPnl.toFixed(2)),
      totalReturnPct: Number(totalReturnPct.toFixed(2)),
      totalClosedTrades: closedTrades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRatePct:
        closedTrades.length > 0
          ? Number(((wins.length / closedTrades.length) * 100).toFixed(1))
          : 0,
    };
  }

  public onTick(market: Active5mMarket): void {
    // Update mark-to-market on all open positions
    for (const pos of this.positions) {
      const book = pos.outcome === 'UP' ? market.upBook : market.downBook;
      const markPrice = Math.max(0.01, book.bestBid);
      pos.currentMarkPrice = markPrice;
      const currentVal = pos.shares * markPrice;
      pos.unrealizedPnlUsd = Number((currentVal - pos.costBasisUsd).toFixed(2));
      pos.unrealizedPnlPct =
        pos.costBasisUsd > 0
          ? Number(((pos.unrealizedPnlUsd / pos.costBasisUsd) * 100).toFixed(2))
          : 0;
    }
  }

  public async executeBuyOrder(
    market: Active5mMarket,
    signal: QuantSignal,
    outcome: 'UP' | 'DOWN',
    amountUsd: number
  ): Promise<TradeRecord | null> {
    const cleanUsd = Math.min(amountUsd, this.cashBalanceUsd);
    if (cleanUsd < 2) {
      this.emit('alert', {
        level: 'warning',
        title: 'Insufficient Balance',
        message: `Available cash ($${this.cashBalanceUsd.toFixed(2)}) is below minimum order size.`,
      });
      return null;
    }

    const book = outcome === 'UP' ? market.upBook : market.downBook;
    const askPrice = book.bestAsk;
    if (askPrice <= 0.01 || askPrice >= 0.99) return null;

    const feeMultiplier = 1 + this.config.feeRateBps / 10000;
    const effectiveEntryPrice = Math.min(0.99, Number((askPrice * feeMultiplier).toFixed(4)));
    const shares = Number((cleanUsd / effectiveEntryPrice).toFixed(2));
    const edgePct = Number(
      (((outcome === 'UP' ? signal.edgeUp : signal.edgeDown) || 0) * 100).toFixed(2)
    );

    let txStatus: TradeRecord['txStatus'] = 'SIMULATED';
    if (this.config.executionMode === 'LIVE_CLOB' && this.hasPolymarketKeys()) {
      const submitted = await this.submitLiveClobOrder(book.tokenId, 'BUY', askPrice, shares);
      txStatus = submitted ? 'SUBMITTED' : 'FAILED';
      if (!submitted) {
        this.emit('alert', {
          level: 'error',
          title: 'Live CLOB Order Failed',
          message: `Could not submit live CLOB BUY ${outcome} order. Check API credentials.`,
        });
        return null;
      }
    }

    this.cashBalanceUsd = Number((this.cashBalanceUsd - cleanUsd).toFixed(2));

    const existing = this.positions.find(
      (p) => p.windowStartSec === market.windowStartSec && p.outcome === outcome
    );

    if (existing) {
      const totalCost = existing.costBasisUsd + cleanUsd;
      const totalShares = existing.shares + shares;
      existing.avgEntryPrice = Number((totalCost / totalShares).toFixed(4));
      existing.shares = Number(totalShares.toFixed(2));
      existing.costBasisUsd = Number(totalCost.toFixed(2));
      existing.currentMarkPrice = book.bestBid;
      existing.unrealizedPnlUsd = Number(
        (existing.shares * existing.currentMarkPrice - existing.costBasisUsd).toFixed(2)
      );
    } else {
      const newPos: Position = {
        id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        windowStartSec: market.windowStartSec,
        windowEndSec: market.windowEndSec,
        marketSlug: market.slug,
        outcome,
        tokenId: book.tokenId,
        shares,
        avgEntryPrice: effectiveEntryPrice,
        costBasisUsd: Number(cleanUsd.toFixed(2)),
        currentMarkPrice: book.bestBid,
        unrealizedPnlUsd: Number((shares * book.bestBid - cleanUsd).toFixed(2)),
        unrealizedPnlPct: Number(
          (((shares * book.bestBid - cleanUsd) / cleanUsd) * 100).toFixed(2)
        ),
        entryTimestamp: Date.now(),
        entryStrikePrice: market.strikePrice,
        entryFastPrice: signal.fastMidPrice,
        entryOraclePrice: signal.chainlinkPrice,
        entryEdgePct: edgePct,
        signalRegime: signal.signalRegime,
        mode: this.config.executionMode,
      };
      this.positions.push(newPos);
    }

    const trade: TradeRecord = {
      id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      windowStartSec: market.windowStartSec,
      marketSlug: market.slug,
      side: 'BUY',
      outcome,
      shares,
      price: effectiveEntryPrice,
      amountUsd: Number(cleanUsd.toFixed(2)),
      pnlUsd: null,
      pnlPct: null,
      edgeAtEntryPct: edgePct,
      regime: signal.signalRegime,
      reason: `Buy ${outcome} @ ${(askPrice * 100).toFixed(0)}¢ (Edge ${edgePct >= 0 ? '+' : ''}${edgePct}%)`,
      mode: this.config.executionMode,
      txStatus,
    };

    this.trades.unshift(trade);
    this.recordEquityPoint();
    this.saveState();

    this.emit('trade', trade);
    this.emit('alert', {
      level: 'success',
      title: `Bought ${outcome} (${shares.toFixed(1)} shares)`,
      message: `Entry ${(effectiveEntryPrice * 100).toFixed(1)}¢ ($${cleanUsd.toFixed(2)}) | Edge: ${
        edgePct >= 0 ? '+' : ''
      }${edgePct}%`,
    });

    return trade;
  }

  public closePosition(
    positionId: string,
    market: Active5mMarket,
    reason = 'Manual Sell'
  ): TradeRecord | null {
    const idx = this.positions.findIndex((p) => p.id === positionId);
    if (idx === -1) return null;

    const pos = this.positions[idx];
    const book = pos.outcome === 'UP' ? market.upBook : market.downBook;
    const bidPrice = Math.max(0.01, book.bestBid);
    const feeMultiplier = 1 - this.config.feeRateBps / 10000;
    const effectiveExitPrice = Number((bidPrice * feeMultiplier).toFixed(4));
    const proceedsUsd = Number((pos.shares * effectiveExitPrice).toFixed(2));
    const pnlUsd = Number((proceedsUsd - pos.costBasisUsd).toFixed(2));
    const pnlPct = Number(((pnlUsd / Math.max(0.01, pos.costBasisUsd)) * 100).toFixed(2));

    this.positions.splice(idx, 1);
    this.cashBalanceUsd = Number((this.cashBalanceUsd + proceedsUsd).toFixed(2));
    this.config.bankrollUsd = this.getTotalEquity();

    const trade: TradeRecord = {
      id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      windowStartSec: pos.windowStartSec,
      marketSlug: pos.marketSlug,
      side: 'SELL',
      outcome: pos.outcome,
      shares: pos.shares,
      price: effectiveExitPrice,
      amountUsd: proceedsUsd,
      pnlUsd,
      pnlPct,
      edgeAtEntryPct: pos.entryEdgePct,
      regime: pos.signalRegime,
      reason,
      mode: pos.mode,
      txStatus: pos.mode === 'LIVE_CLOB' ? 'SUBMITTED' : 'SIMULATED',
    };

    this.trades.unshift(trade);
    this.recordEquityPoint();
    this.saveState();

    this.emit('trade', trade);
    this.emit('alert', {
      level: pnlUsd >= 0 ? 'success' : 'warning',
      title: `Sold ${pos.outcome} (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})`,
      message: `Sold @ ${(effectiveExitPrice * 100).toFixed(1)}¢ (${
        pnlPct >= 0 ? '+' : ''
      }${pnlPct.toFixed(1)}%)`,
    });

    return trade;
  }

  public settleWindow(settlement: {
    windowStartSec: number;
    windowEndSec: number;
    slug: string;
    strikePrice: number;
    closePrice: number;
    winner: 'UP' | 'DOWN';
  }): void {
    const windowPositions = this.positions.filter(
      (p) => p.windowStartSec <= settlement.windowStartSec
    );

    let windowNetPnl = 0;
    let windowTradesCount = 0;

    for (const pos of windowPositions) {
      const won = pos.outcome === settlement.winner;
      const payoutPerShare = won ? 1.0 : 0.0;
      const payoutUsd = Number((pos.shares * payoutPerShare).toFixed(2));
      const pnlUsd = Number((payoutUsd - pos.costBasisUsd).toFixed(2));
      const pnlPct = Number(((pnlUsd / Math.max(0.01, pos.costBasisUsd)) * 100).toFixed(2));

      this.cashBalanceUsd = Number((this.cashBalanceUsd + payoutUsd).toFixed(2));
      windowNetPnl += pnlUsd;
      windowTradesCount += 1;

      const settleTrade: TradeRecord = {
        id: `settle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        windowStartSec: pos.windowStartSec,
        marketSlug: pos.marketSlug,
        side: 'SETTLE',
        outcome: pos.outcome,
        shares: pos.shares,
        price: payoutPerShare,
        amountUsd: payoutUsd,
        pnlUsd,
        pnlPct,
        edgeAtEntryPct: pos.entryEdgePct,
        regime: pos.signalRegime,
        reason: `Settled ${settlement.winner}: Oracle $${settlement.closePrice.toFixed(
          2
        )} vs Strike $${settlement.strikePrice.toFixed(2)}`,
        mode: pos.mode,
        txStatus: 'FILLED',
      };

      this.trades.unshift(settleTrade);
      this.emit('trade', settleTrade);

      this.emit('alert', {
        level: won ? 'success' : 'warning',
        title: `5m Settled ${settlement.winner}: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`,
        message: `Close $${settlement.closePrice.toFixed(
          2
        )} vs Strike $${settlement.strikePrice.toFixed(2)}`,
      });
    }

    this.positions = this.positions.filter(
      (p) => p.windowStartSec > settlement.windowStartSec
    );
    this.config.bankrollUsd = this.getTotalEquity();

    const earlyClosedInWindow = this.trades.filter(
      (t) => t.windowStartSec === settlement.windowStartSec && t.side === 'SELL'
    );
    for (const t of earlyClosedInWindow) {
      windowNetPnl += t.pnlUsd || 0;
      windowTradesCount += 1;
    }

    const historyItem: WindowHistoryItem = {
      windowStartSec: settlement.windowStartSec,
      windowEndSec: settlement.windowEndSec,
      strikePrice: Number(settlement.strikePrice.toFixed(2)),
      closePrice: Number(settlement.closePrice.toFixed(2)),
      winner: settlement.winner,
      deltaUsd: Number((settlement.closePrice - settlement.strikePrice).toFixed(2)),
      tradesCount: windowTradesCount,
      netPnlUsd: Number(windowNetPnl.toFixed(2)),
    };

    this.windowHistory.unshift(historyItem);
    if (this.windowHistory.length > 50) this.windowHistory.pop();

    this.recordEquityPoint();
    this.saveState();
  }

  private recordEquityPoint(): void {
    this.equityCurve.push({
      t: Date.now(),
      equity: this.getTotalEquity(),
    });
    if (this.equityCurve.length > 300) {
      this.equityCurve.splice(0, this.equityCurve.length - 300);
    }
  }

  private async submitLiveClobOrder(
    tokenId: string,
    side: 'BUY' | 'SELL',
    price: number,
    size: number
  ): Promise<boolean> {
    if (this.polymarketSdk.authStatus.canSignOrders) {
      const sdkResp = await this.polymarketSdk.placeLiveOrderViaSdk({
        tokenId,
        side,
        price,
        size,
      });
      if (sdkResp.ok) return true;
    }

    try {
      const apiKey = process.env.POLYMARKET_API_KEY!;
      const secret = process.env.POLYMARKET_SECRET!;
      const passphrase = process.env.POLYMARKET_PASSPHRASE!;
      if (!apiKey || !secret || !passphrase) return false;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const method = 'POST';
      const requestPath = '/order';

      const bodyObj = {
        order: {
          tokenID: tokenId,
          price: Number(price.toFixed(2)),
          side,
          size: Number(size.toFixed(2)),
          feeRateBps: '0',
          nonce: String(Date.now()),
        },
        owner: apiKey,
        orderType: 'GTC',
      };
      const bodyStr = JSON.stringify(bodyObj);

      const message = `${timestamp}${method}${requestPath}${bodyStr}`;
      const base64Secret = Buffer.from(secret, 'base64');
      const hmac = crypto.createHmac('sha256', base64Secret).update(message).digest('base64');
      const signature = hmac.replace(/\+/g, '-').replace(/\//g, '_');

      const res = await fetch(`https://clob.polymarket.com${requestPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          POLY_API_KEY: apiKey,
          POLY_PASSPHRASE: passphrase,
          POLY_TIMESTAMP: timestamp,
          POLY_SIGNATURE: signature,
        },
        body: bodyStr,
        signal: AbortSignal.timeout(4000),
      });

      return res.ok;
    } catch {
      return false;
    }
  }
}
