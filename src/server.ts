import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PriceFeedManager } from './feeds/priceFeeds.ts';
import { Polymarket5mManager } from './feeds/polymarketFeed.ts';
import { QuantEngine } from './engine/quantEngine.ts';
import { ExecutionEngine } from './engine/executionEngine.ts';
import { PolymarketSdkService } from './sdk/polymarketSdk.ts';
import type { PriceChartPoint, QuantSignal } from './types.ts';

const PORT = Number(process.env.PORT || 3000);
const DIST_DIR = path.join(process.cwd(), 'dist');
const STATIC_DIR = fs.existsSync(DIST_DIR) ? DIST_DIR : path.join(process.cwd(), 'public');

const polymarketSdk = new PolymarketSdkService();
const priceFeeds = new PriceFeedManager();
const polymarket = new Polymarket5mManager(priceFeeds, polymarketSdk);
const quantEngine = new QuantEngine(priceFeeds);
const executionEngine = new ExecutionEngine(polymarketSdk);

let latestSignal: QuantSignal | null = null;
const chartSeries: PriceChartPoint[] = [];
const sseClients = new Set<http.ServerResponse>();

function broadcastSse(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Wire 5m Window Settlement
polymarket.on('window_settled', (settlement) => {
  executionEngine.settleWindow(settlement);
  broadcastSse('window_settled', settlement);
});

polymarket.on('window_started', () => {
  // Retain up to 30 minutes of historical ticks so the chart can draw previous milestones
  const cutoff = polymarketSdk.getServerNowMs() - 30 * 60 * 1000;
  while (chartSeries.length > 0 && chartSeries[0].t < cutoff) {
    chartSeries.shift();
  }
});

executionEngine.on('alert', (alert) => {
  broadcastSse('alert', alert);
});

executionEngine.on('trade', (trade) => {
  broadcastSse('trade', trade);
});

polymarketSdk.on('auth_updated', (status) => {
  broadcastSse('auth_updated', status);
});

function computeCurrentSignal(market = polymarket.getActiveMarket()): QuantSignal {
  return quantEngine.computeSignal(
    market,
    executionEngine.config,
    polymarketSdk.getServerNowMs(),
    {
      polymarketSpotPrice: polymarketSdk.latestPolymarketSpotPrice,
      twap60sPrice: polymarketSdk.getChainlink60sTwap(),
    }
  );
}

// Start Polymarket SDK (syncs server clock first), Exchange Feeds, and 5m Market Manager
polymarketSdk.start().then(() => {
  polymarket.start();
});
priceFeeds.start();

// Main 250ms Quant & Mark-to-Market loop
let lastChartPointTs = 0;
setInterval(() => {
  const market = polymarket.getActiveMarket();
  const signal = computeCurrentSignal(market);
  latestSignal = signal;

  executionEngine.onTick(market);

  const now = polymarketSdk.getServerNowMs();
  const hasLivePrice =
    market.strikeLocked ||
    priceFeeds.feedStatus.chainlinkRtds ||
    priceFeeds.feedStatus.binanceSpot ||
    priceFeeds.feedStatus.coinbaseSpot;

  if (hasLivePrice && now - lastChartPointTs >= 900) {
    lastChartPointTs = now;
    // Purge any stale startup points that had a wildly different fallback price (e.g. test dummy 67k)
    for (let i = chartSeries.length - 1; i >= 0; i--) {
      if (Math.abs(chartSeries[i].oracle - signal.chainlinkPrice) > 10000) {
        chartSeries.splice(i, 1);
      }
    }
    chartSeries.push({
      t: now,
      fast: signal.fastMidPrice,
      polySpot: signal.polymarketSpotPrice,
      oracle: signal.chainlinkPrice,
      strike: market.strikePrice,
      upAsk: market.upBook.bestAsk,
    });
    if (chartSeries.length > 1800) {
      chartSeries.splice(0, chartSeries.length - 1800);
    }
  }

  broadcastSse('tick', {
    market,
    signal,
    stats: executionEngine.getPerformanceStats(),
    positions: executionEngine.positions,
    windowHistory: executionEngine.windowHistory.slice(0, 25),
    feedStatus: priceFeeds.feedStatus,
    clobStatus: polymarket.clobStatus,
    sdkAuth: polymarketSdk.authStatus,
    polymarket5mPrice: polymarketSdk.latest5mPrice,
    chartPoint: hasLivePrice
      ? {
          t: now,
          fast: signal.fastMidPrice,
          polySpot: signal.polymarketSpotPrice,
          oracle: signal.chainlinkPrice,
          strike: market.strikePrice,
          upAsk: market.upBook.bestAsk,
        }
      : null,
  });
}, 250);

function getFullState() {
  const market = polymarket.getActiveMarket();
  const signal = latestSignal || computeCurrentSignal(market);
  return {
    market,
    signal,
    config: executionEngine.config,
    sdkAuth: polymarketSdk.authStatus,
    polymarket5mPrice: polymarketSdk.latest5mPrice,
    hasPolymarketKeys: executionEngine.hasPolymarketKeys(),
    stats: executionEngine.getPerformanceStats(),
    positions: executionEngine.positions,
    trades: executionEngine.trades.slice(0, 60),
    windowHistory: executionEngine.windowHistory.slice(0, 25),
    equityCurve: executionEngine.equityCurve,
    chartSeries,
    feedStatus: priceFeeds.feedStatus,
    clobStatus: polymarket.clobStatus,
  };
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // SSE Real-time Stream
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: init\ndata: ${JSON.stringify(getFullState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // Full Snapshot API
  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, getFullState());
    return;
  }

  // Polymarket SDK Authentication API
  if (req.method === 'POST' && url.pathname === '/api/auth') {
    try {
      const body = await readJsonBody(req);
      const authStatus = await polymarketSdk.updateAndVerifyCredentials({
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        secret: typeof body.secret === 'string' ? body.secret : undefined,
        passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined,
        privateKey: typeof body.privateKey === 'string' ? body.privateKey : undefined,
        funderAddress: typeof body.funderAddress === 'string' ? body.funderAddress : undefined,
      });
      sendJson(res, 200, { ok: true, sdkAuth: authStatus, state: getFullState() });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message });
    }
    return;
  }

  // Update Strategy Config API
  if (req.method === 'POST' && url.pathname === '/api/config') {
    try {
      const body = await readJsonBody(req);
      const updated = executionEngine.updateConfig(body);
      sendJson(res, 200, { ok: true, config: updated });
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
    }
    return;
  }

  // Manual Order Placement API (BUY UP or BUY DOWN)
  if (req.method === 'POST' && url.pathname === '/api/order') {
    try {
      const body = await readJsonBody(req);
      const outcome = body.outcome === 'DOWN' ? 'DOWN' : 'UP';
      const amountUsd = Number(body.amountUsd || 25);
      const market = polymarket.getActiveMarket();
      const signal = latestSignal || computeCurrentSignal(market);
      const trade = await executionEngine.executeBuyOrder(
        market,
        signal,
        outcome,
        amountUsd
      );
      sendJson(res, 200, {
        ok: Boolean(trade),
        trade,
        state: getFullState(),
      });
    } catch {
      sendJson(res, 400, { ok: false, error: 'Order execution failed' });
    }
    return;
  }

  // Manual Close Position API
  if (req.method === 'POST' && url.pathname === '/api/close-position') {
    try {
      const body = await readJsonBody(req);
      const positionId = String(body.positionId || '');
      const market = polymarket.getActiveMarket();
      if (positionId === 'ALL') {
        for (const pos of [...executionEngine.positions]) {
          executionEngine.closePosition(pos.id, market, 'Manual Flatten All');
        }
        sendJson(res, 200, { ok: true, state: getFullState() });
      } else {
        const trade = executionEngine.closePosition(
          positionId,
          market,
          'Manual Close Position'
        );
        sendJson(res, 200, { ok: Boolean(trade), trade, state: getFullState() });
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'Close position failed' });
    }
    return;
  }

  // Manual Strike ("Price to Beat") Override API
  if (req.method === 'POST' && url.pathname === '/api/strike') {
    try {
      const body = await readJsonBody(req);
      const strikePrice = Number(body.strikePrice || 0);
      if (strikePrice > 1000) {
        polymarket.setManualStrikePrice(strikePrice);
        sendJson(res, 200, { ok: true, strikePrice });
      } else {
        sendJson(res, 400, { ok: false, error: 'Invalid strike price' });
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid request' });
    }
    return;
  }

  // Reset Paper Trading Account API
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    try {
      const body = await readJsonBody(req);
      const bankroll = Number(body.bankrollUsd || 1000);
      executionEngine.resetPaperAccount(bankroll > 10 ? bankroll : 1000);
      sendJson(res, 200, { ok: true, state: getFullState() });
    } catch {
      sendJson(res, 400, { ok: false, error: 'Reset failed' });
    }
    return;
  }

  // Static files in /dist or /public
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const absPath = path.join(STATIC_DIR, safePath);

  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    const ext = path.extname(absPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isHashedAsset = safePath.startsWith('assets/') || safePath.startsWith('/assets/');
    const cacheControl = isHashedAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-cache, no-store, must-revalidate';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(absPath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

let currentPort = PORT;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    currentPort += 1;
    console.warn(`Port ${currentPort - 1} in use, trying port ${currentPort}...`);
    server.listen(currentPort, '127.0.0.1');
  } else {
    console.error('Server error:', err);
  }
});

server.listen(currentPort, '127.0.0.1', () => {
  console.log(`\n════════════════════════════════════════════════════════════════════════`);
  console.log(`  POLYMARKET BTC 5m UP/DOWN SIGNAL & TRADING TERMINAL`);
  console.log(`  Dashboard URL: http://localhost:${currentPort}`);
  console.log(`  SDK Mode: ${polymarketSdk.authStatus.mode} | Execution: ${executionEngine.config.executionMode}`);
  console.log(`════════════════════════════════════════════════════════════════════════\n`);
});
