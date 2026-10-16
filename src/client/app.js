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

let chartRangeMinutes = 15; // '5' | '15' | '30' | 'all'
let chartHoverPoint = null; // { x, y }

function drawChart() {
  const canvas = document.getElementById('priceChartCanvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(300, Math.floor(rect.width * dpr));
  const targetH = Math.max(180, Math.floor(rect.height * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  const market = appState.market;
  const signal = appState.signal;
  if (!market || !signal) {
    ctx.restore();
    return;
  }

  const strike = market.strikePrice;
  const curOracle = signal.chainlinkPrice;
  const curPolySpot = signal.polymarketSpotPrice || signal.fastMidPrice;
  const curFast = signal.fastMidPrice;
  const nowMs = signal.timestamp || Date.now();

  // Layout Paddings
  const padLeft = 16;
  const padRight = 110; // For price labels and badges
  const padTop = 20;
  const padBottom = 28; // For time labels
  const plotW = Math.max(50, w - padLeft - padRight);
  const plotH = Math.max(50, h - padTop - padBottom);

  // KEY REQUIREMENT: Price to Beat is ALWAYS locked in the exact vertical center!
  const centerY = padTop + plotH / 2;

  // Filter series according to selected time range
  let cutoffTs = 0;
  if (chartRangeMinutes !== 'all') {
    const mins = Number(chartRangeMinutes) || 15;
    cutoffTs = nowMs - mins * 60 * 1000;
  }

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
      t: pt.t,
      oracle: pt.oracle,
      polySpot: typeof pt.polySpot === 'number' && pt.polySpot > 1000 ? pt.polySpot : pt.fast,
      fast: pt.fast,
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

  if (allPoints.length === 1) {
    allPoints.unshift({
      t: nowMs - 5000,
      fast: curFast,
      polySpot: curPolySpot,
      oracle: curOracle,
      strike,
    });
  }

  // Time scale (X-Axis)
  const minT = allPoints[0].t;
  const maxT = Math.max(minT + 10000, nowMs + 10000); // 10s right padding for clean aesthetics
  const timeSpan = maxT - minT;
  const toX = (t) => padLeft + Math.max(0, Math.min(1, (t - minT) / timeSpan)) * plotW;

  // Price scale (Y-Axis) - STRICTLY SYMMETRIC AROUND STRIKE PRICE!
  // Price to Beat ALWAYS in the vertical center: toY(strike) = centerY!
  let maxDev = 15; // Minimum half-span ($15) so scale doesn't jitter when flat
  for (const pt of allPoints) {
    if (typeof pt.oracle === 'number') maxDev = Math.max(maxDev, Math.abs(pt.oracle - strike));
    if (typeof pt.polySpot === 'number') maxDev = Math.max(maxDev, Math.abs(pt.polySpot - strike));
    if (typeof pt.fast === 'number') maxDev = Math.max(maxDev, Math.abs(pt.fast - strike));
  }
  maxDev = Math.max(maxDev, Math.abs(curOracle - strike));
  maxDev = Math.max(maxDev, Math.abs(curPolySpot - strike));
  maxDev = Math.max(maxDev, Math.abs(curFast - strike));

  // Add 25% padding so curves don't clip the edges
  const halfSpan = Math.max(20, Math.ceil(maxDev * 1.25));

  // toY: Exactly centered!
  // When p === strike: toY(strike) = centerY
  // When p > strike: toY(p) < centerY (UP)
  // When p < strike: toY(p) > centerY (DOWN)
  const toY = (p) => centerY - ((p - strike) / halfSpan) * (plotH / 2);

  // 1. UP Zone (Top Half) & DOWN Zone (Bottom Half) Tints
  const upGrad = ctx.createLinearGradient(0, padTop, 0, centerY);
  upGrad.addColorStop(0, 'rgba(16, 185, 129, 0.08)');
  upGrad.addColorStop(1, 'rgba(16, 185, 129, 0.005)');
  ctx.fillStyle = upGrad;
  ctx.fillRect(padLeft, padTop, plotW, centerY - padTop);

  const downGrad = ctx.createLinearGradient(0, centerY, 0, padTop + plotH);
  downGrad.addColorStop(0, 'rgba(244, 63, 94, 0.005)');
  downGrad.addColorStop(1, 'rgba(244, 63, 94, 0.08)');
  ctx.fillStyle = downGrad;
  ctx.fillRect(padLeft, centerY, plotW, padTop + plotH - centerY);

  // Subtle Zone Watermarks
  ctx.save();
  ctx.font = '800 10px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
  ctx.textAlign = 'right';
  ctx.fillText('▲ UP ZONE', padLeft + plotW - 10, padTop + 14);
  ctx.fillStyle = 'rgba(244, 63, 94, 0.15)';
  ctx.fillText('▼ DOWN ZONE', padLeft + plotW - 10, padTop + plotH - 8);
  ctx.restore();

  // 2. Symmetric Gridlines (2 above, 2 below)
  const gridSteps = [
    halfSpan * 0.8,
    halfSpan * 0.4,
    -halfSpan * 0.4,
    -halfSpan * 0.8,
  ];

  ctx.save();
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';

  for (const d of gridSteps) {
    const p = strike + d;
    const y = toY(p);

    ctx.strokeStyle = 'rgba(40, 53, 77, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Delta label on left
    const sign = d > 0 ? '+' : '-';
    const deltaStr = `${sign}$${Math.abs(d).toFixed(1)}`;
    ctx.fillStyle = d > 0 ? 'rgba(16, 185, 129, 0.65)' : 'rgba(244, 63, 94, 0.65)';
    ctx.textAlign = 'left';
    ctx.fillText(deltaStr, padLeft + 4, y - 6);

    // Price label on right
    ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
    ctx.textAlign = 'left';
    ctx.fillText(fmtUsd(p), padLeft + plotW + 6, y);
  }
  ctx.restore();

  // 3. 5m Window Start Vertical Marker
  if (market.startTimeSec) {
    const roundStartMs = market.startTimeSec * 1000;
    if (roundStartMs >= minT && roundStartMs <= maxT) {
      const startX = toX(roundStartMs);
      ctx.save();
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(startX, padTop);
      ctx.lineTo(startX, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#c084fc';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('5M START', startX, padTop + 10);
      ctx.restore();
    }
  }

  // 4. Shaded Area Between #1 Chainlink and Price to Beat
  ctx.save();
  ctx.beginPath();
  allPoints.forEach((pt, idx) => {
    const x = toX(pt.t);
    const y = toY(pt.oracle);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(toX(allPoints[allPoints.length - 1].t), centerY);
  ctx.lineTo(toX(allPoints[0].t), centerY);
  ctx.closePath();
  ctx.fillStyle = curOracle >= strike ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 63, 94, 0.12)';
  ctx.fill();
  ctx.restore();

  // 5. CENTER LINE: Price to Beat (Focused at Center)
  ctx.save();
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(padLeft, centerY);
  ctx.lineTo(padLeft + plotW, centerY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Left Badge for Price to Beat
  const beatLabel = `🎯 BEAT ${fmtUsd(strike)}`;
  ctx.font = 'bold 10px "JetBrains Mono", monospace';
  const beatTextW = ctx.measureText(beatLabel).width;
  ctx.fillStyle = '#1e1b4b';
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 1;
  const badgeX = padLeft + 6;
  const badgeY = centerY - 10;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, beatTextW + 12, 20, 4);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#e9d5ff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(beatLabel, badgeX + 6, centerY);

  // Right-axis Badge for Price to Beat
  const beatRightLabel = fmtUsd(strike);
  const beatRightW = ctx.measureText(beatRightLabel).width;
  ctx.fillStyle = '#7e22ce';
  ctx.beginPath();
  ctx.roundRect(padLeft + plotW + 4, centerY - 9, beatRightW + 10, 18, 4);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(beatRightLabel, padLeft + plotW + 9, centerY);
  ctx.restore();

  // 6. OTHER PRICES HAVE HISTORY
  // #2 Polymarket Spot Line (Blue)
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  allPoints.forEach((pt, idx) => {
    const x = toX(pt.t);
    const y = toY(pt.polySpot);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();

  // #3 Fast Exchange Lead Line (Cyan)
  ctx.save();
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 1.85;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  allPoints.forEach((pt, idx) => {
    const x = toX(pt.t);
    const y = toY(pt.fast);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();

  // #1 Chainlink Settlement Line (Amber)
  ctx.save();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  allPoints.forEach((pt, idx) => {
    const x = toX(pt.t);
    const y = toY(pt.oracle);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();

  // 7. End Dots & Right-Axis Live Badges
  const lastPt = allPoints[allPoints.length - 1];
  const lastX = toX(lastPt.t);

  const drawDot = (y, color, radius = 4) => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(lastX, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  };

  const clY = toY(curOracle);
  const polyY = toY(curPolySpot);
  const fastY = toY(curFast);

  drawDot(polyY, '#3b82f6', 3.5);
  drawDot(fastY, '#06b6d4', 3.5);
  drawDot(clY, '#f59e0b', 5);

  // Right-axis current price badges
  ctx.save();
  ctx.font = 'bold 10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';

  const clDiff = curOracle - strike;
  const clText = `${fmtUsd(curOracle, 1)} (${clDiff >= 0 ? '+' : ''}${clDiff.toFixed(1)})`;
  const clTextW = ctx.measureText(clText).width;
  ctx.fillStyle = curOracle >= strike ? '#065f46' : '#881337';
  ctx.strokeStyle = curOracle >= strike ? '#10b981' : '#f43f5e';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(padLeft + plotW + 4, clY - 9, clTextW + 8, 18, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(clText, padLeft + plotW + 8, clY);

  if (Math.abs(fastY - clY) > 18 && Math.abs(fastY - centerY) > 12) {
    const fsText = `${fmtUsd(curFast, 1)}`;
    const fsTextW = ctx.measureText(fsText).width;
    ctx.fillStyle = '#164e63';
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(padLeft + plotW + 4, fastY - 8, fsTextW + 8, 16, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#67e8f9';
    ctx.fillText(fsText, padLeft + plotW + 8, fastY);
  }
  ctx.restore();

  // 8. X-Axis Time Labels
  ctx.save();
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const formatTime = (ts) => {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };

  const timeTicks = 5;
  for (let i = 0; i <= timeTicks; i++) {
    const t = minT + (i / timeTicks) * timeSpan;
    const x = toX(t);
    ctx.strokeStyle = 'rgba(40, 53, 77, 0.5)';
    ctx.beginPath();
    ctx.moveTo(x, padTop + plotH);
    ctx.lineTo(x, padTop + plotH + 4);
    ctx.stroke();

    ctx.fillText(formatTime(t), x, padTop + plotH + 6);
  }
  ctx.restore();

  // 9. Interactive Crosshair & Tooltip
  if (chartHoverPoint && chartHoverPoint.x >= padLeft && chartHoverPoint.x <= padLeft + plotW) {
    const hx = chartHoverPoint.x;
    let closestPt = allPoints[0];
    let minD = Infinity;
    for (const pt of allPoints) {
      const px = toX(pt.t);
      const dist = Math.abs(px - hx);
      if (dist < minD) {
        minD = dist;
        closestPt = pt;
      }
    }

    if (closestPt) {
      const cx = toX(closestPt.t);
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, padTop);
      ctx.lineTo(cx, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      const hClY = toY(closestPt.oracle);
      const hPlY = toY(closestPt.polySpot);
      const hFsY = toY(closestPt.fast);

      const drawHoverDot = (y, color) => {
        ctx.beginPath();
        ctx.arc(cx, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      };
      drawHoverDot(hPlY, '#3b82f6');
      drawHoverDot(hFsY, '#06b6d4');
      drawHoverDot(hClY, '#f59e0b');
      ctx.restore();

      const tooltip = document.getElementById('chartTooltip');
      if (tooltip) {
        const delta = closestPt.oracle - strike;
        const deltaStr = fmtSignedUsd(delta);
        const d = new Date(closestPt.t);
        const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

        tooltip.innerHTML = `
          <div class="font-bold text-slate-300 mb-1 border-b border-[#28354d] pb-1 flex justify-between gap-3">
            <span>${timeStr}</span>
            <span class="${delta >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-extrabold">${delta >= 0 ? 'UP' : 'DOWN'} ${deltaStr}</span>
          </div>
          <div class="flex flex-col gap-0.5 text-[11px]">
            <div class="flex justify-between gap-3"><span class="text-amber-400">#1 Chainlink:</span><strong class="text-white">${fmtUsd(closestPt.oracle)}</strong></div>
            <div class="flex justify-between gap-3"><span class="text-blue-400">#2 Poly Spot:</span><strong class="text-white">${fmtUsd(closestPt.polySpot)}</strong></div>
            <div class="flex justify-between gap-3"><span class="text-cyan-400">#3 Fast Lead:</span><strong class="text-white">${fmtUsd(closestPt.fast)}</strong></div>
            <div class="flex justify-between gap-3"><span class="text-purple-400">Price to Beat:</span><strong class="text-white">${fmtUsd(strike)}</strong></div>
          </div>
        `;
        tooltip.style.display = 'block';

        const containerRect = canvas.parentElement.getBoundingClientRect();
        let leftPos = cx + 15;
        if (leftPos + 185 > containerRect.width) {
          leftPos = cx - 195;
        }
        tooltip.style.left = `${Math.max(10, leftPos)}px`;
        tooltip.style.top = `${Math.max(10, Math.min(containerRect.height - 110, chartHoverPoint.y - 40))}px`;
      }
    }
  } else {
    const tooltip = document.getElementById('chartTooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  // 10. Header Subtitle Summary
  const subtitleEl = document.getElementById('chartSummarySub');
  if (subtitleEl) {
    const diff = curOracle - strike;
    const fastDiff = curFast - strike;
    subtitleEl.textContent = `🎯 Beat: ${fmtUsd(strike)}  ·  #1 CL: ${fmtUsd(curOracle)} (${fmtSignedUsd(diff)})  ·  #3 Lead: ${fmtSignedUsd(fastDiff)}`;
  }

  ctx.restore();
}

function initChartEvents() {
  const canvas = document.getElementById('priceChartCanvas');
  if (!canvas) return;

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    chartHoverPoint = {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
    drawChart();
  };

  const onLeave = () => {
    chartHoverPoint = null;
    const tooltip = document.getElementById('chartTooltip');
    if (tooltip) tooltip.style.display = 'none';
    drawChart();
  };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('touchstart', onMove, { passive: true });
  canvas.addEventListener('touchmove', onMove, { passive: true });
  canvas.addEventListener('touchend', onLeave);
}

window.addEventListener('DOMContentLoaded', () => {
  initChartEvents();
  window.addEventListener('resize', drawChart);

  // Time Range Filter buttons
  document.querySelectorAll('.chart-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const range = btn.dataset.range;
      if (!range) return;
      chartRangeMinutes = range === 'all' ? 'all' : Number(range);
      document.querySelectorAll('.chart-range-btn').forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.classList.toggle('text-white', isActive);
        b.classList.toggle('bg-blue-600', isActive);
        b.classList.toggle('shadow-sm', isActive);
        b.classList.toggle('font-semibold', isActive);
        b.classList.toggle('text-slate-400', !isActive);
        b.classList.toggle('font-medium', !isActive);
      });
      drawChart();
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

  // PWA Service Worker Registration & Install Prompt
  let deferredPrompt = null;
  const btnInstall = document.getElementById('btnInstallPwa');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnInstall) {
      btnInstall.classList.remove('hidden');
    }
  });

  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        showToast('App Installed', 'BTC 5M Terminal is now installed on your device!');
      }
      deferredPrompt = null;
      btnInstall.classList.add('hidden');
    });
  }

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (btnInstall) btnInstall.classList.add('hidden');
    showToast('PWA Active', 'Running as a standalone web app.');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (installing) {
            installing.addEventListener('statechange', () => {
              if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                showToast('Update Available', 'New version ready. Reload to update.');
              }
            });
          }
        });
      })
      .catch((err) => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
  }
});
