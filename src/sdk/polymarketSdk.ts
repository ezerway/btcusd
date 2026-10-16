import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { ClobClient, Chain, Side, OrderType } from '@polymarket/clob-client';
import type { ApiKeyCreds, OrderBookSummary } from '@polymarket/clob-client';
import { RealTimeDataClient, ConnectionStatus } from '@polymarket/real-time-data-client';
import type { Message } from '@polymarket/real-time-data-client';

const requireFromClob = createRequire(import.meta.resolve('@polymarket/clob-client'));
const { createWalletClient, http } = requireFromClob('viem');
const { privateKeyToAccount } = requireFromClob('viem/accounts');
const { polygon } = requireFromClob('viem/chains');

export interface PolymarketAuthStatus {
  authenticated: boolean;
  canSignOrders: boolean;
  mode: 'L1_AND_L2' | 'L2_API_KEY' | 'PUBLIC_READONLY';
  address: string | null;
  apiKeyPreview: string | null;
  clobOk: boolean;
  rtdsConnected: boolean;
  serverTimeOffsetMs: number;
  lastVerifiedAt: number;
  message: string;
}

export interface Polymarket5mPriceData {
  windowStartSec: number;
  windowEndSec: number;
  priceToBeat: number;         // Official Polymarket 5m openPrice
  currentPrice: number;        // Current Price 1: Chainlink BTC/USD
  polymarketSpotPrice: number; // Current Price 2: Polymarket Crypto (btcusdt) / Fast Exchange
  twap60sPrice: number;        // Rolling 60s TWAP of Chainlink BTC/USD stream
  completed: boolean;
  timestamp: number;
  source: 'polymarket_sdk_live' | 'fallback';
}

export class PolymarketSdkService extends EventEmitter {
  public clobClient: ClobClient;
  private rtdsClient: RealTimeDataClient | null = null;
  private creds: ApiKeyCreds | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private walletClient: any = undefined;
  private funderAddress: string | undefined;

  // Offset between Polymarket Server Clock and local Date.now() (serverMs - localMs)
  public serverTimeOffsetMs = 0;

  private chainlinkSamples: Array<{ t: number; price: number }> = [];
  public latestChainlinkPrice = 0;
  public latestPolymarketSpotPrice = 0;
  public latestRawBtcusdtPrice = 0;
  private usdtBasisEma: number | null = null;

  public authStatus: PolymarketAuthStatus = {
    authenticated: false,
    canSignOrders: false,
    mode: 'PUBLIC_READONLY',
    address: null,
    apiKeyPreview: null,
    clobOk: false,
    rtdsConnected: false,
    serverTimeOffsetMs: 0,
    lastVerifiedAt: 0,
    message: 'Initialized in public read-only mode',
  };

  public latest5mPrice: Polymarket5mPriceData | null = null;
  private cryptoPriceTimer: ReturnType<typeof setInterval> | null = null;
  private serverClockSyncTimer: ReturnType<typeof setInterval> | null = null;
  private rtdsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isStopping = false;

  constructor() {
    super();
    this.clobClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON);
  }

  /**
   * Returns current Unix timestamp in milliseconds synchronized to Polymarket's server clock.
   */
  public getServerNowMs(): number {
    return Date.now() + this.serverTimeOffsetMs;
  }

  /**
   * Returns current Unix timestamp in seconds synchronized to Polymarket's server clock.
   */
  public getServerNowSec(): number {
    return Math.floor(this.getServerNowMs() / 1000);
  }

  private updateServerTimeOffset(serverMs: number): void {
    if (serverMs > 1700000000000) {
      const offset = serverMs - Date.now();
      // Smooth clock offset updates after initial sync
      if (this.serverTimeOffsetMs === 0 || Math.abs(offset - this.serverTimeOffsetMs) > 2000) {
        this.serverTimeOffsetMs = Math.round(offset);
      } else {
        this.serverTimeOffsetMs = Math.round(0.8 * this.serverTimeOffsetMs + 0.2 * offset);
      }
      this.authStatus.serverTimeOffsetMs = this.serverTimeOffsetMs;
    }
  }

  public async start(): Promise<void> {
    this.isStopping = false;
    await this.syncServerTimeViaSdk();
    await this.initializeSdkAuthFromEnv();
    this.startRealTimeDataClient();
    this.startOfficial5mPricePolling();

    // Periodically re-verify server clock via ClobClient.getServerTime()
    this.serverClockSyncTimer = setInterval(() => {
      this.syncServerTimeViaSdk();
    }, 30_000);
  }

  public stop(): void {
    this.isStopping = true;
    if (this.cryptoPriceTimer) clearInterval(this.cryptoPriceTimer);
    if (this.serverClockSyncTimer) clearInterval(this.serverClockSyncTimer);
    if (this.rtdsReconnectTimer) clearTimeout(this.rtdsReconnectTimer);
    if (this.rtdsClient) {
      try {
        this.rtdsClient.disconnect();
      } catch {
        // ignore
      }
    }
  }

  public async syncServerTimeViaSdk(): Promise<void> {
    try {
      const t0 = Date.now();
      const serverSec = await this.clobClient.getServerTime();
      const rttHalf = (Date.now() - t0) / 2;
      const parsedSec = Number(serverSec);
      if (parsedSec > 1700000000) {
        this.updateServerTimeOffset(parsedSec * 1000 + rttHalf);
      }
    } catch {
      // ignore if offline
    }
  }

  public async initializeSdkAuthFromEnv(): Promise<PolymarketAuthStatus> {
    const rawKey = (process.env.POLYMARKET_API_KEY || '').trim();
    const rawSecret = (process.env.POLYMARKET_SECRET || '').trim();
    const rawPassphrase = (process.env.POLYMARKET_PASSPHRASE || '').trim();
    const rawPrivateKey = (process.env.POLYMARKET_PRIVATE_KEY || '').trim();
    const rawFunder = (process.env.POLYMARKET_FUNDER_ADDRESS || '').trim();

    this.funderAddress = rawFunder || undefined;
    this.walletClient = undefined;
    this.creds = undefined;

    let walletAddress: string | null = null;

    if (rawPrivateKey && !rawPrivateKey.includes('your_')) {
      try {
        const normalizedPk = rawPrivateKey.startsWith('0x')
          ? rawPrivateKey
          : `0x${rawPrivateKey}`;
        const account = privateKeyToAccount(normalizedPk);
        walletAddress = account.address;
        this.walletClient = createWalletClient({
          account,
          chain: polygon,
          transport: http('https://polygon-rpc.com'),
        });
      } catch (err) {
        this.authStatus.message = `Invalid POLYMARKET_PRIVATE_KEY: ${(err as Error).message}`;
      }
    }

    if (
      rawKey &&
      rawSecret &&
      rawPassphrase &&
      !rawKey.includes('your_polymarket') &&
      !rawSecret.includes('your_polymarket')
    ) {
      this.creds = {
        key: rawKey,
        secret: rawSecret,
        passphrase: rawPassphrase,
      };
    } else if (this.walletClient) {
      try {
        const tempClient = new ClobClient(
          'https://clob.polymarket.com',
          Chain.POLYGON,
          this.walletClient,
          undefined,
          undefined,
          this.funderAddress
        );
        const derived = await tempClient.createOrDeriveApiKey();
        if (derived && derived.key && derived.secret && derived.passphrase) {
          this.creds = derived;
          process.env.POLYMARKET_API_KEY = derived.key;
          process.env.POLYMARKET_SECRET = derived.secret;
          process.env.POLYMARKET_PASSPHRASE = derived.passphrase;
          this.persistEnvCredentials({
            apiKey: derived.key,
            secret: derived.secret,
            passphrase: derived.passphrase,
          });
        }
      } catch {
        // ignore derivation error if offline
      }
    }

    this.clobClient = new ClobClient(
      'https://clob.polymarket.com',
      Chain.POLYGON,
      this.walletClient,
      this.creds,
      undefined,
      this.funderAddress
    );

    let clobOk = false;
    let verifiedL2 = false;
    let statusMessage = 'Public Read-Only SDK Mode (Add API Keys to enable authenticated L2)';

    try {
      const okResp = await this.clobClient.getOk();
      clobOk = okResp === 'OK' || Boolean(okResp && !okResp.error);
    } catch {
      clobOk = false;
    }

    if (this.creds) {
      try {
        const apiKeysResp = await this.clobClient.getApiKeys();
        if (apiKeysResp && !(apiKeysResp as unknown as Record<string, unknown>).error) {
          verifiedL2 = true;
          statusMessage = this.walletClient
            ? 'Authenticated via Polymarket SDK (L1 Signer + L2 API Key Verified)'
            : 'Authenticated via Polymarket SDK (L2 API Key Verified)';
        } else {
          const errStr = String(
            (apiKeysResp as unknown as Record<string, unknown>)?.error || 'Invalid L2 credentials'
          );
          statusMessage = `L2 Auth Warning: ${errStr}`;
        }
      } catch (err) {
        statusMessage = `L2 Auth Check Failed: ${(err as Error).message}`;
      }
    }

    this.authStatus = {
      authenticated: verifiedL2,
      canSignOrders: Boolean(this.walletClient && this.creds),
      mode:
        this.walletClient && this.creds
          ? 'L1_AND_L2'
          : this.creds
          ? 'L2_API_KEY'
          : 'PUBLIC_READONLY',
      address: walletAddress || this.funderAddress || null,
      apiKeyPreview: this.creds ? `${this.creds.key.slice(0, 8)}...` : null,
      clobOk,
      rtdsConnected: this.authStatus.rtdsConnected,
      serverTimeOffsetMs: this.serverTimeOffsetMs,
      lastVerifiedAt: Date.now(),
      message: statusMessage,
    };

    this.emit('auth_updated', this.authStatus);
    return this.authStatus;
  }

  public async updateAndVerifyCredentials(input: {
    apiKey?: string;
    secret?: string;
    passphrase?: string;
    privateKey?: string;
    funderAddress?: string;
  }): Promise<PolymarketAuthStatus> {
    if (typeof input.apiKey === 'string') process.env.POLYMARKET_API_KEY = input.apiKey.trim();
    if (typeof input.secret === 'string') process.env.POLYMARKET_SECRET = input.secret.trim();
    if (typeof input.passphrase === 'string')
      process.env.POLYMARKET_PASSPHRASE = input.passphrase.trim();
    if (typeof input.privateKey === 'string')
      process.env.POLYMARKET_PRIVATE_KEY = input.privateKey.trim();
    if (typeof input.funderAddress === 'string')
      process.env.POLYMARKET_FUNDER_ADDRESS = input.funderAddress.trim();

    this.persistEnvCredentials(input);
    const status = await this.initializeSdkAuthFromEnv();
    this.startRealTimeDataClient();
    return status;
  }

  private persistEnvCredentials(input: {
    apiKey?: string;
    secret?: string;
    passphrase?: string;
    privateKey?: string;
    funderAddress?: string;
  }): void {
    try {
      const envPath = path.join(process.cwd(), '.env');
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

      const upsert = (key: string, val?: string) => {
        if (val === undefined) return;
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${val}`);
        } else {
          content += `\n${key}=${val}`;
        }
      };

      upsert('POLYMARKET_API_KEY', input.apiKey);
      upsert('POLYMARKET_SECRET', input.secret);
      upsert('POLYMARKET_PASSPHRASE', input.passphrase);
      upsert('POLYMARKET_PRIVATE_KEY', input.privateKey);
      upsert('POLYMARKET_FUNDER_ADDRESS', input.funderAddress);

      fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
    } catch {
      // ignore
    }
  }

  /**
   * Connects @polymarket/real-time-data-client (`RealTimeDataClient`)
   * Subscribes strictly to `crypto_prices_chainlink` (`{"symbol":"btc/usd"}`) so Binance USDT prices
   * do not overwrite the Chainlink BTC/USD price!
   */
  private startRealTimeDataClient(): void {
    if (this.isStopping) return;
    if (this.rtdsReconnectTimer) {
      clearTimeout(this.rtdsReconnectTimer);
      this.rtdsReconnectTimer = null;
    }
    if (this.rtdsClient) {
      try {
        this.rtdsClient.disconnect();
      } catch {
        // ignore
      }
    }

    try {
      this.rtdsClient = new RealTimeDataClient({
        autoReconnect: false,
        pingInterval: 5000,
        onConnect: (client) => {
          this.authStatus.rtdsConnected = true;
          const clobAuth = this.creds
            ? {
                key: this.creds.key,
                secret: this.creds.secret,
                passphrase: this.creds.passphrase,
              }
            : undefined;

          client.subscribe({
            subscriptions: [
              {
                topic: 'crypto_prices_chainlink',
                type: '*',
                filters: '{"symbol":"btc/usd"}',
                ...(clobAuth ? { clob_auth: clobAuth } : {}),
              },
              {
                topic: 'crypto_prices',
                type: 'update',
                ...(clobAuth ? { clob_auth: clobAuth } : {}),
              },
            ],
          });
        },
        onStatusChange: (status) => {
          this.authStatus.rtdsConnected = status === ConnectionStatus.CONNECTED;
          if (status === ConnectionStatus.DISCONNECTED && !this.isStopping) {
            if (!this.rtdsReconnectTimer) {
              this.rtdsReconnectTimer = setTimeout(() => {
                this.rtdsReconnectTimer = null;
                this.startRealTimeDataClient();
              }, 3500);
            }
          }
        },
        onMessage: (_client, message: Message) => {
          this.handleRtdsMessage(message);
        },
      });

      (this.rtdsClient as unknown as { autoReconnect: boolean }).autoReconnect = false;
      this.rtdsClient.connect();
    } catch {
      this.authStatus.rtdsConnected = false;
    }
  }

  private handleRtdsMessage(message: Message): void {
    try {
      const payload = (message.payload || {}) as Record<string, unknown>;
      const symbol = String(payload.symbol || '').toLowerCase();
      const price = parseFloat(String(payload.value || '0'));
      if (price <= 1000) return;

      if (typeof message.timestamp === 'number' && message.timestamp > 1700000000000) {
        this.updateServerTimeOffset(message.timestamp);
      }
      const serverNow = this.getServerNowMs();

      // Stream 1: Chainlink BTC/USD (Settlement Price)
      if (message.topic === 'crypto_prices_chainlink' && symbol === 'btc/usd') {
        this.latestChainlinkPrice = price;
        this.chainlinkSamples.push({ t: serverNow, price });
        const cutoff = serverNow - 60_000;
        while (this.chainlinkSamples.length > 0 && this.chainlinkSamples[0].t < cutoff) {
          this.chainlinkSamples.shift();
        }

        // Update slow-moving USDT->USD basis EMA (BTC/USD minus BTC/USDT)
        if (this.latestRawBtcusdtPrice > 1000) {
          const diff = price - this.latestRawBtcusdtPrice;
          if (Math.abs(diff) < 500) {
            this.usdtBasisEma =
              this.usdtBasisEma === null
                ? diff
                : this.usdtBasisEma + 0.05 * (diff - this.usdtBasisEma);
          }
          this.latestPolymarketSpotPrice = this.latestRawBtcusdtPrice + (this.usdtBasisEma ?? diff);
        }

        if (this.latest5mPrice) {
          this.latest5mPrice.currentPrice = Number(price.toFixed(2));
          this.latest5mPrice.twap60sPrice = Number(this.getChainlink60sTwap().toFixed(2));
          if (this.latestPolymarketSpotPrice > 1000) {
            this.latest5mPrice.polymarketSpotPrice = Number(
              this.latestPolymarketSpotPrice.toFixed(2)
            );
          }
          this.latest5mPrice.timestamp = serverNow;
        }

        this.emit('rtds_btc_price', {
          price,
          twap60s: this.getChainlink60sTwap(),
          timestamp: serverNow,
          topic: message.topic,
        });
      }
      // Stream 2: Polymarket Crypto Spot Stream (btcusdt -> normalized to USD scale)
      else if (message.topic === 'crypto_prices' && symbol === 'btcusdt') {
        this.latestRawBtcusdtPrice = price;
        if (this.latestChainlinkPrice > 1000 && this.usdtBasisEma === null) {
          const initDiff = this.latestChainlinkPrice - price;
          if (Math.abs(initDiff) < 500) {
            this.usdtBasisEma = initDiff;
          }
        }
        const usdAdjusted =
          this.usdtBasisEma !== null ? price + this.usdtBasisEma : this.latestChainlinkPrice || price;
        this.latestPolymarketSpotPrice = usdAdjusted;

        if (this.latest5mPrice) {
          this.latest5mPrice.polymarketSpotPrice = Number(usdAdjusted.toFixed(2));
        }
        this.emit('rtds_btcusdt_price', {
          price: usdAdjusted,
          rawUsdtPrice: price,
          timestamp: serverNow,
        });
      }
    } catch {
      // ignore malformed message
    }
  }

  public getChainlink60sTwap(): number {
    if (this.chainlinkSamples.length === 0) return this.latestChainlinkPrice;
    const sum = this.chainlinkSamples.reduce((acc, s) => acc + s.price, 0);
    return sum / this.chainlinkSamples.length;
  }

  /**
   * Polls Polymarket's official 5m crypto-price endpoint every 1 second using:
   * - Synchronized Polymarket Server Clock (`getServerNowSec()`)
   * - Exact query parameters: `variant=fiveminute&twapEnabled=true&twapLookbackSeconds=60`
   */
  private startOfficial5mPricePolling(): void {
    if (this.cryptoPriceTimer) clearInterval(this.cryptoPriceTimer);

    const poll = async () => {
      if (this.isStopping) return;
      const nowSec = this.getServerNowSec();
      const windowStartSec = Math.floor(nowSec / 300) * 300;
      const windowEndSec = windowStartSec + 300;
      const data = await this.fetchOfficial5mPrice(windowStartSec, windowEndSec);
      if (data) {
        this.latest5mPrice = data;
        this.emit('polymarket_5m_price', data);
      }
    };

    poll();
    this.cryptoPriceTimer = setInterval(poll, 1000);
  }

  public async fetchOfficial5mPrice(
    windowStartSec: number,
    windowEndSec: number
  ): Promise<Polymarket5mPriceData | null> {
    try {
      // Format without .000Z to match Polymarket's queryKey: "2026-10-07T05:25:00Z"
      const startIso = new Date(windowStartSec * 1000).toISOString().replace('.000Z', 'Z');
      const endIso = new Date(windowEndSec * 1000).toISOString().replace('.000Z', 'Z');
      const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${encodeURIComponent(
        startIso
      )}&variant=fiveminute&endDate=${encodeURIComponent(
        endIso
      )}&twapEnabled=true&twapLookbackSeconds=60`;

      const t0 = Date.now();
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          ...(this.creds ? { POLY_API_KEY: this.creds.key } : {}),
        },
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) return null;
      const json = (await res.json()) as {
        openPrice?: number;
        closePrice?: number | null;
        timestamp?: number;
        completed?: boolean;
      };

      if (typeof json.timestamp === 'number' && json.timestamp > 1700000000000) {
        const rttHalf = (Date.now() - t0) / 2;
        this.updateServerTimeOffset(json.timestamp + rttHalf);
      }

      const openPrice = Number(json.openPrice || 0);
      const currentPrice =
        Number(json.closePrice || 0) > 1000
          ? Number(json.closePrice)
          : this.latestChainlinkPrice > 1000
          ? this.latestChainlinkPrice
          : openPrice;

      const polySpot =
        this.latestPolymarketSpotPrice > 1000 ? this.latestPolymarketSpotPrice : currentPrice;

      if (openPrice > 1000) {
        return {
          windowStartSec,
          windowEndSec,
          priceToBeat: Number(openPrice.toFixed(2)),
          currentPrice: Number(currentPrice.toFixed(2)),
          polymarketSpotPrice: Number(polySpot.toFixed(2)),
          twap60sPrice: Number(
            (this.getChainlink60sTwap() > 1000 ? this.getChainlink60sTwap() : currentPrice).toFixed(
              2
            )
          ),
          completed: Boolean(json.completed),
          timestamp: Number(json.timestamp || this.getServerNowMs()),
          source: 'polymarket_sdk_live',
        };
      }
    } catch {
      // Fallback handled by caller
    }
    return null;
  }

  public async fetchOrderBooksViaSdk(
    upTokenId: string,
    downTokenId: string
  ): Promise<{ upBook: OrderBookSummary; downBook: OrderBookSummary } | null> {
    try {
      const books = await this.clobClient.getOrderBooks([
        { token_id: upTokenId },
        { token_id: downTokenId },
      ]);
      if (Array.isArray(books) && books.length >= 2) {
        const upBook = books.find((b) => b.asset_id === upTokenId) || books[0];
        const downBook = books.find((b) => b.asset_id === downTokenId) || books[1];
        if (upBook && downBook && !('error' in upBook)) {
          this.authStatus.clobOk = true;
          return { upBook, downBook };
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  public async placeLiveOrderViaSdk(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<{ ok: boolean; orderId?: string; error?: string }> {
    if (!this.creds) {
      return {
        ok: false,
        error: 'Missing Polymarket API credentials (POLYMARKET_API_KEY / SECRET / PASSPHRASE)',
      };
    }
    if (!this.walletClient) {
      return {
        ok: false,
        error:
          'Live order signing requires POLYMARKET_PRIVATE_KEY in addition to L2 API credentials',
      };
    }

    try {
      const resp = await this.clobClient.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: Number(params.price.toFixed(2)),
          side: params.side === 'BUY' ? Side.BUY : Side.SELL,
          size: Number(params.size.toFixed(2)),
        },
        undefined,
        OrderType.GTC
      );

      if (resp && (resp.orderID || resp.success)) {
        return { ok: true, orderId: String(resp.orderID || '') };
      }
      return {
        ok: false,
        error: String(resp?.errorMsg || resp?.error || 'Order rejected by CLOB'),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
