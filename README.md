# Polymarket BTC 5m Up/Down — Lead-Lag & Oracle Arbitrage Terminal

A real-time quantitative signal dashboard, paper-trading simulator, and automated Polymarket CLOB execution engine built specifically for **Polymarket Bitcoin Up or Down (5-Minute)** binary markets (`btc-updown-5m-<epoch>`).

---

## Quick Start

Requires **Node.js 22.6+** (tested on Node v25.9.0 with native TypeScript execution — zero build step required):

```bash
pnpm start
# or in watch mode:
pnpm dev
```

Then open **http://localhost:3000** in your browser.

---

## How the Alpha & Strategy Engine Works

Polymarket's 5-minute BTC markets resolve to **UP (YES)** if the Chainlink BTC/USD Data Stream price at the end of the 5-minute window ($T_{\text{end}}$) is $\ge$ the Chainlink BTC/USD price at the start of the window ($T_{\text{start}}$, the **"Price to Beat"** / Strike $K$).

1. **Fast Exchange Lead vs. Settlement Oracle Lag (`ORACLE_LEAD_ARB`)**
   - Streams real-time ticks from **Binance USD-M Perpetual Futures**, **Binance Spot**, and **Coinbase USD Spot**, computing a lead-weighted composite price (`fastMidPrice`) alongside 1s/5s velocity, aggressor CVD, and orderbook imbalance.
   - Compares `fastMidPrice` against the **Chainlink BTC/USD Oracle** (`chainlinkPrice`) to project where Chainlink will print 1–2.5 seconds ahead before Polymarket CLOB market makers update their quotes.

2. **Drift-Adjusted Binary Option Fair Value (`FAIR_VALUE_MISPRICING`)**
   - Computes the exact remaining time $\tau = T_{\text{end}} - t$ and realized per-second log-return volatility $\sigma_{\text{sec}}$ to price the true binary probability:
     $$P_{\text{fair}}(\text{UP}) = \Phi\left(\frac{\ln(S_{\text{projected}} / K) + \mu_{\text{drift}}}{\sigma_{\text{sec}}\sqrt{\tau}}\right)$$
   - Compares $P_{\text{fair}}$ against live Polymarket CLOB best asks (`Ask_UP`, `Ask_DOWN`) minus fee/slippage buffer to calculate **Net Edge (%)** and **Fractional Kelly Criterion** bet sizing.

3. **Final-Minute High-Gamma Latency Sniping (`LATENCY_SNIPE`)**
   - In the final 65 seconds of a 5-minute candle, binary option gamma peaks near the strike. When Binance Perp/Spot crosses or accelerates away from the strike ahead of Chainlink and CLOB market makers, the engine flags high-conviction **Latency Snipe** opportunities.

4. **Latency Convergence Early Profit-Taking**
   - Instead of holding every trade to 5m expiration risk, when Polymarket CLOB bids catch up to the model's fair value and unrealized ROI exceeds the target threshold (default `+16%`), the Auto-Bot automatically sells into the bid to lock in profits early.

---

## Configuration (`.env`)

By default, the terminal runs in **Paper Trading / Simulation Mode** using public exchange WebSockets + Polymarket Gamma/CLOB/RTDS feeds (with automatic offline simulation fallback).

To enable direct authenticated Chainlink Data Streams or Live Polymarket CLOB order placement, populate [`.env`](file:///Volumes/KINGSTON/Code/btcusd/.env) (see [`.env.example`](file:///Volumes/KINGSTON/Code/btcusd/.env.example)):

```ini
CHAINLINK_API_KEY=your_chainlink_api_key_here
CHAINLINK_USER_SECRET=your_chainlink_hmac_secret_here

POLYMARKET_API_KEY=your_polymarket_api_key_here
POLYMARKET_SECRET=your_polymarket_secret_here
POLYMARKET_PASSPHRASE=your_polymarket_passphrase_here

PORT=3000
```
