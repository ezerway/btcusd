import { EventEmitter } from 'node:events';
import type { Active5mMarket, OrderbookLevel, PolymarketTokenBook } from '../types.ts';
import type { PriceFeedManager } from './priceFeeds.ts';
import type { PolymarketSdkService } from '../sdk/polymarketSdk.ts';

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

export class Polymarket5mManager extends EventEmitter {
  private priceFeeds: PriceFeedManager;
  private polymarketSdk: PolymarketSdkService;
  private activeMarket: Active5mMarket;
  private clobWs: WebSocket | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private bookPollInterval: ReturnType<typeof setInterval> | null = null;
  private isStopping = false;
  private manualStrikeOverridden = false;

  private laggedMmRefPrice = 0;

  public clobStatus: { connected: boolean; mode: string; slug: string; lastUpdate: number } = {
    connected: false,
    mode: 'initializing',
    slug: '',
    lastUpdate: 0,
  };

  constructor(priceFeeds: PriceFeedManager, polymarketSdk: PolymarketSdkService) {
    super();
    this.priceFeeds = priceFeeds;
    this.polymarketSdk = polymarketSdk;
    const nowSec = this.polymarketSdk.getServerNowSec();
    const startSec = Math.floor(nowSec / 300) * 300;
    this.activeMarket = this.createInitialMarket(startSec, priceFeeds.getChainlinkPrice());

    // Wire official Polymarket 5m Price to Beat (`openPrice`) & Current Price (`closePrice`)
    this.polymarketSdk.on('polymarket_5m_price', (data) => {
      if (data.windowStartSec === this.activeMarket.windowStartSec && !this.manualStrikeOverridden) {
        this.activeMarket.strikePrice = data.priceToBeat;
        this.activeMarket.strikeLocked = true;
      }
      if (data.currentPrice > 1000) {
        this.priceFeeds.setOfficialPolymarketPrice(data.currentPrice, 'polymarket_sdk_5m');
      }
    });

    // Wire @polymarket/real-time-data-client sub-second Chainlink BTC/USD stream
    this.polymarketSdk.on('rtds_btc_price', ({ price }) => {
      if (price > 1000) {
        this.priceFeeds.setOfficialPolymarketPrice(price, 'polymarket_rtds_sdk');
      }
    });
  }

  public start(): void {
    this.isStopping = false;
    this.checkWindowRollover();
    this.discoverCurrent5mMarket();

    this.tickInterval = setInterval(() => {
      this.checkWindowRollover();
      if (this.activeMarket.isSimulatedBook) {
        this.updateSimulatedOrderbook();
      }
    }, 200);

    // Poll live CLOB books via @polymarket/clob-client SDK every 1.2s
    this.bookPollInterval = setInterval(() => {
      if (!this.activeMarket.isSimulatedBook) {
        this.pollLiveClobBooksViaSdk();
      }
    }, 1200);
  }

  public stop(): void {
    this.isStopping = true;
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.bookPollInterval) clearInterval(this.bookPollInterval);
    if (this.clobWs) {
      try {
        this.clobWs.close();
      } catch {
        // ignore
      }
    }
  }

  public getActiveMarket(): Active5mMarket {
    return this.activeMarket;
  }

  public setManualStrikePrice(strikePrice: number): void {
    if (strikePrice > 1000) {
      this.activeMarket.strikePrice = strikePrice;
      this.activeMarket.strikeLocked = true;
      this.manualStrikeOverridden = true;
      if (this.activeMarket.isSimulatedBook) {
        this.updateSimulatedOrderbook();
      }
    }
  }

  private createInitialMarket(windowStartSec: number, initialStrike: number): Active5mMarket {
    const windowEndSec = windowStartSec + 300;
    const slug = `btc-updown-5m-${windowStartSec}`;
    const strike = initialStrike > 1000 ? initialStrike : 84200;
    this.laggedMmRefPrice = strike;
    this.manualStrikeOverridden = false;

    return {
      slug,
      conditionId: `0x5m_${windowStartSec}`,
      question: `Bitcoin Up or Down - 5m (${new Date(windowStartSec * 1000).toISOString().slice(11, 16)} - ${new Date(windowEndSec * 1000).toISOString().slice(11, 16)} UTC)`,
      windowStartSec,
      windowEndSec,
      strikePrice: strike,
      strikeLocked: initialStrike > 1000,
      upBook: this.buildEmptyBook(`up_${windowStartSec}`, 'UP', 0.5),
      downBook: this.buildEmptyBook(`down_${windowStartSec}`, 'DOWN', 0.5),
      isSimulatedBook: true,
    };
  }

  private buildEmptyBook(tokenId: string, outcome: 'UP' | 'DOWN', mid: number): PolymarketTokenBook {
    const bestBid = Math.max(0.01, Math.min(0.98, Number((mid - 0.01).toFixed(2))));
    const bestAsk = Math.max(0.02, Math.min(0.99, Number((mid + 0.01).toFixed(2))));
    return {
      tokenId,
      outcome,
      bestBid,
      bestAsk,
      mid: Number(((bestBid + bestAsk) / 2).toFixed(3)),
      spread: Number((bestAsk - bestBid).toFixed(3)),
      bidDepthUsd: 1250,
      askDepthUsd: 1250,
      imbalance: 0,
      bids: [
        { price: bestBid, size: 800 },
        { price: Math.max(0.01, Number((bestBid - 0.01).toFixed(2))), size: 1500 },
        { price: Math.max(0.01, Number((bestBid - 0.02).toFixed(2))), size: 2400 },
      ],
      asks: [
        { price: bestAsk, size: 800 },
        { price: Math.min(0.99, Number((bestAsk + 0.01).toFixed(2))), size: 1500 },
        { price: Math.min(0.99, Number((bestAsk + 0.02).toFixed(2))), size: 2400 },
      ],
      lastUpdated: Date.now(),
    };
  }

  private checkWindowRollover(): void {
    const nowSec = this.polymarketSdk.getServerNowSec();
    const currentWindowStart = Math.floor(nowSec / 300) * 300;
    const oraclePrice = this.priceFeeds.getChainlinkPrice();

    if (!this.activeMarket.strikeLocked && oraclePrice > 1000) {
      this.activeMarket.strikePrice = oraclePrice;
      this.activeMarket.strikeLocked = true;
    }

    if (currentWindowStart !== this.activeMarket.windowStartSec) {
      const prevMarket = this.activeMarket;
      const closePrice = oraclePrice > 1000 ? oraclePrice : prevMarket.strikePrice;
      const winner: 'UP' | 'DOWN' = closePrice >= prevMarket.strikePrice ? 'UP' : 'DOWN';

      this.emit('window_settled', {
        windowStartSec: prevMarket.windowStartSec,
        windowEndSec: prevMarket.windowEndSec,
        slug: prevMarket.slug,
        strikePrice: prevMarket.strikePrice,
        closePrice,
        winner,
      });

      this.activeMarket = this.createInitialMarket(currentWindowStart, closePrice);
      this.discoverCurrent5mMarket();
      this.emit('window_started', this.activeMarket);
    }
  }

  private async discoverCurrent5mMarket(): Promise<void> {
    const slug = this.activeMarket.slug;
    this.clobStatus.slug = slug;

    // 1. Fetch official 5m Price to Beat & Current Price via PolymarketSdkService
    const officialPrice = await this.polymarketSdk.fetchOfficial5mPrice(
      this.activeMarket.windowStartSec,
      this.activeMarket.windowEndSec
    );
    if (officialPrice && !this.manualStrikeOverridden) {
      this.activeMarket.strikePrice = officialPrice.priceToBeat;
      this.activeMarket.strikeLocked = true;
      this.priceFeeds.setOfficialPolymarketPrice(officialPrice.currentPrice, 'polymarket_sdk_5m');
    }

    // 2. Fetch active 5m Market Token IDs from Gamma API
    try {
      const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`Gamma HTTP ${res.status}`);
      const events = (await res.json()) as Array<Record<string, unknown>>;
      if (Array.isArray(events) && events.length > 0) {
        const ev = events[0];
        const markets = (ev.markets as Array<Record<string, unknown>>) || [];
        if (markets.length > 0) {
          const m = markets[0];
          const rawTokens = m.clobTokenIds;
          let tokenIds: string[] = [];
          if (typeof rawTokens === 'string') {
            try {
              tokenIds = JSON.parse(rawTokens);
            } catch {
              tokenIds = [];
            }
          } else if (Array.isArray(rawTokens)) {
            tokenIds = rawTokens.map(String);
          }

          if (tokenIds.length >= 2) {
            this.activeMarket.conditionId = String(m.conditionId || this.activeMarket.conditionId);
            this.activeMarket.question = String(m.question || ev.title || this.activeMarket.question);
            this.activeMarket.upBook.tokenId = tokenIds[0];
            this.activeMarket.downBook.tokenId = tokenIds[1];
            this.activeMarket.isSimulatedBook = false;
            this.clobStatus.connected = true;
            this.clobStatus.mode = 'polymarket_clob_sdk';
            this.clobStatus.lastUpdate = Date.now();

            this.connectClobWebSocket(tokenIds);
            await this.pollLiveClobBooksViaSdk();
            return;
          }
        }
      }
    } catch {
      // Fallback to MM book model if offline
    }

    this.activeMarket.isSimulatedBook = true;
    this.clobStatus.connected = true;
    this.clobStatus.mode = 'mm_book_model';
    this.clobStatus.lastUpdate = Date.now();
    this.updateSimulatedOrderbook();
  }

  private connectClobWebSocket(tokenIds: string[]): void {
    if (this.clobWs) {
      try {
        this.clobWs.close();
      } catch {
        // ignore
      }
    }
    try {
      const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
      this.clobWs = ws;

      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            assets_ids: tokenIds,
            type: 'market',
          })
        );
      });

      ws.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(String(event.data));
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const assetId = String(item.asset_id || '');
            if (item.event_type === 'book' && assetId) {
              if (assetId === this.activeMarket.upBook.tokenId) {
                this.applyClobBookSnapshot(this.activeMarket.upBook, item.bids, item.asks);
              } else if (assetId === this.activeMarket.downBook.tokenId) {
                this.applyClobBookSnapshot(this.activeMarket.downBook, item.bids, item.asks);
              }
            }
          }
        } catch {
          // ignore
        }
      });
    } catch {
      // SDK polling will still run
    }
  }

  /**
   * Uses official @polymarket/clob-client SDK `getOrderBooks`
   */
  private async pollLiveClobBooksViaSdk(): Promise<void> {
    if (this.activeMarket.isSimulatedBook) return;
    const books = await this.polymarketSdk.fetchOrderBooksViaSdk(
      this.activeMarket.upBook.tokenId,
      this.activeMarket.downBook.tokenId
    );
    if (books) {
      this.applyClobBookSnapshot(
        this.activeMarket.upBook,
        books.upBook.bids || [],
        books.upBook.asks || []
      );
      this.applyClobBookSnapshot(
        this.activeMarket.downBook,
        books.downBook.bids || [],
        books.downBook.asks || []
      );
      this.clobStatus.lastUpdate = Date.now();
      this.clobStatus.mode = 'polymarket_clob_sdk';
    }
  }

  private applyClobBookSnapshot(
    targetBook: PolymarketTokenBook,
    rawBids: unknown[],
    rawAsks: unknown[]
  ): void {
    const parseLevels = (arr: unknown[], sortDesc: boolean): OrderbookLevel[] => {
      const levels: OrderbookLevel[] = [];
      for (const item of arr) {
        const rec = item as Record<string, unknown>;
        const price = parseFloat(String(rec.price || '0'));
        const size = parseFloat(String(rec.size || '0'));
        if (price > 0 && price < 1 && size > 0) {
          levels.push({ price, size });
        }
      }
      levels.sort((a, b) => (sortDesc ? b.price - a.price : a.price - b.price));
      return levels.slice(0, 6);
    };

    const bids = parseLevels(rawBids, true);
    const asks = parseLevels(rawAsks, false);

    if (bids.length === 0 && asks.length === 0) return;

    const bestBid = bids.length > 0 ? bids[0].price : 0.01;
    const bestAsk = asks.length > 0 ? asks[0].price : 0.99;
    const mid = Number(((bestBid + bestAsk) / 2).toFixed(3));
    const spread = Number(Math.max(0.01, bestAsk - bestBid).toFixed(3));

    const bidDepthUsd = bids.reduce((sum, l) => sum + l.price * l.size, 0);
    const askDepthUsd = asks.reduce((sum, l) => sum + l.price * l.size, 0);
    const imbalance =
      bidDepthUsd + askDepthUsd > 0
        ? (bidDepthUsd - askDepthUsd) / (bidDepthUsd + askDepthUsd)
        : 0;

    targetBook.bids = bids;
    targetBook.asks = asks;
    targetBook.bestBid = bestBid;
    targetBook.bestAsk = bestAsk;
    targetBook.mid = mid;
    targetBook.spread = spread;
    targetBook.bidDepthUsd = Math.round(bidDepthUsd);
    targetBook.askDepthUsd = Math.round(askDepthUsd);
    targetBook.imbalance = Number(imbalance.toFixed(3));
    targetBook.lastUpdated = Date.now();
  }

  private updateSimulatedOrderbook(): void {
    const oraclePrice = this.priceFeeds.getChainlinkPrice();
    if (oraclePrice <= 0) return;

    if (this.laggedMmRefPrice <= 0) {
      this.laggedMmRefPrice = oraclePrice;
    } else {
      this.laggedMmRefPrice = this.laggedMmRefPrice + 0.14 * (oraclePrice - this.laggedMmRefPrice);
    }

    const strike = this.activeMarket.strikePrice;
    const nowSec = this.polymarketSdk.getServerNowMs() / 1000;
    const tau = Math.max(1.5, this.activeMarket.windowEndSec - nowSec);
    const volPerSec = this.priceFeeds.getRealizedVolatilityPerSec();

    const denom = Math.max(0.00002, volPerSec * Math.sqrt(tau));
    const zMm = Math.log(this.laggedMmRefPrice / strike) / denom;
    const mmMidUp = Math.max(0.02, Math.min(0.98, normalCdf(zMm)));
    const mmMidDown = Number((1 - mmMidUp).toFixed(3));

    const halfSpread = tau < 25 ? 0.015 : 0.01;

    this.populateSimulatedSide(this.activeMarket.upBook, mmMidUp, halfSpread);
    this.populateSimulatedSide(this.activeMarket.downBook, mmMidDown, halfSpread);
    this.clobStatus.lastUpdate = Date.now();
  }

  private populateSimulatedSide(
    book: PolymarketTokenBook,
    rawMid: number,
    halfSpread: number
  ): void {
    const bestBid = Math.max(0.01, Math.min(0.98, Number((rawMid - halfSpread).toFixed(2))));
    const bestAsk = Math.max(
      bestBid + 0.01,
      Math.min(0.99, Number((rawMid + halfSpread).toFixed(2)))
    );
    const mid = Number(((bestBid + bestAsk) / 2).toFixed(3));
    const spread = Number((bestAsk - bestBid).toFixed(2));

    const bids: OrderbookLevel[] = [
      { price: bestBid, size: 650 },
      { price: Math.max(0.01, Number((bestBid - 0.01).toFixed(2))), size: 1400 },
      { price: Math.max(0.01, Number((bestBid - 0.02).toFixed(2))), size: 2800 },
      { price: Math.max(0.01, Number((bestBid - 0.03).toFixed(2))), size: 4200 },
    ];
    const asks: OrderbookLevel[] = [
      { price: bestAsk, size: 650 },
      { price: Math.min(0.99, Number((bestAsk + 0.01).toFixed(2))), size: 1400 },
      { price: Math.min(0.99, Number((bestAsk + 0.02).toFixed(2))), size: 2800 },
      { price: Math.min(0.99, Number((bestAsk + 0.03).toFixed(2))), size: 4200 },
    ];

    const bidDepthUsd = bids.reduce((sum, l) => sum + l.price * l.size, 0);
    const askDepthUsd = asks.reduce((sum, l) => sum + l.price * l.size, 0);

    book.bestBid = bestBid;
    book.bestAsk = bestAsk;
    book.mid = mid;
    book.spread = spread;
    book.bids = bids;
    book.asks = asks;
    book.bidDepthUsd = Math.round(bidDepthUsd);
    book.askDepthUsd = Math.round(askDepthUsd);
    book.imbalance = Number(
      ((bidDepthUsd - askDepthUsd) / Math.max(1, bidDepthUsd + askDepthUsd)).toFixed(3)
    );
    book.lastUpdated = Date.now();
  }
}
