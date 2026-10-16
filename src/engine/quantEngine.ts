import type { Active5mMarket, QuantSignal, StrategyConfig } from '../types.ts';
import type { PriceFeedManager } from '../feeds/priceFeeds.ts';

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export class QuantEngine {
  private priceFeeds: PriceFeedManager;

  constructor(priceFeeds: PriceFeedManager) {
    this.priceFeeds = priceFeeds;
  }

  public computeSignal(
    market: Active5mMarket,
    config: StrategyConfig,
    serverNowMs?: number,
    extraPrices?: { polymarketSpotPrice?: number; twap60sPrice?: number }
  ): QuantSignal {
    const now = serverNowMs || Date.now();
    const nowSec = now / 1000;
    const timeRemainingSec = Math.max(0, Number((market.windowEndSec - nowSec).toFixed(1)));

    const fastMidPrice = this.priceFeeds.getFastMidPrice();
    const binanceSpotPrice = this.priceFeeds.getBinanceSpotPrice();
    const binancePerpPrice = this.priceFeeds.getBinancePerpPrice();
    const coinbaseSpotPrice = this.priceFeeds.getCoinbasePrice();
    const chainlinkPrice = this.priceFeeds.getChainlinkPrice();
    const polymarketSpotPrice =
      extraPrices?.polymarketSpotPrice && extraPrices.polymarketSpotPrice > 1000
        ? extraPrices.polymarketSpotPrice
        : fastMidPrice;
    const twap60sPrice =
      extraPrices?.twap60sPrice && extraPrices.twap60sPrice > 1000
        ? extraPrices.twap60sPrice
        : chainlinkPrice;
    const strikePrice = market.strikePrice;

    const distanceToStrikeUsd = chainlinkPrice - strikePrice;
    const fastDistanceToStrikeUsd = fastMidPrice - strikePrice;

    // Lead-Lag divergence: how far Fast Exchange Composite is ahead of Chainlink Oracle
    const oracleLagUsd = fastMidPrice - chainlinkPrice;
    const oracleLagBps = chainlinkPrice > 0 ? (oracleLagUsd / chainlinkPrice) * 10000 : 0;

    // Microstructure velocity & orderflow
    const momentum1sUsd = this.priceFeeds.getPriceChangeOver(1000);
    const momentum5sUsd = this.priceFeeds.getPriceChangeOver(5000);
    const momentum15sUsd = this.priceFeeds.getPriceChangeOver(15000);
    const aggressorCvd5s = this.priceFeeds.getAggressorCvd(5000);
    const orderbookImbalance = this.priceFeeds.getOrderbookImbalance();

    // Realized volatility
    const realizedVolPerSec = this.priceFeeds.getRealizedVolatilityPerSec(60_000);
    // Annualized vol = perSecVol * sqrt(365.25 * 86400)
    const realizedVolAnnualized = realizedVolPerSec * Math.sqrt(31_557_600);

    // Projected Oracle Price in 1.5 - 3.0 seconds:
    // Combines current fast exchange lead + short-term aggressor flow continuation
    const flowBoostUsd =
      Math.sign(momentum1sUsd) === Math.sign(oracleLagUsd)
        ? momentum1sUsd * 0.35 + orderbookImbalance * 2.5
        : orderbookImbalance * 1.2;
    const projectedOraclePrice = chainlinkPrice + 0.88 * oracleLagUsd + flowBoostUsd;

    // Drift-adjusted Binary Option Fair Probability P(S_T >= K)
    // Near expiry (tau < 3s), use tight volatility floor
    const effectiveTau = Math.max(0.75, timeRemainingSec);
    const remainingSigma = Math.max(0.000018, realizedVolPerSec * Math.sqrt(effectiveTau));

    // Short-horizon momentum log-drift (decays over remaining time, capped so it doesn't over-extrapolate)
    const momentumHorizonWeight = Math.min(1.0, 12 / Math.max(4, effectiveTau));
    const shortDriftUsd =
      (momentum5sUsd * 0.22 + aggressorCvd5s * 1.4 + orderbookImbalance * 3.0) *
      momentumHorizonWeight;
    const effectiveSpotForModel = Math.max(1000, projectedOraclePrice + shortDriftUsd);

    const logMoneyness = Math.log(effectiveSpotForModel / strikePrice);
    const zScore = logMoneyness / remainingSigma;

    const rawProbUp = normalCdf(zScore);
    const fairProbUp = Number(Math.max(0.01, Math.min(0.99, rawProbUp)).toFixed(4));
    const fairProbDown = Number((1 - fairProbUp).toFixed(4));

    const marketAskUp = market.upBook.bestAsk;
    const marketBidUp = market.upBook.bestBid;
    const marketAskDown = market.downBook.bestAsk;
    const marketBidDown = market.downBook.bestBid;

    const estFee = config.feeRateBps / 10000;
    const edgeUp = Number((fairProbUp - marketAskUp - estFee).toFixed(4));
    const edgeDown = Number((fairProbDown - marketAskDown - estFee).toFixed(4));

    // Determine best side and regime
    const minEdge = config.minEdgePct / 100;
    let action: QuantSignal['action'] = 'HOLD';
    let signalRegime: QuantSignal['signalRegime'] = 'NEUTRAL';
    let confidence = 0;
    let recommendedSizeUsd = 0;
    let reason = 'No clear edge · Fair odds match Polymarket';

    const bestSide = edgeUp >= edgeDown ? 'UP' : 'DOWN';
    const bestEdge = bestSide === 'UP' ? edgeUp : edgeDown;
    const bestAsk = bestSide === 'UP' ? marketAskUp : marketAskDown;

    // Avoid entering in the final 1.5 seconds (settlement lock risk) or if ask is >= 0.96
    const tradeableWindow = timeRemainingSec >= 2.0 && timeRemainingSec <= 298 && bestAsk <= 0.95 && bestAsk >= 0.04;

    if (tradeableWindow && bestEdge >= minEdge) {
      const isUp = bestSide === 'UP';
      const leadAligned = isUp
        ? oracleLagUsd >= config.minOracleLeadUsd
        : oracleLagUsd <= -config.minOracleLeadUsd;
      const momentumAligned = isUp ? momentum5sUsd > 4 : momentum5sUsd < -4;

      if (config.enableFinalMinuteSnipe && timeRemainingSec <= 65 && Math.abs(oracleLagUsd) >= config.minOracleLeadUsd * 0.7) {
        signalRegime = 'LATENCY_SNIPE';
      } else if (leadAligned) {
        signalRegime = 'ORACLE_LEAD_ARB';
      } else if (momentumAligned && Math.abs(aggressorCvd5s) > 0.3) {
        signalRegime = 'MOMENTUM_BREAKOUT';
      } else {
        signalRegime = 'FAIR_VALUE_MISPRICING';
      }

      action = isUp ? 'BUY_UP' : 'BUY_DOWN';

      // Confidence score (0..100)
      const edgeScore = Math.min(55, (bestEdge / Math.max(0.01, minEdge)) * 28);
      const leadScore = Math.min(25, (Math.abs(oracleLagUsd) / Math.max(1, config.minOracleLeadUsd)) * 14);
      const flowScore = Math.min(20, Math.abs(orderbookImbalance) * 12 + Math.min(8, Math.abs(aggressorCvd5s) * 2));
      confidence = Math.min(99, Math.round(edgeScore + leadScore + flowScore));

      // Fractional Kelly Sizing: f* = kellyFraction * (edge / (1 - ask))
      const kellyFull = bestEdge / Math.max(0.05, 1 - bestAsk);
      const rawSize = config.bankrollUsd * config.kellyFraction * kellyFull;
      recommendedSizeUsd = Math.max(
        5,
        Math.min(config.maxSingleOrderUsd, Math.round(rawSize))
      );

      const dirSign = oracleLagUsd >= 0 ? '+' : '';
      reason = `Model ${isUp ? 'UP' : 'DOWN'} ${(
        (isUp ? fairProbUp : fairProbDown) * 100
      ).toFixed(1)}% vs Ask ${(bestAsk * 100).toFixed(0)}¢ · Edge +${(bestEdge * 100).toFixed(
        1
      )}% · Lead ${dirSign}$${oracleLagUsd.toFixed(1)}`;
    }

    return {
      timestamp: now,
      fastMidPrice: Number(fastMidPrice.toFixed(2)),
      binanceSpotPrice: Number(binanceSpotPrice.toFixed(2)),
      binancePerpPrice: Number(binancePerpPrice.toFixed(2)),
      coinbaseSpotPrice: Number(coinbaseSpotPrice.toFixed(2)),
      polymarketSpotPrice: Number(polymarketSpotPrice.toFixed(2)),
      chainlinkPrice: Number(chainlinkPrice.toFixed(2)),
      twap60sPrice: Number(twap60sPrice.toFixed(2)),
      projectedOraclePrice: Number(projectedOraclePrice.toFixed(2)),
      strikePrice: Number(strikePrice.toFixed(2)),
      distanceToStrikeUsd: Number(distanceToStrikeUsd.toFixed(2)),
      fastDistanceToStrikeUsd: Number(fastDistanceToStrikeUsd.toFixed(2)),
      oracleLagUsd: Number(oracleLagUsd.toFixed(2)),
      oracleLagBps: Number(oracleLagBps.toFixed(2)),
      momentum1sUsd: Number(momentum1sUsd.toFixed(2)),
      momentum5sUsd: Number(momentum5sUsd.toFixed(2)),
      momentum15sUsd: Number(momentum15sUsd.toFixed(2)),
      aggressorCvd5s: Number(aggressorCvd5s.toFixed(3)),
      orderbookImbalance: Number(orderbookImbalance.toFixed(3)),
      realizedVolAnnualized: Number(realizedVolAnnualized.toFixed(4)),
      realizedVolPerSec: Number(realizedVolPerSec.toFixed(6)),
      timeRemainingSec,
      fairProbUp,
      fairProbDown,
      marketAskUp,
      marketBidUp,
      marketAskDown,
      marketBidDown,
      edgeUp,
      edgeDown,
      action,
      signalRegime,
      confidence,
      recommendedSizeUsd,
      reason,
    };
  }
}
