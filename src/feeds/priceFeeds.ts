import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ExchangeTick } from '../types.ts';

interface TradeSample {
  t: number;
  price: number;
  qty: number;
  isBuyerMaker: boolean; // false = buyer was aggressor (market buy)
}

interface PriceHistoryPoint {
  t: number;
  fastMid: number;
  oracle: number;
}

export class PriceFeedManager extends EventEmitter {
  private binanceSpotTick: ExchangeTick | null = null;
  private binancePerpTick: ExchangeTick | null = null;
  private coinbaseTick: ExchangeTick | null = null;
  private chainlinkTick: ExchangeTick | null = null;

  private recentTrades: TradeSample[] = [];
  private priceHistory: PriceHistoryPoint[] = [];

  private sockets: WebSocket[] = [];
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  private synthInterval: ReturnType<typeof setInterval> | null = null;
  private oracleEstimatorInterval: ReturnType<typeof setInterval> | null = null;

  private isStopping = false;
  private lastExternalTickTime = 0;
  private syntheticBasePrice = 89450.0;
  private syntheticOraclePrice = 89450.0;
  private syntheticMomentum = 0;

  // Connection status tracking for UI
  public feedStatus: Record<string, { connected: boolean; mode: string; lastUpdate: number; latencyMs: number }> = {
    binance_spot: { connected: false, mode: 'connecting', lastUpdate: 0, latencyMs: 0 },
    binance_perp: { connected: false, mode: 'connecting', lastUpdate: 0, latencyMs: 0 },
    coinbase: { connected: false, mode: 'connecting', lastUpdate: 0, latencyMs: 0 },
    chainlink: { connected: false, mode: 'estimator', lastUpdate: 0, latencyMs: 0 },
  };

  public start(): void {
    this.isStopping = false;
    this.connectBinanceSpot();
    this.connectBinancePerp();
    this.connectCoinbase();
    this.connectChainlinkAndPolymarketRtds();
    this.startOracleEstimatorAndWatchdog();
  }

  public stop(): void {
    this.isStopping = true;
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers = [];
    if (this.synthInterval) clearInterval(this.synthInterval);
    if (this.oracleEstimatorInterval) clearInterval(this.oracleEstimatorInterval);
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sockets = [];
  }

  private hasValidChainlinkKeys(): boolean {
    const key = process.env.CHAINLINK_API_KEY || '';
    const secret = process.env.CHAINLINK_USER_SECRET || '';
    return (
      Boolean(key && secret) &&
      !key.includes('your_chainlink') &&
      !secret.includes('your_chainlink')
    );
  }

  private connectBinanceSpot(): void {
    if (this.isStopping) return;
    const url = 'wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/btcusdt@aggTrade';
    try {
      const ws = new WebSocket(url);
      this.sockets.push(ws);

      ws.addEventListener('open', () => {
        this.feedStatus.binance_spot.connected = true;
        this.feedStatus.binance_spot.mode = 'live_ws';
      });

      ws.addEventListener('message', (event) => {
        try {
          const now = Date.now();
          const payload = JSON.parse(String(event.data));
          const stream: string = payload.stream || '';
          const data = payload.data;
          if (!data) return;

          if (stream.includes('bookTicker')) {
            const bid = parseFloat(data.b);
            const ask = parseFloat(data.a);
            if (bid > 0 && ask > 0) {
              const price = (bid + ask) / 2;
              const eventTs = data.E || now;
              const latencyMs = Math.max(1, now - eventTs);
              this.binanceSpotTick = {
                source: 'binance_spot',
                price,
                bid,
                ask,
                timestamp: now,
                latencyMs,
              };
              this.lastExternalTickTime = now;
              this.feedStatus.binance_spot.lastUpdate = now;
              this.feedStatus.binance_spot.latencyMs = latencyMs;
              this.feedStatus.binance_spot.connected = true;
              this.feedStatus.binance_spot.mode = 'live_ws';

              // Compute top-of-book size imbalance
              const bidQty = parseFloat(data.B || '1');
              const askQty = parseFloat(data.A || '1');
              this.latestBookImbalance = (bidQty - askQty) / Math.max(0.0001, bidQty + askQty);

              this.onNewTick();
            }
          } else if (stream.includes('aggTrade')) {
            const price = parseFloat(data.p);
            const qty = parseFloat(data.q);
            const isBuyerMaker = Boolean(data.m);
            if (price > 0 && qty > 0) {
              this.recentTrades.push({
                t: now,
                price,
                qty,
                isBuyerMaker,
              });
              if (this.recentTrades.length > 2000) {
                this.recentTrades.splice(0, this.recentTrades.length - 1200);
              }
            }
          }
        } catch {
          // ignore malformed tick
        }
      });

      ws.addEventListener('close', () => {
        this.feedStatus.binance_spot.connected = false;
        this.scheduleReconnect(() => this.connectBinanceSpot(), 2500);
      });

      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    } catch {
      this.scheduleReconnect(() => this.connectBinanceSpot(), 3000);
    }
  }

  private connectBinancePerp(): void {
    if (this.isStopping) return;
    const url = 'wss://fstream.binance.com/ws/btcusdt@bookTicker';
    try {
      const ws = new WebSocket(url);
      this.sockets.push(ws);

      ws.addEventListener('open', () => {
        this.feedStatus.binance_perp.connected = true;
        this.feedStatus.binance_perp.mode = 'live_ws';
      });

      ws.addEventListener('message', (event) => {
        try {
          const now = Date.now();
          const data = JSON.parse(String(event.data));
          const bid = parseFloat(data.b);
          const ask = parseFloat(data.a);
          if (bid > 0 && ask > 0) {
            const price = (bid + ask) / 2;
            const eventTs = data.E || data.T || now;
            const latencyMs = Math.max(1, now - eventTs);
            this.binancePerpTick = {
              source: 'binance_perp',
              price,
              bid,
              ask,
              timestamp: now,
              latencyMs,
            };
            this.lastExternalTickTime = now;
            this.feedStatus.binance_perp.lastUpdate = now;
            this.feedStatus.binance_perp.latencyMs = latencyMs;
            this.feedStatus.binance_perp.connected = true;
            this.feedStatus.binance_perp.mode = 'live_ws';
            this.onNewTick();
          }
        } catch {
          // ignore
        }
      });

      ws.addEventListener('close', () => {
        this.feedStatus.binance_perp.connected = false;
        this.scheduleReconnect(() => this.connectBinancePerp(), 2500);
      });

      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    } catch {
      this.scheduleReconnect(() => this.connectBinancePerp(), 3000);
    }
  }

  private connectCoinbase(): void {
    if (this.isStopping) return;
    const url = 'wss://ws-feed.exchange.coinbase.com';
    try {
      const ws = new WebSocket(url);
      this.sockets.push(ws);

      ws.addEventListener('open', () => {
        this.feedStatus.coinbase.connected = true;
        this.feedStatus.coinbase.mode = 'live_ws';
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            product_ids: ['BTC-USD'],
            channels: ['ticker'],
          })
        );
      });

      ws.addEventListener('message', (event) => {
        try {
          const now = Date.now();
          const data = JSON.parse(String(event.data));
          if (data.type === 'ticker' && data.price) {
            const price = parseFloat(data.price);
            const bid = parseFloat(data.best_bid || data.price);
            const ask = parseFloat(data.best_ask || data.price);
            const eventTs = data.time ? new Date(data.time).getTime() : now;
            const latencyMs = Math.max(1, now - eventTs);
            if (price > 0) {
              this.coinbaseTick = {
                source: 'coinbase',
                price,
                bid,
                ask,
                timestamp: now,
                latencyMs,
              };
              this.lastExternalTickTime = now;
              this.feedStatus.coinbase.lastUpdate = now;
              this.feedStatus.coinbase.latencyMs = latencyMs;
              this.feedStatus.coinbase.connected = true;
              this.feedStatus.coinbase.mode = 'live_ws';
              this.onNewTick();
            }
          }
        } catch {
          // ignore
        }
      });

      ws.addEventListener('close', () => {
        this.feedStatus.coinbase.connected = false;
        this.scheduleReconnect(() => this.connectCoinbase(), 3000);
      });

      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    } catch {
      this.scheduleReconnect(() => this.connectCoinbase(), 3500);
    }
  }

  private connectChainlinkAndPolymarketRtds(): void {
    if (this.isStopping) return;
    // PolymarketSdkService (@polymarket/real-time-data-client) drives the live Chainlink BTC/USD feed.
    // Only start direct Chainlink Data Streams REST polling if enterprise keys are valid.
    if (this.hasValidChainlinkKeys()) {
      this.pollAuthenticatedChainlinkRest();
    }
  }

  private async pollAuthenticatedChainlinkRest(): Promise<void> {
    // Chainlink Data Streams BTC/USD Feed ID (mainnet standard)
    const feedId =
      process.env.CHAINLINK_BTC_FEED_ID ||
      '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';
    const apiKey = process.env.CHAINLINK_API_KEY!;
    const apiSecret = process.env.CHAINLINK_USER_SECRET!;
    const path = `/api/v1/reports/latest?feedID=${feedId}`;
    const host = process.env.CHAINLINK_REST_URL || 'https://api.testnet-dataengine.chain.link';

    const poll = async () => {
      if (this.isStopping) return;
      try {
        const timestamp = String(Date.now());
        const bodyHash = crypto.createHash('sha256').update('').digest('hex');
        const stringToSign = `GET ${path} ${bodyHash} ${apiKey} ${timestamp}`;
        const signature = crypto
          .createHmac('sha256', apiSecret)
          .update(stringToSign)
          .digest('hex');

        const res = await fetch(`${host}${path}`, {
          headers: {
            Authorization: apiKey,
            'X-Authorization-Timestamp': timestamp,
            'X-Authorization-Signature-SHA256': signature,
          },
        });
        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const report = data.report as Record<string, unknown> | undefined;
          if (report && typeof report.benchmarkPrice === 'string') {
            const parsed = Number(BigInt(report.benchmarkPrice)) / 1e18;
            if (parsed > 1000) {
              const now = Date.now();
              this.chainlinkTick = {
                source: 'chainlink',
                price: parsed,
                bid: parsed,
                ask: parsed,
                timestamp: now,
                latencyMs: 12,
              };
              this.feedStatus.chainlink.connected = true;
              this.feedStatus.chainlink.mode = 'chainlink_direct';
              this.feedStatus.chainlink.lastUpdate = now;
              this.onNewTick();
            }
          }
        }
      } catch {
        // Fallback to RTDS / Estimator silently
      }
      if (!this.isStopping) {
        const t = setTimeout(poll, 1000);
        this.reconnectTimers.push(t);
      }
    };
    poll();
  }

  private spotBasisEma: number | null = null;
  private perpBasisEma: number | null = null;
  private cbBasisEma: number | null = null;

  public setOfficialPolymarketPrice(price: number, mode = 'polymarket_sdk'): void {
    if (price <= 1000) return;
    const now = Date.now();
    this.chainlinkTick = {
      source: 'chainlink',
      price,
      bid: price,
      ask: price,
      timestamp: now,
      latencyMs: 15,
    };

    // Update slow-moving structural basis EMAs (Chainlink USD minus venue price)
    // α = 0.04 (~25s time constant) removes static USDT/perp/venue basis while preserving 1s-5s lead
    const alpha = 0.04;
    if (this.binanceSpotTick && this.binanceSpotTick.price > 1000) {
      const diff = price - this.binanceSpotTick.price;
      if (Math.abs(diff) < 500) {
        this.spotBasisEma =
          this.spotBasisEma === null ? diff : this.spotBasisEma + alpha * (diff - this.spotBasisEma);
      }
    }
    if (this.binancePerpTick && this.binancePerpTick.price > 1000) {
      const diff = price - this.binancePerpTick.price;
      if (Math.abs(diff) < 500) {
        this.perpBasisEma =
          this.perpBasisEma === null ? diff : this.perpBasisEma + alpha * (diff - this.perpBasisEma);
      }
    }
    if (this.coinbaseTick && this.coinbaseTick.price > 1000) {
      const diff = price - this.coinbaseTick.price;
      if (Math.abs(diff) < 500) {
        this.cbBasisEma =
          this.cbBasisEma === null ? diff : this.cbBasisEma + alpha * (diff - this.cbBasisEma);
      }
    }

    this.lastExternalTickTime = now;
    this.feedStatus.chainlink.connected = true;
    this.feedStatus.chainlink.mode = mode;
    this.feedStatus.chainlink.lastUpdate = now;
    this.onNewTick();
  }

  private latestBookImbalance = 0;

  private startOracleEstimatorAndWatchdog(): void {
    this.oracleEstimatorInterval = setInterval(() => {
      const now = Date.now();
      const hasLiveExchange =
        now - this.lastExternalTickTime < 6000 &&
        (this.binanceSpotTick !== null ||
          this.coinbaseTick !== null ||
          this.binancePerpTick !== null ||
          this.chainlinkTick !== null);

      if (!hasLiveExchange) {
        this.stepSyntheticMarket(now);
      } else {
        const rtdsFresh =
          this.chainlinkTick &&
          this.feedStatus.chainlink.mode !== 'oracle_estimator' &&
          this.feedStatus.chainlink.mode !== 'synthetic_sim' &&
          now - this.chainlinkTick.timestamp < 2500;

        if (!rtdsFresh) {
          const fastMid = this.getFastMidPrice();
          const prevOracle = this.chainlinkTick ? this.chainlinkTick.price : fastMid;
          const alpha = 0.14;
          const nextOracle = prevOracle + alpha * (fastMid - prevOracle);
          this.chainlinkTick = {
            source: 'chainlink',
            price: nextOracle,
            bid: nextOracle,
            ask: nextOracle,
            timestamp: now,
            latencyMs: 180,
          };
          this.feedStatus.chainlink.connected = true;
          this.feedStatus.chainlink.mode = 'oracle_estimator';
          this.feedStatus.chainlink.lastUpdate = now;
          this.onNewTick();
        }
      }
    }, 150);
  }

  private stepSyntheticMarket(now: number): void {
    // Mean-reverting jump-diffusion micro-structure simulation
    const shock = (Math.random() - 0.5) * 14.5;
    this.syntheticMomentum = 0.82 * this.syntheticMomentum + 0.18 * shock;
    // Occasional momentum burst (simulating whale market order on Binance Perp)
    if (Math.random() < 0.04) {
      this.syntheticMomentum += (Math.random() - 0.48) * 38.0;
    }
    this.syntheticBasePrice = Math.max(10000, this.syntheticBasePrice + this.syntheticMomentum * 0.25);

    const perpPrice = this.syntheticBasePrice + this.syntheticMomentum * 0.45;
    const spotPrice = this.syntheticBasePrice;
    const cbPrice = this.syntheticBasePrice - this.syntheticMomentum * 0.1 + (Math.random() - 0.5) * 1.5;

    // Chainlink oracle lags the fast move by ~1.2 seconds
    this.syntheticOraclePrice =
      this.syntheticOraclePrice + 0.12 * (spotPrice - this.syntheticOraclePrice);

    this.binanceSpotTick = {
      source: 'binance_spot',
      price: spotPrice,
      bid: spotPrice - 0.5,
      ask: spotPrice + 0.5,
      timestamp: now,
      latencyMs: 18,
    };
    this.binancePerpTick = {
      source: 'binance_perp',
      price: perpPrice,
      bid: perpPrice - 0.4,
      ask: perpPrice + 0.4,
      timestamp: now,
      latencyMs: 14,
    };
    this.coinbaseTick = {
      source: 'coinbase',
      price: cbPrice,
      bid: cbPrice - 0.8,
      ask: cbPrice + 0.8,
      timestamp: now,
      latencyMs: 25,
    };
    this.chainlinkTick = {
      source: 'chainlink',
      price: this.syntheticOraclePrice,
      bid: this.syntheticOraclePrice,
      ask: this.syntheticOraclePrice,
      timestamp: now,
      latencyMs: 140,
    };

    this.latestBookImbalance = Math.max(-0.95, Math.min(0.95, this.syntheticMomentum / 25));
    this.recentTrades.push({
      t: now,
      price: spotPrice,
      qty: Math.abs(this.syntheticMomentum) * 0.08 + Math.random() * 0.15,
      isBuyerMaker: this.syntheticMomentum < 0,
    });
    if (this.recentTrades.length > 1000) {
      this.recentTrades.splice(0, this.recentTrades.length - 600);
    }

    for (const key of ['binance_spot', 'binance_perp', 'coinbase', 'chainlink']) {
      this.feedStatus[key].connected = true;
      this.feedStatus[key].mode = 'synthetic_sim';
      this.feedStatus[key].lastUpdate = now;
      this.feedStatus[key].latencyMs = key === 'chainlink' ? 140 : 18;
    }

    this.onNewTick();
  }

  private onNewTick(): void {
    const now = Date.now();
    const fastMid = this.getFastMidPrice();
    const oracle = this.getChainlinkPrice();
    if (fastMid <= 0) return;

    this.priceHistory.push({
      t: now,
      fastMid,
      oracle,
    });

    // Keep last 6 minutes of high-res history
    const cutoff = now - 360_000;
    if (this.priceHistory.length > 3500) {
      const idx = this.priceHistory.findIndex((p) => p.t >= cutoff);
      if (idx > 0) {
        this.priceHistory.splice(0, idx);
      } else {
        this.priceHistory.splice(0, 500);
      }
    }

    this.emit('tick', {
      fastMid,
      oracle,
      timestamp: now,
    });
  }

  public getFastMidPrice(): number {
    // Lead-weighted composite price normalized to Chainlink BTC/USD basis:
    // Removes static USDT/USD and Perp funding basis via rolling EMA so Fast Mid sits on the exact
    // same USD scale as Polymarket's Chainlink settlement price and only diverges on real 1s-5s lead moves.
    const cb = this.coinbaseTick?.price || 0;
    const perp = this.binancePerpTick?.price || 0;
    const spot = this.binanceSpotTick?.price || 0;

    const fallbackSpotToCb = cb > 0 && spot > 0 ? cb - spot : 0;
    const fallbackPerpToCb = cb > 0 && perp > 0 ? cb - perp : 0;

    const adjSpot =
      spot > 0 ? spot + (this.spotBasisEma !== null ? this.spotBasisEma : fallbackSpotToCb) : 0;
    const adjPerp =
      perp > 0 ? perp + (this.perpBasisEma !== null ? this.perpBasisEma : fallbackPerpToCb) : 0;
    const adjCb = cb > 0 ? cb + (this.cbBasisEma !== null ? this.cbBasisEma : 0) : 0;

    let totalWeight = 0;
    let weightedSum = 0;

    if (adjPerp > 0) {
      weightedSum += adjPerp * 0.42;
      totalWeight += 0.42;
    }
    if (adjCb > 0) {
      weightedSum += adjCb * 0.33;
      totalWeight += 0.33;
    }
    if (adjSpot > 0) {
      weightedSum += adjSpot * 0.25;
      totalWeight += 0.25;
    }

    if (totalWeight === 0) return this.chainlinkTick?.price || 89450;
    return weightedSum / totalWeight;
  }

  public getBinanceSpotPrice(): number {
    return this.binanceSpotTick?.price || this.getFastMidPrice();
  }

  public getBinancePerpPrice(): number {
    return this.binancePerpTick?.price || this.getFastMidPrice();
  }

  public getCoinbasePrice(): number {
    return this.coinbaseTick?.price || this.getFastMidPrice();
  }

  public getChainlinkPrice(): number {
    return this.chainlinkTick?.price || this.getFastMidPrice();
  }

  public getOrderbookImbalance(): number {
    return this.latestBookImbalance;
  }

  public getAggressorCvd(windowMs = 5000): number {
    const cutoff = Date.now() - windowMs;
    let cvd = 0;
    for (let i = this.recentTrades.length - 1; i >= 0; i--) {
      const tr = this.recentTrades[i];
      if (tr.t < cutoff) break;
      cvd += tr.isBuyerMaker ? -tr.qty : tr.qty;
    }
    return cvd;
  }

  public getPriceChangeOver(windowMs: number): number {
    if (this.priceHistory.length < 2) return 0;
    const now = Date.now();
    const targetTime = now - windowMs;
    const current = this.priceHistory[this.priceHistory.length - 1].fastMid;
    for (let i = this.priceHistory.length - 1; i >= 0; i--) {
      if (this.priceHistory[i].t <= targetTime) {
        return current - this.priceHistory[i].fastMid;
      }
    }
    return current - this.priceHistory[0].fastMid;
  }

  public getRealizedVolatilityPerSec(windowMs = 60_000): number {
    // Compute 1-second sampled log-return standard deviation
    const now = Date.now();
    const start = now - windowMs;
    const samples: number[] = [];
    let bucketTime = start;

    for (let i = 0; i < this.priceHistory.length; i++) {
      const pt = this.priceHistory[i];
      if (pt.t >= bucketTime) {
        samples.push(pt.fastMid);
        bucketTime = pt.t + 1000;
      }
    }

    if (samples.length < 5) {
      // Default ~45% annualized BTC vol => per-second vol: 0.45 / sqrt(365 * 86400) ≈ 0.0000801
      return 0.000085;
    }

    const logReturns: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      if (samples[i - 1] > 0 && samples[i] > 0) {
        logReturns.push(Math.log(samples[i] / samples[i - 1]));
      }
    }

    if (logReturns.length < 3) return 0.000085;
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
    const variance =
      logReturns.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) /
      Math.max(1, logReturns.length - 1);
    const stdPerSec = Math.sqrt(variance);
    // Clamp to reasonable bounds so thin periods don't divide by 0
    return Math.max(0.000035, Math.min(0.00065, stdPerSec));
  }

  private scheduleReconnect(fn: () => void, delayMs: number): void {
    if (this.isStopping) return;
    const t = setTimeout(fn, delayMs);
    this.reconnectTimers.push(t);
  }
}
