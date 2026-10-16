let appState = {
  market: null,
  signal: null,
  sdkAuth: null,
  polymarket5mPrice: null,
  chartSeries: [],
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

  document.getElementById('chainlinkPriceVal').textContent = fmtUsd(curChainlink);
  document.getElementById('twap60sVal').textContent = fmtUsd(signal.twap60sPrice || curChainlink);
  document.getElementById('projectedOracleVal').textContent = fmtUsd(signal.projectedOraclePrice);

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

function drawPriceTag(ctx, x, y, width, text, bgColor, textColor = '#080b11') {
  const h = 17;
  const r = 4;
  const top = Math.round(y - h / 2);
  ctx.save();
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.roundRect(x, top, width, h, r);
  ctx.fill();

  ctx.fillStyle = textColor;
  ctx.font = 'bold 10px "JetBrains Mono", Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 5, y);
  ctx.restore();
}

function drawChart() {
  const canvas = document.getElementById('priceChartCanvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(600, Math.floor(rect.width * dpr));
  const targetH = Math.max(240, Math.floor(rect.height * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

  const w = rect.width || 1160;
  const h = rect.height || 360;
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

  const windowCutoff = (market.startTimeSec - 30) * 1000;
  const rawSeries = (appState.chartSeries || [])
    .filter(
      (pt) =>
        pt &&
        pt.t >= windowCutoff &&
        Math.abs(pt.oracle - curOracle) < 1000 &&
        Math.abs(pt.fast - curFast) < 1000
    )
    .map((pt) => ({
      ...pt,
      polySpot: typeof pt.polySpot === 'number' && pt.polySpot > 1000 ? pt.polySpot : pt.fast,
    }));

  const series = [
    ...rawSeries,
    {
      t: signal.timestamp || Date.now(),
      fast: curFast,
      polySpot: curPolySpot,
      oracle: curOracle,
      strike,
    },
  ];

  if (series.length === 1) {
    series.unshift({
      t: series[0].t - 2000,
      fast: curFast,
      polySpot: curPolySpot,
      oracle: curOracle,
      strike,
    });
  }

  const padLeft = 14;
  const padRight = 112;
  const padTop = 18;
  const padBottom = 26;
  const plotW = Math.max(100, w - padLeft - padRight);
  const plotH = Math.max(80, h - padTop - padBottom);

  let minP = strike;
  let maxP = strike;
  for (const pt of series) {
    minP = Math.min(minP, pt.fast, pt.polySpot, pt.oracle);
    maxP = Math.max(maxP, pt.fast, pt.polySpot, pt.oracle);
  }

  const rawSpan = maxP - minP;
  const minSpan = 28;
  if (rawSpan < minSpan) {
    const mid = (maxP + minP) / 2;
    minP = mid - minSpan / 2;
    maxP = mid + minSpan / 2;
  } else {
    const pad = rawSpan * 0.18;
    minP -= pad;
    maxP += pad;
  }

  const range = Math.max(1, maxP - minP);
  const toY = (p) => padTop + (1 - (p - minP) / range) * plotH;
  const toX = (i) => padLeft + (i / Math.max(1, series.length - 1)) * plotW;

  const strikeY = toY(strike);
  const clampedStrikeY = Math.max(padTop, Math.min(padTop + plotH, strikeY));

  const subtitleEl = document.getElementById('chartSummarySub');
  if (subtitleEl) {
    subtitleEl.textContent = `Beat ${fmtUsd(strike)}  ·  #1 CL ${fmtSignedUsd(
      curOracle - strike
    )}  ·  #2 Poly ${fmtSignedUsd(curPolySpot - strike)}  ·  #3 Fast ${fmtSignedUsd(
      curFast - strike
    )}`;
  }

  // 1. UP (green) and DOWN (red) background tint
  if (clampedStrikeY > padTop) {
    const upGrad = ctx.createLinearGradient(0, padTop, 0, clampedStrikeY);
    upGrad.addColorStop(0, 'rgba(16, 185, 129, 0.09)');
    upGrad.addColorStop(1, 'rgba(16, 185, 129, 0.01)');
    ctx.fillStyle = upGrad;
    ctx.fillRect(padLeft, padTop, plotW, clampedStrikeY - padTop);
  }
  if (clampedStrikeY < padTop + plotH) {
    const downGrad = ctx.createLinearGradient(0, clampedStrikeY, 0, padTop + plotH);
    downGrad.addColorStop(0, 'rgba(244, 63, 94, 0.01)');
    downGrad.addColorStop(1, 'rgba(244, 63, 94, 0.09)');
    ctx.fillStyle = downGrad;
    ctx.fillRect(padLeft, clampedStrikeY, plotW, padTop + plotH - clampedStrikeY);
  }

  // 2. Grid lines + price & delta labels
  const gridSteps = 4;
  ctx.font = '10px "JetBrains Mono", Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= gridSteps; i++) {
    const p = maxP - (i / gridSteps) * range;
    const y = toY(p);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();

    const delta = p - strike;
    const deltaStr = `${delta >= 0 ? '+' : '-'}$${Math.abs(delta).toFixed(0)}`;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.fillText(deltaStr, padLeft + 4, y - 7);
    ctx.fillText(`$${p.toFixed(1)}`, padLeft + plotW + 6, y);
  }

  // 3. Shaded area between #1 Chainlink and Price to Beat
  ctx.save();
  ctx.beginPath();
  series.forEach((pt, idx) => {
    const x = toX(idx);
    const y = toY(pt.oracle);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(toX(series.length - 1), clampedStrikeY);
  ctx.lineTo(toX(0), clampedStrikeY);
  ctx.closePath();
  ctx.fillStyle =
    curOracle >= strike ? 'rgba(16, 185, 129, 0.16)' : 'rgba(244, 63, 94, 0.16)';
  ctx.fill();
  ctx.restore();

  // 4. Price to Beat line
  ctx.save();
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 1.75;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(padLeft, strikeY);
  ctx.lineTo(padLeft + plotW, strikeY);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#d8b4fe';
  ctx.font = 'bold 10px "JetBrains Mono", Menlo, monospace';
  ctx.fillText(`BEAT ${fmtUsd(strike)}`, padLeft + 44, strikeY - 6);

  // 5. #1 Chainlink (Amber)
  ctx.save();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  series.forEach((pt, idx) => {
    const x = toX(idx);
    const y = toY(pt.oracle);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();

  // 6. #2 Poly Spot (Blue)
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.9;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  series.forEach((pt, idx) => {
    const x = toX(idx);
    const y = toY(pt.polySpot);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();

  // 7. #3 Fast Exch (Cyan)
  ctx.save();
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  series.forEach((pt, idx) => {
    const x = toX(idx);
    const y = toY(pt.fast);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();

  // 8. End Dots + Right-Axis Callout Badges
  const lastX = toX(series.length - 1);
  const oracleY = toY(curOracle);
  const polySpotY = toY(curPolySpot);
  const fastY = toY(curFast);

  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(lastX, oracleY, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.arc(lastX, polySpotY, 3.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#06b6d4';
  ctx.beginPath();
  ctx.arc(lastX, fastY, 3.4, 0, Math.PI * 2);
  ctx.fill();

  const tags = [
    { y: strikeY, text: `BEAT ${strike.toFixed(1)}`, bg: '#a855f7', fg: '#ffffff' },
    { y: oracleY, text: `#1 CL ${curOracle.toFixed(1)}`, bg: '#f59e0b', fg: '#080b11' },
    { y: polySpotY, text: `#2 PL ${curPolySpot.toFixed(1)}`, bg: '#3b82f6', fg: '#ffffff' },
    { y: fastY, text: `#3 FS ${curFast.toFixed(1)}`, bg: '#06b6d4', fg: '#080b11' },
  ].sort((a, b) => a.y - b.y);

  const minGap = 18;
  for (let i = 1; i < tags.length; i++) {
    if (tags[i].y - tags[i - 1].y < minGap) {
      tags[i].y = tags[i - 1].y + minGap;
    }
  }
  for (const tag of tags) {
    const clampedY = Math.max(padTop + 8, Math.min(padTop + plotH - 8, tag.y));
    drawPriceTag(ctx, padLeft + plotW + 4, clampedY, padRight - 8, tag.text, tag.bg, tag.fg);
  }

  // 9. X-Axis Timestamps
  ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
  ctx.font = '10px "JetBrains Mono", Menlo, monospace';
  const timeTicks = Math.min(6, series.length);
  for (let k = 0; k < timeTicks; k++) {
    const idx = Math.floor((k / Math.max(1, timeTicks - 1)) * (series.length - 1));
    const pt = series[idx];
    const x = toX(idx);
    const label =
      k === timeTicks - 1
        ? 'NOW'
        : new Date(pt.t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
    const alignOffset = k === 0 ? 0 : k === timeTicks - 1 ? -24 : -16;
    ctx.fillText(label, x + alignOffset, h - 8);
  }

  // 10. Hover Crosshair & Tooltip
  if (chartHoverX !== null && chartHoverX >= padLeft && chartHoverX <= padLeft + plotW) {
    const ratio = (chartHoverX - padLeft) / plotW;
    const hoverIdx = Math.max(
      0,
      Math.min(series.length - 1, Math.round(ratio * (series.length - 1)))
    );
    const pt = series[hoverIdx];
    const hx = toX(hoverIdx);
    const hyOracle = toY(pt.oracle);

    ctx.save();
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, padTop);
    ctx.lineTo(hx, padTop + plotH);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(hx, hyOracle, 4.5, 0, Math.PI * 2);
    ctx.fill();

    const diffOracle = pt.oracle - strike;
    const diffPoly = pt.polySpot - strike;
    const diffFast = pt.fast - strike;
    const tStr = new Date(pt.t).toLocaleTimeString();
    const lines = [
      `Time: ${tStr}`,
      `#1 CL:   ${fmtUsd(pt.oracle)} (${fmtSignedUsd(diffOracle)})`,
      `#2 Poly: ${fmtUsd(pt.polySpot)} (${fmtSignedUsd(diffPoly)})`,
      `#3 Fast: ${fmtUsd(pt.fast)} (${fmtSignedUsd(diffFast)})`,
      `Beat:    ${fmtUsd(strike)}`,
    ];

    const boxW = 216;
    const boxH = 82;
    const boxX = hx + 12 + boxW > padLeft + plotW ? hx - boxW - 12 : hx + 12;
    const boxY = Math.max(padTop + 4, Math.min(padTop + plotH - boxH - 4, hyOracle - boxH / 2));

    ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
    ctx.strokeStyle = '#334155';
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '10.5px "JetBrains Mono", Menlo, monospace';
    lines.forEach((line, i) => {
      ctx.fillText(line, boxX + 8, boxY + 13 + i * 14);
    });
    ctx.restore();
  }

  ctx.restore();
}

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('priceChartCanvas');
  if (canvas) {
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      chartHoverX = e.clientX - r.left;
      drawChart();
    });
    canvas.addEventListener('mouseleave', () => {
      chartHoverX = null;
      drawChart();
    });
  }

  window.addEventListener('resize', () => drawChart());

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
    if (data.chartPoint) {
      const last = appState.chartSeries[appState.chartSeries.length - 1];
      if (!last || data.chartPoint.t - last.t >= 850) {
        appState.chartSeries.push(data.chartPoint);
        if (appState.chartSeries.length > 240) appState.chartSeries.shift();
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
