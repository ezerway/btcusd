import * as LightweightCharts from 'lightweight-charts';

let appState = {
  market: null,
  signal: null,
  sdkAuth: null,
  polymarket5mPrice: null,
  chartSeries: [],
  windowHistory: [],
};

let chartHoverX = null;

const fmtUsd = (n, decimals = 2) => {
  if (typeof n !== 'number' || Number.isNaN(n)) return '$--,---.--';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

const fmtSignedUsd = (n, decimals = 2) => {
  if (typeof n !== 'number' || Number.isNaN(n)) return '$0.00';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
};

let toastCounter = 0;
function showToast(title, message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const id = `toast-pop-${++toastCounter}`;
  const toast = document.createElement('div');
  toast.id = id;
  toast.setAttribute('popover', 'manual');
  toast.className = 'toast-item';

  const count = container.querySelectorAll('.toast-item').length;
  toast.style.bottom = `${18 + count * 70}px`;

  toast.innerHTML = `
    <div class="toast-top">
      <span>${escapeHtml(title)}</span>
      <button type="button" class="toast-close" popovertarget="${id}" popovertargetaction="hide">&times;</button>
    </div>
    <div class="toast-msg">${escapeHtml(message)}</div>
  `;

  container.appendChild(toast);
  try {
    if (typeof toast.showPopover === 'function') toast.showPopover();
    else toast.classList.add(':popover-open');
  } catch {
    toast.classList.add(':popover-open');
  }

  toast.querySelector('.toast-close')?.addEventListener('click', () => toast.remove());
  setTimeout(() => toast.remove(), 3800);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatCountdown(sec) {
  const s = Math.max(0, Number(sec || 0));
  const mins = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1).padStart(4, '0');
  return `0${mins}:${rem}`;
}

function updateSdkAuthUI() {
  const auth = appState.sdkAuth;
  const badge = document.getElementById('sdkAuthBadge');
  const detail = document.getElementById('sdkStatusDetail');
  if (!auth || !badge) return;

  if (auth.authenticated) {
    badge.textContent = auth.apiKeyPreview ? `SDK AUTH (${auth.apiKeyPreview})` : 'SDK AUTH';
    badge.className = 'sdk-badge authed';
  } else {
    badge.textContent = auth.clobOk ? 'SDK LIVE' : 'SDK PUBLIC';
    badge.className = 'sdk-badge';
  }

  if (detail && auth.message) {
    detail.textContent = auth.message;
  }
}

function updateUI() {
  const { market, signal, polymarket5mPrice } = appState;
  if (!market || !signal) return;

  updateSdkAuthUI();

  document.getElementById('marketQuestion').textContent = market.question;

  // Countdown inside Current Prices
  const timeEl = document.getElementById('timeRemaining');
  timeEl.textContent = formatCountdown(signal.timeRemainingSec);
  const isUrgent = signal.timeRemainingSec <= 45;
  timeEl.classList.toggle('urgent', isUrgent);

  const barFill = document.getElementById('countdownBarFill');
  if (barFill) {
    const pct = Math.max(0, Math.min(100, (signal.timeRemainingSec / 300) * 100));
    barFill.style.width = `${pct.toFixed(1)}%`;
    barFill.classList.toggle('urgent', isUrgent);
  }

  const winningBadge = document.getElementById('liveWinningBadge');
  if (winningBadge) {
    const diff = signal.distanceToStrikeUsd;
    if (diff > 0.01) {
      winningBadge.textContent = `UP ${fmtSignedUsd(diff)}`;
      winningBadge.className = 'pill pos';
    } else if (diff < -0.01) {
      winningBadge.textContent = `DOWN ${fmtSignedUsd(diff)}`;
      winningBadge.className = 'pill neg';
    } else {
      winningBadge.textContent = 'TIED';
      winningBadge.className = 'pill neutral';
    }
  }

  // Signal Banner
  const banner = document.getElementById('signalBanner');
  banner.classList.remove('buy-up', 'buy-down');
  document.getElementById('regimeBadge').textContent = signal.signalRegime;

  const actionEl = document.getElementById('signalActionVal');
  if (signal.action === 'BUY_UP') {
    banner.classList.add('buy-up');
    actionEl.textContent = 'SIGNAL: UP';
    actionEl.className = 'pos';
  } else if (signal.action === 'BUY_DOWN') {
    banner.classList.add('buy-down');
    actionEl.textContent = 'SIGNAL: DOWN';
    actionEl.className = 'neg';
  } else {
    actionEl.textContent = 'WAIT';
    actionEl.className = '';
  }

  document.getElementById('signalReasonText').textContent = signal.reason;
  document.getElementById('confidenceVal').textContent = `${signal.confidence}%`;

  // Price to Beat
  document.getElementById('strikePriceVal').textContent = fmtUsd(market.strikePrice);
  const strikeSub = document.getElementById('strikeSourceSub');
  if (strikeSub) {
    strikeSub.textContent = polymarket5mPrice ? 'Polymarket 5m Open' : '5m Open Reference';
  }

  // Current Price #1: Chainlink (BTC/USD)
  const curChainlink = signal.chainlinkPrice;
  const curPolySpot = signal.polymarketSpotPrice || signal.fastMidPrice;
  const curFast = signal.fastMidPrice;

  const clEl = document.getElementById('chainlinkPriceVal');
  if (clEl) clEl.textContent = fmtUsd(curChainlink);
  const twapEl = document.getElementById('twap60sVal');
  if (twapEl) twapEl.textContent = fmtUsd(signal.twap60sPrice || curChainlink);
  const projEl = document.getElementById('projectedOracleVal');
  if (projEl) projEl.textContent = fmtUsd(signal.projectedOraclePrice);

  const distBadge = document.getElementById('distanceBadge');
  distBadge.textContent = fmtSignedUsd(signal.distanceToStrikeUsd);
  distBadge.className = `pill ${signal.distanceToStrikeUsd >= 0 ? 'pos' : 'neg'}`;

  // Current Price #2: Polymarket RTDS Spot
  document.getElementById('polySpotPriceVal').textContent = fmtUsd(curPolySpot);
  const polyDist = curPolySpot - market.strikePrice;
  const polyDistBadge = document.getElementById('polySpotDistBadge');
  if (polyDistBadge) {
    polyDistBadge.textContent = fmtSignedUsd(polyDist);
    polyDistBadge.className = `pill ${polyDist >= 0 ? 'pos' : 'neg'}`;
  }

  // Current Price #3: Fast Exchange (same layout as #2)
  document.getElementById('fastMidPriceVal').textContent = fmtUsd(curFast);
  const fastDist = signal.fastDistanceToStrikeUsd;
  const fastDistBadge = document.getElementById('fastDistBadge');
  if (fastDistBadge) {
    fastDistBadge.textContent = fmtSignedUsd(fastDist);
    fastDistBadge.className = `pill ${fastDist >= 0 ? 'pos' : 'neg'}`;
  }

  // Fair Value vs Market Odds
  document.getElementById('fairProbUpVal').textContent = `${(signal.fairProbUp * 100).toFixed(1)}%`;
  document.getElementById('marketAskUpVal').textContent = `${(signal.marketAskUp * 100).toFixed(1)}¢`;
  const edgeUpPct = (signal.edgeUp * 100).toFixed(1);
  const edgeUpEl = document.getElementById('edgeUpVal');
  edgeUpEl.textContent = `Edge ${signal.edgeUp >= 0 ? '+' : ''}${edgeUpPct}%`;
  edgeUpEl.className = `edge-badge ${signal.edgeUp >= 0.025 ? 'pos' : signal.edgeUp < 0 ? 'neg' : ''}`;
  document.getElementById('upCard').classList.toggle('active-up', signal.action === 'BUY_UP');

  document.getElementById('fairProbDownVal').textContent = `${(signal.fairProbDown * 100).toFixed(1)}%`;
  document.getElementById('marketAskDownVal').textContent = `${(signal.marketAskDown * 100).toFixed(1)}¢`;
  const edgeDownPct = (signal.edgeDown * 100).toFixed(1);
  const edgeDownEl = document.getElementById('edgeDownVal');
  edgeDownEl.textContent = `Edge ${signal.edgeDown >= 0 ? '+' : ''}${edgeDownPct}%`;
  edgeDownEl.className = `edge-badge ${signal.edgeDown >= 0.025 ? 'pos' : signal.edgeDown < 0 ? 'neg' : ''}`;
  document.getElementById('downCard').classList.toggle('active-down', signal.action === 'BUY_DOWN');

  drawChart();
}

let chart = null;
let primaryBaselineSeries = null;
let polySpotSeries = null;
let fastSeries = null;
let strikePriceLine = null;
let seriesMarkersPlugin = null;
let currentChartMode = 'baseline'; // 'baseline' | 'delta' | 'price'

function initLightweightChart() {
  const container = document.getElementById('priceChartContainer');
  if (!container || typeof LightweightCharts === 'undefined') return;

  if (chart) {
    try { chart.remove(); } catch {}
    chart = null;
    seriesMarkersPlugin = null;
    strikePriceLine = null;
  }

  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth || 600,
    height: container.clientHeight || 320,
    layout: {
      background: { color: '#080b11' },
      textColor: '#94a3b8',
      fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(40, 53, 77, 0.4)' },
      horzLines: { color: 'rgba(40, 53, 77, 0.4)' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode ? LightweightCharts.CrosshairMode.Normal : 1,
      vertLine: {
        color: 'rgba(148, 163, 184, 0.6)',
        width: 1,
        style: 3,
        labelBackgroundColor: '#1e293b',
      },
      horzLine: {
        color: 'rgba(148, 163, 184, 0.6)',
        width: 1,
        style: 3,
        labelBackgroundColor: '#1e293b',
      },
    },
    rightPriceScale: {
      borderColor: '#28354d',
      scaleMargins: {
        top: 0.14,
        bottom: 0.14,
      },
      autoScale: true,
    },
    timeScale: {
      borderColor: '#28354d',
      timeVisible: true,
      secondsVisible: true,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    handleScroll: {
      vertTouchDrag: false,
    },
  });

  const addSeries = (type, options) => {
    if (chart.addSeries && LightweightCharts[type]) {
      return chart.addSeries(LightweightCharts[type], options);
    }
    if (type === 'BaselineSeries' && chart.addBaselineSeries) return chart.addBaselineSeries(options);
    if (type === 'AreaSeries' && chart.addAreaSeries) return chart.addAreaSeries(options);
    if (type === 'LineSeries' && chart.addLineSeries) return chart.addLineSeries(options);
    return null;
  };

  // Primary Series: Baseline Series for #1 Chainlink with binary win/loss shading
  primaryBaselineSeries = addSeries('BaselineSeries', {
    baseValue: { type: 'price', price: 0 },
    baseLineVisible: true,
    baseLineColor: '#c084fc',
    baseLineWidth: 2,
    baseLineStyle: LightweightCharts.LineStyle ? LightweightCharts.LineStyle.Dashed : 2,
    topLineColor: '#10b981',
    topFillColor1: 'rgba(16, 185, 129, 0.32)',
    topFillColor2: 'rgba(16, 185, 129, 0.04)',
    bottomLineColor: '#f43f5e',
    bottomFillColor1: 'rgba(244, 63, 94, 0.04)',
    bottomFillColor2: 'rgba(244, 63, 94, 0.32)',
    lineWidth: 2.5,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    title: '#1 Chainlink',
  });

  // #2 Polymarket Spot Line (Blue)
  polySpotSeries = addSeries('LineSeries', {
    color: '#3b82f6',
    lineWidth: 1.8,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    title: '#2 Poly Spot',
  });

  // #3 Fast Exchange Lead Line (Cyan)
  fastSeries = addSeries('LineSeries', {
    color: '#06b6d4',
    lineWidth: 2,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    title: '#3 Fast Exch',
  });

  // Hover Tooltip / Header Sync
  chart.subscribeCrosshairMove((param) => {
    const subtitleEl = document.getElementById('chartSummarySub');
    if (!subtitleEl) return;

    if (
      !param.time ||
      param.point === undefined ||
      param.point.x < 0 ||
      param.point.x > container.clientWidth ||
      param.point.y < 0 ||
      param.point.y > container.clientHeight
    ) {
      updateChartHeaderSummary();
      return;
    }

    const market = appState.market;
    const strike = market ? market.strikePrice : null;
    const clData = primaryBaselineSeries && param.seriesData ? param.seriesData.get(primaryBaselineSeries) : null;
    const plData = polySpotSeries && param.seriesData ? param.seriesData.get(polySpotSeries) : null;
    const fsData = fastSeries && param.seriesData ? param.seriesData.get(fastSeries) : null;

    const clVal = clData ? (typeof clData.value === 'number' ? clData.value : clData.close) : null;
    const plVal = plData ? (typeof plData.value === 'number' ? plData.value : plData.close) : null;
    const fsVal = fsData ? (typeof fsData.value === 'number' ? fsData.value : fsData.close) : null;

    if (currentChartMode === 'delta') {
      let text = typeof strike === 'number' ? `Beat: ${fmtUsd(strike)}` : '';
      if (typeof clVal === 'number') text += `  ·  #1 CL: ${fmtSignedUsd(clVal)}`;
      if (typeof plVal === 'number') text += `  ·  #2 Poly: ${fmtSignedUsd(plVal)}`;
      if (typeof fsVal === 'number') text += `  ·  #3 Fast: ${fmtSignedUsd(fsVal)}`;
      subtitleEl.textContent = text || 'Live Ticks Active';
    } else {
      let text = typeof strike === 'number' ? `Beat: ${fmtUsd(strike)}` : '';
      if (typeof clVal === 'number') text += `  ·  #1 CL ${fmtUsd(clVal)} (${typeof strike === 'number' ? fmtSignedUsd(clVal - strike) : ''})`;
      if (typeof plVal === 'number') text += `  ·  #2 Poly ${fmtUsd(plVal)}`;
      if (typeof fsVal === 'number') text += `  ·  #3 Fast ${fmtUsd(fsVal)}`;
      subtitleEl.textContent = text || 'Live Ticks Active';
    }
  });

  // Observe container resize for responsive sizing on mobile & desktop
  if (window.ResizeObserver) {
    const ro = new ResizeObserver((entries) => {
      if (!entries.length || !chart) return;
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        chart.applyOptions({ width, height });
      }
    });
    ro.observe(container);
  }
}

function updateChartHeaderSummary() {
  const subtitleEl = document.getElementById('chartSummarySub');
  const market = appState.market;
  const signal = appState.signal;
  if (!subtitleEl || !market || !signal) return;

  const strike = market.strikePrice;
  const curOracle = signal.chainlinkPrice;
  const curPolySpot = signal.polymarketSpotPrice || signal.fastMidPrice;
  const curFast = signal.fastMidPrice;

  if (currentChartMode === 'delta') {
    subtitleEl.textContent = `Beat: ${fmtUsd(strike)}  ·  #1 CL: ${fmtSignedUsd(curOracle - strike)}  ·  #3 Lead: ${fmtSignedUsd(curFast - strike)}`;
  } else {
    subtitleEl.textContent = `Beat: ${fmtUsd(strike)}  ·  #1 CL: ${fmtSignedUsd(curOracle - strike)}  ·  #3 Lead: ${fmtSignedUsd(curFast - strike)}`;
  }
}

function updateChartLegendUI() {
  const legend = document.getElementById('chartLegend');
  if (!legend) return;

  if (currentChartMode === 'delta') {
    legend.innerHTML = `
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-emerald-400"></i>UP (&gt; $0)</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-rose-500"></i>DOWN (&lt; $0)</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-cyan-400"></i>#3 Lead</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-purple-400"></i>Price to Beat</span>
    `;
  } else if (currentChartMode === 'price') {
    legend.innerHTML = `
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-emerald-400"></i>#1 Chainlink</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-blue-500"></i>#2 Poly Spot</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-cyan-400"></i>#3 Lead</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-purple-400"></i>Price to Beat</span>
    `;
  } else {
    legend.innerHTML = `
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-emerald-400"></i>UP</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-rose-500"></i>DOWN</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-cyan-400"></i>#3 Lead</span>
      <span class="inline-flex items-center gap-1.5 bg-[#1a2333] border border-[#28354d] px-2 py-0.5 rounded"><i class="inline-block w-2.5 h-1 rounded-sm bg-purple-400"></i>Price to Beat</span>
    `;
  }
}

function setChartMode(mode) {
  if (currentChartMode === mode) return;
  currentChartMode = mode;

  const buttons = document.querySelectorAll('.chart-mode-btn');
  buttons.forEach((btn) => {
    const isActive = btn.dataset.mode === mode;
    btn.classList.toggle('active', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('bg-blue-600', isActive);
    btn.classList.toggle('shadow-sm', isActive);
    btn.classList.toggle('font-semibold', isActive);
    btn.classList.toggle('text-slate-400', !isActive);
    btn.classList.toggle('font-medium', !isActive);
  });

  updateChartLegendUI();
  drawChart();
}

function applySeriesMarkers(series, markers) {
  if (!series) return;
  try {
    if (!seriesMarkersPlugin && typeof LightweightCharts.createSeriesMarkers === 'function') {
      seriesMarkersPlugin = LightweightCharts.createSeriesMarkers(series, markers);
      return;
    }
    if (seriesMarkersPlugin && typeof seriesMarkersPlugin.setMarkers === 'function') {
      seriesMarkersPlugin.setMarkers(markers);
      return;
    }
    if (typeof series.setMarkers === 'function') {
      series.setMarkers(markers);
    }
  } catch (err) {
    console.warn('Could not set markers:', err);
  }
}

function drawChart() {
  if (!chart) {
    initLightweightChart();
    if (!chart) return;
  }

  const market = appState.market;
  const signal = appState.signal;
  if (!market || !signal) return;

  const strike = market.strikePrice;
  const curOracle = signal.chainlinkPrice;
  const curPolySpot = signal.polymarketSpotPrice || signal.fastMidPrice;
  const curFast = signal.fastMidPrice;

  const isDelta = currentChartMode === 'delta';
  const isPrice = currentChartMode === 'price';
  const targetBasePrice = isDelta ? 0 : strike;
  const linePrice = isDelta ? 0 : strike;
  const lineTitle = isDelta ? 'BEAT ($0.00)' : `BEAT ${fmtUsd(strike)}`;

  // Keep up to 35 minutes of continuous historical ticks across previous milestones
  const nowMs = signal.timestamp || Date.now();
  const maxHistoryMs = 35 * 60 * 1000;
  const cutoffTs = nowMs - maxHistoryMs;

  const rawSeries = (appState.chartSeries || [])
    .filter(
      (pt) =>
        pt &&
        typeof pt.t === 'number' &&
        pt.t >= cutoffTs &&
        typeof pt.oracle === 'number' &&
        pt.oracle > 1000 &&
        Math.abs(pt.oracle - curOracle) < 8000
    )
    .map((pt) => ({
      ...pt,
      polySpot: typeof pt.polySpot === 'number' && pt.polySpot > 1000 ? pt.polySpot : pt.fast,
      strike: typeof pt.strike === 'number' && pt.strike > 1000 ? pt.strike : strike,
    }));

  const allPoints = [
    ...rawSeries,
    {
      t: nowMs,
      fast: curFast,
      polySpot: curPolySpot,
      oracle: curOracle,
      strike,
    },
  ];

  // Helper to deduplicate seconds and ensure strictly ascending timestamps
  const prepareSeriesData = (key) => {
    const list = [];
    let lastSec = -1;
    for (const pt of allPoints) {
      if (!pt || typeof pt[key] !== 'number' || isNaN(pt[key])) continue;
      const sec = Math.floor(pt.t / 1000);
      let val = pt[key];
      if (isDelta) {
        val = val - (pt.strike || strike);
      }
      if (sec <= lastSec) {
        if (list.length > 0 && sec === lastSec) {
          list[list.length - 1].value = val;
        }
        continue;
      }
      list.push({ time: sec, value: val });
      lastSec = sec;
    }
    return list;
  };

  const clData = prepareSeriesData('oracle');
  const polyData = prepareSeriesData('polySpot');
  const fastData = prepareSeriesData('fast');

  if (primaryBaselineSeries) primaryBaselineSeries.setData(clData);
  if (polySpotSeries) polySpotSeries.setData(polyData);
  if (fastSeries) fastSeries.setData(fastData);

  // Configure Baseline appearance
  if (primaryBaselineSeries) {
    if (isPrice) {
      primaryBaselineSeries.applyOptions({
        baseValue: { type: 'price', price: targetBasePrice },
        baseLineVisible: true,
        baseLineColor: '#c084fc',
        baseLineWidth: 2,
        baseLineStyle: LightweightCharts.LineStyle ? LightweightCharts.LineStyle.Dashed : 2,
        topLineColor: '#10b981',
        bottomLineColor: '#10b981',
        topFillColor1: 'rgba(16, 185, 129, 0.16)',
        topFillColor2: 'rgba(16, 185, 129, 0.02)',
        bottomFillColor1: 'rgba(16, 185, 129, 0.02)',
        bottomFillColor2: 'rgba(16, 185, 129, 0.16)',
      });
    } else {
      primaryBaselineSeries.applyOptions({
        baseValue: { type: 'price', price: targetBasePrice },
        baseLineVisible: true,
        baseLineColor: '#c084fc',
        baseLineWidth: 2,
        baseLineStyle: LightweightCharts.LineStyle ? LightweightCharts.LineStyle.Dashed : 2,
        topLineColor: '#10b981',
        topFillColor1: 'rgba(16, 185, 129, 0.32)',
        topFillColor2: 'rgba(16, 185, 129, 0.04)',
        bottomLineColor: '#f43f5e',
        bottomFillColor1: 'rgba(244, 63, 94, 0.04)',
        bottomFillColor2: 'rgba(244, 63, 94, 0.32)',
      });
    }

    // Always maintain Price to Beat horizontal price line with prominent axis label
    if (!strikePriceLine) {
      try {
        strikePriceLine = primaryBaselineSeries.createPriceLine({
          price: linePrice,
          color: '#c084fc',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle ? LightweightCharts.LineStyle.Dashed : 2,
          axisLabelVisible: true,
          title: lineTitle,
        });
      } catch (err) {
        console.warn('Failed to create price line:', err);
      }
    } else {
      try {
        strikePriceLine.applyOptions({
          price: linePrice,
          color: '#c084fc',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle ? LightweightCharts.LineStyle.Dashed : 2,
          axisLabelVisible: true,
          title: lineTitle,
        });
      } catch (err) {
        console.warn('Failed to update price line:', err);
      }
    }
  }

  // Generate milestone markers for previous rounds and current round
  const markers = [];
  const history = appState.windowHistory || [];
  const sortedHistory = [...history].sort((a, b) => a.windowStartSec - b.windowStartSec);

  const findClosestTime = (targetSec) => {
    if (!clData || !clData.length) return null;
    let closest = null;
    let minDiff = Infinity;
    for (const pt of clData) {
      const diff = Math.abs(pt.time - targetSec);
      if (diff < minDiff && diff <= 35) {
        minDiff = diff;
        closest = pt.time;
      }
    }
    return closest;
  };

  const usedTimes = new Set();

  for (const item of sortedHistory) {
    // 1. Previous Round Start Milestone
    const startT = findClosestTime(item.windowStartSec);
    if (startT && !usedTimes.has(startT)) {
      usedTimes.add(startT);
      markers.push({
        time: startT,
        position: 'aboveBar',
        color: '#c084fc',
        shape: 'circle',
        text: `🎯 Beat ${fmtUsd(item.strikePrice, 0)}`,
      });
    }

    // 2. Previous Round Resolution Milestone
    const endT = findClosestTime(item.windowEndSec);
    if (endT && !usedTimes.has(endT)) {
      usedTimes.add(endT);
      const isUp = item.winner === 'UP';
      markers.push({
        time: endT,
        position: isUp ? 'belowBar' : 'aboveBar',
        color: isUp ? '#10b981' : '#f43f5e',
        shape: isUp ? 'arrowUp' : 'arrowDown',
        text: `${isUp ? '🟢 UP' : '🔴 DOWN'} (${fmtSignedUsd(item.deltaUsd, 0)})`,
      });
    }
  }

  // Current active round milestone
  if (market && market.startTimeSec) {
    const curStartT = findClosestTime(market.startTimeSec);
    if (curStartT && !usedTimes.has(curStartT)) {
      usedTimes.add(curStartT);
      markers.push({
        time: curStartT,
        position: 'aboveBar',
        color: '#a855f7',
        shape: 'circle',
        text: `🎯 Beat ${fmtUsd(market.strikePrice, 0)} (Live)`,
      });
    }
  }

  // Sort markers in ascending order of time
  markers.sort((a, b) => a.time - b.time);

  if (primaryBaselineSeries) {
    applySeriesMarkers(primaryBaselineSeries, markers);
  }

  updateChartHeaderSummary();
}

window.addEventListener('DOMContentLoaded', () => {
  initLightweightChart();
  window.addEventListener('resize', () => {
    const container = document.getElementById('priceChartContainer');
    if (chart && container) {
      chart.applyOptions({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    }
  });

  // Mode Switcher buttons
  document.querySelectorAll('.chart-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode) setChartMode(mode);
    });
  });

  document.getElementById('btnEditStrike').addEventListener('click', async () => {
    const cur = appState.market ? appState.market.strikePrice : 84150;
    const val = parseFloat(window.prompt('Enter 5m Price to Beat:', String(cur)) || '');
    if (val > 1000) {
      await fetch('/api/strike', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strikePrice: val }),
      });
    }
  });

  // Polymarket SDK Auth Dialog
  const authDialog = document.getElementById('authDialog');
  document.getElementById('btnOpenAuthModal').addEventListener('click', () => {
    authDialog.showModal();
  });
  document.getElementById('btnCloseAuthModal').addEventListener('click', () => authDialog.close());
  document.getElementById('btnCancelAuth').addEventListener('click', () => authDialog.close());

  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      apiKey: document.getElementById('inputApiKey').value.trim() || undefined,
      secret: document.getElementById('inputSecret').value.trim() || undefined,
      passphrase: document.getElementById('inputPassphrase').value.trim() || undefined,
      privateKey: document.getElementById('inputPrivateKey').value.trim() || undefined,
    };
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.sdkAuth) {
      appState.sdkAuth = data.sdkAuth;
      updateSdkAuthUI();
      showToast(
        data.sdkAuth.authenticated ? 'SDK Authenticated' : 'SDK Status',
        data.sdkAuth.message
      );
    }
    authDialog.close();
  });

  const es = new EventSource('/api/stream');
  es.addEventListener('init', (e) => {
    Object.assign(appState, JSON.parse(e.data));
    updateUI();
  });

  es.addEventListener('tick', (e) => {
    const data = JSON.parse(e.data);
    appState.market = data.market;
    appState.signal = data.signal;
    if (data.sdkAuth) appState.sdkAuth = data.sdkAuth;
    if (data.polymarket5mPrice) appState.polymarket5mPrice = data.polymarket5mPrice;
    if (Array.isArray(data.windowHistory)) appState.windowHistory = data.windowHistory;
    if (data.chartPoint) {
      const last = appState.chartSeries[appState.chartSeries.length - 1];
      if (!last || data.chartPoint.t - last.t >= 850) {
        appState.chartSeries.push(data.chartPoint);
        if (appState.chartSeries.length > 1800) {
          appState.chartSeries.splice(0, appState.chartSeries.length - 1800);
        }
      } else {
        appState.chartSeries[appState.chartSeries.length - 1] = data.chartPoint;
      }
    }
    updateUI();
  });

  es.addEventListener('auth_updated', (e) => {
    appState.sdkAuth = JSON.parse(e.data);
    updateSdkAuthUI();
  });

  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    showToast(a.title, a.message);
  });
});
