export interface ExchangeTick {
  source: 'binance_spot' | 'binance_perp' | 'coinbase' | 'chainlink' | 'polymarket_rtds';
  price: number;
  bid: number;
  ask: number;
  timestamp: number;
  latencyMs: number;
}

export interface OrderbookLevel {
  price: number; // 0.01 to 0.99
  size: number;  // shares
}

export interface PolymarketTokenBook {
  tokenId: string;
  outcome: 'UP' | 'DOWN';
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalance: number; // -1 to +1
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  lastUpdated: number;
}

export interface Active5mMarket {
  slug: string;
  conditionId: string;
  question: string;
  windowStartSec: number; // Unix timestamp in seconds (divisible by 300)
  windowEndSec: number;   // windowStartSec + 300
  strikePrice: number;    // Chainlink BTC/USD price at windowStartSec ("Price to Beat")
  strikeLocked: boolean;
  upBook: PolymarketTokenBook;
  downBook: PolymarketTokenBook;
  isSimulatedBook: boolean;
}

export interface QuantSignal {
  timestamp: number;
  // Prices
  fastMidPrice: number;       // Lead-weighted Binance Perp + Spot + Coinbase
  polymarketSpotPrice: number; // Polymarket RTDS crypto_prices (btcusdt) + fast exchange price
  binanceSpotPrice: number;
  binancePerpPrice: number;
  coinbaseSpotPrice: number;
  chainlinkPrice: number;     // Settlement reference price (Chainlink BTC/USD)
  twap60sPrice: number;       // 60s rolling Chainlink TWAP
  projectedOraclePrice: number; // Where Chainlink is projected to print next (1-2s lead)
  strikePrice: number;        // 5m Window "Price to Beat"
  distanceToStrikeUsd: number; // chainlinkPrice - strikePrice
  fastDistanceToStrikeUsd: number; // fastMidPrice - strikePrice

  // Lead-Lag & Microstructure
  oracleLagUsd: number;       // fastMidPrice - chainlinkPrice (+ means exchanges leading higher)
  oracleLagBps: number;       // oracleLagUsd / chainlinkPrice * 10000
  momentum1sUsd: number;      // 1-second price velocity ($/s)
  momentum5sUsd: number;      // 5-second price change ($)
  momentum15sUsd: number;     // 15-second price change ($)
  aggressorCvd5s: number;     // Net buy minus sell volume in BTC over last 5s
  orderbookImbalance: number; // Combined exchange top-of-book imbalance (-1 to +1)
  realizedVolAnnualized: number; // Annualized realized volatility (e.g. 0.45 = 45%)
  realizedVolPerSec: number;  // Per-second log return volatility

  // Probabilities & Edge
  timeRemainingSec: number;
  fairProbUp: number;         // Model true probability of BTC >= Strike at T_end (0..1)
  fairProbDown: number;       // 1 - fairProbUp
  marketAskUp: number;        // Best ask for UP on Polymarket (0..1)
  marketBidUp: number;        // Best bid for UP on Polymarket
  marketAskDown: number;      // Best ask for DOWN on Polymarket
  marketBidDown: number;      // Best bid for DOWN on Polymarket
  edgeUp: number;             // fairProbUp - marketAskUp - estFee
  edgeDown: number;           // fairProbDown - marketAskDown - estFee

  // Actionable Recommendation
  action: 'BUY_UP' | 'BUY_DOWN' | 'HOLD' | 'TAKE_PROFIT';
  signalRegime: 'LATENCY_SNIPE' | 'ORACLE_LEAD_ARB' | 'MOMENTUM_BREAKOUT' | 'FAIR_VALUE_MISPRICING' | 'NEUTRAL';
  confidence: number;         // 0 to 100
  recommendedSizeUsd: number; // Kelly-sized bet in USD
  reason: string;
}

export interface StrategyConfig {
  executionMode: 'PAPER' | 'LIVE_CLOB';
  bankrollUsd: number;
  minEdgePct: number;          // e.g. 3.0 means +3.0% minimum net edge to trigger signal
  minOracleLeadUsd: number;    // Minimum lead-lag divergence ($) for oracle arb boost
  kellyFraction: number;       // e.g. 0.25 (Quarter Kelly) for recommended bet size
  maxSingleOrderUsd: number;   // Max recommended USD per trade
  enableFinalMinuteSnipe: boolean; // Highlight final-65s latency snipe opportunities
  feeRateBps: number;          // Estimated effective Polymarket fee/slippage bps
}

export interface Position {
  id: string;
  windowStartSec: number;
  windowEndSec: number;
  marketSlug: string;
  outcome: 'UP' | 'DOWN';
  tokenId: string;
  shares: number;
  avgEntryPrice: number;       // 0..1
  costBasisUsd: number;
  currentMarkPrice: number;    // Current bid/mark price
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  entryTimestamp: number;
  entryStrikePrice: number;
  entryFastPrice: number;
  entryOraclePrice: number;
  entryEdgePct: number;
  signalRegime: string;
  mode: 'PAPER' | 'LIVE_CLOB';
}

export interface TradeRecord {
  id: string;
  timestamp: number;
  windowStartSec: number;
  marketSlug: string;
  side: 'BUY' | 'SELL' | 'SETTLE';
  outcome: 'UP' | 'DOWN';
  shares: number;
  price: number;
  amountUsd: number;
  pnlUsd: number | null;
  pnlPct: number | null;
  edgeAtEntryPct: number;
  regime: string;
  reason: string;
  mode: 'PAPER' | 'LIVE_CLOB';
  txStatus: 'FILLED' | 'SIMULATED' | 'SUBMITTED' | 'FAILED';
}

export interface WindowHistoryItem {
  windowStartSec: number;
  windowEndSec: number;
  strikePrice: number;
  closePrice: number;
  winner: 'UP' | 'DOWN';
  deltaUsd: number;
  tradesCount: number;
  netPnlUsd: number;
}

export interface PriceChartPoint {
  t: number;
  fast: number;
  polySpot?: number;
  oracle: number;
  strike: number;
  upAsk: number;
}
