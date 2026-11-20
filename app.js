/* 竞彩台账工作台 —— 前端逻辑（本地 API + 只读快照双模式） */
(function () {
  'use strict';

  const SNAP = window.__SNAPSHOT__ || null;
  const READONLY = !!(SNAP && SNAP.readonly);
  const state = {
    data: null,
    db: null,
    full: null,          // 未筛选的全量数据（本地重算用，含 meta/accountList/multiplier）
    page: 'dashboard',
    hiddenSeries: new Set(),
    range: { type: 'all', from: '', to: '' },
  };

  // ---------- 日期工具（本地时区） ----------
  function ymd(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function shiftDays(days) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return ymd(d);
  }
  // 根据预设算出 {from,to}；自定义沿用 state.range 里已填的日期
  function resolveRange(type) {
    const today = ymd(new Date());
    switch (type) {
      case 'today': return { from: today, to: today };
      case 'yesterday': return { from: shiftDays(-1), to: shiftDays(-1) };
      case 'week': return { from: shiftDays(-6), to: today };   // 近7天含今天
      case 'month': return { from: shiftDays(-29), to: today }; // 近30天含今天
      case 'custom': return { from: state.range.from || '', to: state.range.to || '' };
      default: return { from: '', to: '' };
    }
  }

  // 账号配色
  const PALETTE = ['#2f6df6', '#e0392f', '#12946b', '#c8871a', '#8b5cf6', '#0891b2', '#db2777', '#475569'];
  let ACCOUNT_COLOR = {};
  function seedColors() {
    ACCOUNT_COLOR = {};
    (state.data?.accountList || state.data?.tabs || []).forEach((a, i) => {
      const name = typeof a === 'string' ? a : a.name;
      ACCOUNT_COLOR[name] = PALETTE[i % PALETTE.length];
    });
  }
  function colorFor(name) {
    if (!(name in ACCOUNT_COLOR)) {
      const i = Object.keys(ACCOUNT_COLOR).length % PALETTE.length;
      ACCOUNT_COLOR[name] = PALETTE[i];
    }
    return ACCOUNT_COLOR[name];
  }
  const money = n => '¥' + Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const num = n => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const signMoney = n => (Number(n) > 0 ? '+' : '') + money(n);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cls = n => Number(n) > 0 ? 'profit' : Number(n) < 0 ? 'loss' : 'muted';
  const td = (label, content, extraClass) =>
    `<td data-label="${esc(label)}"${extraClass ? ` class="${extraClass}"` : ''}>${content}</td>`;

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- 数据加载 ----------
  // force=true 才真正打网络（首屏/手动刷新/配置变更）；其余走缓存或本地重算
  async function load(force) {
    try {
      if (READONLY) {
        state.data = SNAP;
        state.full = SNAP;
        state.db = SNAP.db || null;
      } else {
        const range = { from: state.range.from, to: state.range.to };
        const d = await Store.load(range, !!force);
        state.data = d;
        state.full = d._full || null;
        // dbInfo 只读缓存，不发请求；若缓存还没有就用 data 兜底
        state.db = await Store.dbInfo().catch(() => null);
      }
      applyLoaded();
    } catch (e) {
      const cfg = Store.getConfig();
      const noCloud = cfg.mode === 'github' && (!cfg.token || !cfg.owner || !cfg.repo);
      if (noCloud) {
        $('#setupText').textContent = '这是刚部署好的云端版。请到「数据与备份 → 数据源设置」填入 GitHub 用户名、数据仓库名和令牌，点「测试连接」确认后再「保存配置」。';
        $('#setupBanner').style.display = '';
      }
      toast('数据载入失败：' + (e.message || '请检查数据源配置'));
    }
  }

  function applyLoaded() {
    seedColors();
    $('#setupBanner').style.display = 'none';
    renderRangeBar();
    renderAll();
    renderStoreBar();
  }

  // 切筛选/只读快照切页：纯本地重算，不发网络
  function refilterLocal() {
    if (!state.data) return;
    if (READONLY) {
      // 快照模式：从内嵌数据本地过滤（快照数据即全量）
      state.data = Store.enrich(SNAP, { from: state.range.from, to: state.range.to });
    } else {
      const d = Store.reFilter({ from: state.range.from, to: state.range.to });
      if (d) {
        state.data = d;
        state.db = state.db || null;
      } else { load(false); return; } // 无缓存时兜底（首屏还没加载完）
    }
    renderRangeBar();
    renderAll();
  }

  // ---------- 时间筛选条 ----------
  function renderRangeBar() {
    if (READONLY) { $('#rangeBar').style.display = 'none'; return; }
    const r = state.range;
    $$('.range-chip').forEach(b => b.classList.toggle('active', b.dataset.range === r.type));
    $('#rangeCustom').style.display = r.type === 'custom' ? '' : 'none';
    if (r.type === 'custom') {
      $('#rangeFrom').value = r.from || '';
      $('#rangeTo').value = r.to || '';
    }
    const c = state.data?.computed;
    const label = { all: '全部时间', today: '今天', yesterday: '昨天',
      week: '近7天', month: '近30天', custom: '自定义' }[r.type] || '全部时间';
    let desc = label;
    if (r.type === 'custom' && (r.from || r.to)) desc = `${r.from || '不限'} ~ ${r.to || '不限'}`;
    else if (['today', 'yesterday'].includes(r.type)) desc = r.from;
    else if (r.type === 'week' || r.type === 'month') desc = `${r.from} ~ ${r.to}`;
    if (c) {
      const pcls = c.totalProfit > 0 ? 'r-profit' : c.totalProfit < 0 ? 'r-loss' : '';
      $('#rangeSummary').innerHTML = `${esc(desc)} · <b>${c.betCount}</b> 笔 · 盈亏 <b class="${pcls}">${signMoney(c.totalProfit)}</b>`;
    }
  }

  function setRange(type, from = '', to = '', reload = true) {
    const r = resolveRange(type);
    state.range = { type, from: from || r.from, to: to || r.to };
    if (reload) refilterLocal();  // 本地重算，不再打网络
    else renderRangeBar();
  }

  // ---------- 渲染入口 ----------
  function renderAll() {
    renderKPIs();
    renderTrendChart();
    renderAccountChart();
    renderAccountTable();
    renderRecent();
    renderLedger();
    renderAccountManage();
    renderAccountCards();
    renderMultiplier();
    renderDbInfo();
    renderNote();
    fillAccountSelects();
    if (state.db) $('#sideDbPath').textContent = state.db.path || 'data/app.db';
    if (READONLY) {
      $('#btnAddTop').style.display = 'none';
      $('#btnSnapshot').style.display = 'none';
      $('#btnAddAccount').style.display = 'none';
    }
  }

  function renderKPIs() {
    const c = state.data.computed;
    const cards = [
      { label: '总投入', value: money(c.totalStake), foot: `共 ${c.betCount} 笔投注` },
      { label: '总回报', value: money(c.totalPayout), foot: `命中 ${c.winCount} 笔` },
      { label: '累计盈亏', value: signMoney(c.totalProfit),
        cls: c.totalProfit > 0 ? 'profit' : c.totalProfit < 0 ? 'loss' : '',
        k: c.totalProfit > 0 ? 'k-profit' : c.totalProfit < 0 ? 'k-loss' : '' },
      { label: '收益率 ROI', value: (c.roi > 0 ? '+' : '') + c.roi + '%',
        cls: cls(c.roi), k: c.roi >= 0 ? 'k-profit' : 'k-loss' },
      { label: '命中率', value: c.hitRate + '%', foot: `${c.winCount} / ${c.betCount}`, k: 'k-amber' },
      { label: '运营账号', value: c.accountCount + ' 个', foot: (state.data.tabs || []).join(' · ') },
    ];
    $('#kpiGrid').innerHTML = cards.map(x => `
      <div class="kpi ${x.k || ''}">
        <div class="kpi-label">${x.label}</div>
        <div class="kpi-value ${x.cls || ''}">${x.value}</div>
        ${x.foot ? `<div class="kpi-foot">${esc(x.foot)}</div>` : ''}
      </div>`).join('');
  }

  // ---------- SVG 折线图：各账号累计盈亏 ----------
  // 把任意区间吸附到"漂亮"的刻度步长 (1/2/2.5/5 × 10^n)
  function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const n = raw / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function renderTrendChart() {
    const byTab = state.data.byTab || state.data.accounts || {};
    const allNames = Object.keys(byTab);
    const names = allNames.filter(n => !state.hiddenSeries.has(n));
    const wrap = $('#trendChart');

    // 图例直接带该账号最终盈亏，曲线上不再堆末端标签（避免文字互相叠加）
    $('#trendLegend').innerHTML = allNames.map(n => {
      const series = byTab[n].series;
      const final = series.length ? series[series.length - 1].profit : 0;
      return `<span class="legend-item ${state.hiddenSeries.has(n) ? 'off' : ''}" data-series="${esc(n)}" title="点击显示/隐藏">
        <span class="legend-swatch" style="background:${colorFor(n)}"></span>
        <span class="legend-name">${esc(n)}</span>
        <b class="legend-val ${cls(final)}">${signMoney(final)}</b></span>`;
    }).join('');
    $$('#trendLegend .legend-item').forEach(el => el.onclick = () => {
      const n = el.dataset.series;
      if (state.hiddenSeries.has(n)) state.hiddenSeries.delete(n); else state.hiddenSeries.add(n);
      renderTrendChart();
    });

    if (!names.length) {
      wrap.innerHTML = `<div style="color:#94a0b4;padding:60px;text-align:center">没有可显示的数据</div>`;
      return;
    }

    // 按容器实际宽度绘制，不再固定 viewBox 导致两边留白
    const availW = Math.max(560, wrap.clientWidth || 900);
    const W = availW, H = 340;
    const PL = 66, PR = 74, PT = 26, PB = 40;
    const iw = W - PL - PR, ih = H - PT - PB;
    const maxLen = Math.max(1, ...names.map(n => byTab[n].series.length));

    let vmin = 0, vmax = 0;
    names.forEach(n => byTab[n].series.forEach(p => {
      vmin = Math.min(vmin, p.profit); vmax = Math.max(vmax, p.profit);
    }));
    if (vmin === vmax) { vmin -= 1; vmax += 1; }
    const step = niceStep(vmax - vmin, 5);
    const tickMin = Math.floor(vmin / step) * step;
    const tickMax = Math.ceil(vmax / step) * step;
    const span = tickMax - tickMin || step;
    const X = i => PL + (maxLen <= 1 ? iw / 2 : i / (maxLen - 1) * iw);
    const Y = v => PT + ih - (v - tickMin) / span * ih;

    const money短 = v => {
      const a = Math.abs(v);
      if (a >= 10000) return (v / 10000).toFixed(a >= 100000 ? 0 : 1) + '万';
      return num(v);
    };

    // 渐变定义
    let defs = '';
    names.forEach((n, idx) => {
      defs += `<linearGradient id="lg${idx}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${colorFor(n)}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${colorFor(n)}" stop-opacity="0"/>
      </linearGradient>`;
    });

    // Y 轴网格 + 刻度
    let g = '';
    for (let v = tickMin; v <= tickMax + step / 2; v += step) {
      const y = Y(v);
      const isZero = Math.abs(v) < step / 1000;
      g += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}"
        stroke="${isZero ? '#c8d2e0' : '#eef1f6'}" stroke-width="${isZero ? 1.3 : 1}"
        ${isZero ? '' : 'stroke-dasharray="3 4"'}/>`;
      g += `<text x="${PL - 12}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11"
        fill="${isZero ? '#6b768a' : '#9aa6b8'}" ${isZero ? 'font-weight="600"' : ''}>${money短(v)}</text>`;
    }
    // X 轴刻度（笔数）
    const tickEvery = Math.max(1, Math.ceil(maxLen / 10));
    for (let i = 0; i <= maxLen; i += tickEvery) {
      g += `<text x="${X(i).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#9aa6b8">${i}</text>`;
    }
    g += `<text x="${W - PR + 4}" y="${H - 12}" text-anchor="end" font-size="10" fill="#b6bfcd">笔数</text>`;

    // 每条线：面积 + 折线 + 点（数值只放图例与悬浮提示，曲线上保持干净）
    names.forEach((n, idx) => {
      const ser = byTab[n].series;
      if (!ser.length) return;
      const col = colorFor(n);
      const pts = ser.map((p, i) => `${X(i).toFixed(1)},${Y(p.profit).toFixed(1)}`);
      const baseline = Y(Math.max(tickMin, Math.min(0, tickMax)));
      const area = `M ${X(0).toFixed(1)} ${baseline.toFixed(1)} L ` + pts.join(' L ') +
        ` L ${X(ser.length - 1).toFixed(1)} ${baseline.toFixed(1)} Z`;
      g += `<path d="${area}" fill="url(#lg${idx})" stroke="none"/>`;
      g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2.4"
        stroke-linejoin="round" stroke-linecap="round"/>`;
      ser.forEach((p, i) => {
        const last = i === ser.length - 1;
        g += `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.profit).toFixed(1)}" r="${last ? 4.4 : 2.4}"
          fill="${last ? col : '#fff'}" stroke="${col}" stroke-width="${last ? 2 : 1.6}"/>`;
      });
    });

    // hover 十字线 + 提示（用透明矩形捕获鼠标）
    let hover = `<g id="trendHover" style="display:none">
        <line id="thLine" y1="${PT}" y2="${PT + ih}" stroke="#9aa6b8" stroke-width="1" stroke-dasharray="4 3"/>
      </g>`;
    let capture = `<rect x="${PL}" y="${PT}" width="${iw}" height="${ih}" fill="transparent"
      id="trendCapture" style="cursor:crosshair"/>`;
    let dots = names.map((n, idx) =>
      `<circle id="thDot${idx}" r="5" fill="#fff" stroke="${colorFor(n)}" stroke-width="2.4" style="display:none"/>`).join('');

    wrap.innerHTML = `<div class="trend-canvas">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
        <defs>${defs}</defs>${g}${hover}${capture}${dots}
      </svg>
      <div class="trend-tip" id="trendTip"></div>
    </div>`;

    // 交互：按鼠标 x 找最近笔数索引
    const svg = wrap.querySelector('svg');
    const cap = $('#trendCapture');
    const hLine = $('#thLine');
    const hGroup = $('#trendHover');
    const tip = $('#trendTip');
    const dotEls = names.map((_, idx) => $('#thDot' + idx));
    function onMove(ev) {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * W;
      if (px < PL - 6 || px > W - PR + 6) { onLeave(); return; }
      let idx = Math.round((px - PL) / iw * (maxLen - 1));
      idx = Math.max(0, Math.min(maxLen - 1, idx));
      const cx = X(idx);
      hLine.setAttribute('x1', cx); hLine.setAttribute('x2', cx);
      hGroup.style.display = '';
      const lines = [];
      names.forEach((n, si) => {
        const ser = byTab[n].series;
        const d = dotEls[si];
        if (idx < ser.length) {
          d.setAttribute('cx', X(idx)); d.setAttribute('cy', Y(ser[idx].profit));
          d.style.display = '';
          lines.push(`<div class="tip-row"><span class="tip-name"><i style="background:${colorFor(n)}"></i>${esc(n)}</span><b class="${cls(ser[idx].profit)}">${signMoney(ser[idx].profit)}</b></div>`);
        } else { d.style.display = 'none'; }
      });
      tip.innerHTML = `<div class="tip-head">第 ${idx} 笔</div>${lines.join('')}`;
      tip.style.display = 'block';
      const leftPct = cx / W;
      tip.style.left = (leftPct > 0.7 ? (leftPct * 100 - 4) + '%' : (leftPct * 100 + 2) + '%');
      tip.style.transform = leftPct > 0.7 ? 'translateX(-100%)' : 'none';
    }
    function onLeave() {
      hGroup.style.display = 'none'; tip.style.display = 'none';
      dotEls.forEach(d => { d.style.display = 'none'; });
    }
    cap.addEventListener('mousemove', onMove);
    cap.addEventListener('mouseleave', onLeave);
  }

  // ---------- 横向条形图：各账号盈亏（按容器宽度绘制，数值固定右列） ----------
  function renderAccountChart() {
    const wrap = $('#accountChart');
    const list = Object.values(state.data.byTab || state.data.accounts || {});
    if (!list.length) {
      wrap.innerHTML = `<div style="color:#94a0b4;padding:40px;text-align:center">暂无账号</div>`;
      return;
    }
    const W = Math.max(320, wrap.clientWidth || 460);
    const rowH = 40, PT = 14, PB = 14, PL = 76, PR = 96;
    const H = PT + list.length * rowH + PB;
    let max = 1;
    list.forEach(a => { max = Math.max(max, Math.abs(a.profit)); });
    const barL = PL, barR = W - PR;
    const iw = barR - barL;
    const zeroX = barL + iw / 2;
    const half = iw / 2 - 8;
    const scale = half / max;

    let g = '';
    // 零轴 + 两侧浅色刻度带
    g += `<line x1="${zeroX}" y1="${PT - 4}" x2="${zeroX}" y2="${H - PB + 4}" stroke="#c8d2e0" stroke-width="1.2"/>`;
    [-1, -0.5, 0.5, 1].forEach(t => {
      const x = zeroX + t * half;
      g += `<line x1="${x.toFixed(1)}" y1="${PT - 4}" x2="${x.toFixed(1)}" y2="${H - PB + 4}" stroke="#f1f4f8" stroke-width="1"/>`;
    });
    // 刻度值（左下、右下角）
    g += `<text x="${barL}" y="${H - 2}" font-size="10" fill="#b6bfcd">-${num(max)}</text>`;
    g += `<text x="${barR}" y="${H - 2}" text-anchor="end" font-size="10" fill="#b6bfcd">+${num(max)}</text>`;

    list.forEach((a, i) => {
      const cy = PT + i * rowH + rowH / 2;
      const w = Math.abs(a.profit) * scale;
      const pos = a.profit >= 0;
      const x = pos ? zeroX : zeroX - w;
      const col = pos ? '#e0392f' : '#12946b';
      const bh = 18;
      // 账号名
      g += `<text x="${PL - 12}" y="${cy + 4}" text-anchor="end" font-size="12" fill="#5b667a">${esc(a.account)}</text>`;
      // 条
      g += `<rect x="${(pos ? zeroX : x).toFixed(1)}" y="${(cy - bh / 2).toFixed(1)}"
        width="${Math.max(2, w).toFixed(1)}" height="${bh}" rx="${Math.min(5, w / 2).toFixed(1)}"
        fill="${col}" opacity=".9"/>`;
      // 数值：固定在右侧一列，右对齐，绝不越界
      g += `<text x="${W - 6}" y="${cy + 4}" text-anchor="end" font-size="12" font-weight="700"
        fill="${col}">${signMoney(a.profit)}</text>`;
    });

    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${g}</svg>`;
  }

  function renderAccountTable() {
    const list = Object.values(state.data.byTab || state.data.accounts || {});
    let h = `<table class="mini-table"><thead><tr><th>账号</th><th class="num">投入</th><th class="num">回报</th><th class="num">盈亏</th><th class="num">命中率</th></tr></thead><tbody>`;
    list.forEach(a => {
      h += `<tr>
        ${td('账号', `<span class="tag tag-account">${esc(a.account)}</span>`, 'cell-account')}
        ${td('投入', money(a.stake), 'num')}
        ${td('回报', money(a.payout), 'num')}
        ${td('盈亏', `<span class="${cls(a.profit)}">${signMoney(a.profit)}</span>`, 'num')}
        ${td('命中率', a.hitRate + '%', 'num')}
      </tr>`;
    });
    $('#accountTableWrap').innerHTML = h + '</tbody></table>';
  }

  function recordRow(r) {
    const won = Number(r.profit) > 0;
    const dateCell = r.date ? esc(r.date) : `<span class="muted">未记录</span>`;
    const act = READONLY ? '' : `<td data-label="操作" class="cell-full">
        <div class="row-actions">
          <button data-edit="${r.id}" title="编辑">✎ 编辑</button>
          <button class="del-btn" data-del="${r.id}" title="直接删除">✕ 删除</button>
        </div>
      </td>`;
    return `<tr>
      ${td('账号', `<span class="tag tag-account">${esc(r.account)}</span>`, 'cell-account')}
      ${td('日期', dateCell)}
      ${td('结果', won ? '<span class="tag tag-win">命中</span>' : '<span class="tag tag-loss">未中</span>')}
      ${td('方案', `<span class="plan-text">${esc(r.plan)}</span>`, 'cell-plan')}
      ${td('投入', money(r.stake), 'num')}
      ${td('回报', money(r.payout), 'num')}
      ${td('盈亏', `<span class="${cls(r.profit)}">${signMoney(r.profit)}</span>`, 'num')}
      ${td('累计', `<span class="${cls(r.running)}">${signMoney(r.running)}</span>`, 'num')}
      ${act}
    </tr>`;
  }
  const TABLE_HEAD = `<thead><tr>
      <th>账号</th><th>日期</th><th>结果</th><th>方案</th>
      <th class="num">投入</th><th class="num">回报</th><th class="num">盈亏</th><th class="num">累计</th>
      ${READONLY ? '' : '<th>操作</th>'}
    </tr></thead>`;

  function renderRecent() {
    const rows = state.data.records.slice().reverse().slice(0, 8);
    $('#recentTableWrap').innerHTML = `<table class="data-table">${TABLE_HEAD}<tbody>` +
      rows.map(r => recordRow(r)).join('') + '</tbody></table>';
  }

  function renderLedger() {
    const acc = $('#filterAccount').value || '__all__';
    const result = $('#filterResult').value || '__all__';
    const kw = ($('#filterKw').value || '').trim().toLowerCase();
    let rows = state.data.records.slice();
    if (acc !== '__all__') rows = rows.filter(r => r.account === acc);
    if (result === 'win') rows = rows.filter(r => Number(r.profit) > 0);
    if (result === 'loss') rows = rows.filter(r => Number(r.profit) <= 0);
    if (kw) rows = rows.filter(r => (r.plan + ' ' + (r.note || '')).toLowerCase().includes(kw));
    rows.reverse();
    const sumStake = rows.reduce((s, r) => s + Number(r.stake || 0), 0);
    const sumProfit = rows.reduce((s, r) => s + Number(r.profit || 0), 0);
    $('#filterSummary').innerHTML = `筛选 <b>${rows.length}</b> 笔 · 投入 <b>${money(sumStake)}</b> · 盈亏 <b class="${cls(sumProfit)}">${signMoney(sumProfit)}</b>`;
    $('#ledgerTableWrap').innerHTML = `<table class="data-table">${TABLE_HEAD}<tbody>` +
      (rows.length ? rows.map(r => recordRow(r)).join('')
        : `<tr><td colspan="9" style="text-align:center;color:#94a0b4;padding:40px">没有符合条件的记录</td></tr>`) +
      '</tbody></table>';

    $$('#ledgerTableWrap [data-edit]').forEach(b => b.onclick = () => openModal(Number(b.dataset.edit)));
    $$('#ledgerTableWrap [data-del]').forEach(b => b.onclick = () => delRecord(Number(b.dataset.del)));
  }

  // ---------- 账号管理 ----------
  function renderAccountManage() {
    const list = state.data.accountList || [];
    const total = state.data.records.length;
    $('#accountManage').innerHTML = list.map(a => {
      const cnt = state.data.records.filter(r => r.account === a.name).length;
      const acts = READONLY ? '' : `<div class="acc-manage-actions">
        <button class="icon-btn" data-acc-rename="${a.id}" title="改名">✎ 改名</button>
        <button class="icon-btn danger" data-acc-delete="${a.id}" title="删除">✕ 删除</button>
      </div>`;
      return `<div class="acc-manage-row">
        <span class="acc-manage-dot" style="background:${colorFor(a.name)}"></span>
        <span class="acc-manage-name">${esc(a.name)}</span>
        <span class="acc-manage-count">${cnt} 笔</span>
        ${acts}
      </div>`;
    }).join('') || `<div style="padding:20px;color:#94a0b4;text-align:center">还没有账号，点右上角新增</div>`;

    $$('#accountManage [data-acc-rename]').forEach(b => b.onclick = () => openAccountModal('rename', Number(b.dataset.accRename)));
    $$('#accountManage [data-acc-delete]').forEach(b => b.onclick = () => openAccountModal('delete', Number(b.dataset.accDelete)));
  }

  function renderAccountCards() {
    const list = Object.values(state.data.byTab || state.data.accounts || {});
    $('#accountCards').innerHTML = list.map(a => {
      const won = a.win, lost = a.count - a.win;
      return `<div class="acc-card">
        <div class="acc-name"><span class="acc-badge" style="background:${colorFor(a.account)}">${esc(a.account.slice(0, 1))}</span>${esc(a.account)}</div>
        <div class="acc-profit ${cls(a.profit)}">${signMoney(a.profit)}</div>
        <div class="kpi-foot">累计净盈亏 · 收益率 ${a.roi > 0 ? '+' : ''}${a.roi}%</div>
        <div class="acc-grid">
          <div class="acc-stat">投注笔数<b>${a.count}</b></div>
          <div class="acc-stat">命中 / 未中<b>${won} / ${lost}</b></div>
          <div class="acc-stat">总投入<b>${money(a.stake)}</b></div>
          <div class="acc-stat">总回报<b>${money(a.payout)}</b></div>
          <div class="acc-stat">命中率<b>${a.hitRate}%</b></div>
          <div class="acc-stat">回报率<b>${a.stake ? (a.payout / a.stake * 100).toFixed(1) : '0.0'}%</b></div>
        </div>
      </div>`;
    }).join('');
  }

  function renderMultiplier() {
    const m = state.data.multiplier || { steps: [] };
    if (!m.steps || !m.steps.length) {
      $('#multiplierTableWrap').innerHTML = `<table class="data-table"><tbody><tr><td style="padding:20px;color:#94a0b4">无倍投参考数据</td></tr></tbody></table>`;
      return;
    }
    const keys = Object.keys(m.steps[0]).filter(k => k !== 'step');
    let h = `<table class="data-table"><thead><tr><th>档位</th>`;
    keys.forEach(k => h += `<th class="num">${k === 'p100' ? '100 本金方案' : k === 'p200' ? '200 本金方案' : esc(k)}</th>`);
    h += `</tr></thead><tbody>`;
    m.steps.forEach(s => {
      h += `<tr>${td('档位', `第 ${s.step} 档`, 'cell-account')}`;
      keys.forEach(k => h += td(k === 'p100' ? '100本金' : k === 'p200' ? '200本金' : k, money(s[k]), 'num'));
      h += `</tr>`;
    });
    $('#multiplierTableWrap').innerHTML = h + '</tbody></table>';
  }

  function renderDbInfo() {
    const d = state.db;
    const cloud = !READONLY && Store.mode === 'github';
    $('#dbModeBadge').textContent = READONLY ? '只读快照' : cloud ? 'GitHub 云端' : '本地模式';
    $('#dbModeBadge').className = 'badge' + (READONLY ? ' readonly' : '');
    const items = d ? [
      { label: cloud ? '云端数据文件' : '数据库文件', value: d.path, path: true },
      { label: '文件大小', value: d.sizeKB + ' KB' },
      { label: '记录条数', value: d.count + ' 条' },
      { label: '账号数量', value: (d.accountCount ?? '—') + ' 个' },
      { label: '数据表', value: (d.tables || []).join(', ') },
      { label: '最后写入', value: d.lastWrite ? new Date(d.lastWrite).toLocaleString('zh-CN') : '—' },
      { label: '运行模式', value: READONLY ? '只读快照（数据内嵌网页）' : cloud ? 'GitHub Contents API 读写' : 'node:sqlite 本地读写' },
    ] : [
      { label: '运行模式', value: '只读快照（数据内嵌网页）' },
      { label: '说明', value: '快照中的数据已内嵌，可直接查看但不可修改' },
    ];
    $('#dbGrid').innerHTML = items.map(x =>
      `<div class="db-item"><div class="db-item-label">${x.label}</div>
        <div class="db-item-value ${x.path ? 'path' : ''}">${esc(x.value)}</div></div>`).join('');
  }

  $('#setupGo').onclick = () => goto('data');

  // ---------- 数据源面板 ----------
  function renderStoreBar() {
    if (READONLY) { $('#storePanel').style.display = 'none'; return; }
    const cfg = Store.getConfig();
    $$('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === cfg.mode));
    $('#ghForm').style.display = cfg.mode === 'github' ? '' : 'none';
    $('#storeBadge').textContent = cfg.mode === 'github' ? 'GitHub 云端' : '本地数据库';
    $('#ghOwner').value = cfg.owner || '';
    $('#ghRepo').value = cfg.repo || '';
    $('#ghPath').value = cfg.path || 'data.json';
    $('#ghBranch').value = cfg.branch || 'main';
    $('#ghToken').value = cfg.token || '';
    const c = state.data?.computed;
    $('#storeStatus').innerHTML = cfg.mode === 'github'
      ? `云端模式 · ${cfg.owner ? esc(cfg.owner + '/' + cfg.repo) : '尚未配置仓库'} · 共 ${c ? c.betCount : '—'} 笔`
      : `本地模式 · 数据在你这台电脑的 app.db · 共 ${c ? c.betCount : '—'} 笔`;
  }

  function readGhForm() {
    return {
      mode: 'github',
      owner: $('#ghOwner').value.trim(),
      repo: $('#ghRepo').value.trim(),
      path: $('#ghPath').value.trim() || 'data.json',
      branch: $('#ghBranch').value.trim() || 'main',
      token: $('#ghToken').value.trim(),
    };
  }
  function ghResult(html, cls) {
    $('#ghResult').innerHTML = `<div class="gh-msg ${cls || ''}">${html}</div>`;
  }

  $$('.mode-btn').forEach(b => b.onclick = async () => {
    const mode = b.dataset.mode;
    if (mode === Store.mode) return;
    if (mode === 'github' && !Store.getConfig().token) {
      Store.setConfig(Object.assign({}, Store.getConfig(), { mode: 'github' }));
      renderStoreBar();
      toast('已切到 GitHub 模式，请填写仓库与令牌');
      return;
    }
    Store.setConfig(Object.assign({}, Store.getConfig(), { mode: mode }));
    toast('已切换到' + (mode === 'github' ? '云端' : '本地') + '模式');
    Store.invalidate(); await load(true);
  });

  $('#ghTest').onclick = async () => {
    ghResult('正在连接…', '');
    try {
      const t = await Store.testGithub(readGhForm());
      ghResult(`连接成功：<b>${esc(t.repo)}</b> · ${t.private ? '私有仓库' : '公开仓库'} · ${t.count} 笔 / ${t.accounts} 账号 · 累计 ${signMoney(t.profit)}${t.sha ? '' : '（文件尚不存在，保存后将创建）'}`, 'ok');
    } catch (e) { ghResult('连接失败：' + esc(e.message || '未知错误'), 'err'); }
  };
  $('#ghSave').onclick = async () => {
    const cfg = readGhForm();
    if (!cfg.owner || !cfg.repo || !cfg.token) { ghResult('请填全用户名、仓库名和令牌', 'err'); return; }
    Store.setConfig(cfg);
    ghResult('配置已保存到本设备浏览器', 'ok');
    toast('配置已保存，正在载入云端数据');
    Store.invalidate(); await load(true);
  };

  function renderNote() {
    const cloud = !READONLY && Store.mode === 'github';
    $('#noteBlock').innerHTML = `
      <p><b>数据来源：</b>${cloud
        ? 'GitHub 私有仓库里的 <code>data.json</code>（本网页只写代码、不含任何真实数据）'
        : `由你提供的 <code>${esc(state.data?.meta?.source || '原始 Excel')}</code> 清洗导入`}。</p>
      <p><b>字段口径：</b>盈亏 = 回报 − 投入；累计 = 同一账号内按投注顺序逐笔累加盈亏。</p>
      <p><b>已做的校正：</b>原表是多账号横向并排、列结构不统一的"乱表"，已拆成统一明细；
      合并单元格式的日期向下填充、无日期列标记为"未记录"、未填方案的行标记为"未填方案"。
      历史数据经投入/回报/盈亏/累计四列交叉验证一致。</p>
      <p><b>时间筛选：</b>顶部时间范围作用于全部页面（看板、明细、账号分析），按投注日期过滤；
      无日期的记录在选定具体时间段时不计入。CSV 与快照导出的是当前所选范围的数据。</p>
      <p><b>账号自定义：</b>账号独立管理，可在「账号分析 → 账号管理」里新增、改名、删除。
      改名时所有历史记录会自动跟着改；删除有记录的账号时会让你先把记录转移到别的账号。各页统计、图表、筛选都会实时联动。</p>
      <p><b>记账约定：</b>新增记录时盈亏由"回报 − 投入"自动计算，无需手填；金额支持小数；操作列可直接删除。</p>
      ${cloud ? '<p><b>多设备同步：</b>每次保存写回云端 <code>data.json</code>；其他设备刷新即见。写入前会校验版本号，若别的设备刚改过会提示刷新，不会互相覆盖。</p>' : ''}
      ${READONLY ? '<p><b>当前为只读快照：</b>数据内嵌在此 HTML 中，可离线查看、搜索、导出 CSV，但不能增删改。需要记账请启动本地服务或打开云端版。</p>' : ''}`;
  }

  function fillAccountSelects() {
    const tabs = state.data.tabs || [];
    const fa = $('#fAccount');
    const prev = fa.value;
    fa.innerHTML = tabs.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
      (READONLY ? '' : `<option value="__new__">＋ 新建账号…</option>`);
    if (tabs.includes(prev)) fa.value = prev;
    const sel = $('#filterAccount');
    const cur = sel.value || '__all__';
    sel.innerHTML = `<option value="__all__">全部</option>` +
      tabs.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = tabs.includes(cur) ? cur : '__all__';
  }

  // 选择"新建账号"时展开输入框
  function toggleNewAccountField() {
    const isNew = $('#fAccount').value === '__new__';
    $('#fNewAccountWrap').style.display = isNew ? '' : 'none';
    $('#fNewAccount').required = isNew;
    if (isNew) setTimeout(() => $('#fNewAccount').focus(), 30);
  }

  // ---------- 导航 ----------
  const PAGE_TITLES = { dashboard: '总览看板', ledger: '投注明细', accounts: '账号分析', data: '数据与备份' };
  function goto(page) {
    state.page = page;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    $$('.page').forEach(s => s.classList.toggle('active', s.id === 'page-' + page));
    $('#pageTitle').textContent = PAGE_TITLES[page] || page;
    $('#crumbPage').textContent = PAGE_TITLES[page] || page;
    $('.content').scrollTop = 0;
    closeNav();
    if (page === 'ledger') renderLedger();
  }
  $$('.nav-item').forEach(b => b.onclick = () => goto(b.dataset.page));
  $$('[data-goto]').forEach(b => b.onclick = () => goto(b.dataset.goto));

  // 移动端侧栏
  function openNav() { $('#sidebar').classList.add('open'); $('#navOverlay').classList.add('show'); }
  function closeNav() { $('#sidebar').classList.remove('open'); $('#navOverlay').classList.remove('show'); }
  $('#menuBtn').onclick = openNav;
  $('#navOverlay').onclick = closeNav;

  // ---------- 记录 Modal / CRUD ----------
  function updateProfitPreview() {
    const s = Number($('#fStake').value) || 0;
    const p = Number($('#fPayout').value) || 0;
    const v = p - s;
    const b = $('#profitPreview').querySelector('b');
    b.textContent = signMoney(v);
    b.className = cls(v);
  }
  ['#fStake', '#fPayout'].forEach(sel => $(sel).addEventListener('input', updateProfitPreview));

  function openModal(id) {
    if (READONLY) return;
    $('#modalTitle').textContent = id ? '编辑记录' : '记一笔';
    $('#btnDelete').style.display = id ? '' : 'none';
    if (id) {
      const r = state.data.records.find(x => x.id === id);
      if (!r) return;
      $('#fId').value = r.id;
      $('#fAccount').value = r.account;
      $('#fDate').value = r.date || '';
      $('#fPlan').value = r.plan || '';
      $('#fStake').value = r.stake;
      $('#fPayout').value = r.payout;
      $('#fNote').value = r.note || '';
    } else {
      $('#recordForm').reset();
      $('#fId').value = '';
      $('#fDate').value = new Date().toISOString().slice(0, 10);
      $('#fPayout').value = 0;
      if (state.data.tabs.length) $('#fAccount').value = state.data.tabs[0];
    }
    toggleNewAccountField();
    updateProfitPreview();
    $('#modalMask').classList.add('show');
  }
  function closeModal() { $('#modalMask').classList.remove('show'); }

  $('#btnAddTop').onclick = () => openModal(null);
  $('#modalClose').onclick = closeModal;
  $('#modalCancel').onclick = closeModal;
  $('#modalMask').onclick = e => { if (e.target === $('#modalMask')) closeModal(); };

  $('#fAccount').addEventListener('change', toggleNewAccountField);

  $('#recordForm').onsubmit = async e => {
    e.preventDefault();
    let account = $('#fAccount').value;
    if (account === '__new__') {
      account = ($('#fNewAccount').value || '').trim();
      if (!account) { toast('请填写新账号名称'); $('#fNewAccount').focus(); return; }
      if ((state.data.tabs || []).includes(account)) {
        toast('账号「' + account + '」已存在，请直接选择'); return;
      }
    }
    const body = {
      account,
      date: $('#fDate').value || null,
      plan: $('#fPlan').value || '（未填方案）',
      stake: Number($('#fStake').value) || 0,
      payout: Number($('#fPayout').value) || 0,
      note: $('#fNote').value || '',
    };
    const id = $('#fId').value;
    try {
      const fresh = id ? await Store.updateRecord(id, body) : await Store.addRecord(body);
      closeModal();
      toast(id ? (Store.mode === 'github' ? '已保存到云端' : '已保存修改') :
        (Store.mode === 'github' ? '已记到云端' : '已记录这笔'));
      adoptFresh(fresh); // 用写入返回的完整数据直接更新界面，不再请求
      goto('ledger');
    } catch (err) { toast('保存失败：' + (err.message || err.error || '未知错误')); }
  };

  async function delRecord(id) {
    if (!confirm('确定删除这笔记录？此操作不可撤销。')) return;
    try {
      const fresh = await Store.deleteRecord(id);
      toast('已删除');
      adoptFresh(fresh);
    } catch (err) { toast('删除失败：' + (err.message || err.error || '未知错误')); }
  }

  // 写入后用返回的完整数据就地重算当前区间，零额外网络
  function adoptFresh(fresh) {
    if (fresh && fresh.records) {
      const d = Store.enrich(fresh, { from: state.range.from, to: state.range.to });
      state.data = d;
      state.db = state.db || null;
      applyLoaded();
    } else {
      refilterLocal();
    }
  }
  $('#btnDelete').onclick = async () => {
    const id = $('#fId').value;
    if (!id) return;
    closeModal();
    await delRecord(Number(id));
  };

  // ---------- 账号 Modal ----------
  function closeAccModal() { $('#accountModalMask').classList.remove('show'); }
  $('#accModalClose').onclick = closeAccModal;
  $('#accModalCancel').onclick = closeAccModal;
  $('#accountModalMask').onclick = e => { if (e.target === $('#accountModalMask')) closeAccModal(); };

  let accMode = 'add', accId = null;
  function openAccountModal(mode, id) {
    if (READONLY) return;
    accMode = mode; accId = id;
    const list = state.data.accountList || [];
    const acc = list.find(a => a.id === id);
    const body = $('#accFormBody');
    const submit = $('#accFormSubmit');

    if (mode === 'add') {
      $('#accModalTitle').textContent = '新增账号';
      body.innerHTML = `
        <div class="form-hint">新增后，这个账号会出现在所有筛选、图表和统计里。可以先建空账号，之后再记账。</div>
        <label class="field"><span>账号名称</span>
          <input type="text" id="accName" placeholder="如：老王 / 小号 / 方案A" maxlength="24" required>
        </label>`;
      submit.textContent = '添加账号'; submit.className = 'btn btn-primary';
    } else if (mode === 'rename') {
      $('#accModalTitle').textContent = '账号改名';
      body.innerHTML = `
        <div class="form-hint">改名后，该账号下所有历史记录会<b>自动一起改名</b>，统计和图表不受影响。</div>
        <label class="field"><span>新名称</span>
          <input type="text" id="accName" value="${esc(acc?.name || '')}" maxlength="24" required>
        </label>`;
      submit.textContent = '保存改名'; submit.className = 'btn btn-primary';
    } else if (mode === 'delete') {
      const cnt = state.data.records.filter(r => r.account === acc?.name).length;
      const others = list.filter(a => a.id !== id);
      $('#accModalTitle').textContent = '删除账号';
      body.innerHTML = `
        <div class="form-hint">
          即将删除账号 <b>${esc(acc?.name || '')}</b>。
          ${cnt > 0 ? `该账号下有 <b>${cnt} 笔记录</b>，请选择转移到哪个账号（不会删除记录）。`
                    : '该账号下没有记录，可以直接删除。'}
          ${others.length === 0 && cnt > 0 ? '<br><b style="color:#d0342c">当前没有其他账号可转移，请先新建一个账号。</b>' : ''}
        </div>
        ${cnt > 0 ? `<label class="field"><span>把记录转移到</span>
          <select id="accMoveTo">
            ${others.map(a => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('')}
          </select></label>` : ''}`;
      submit.textContent = '确认删除'; submit.className = 'btn btn-danger';
    }
    $('#accountModalMask').classList.add('show');
    setTimeout(() => { const el = $('#accName'); if (el) el.focus(); }, 50);
  }
  $('#btnAddAccount').onclick = () => openAccountModal('add');

  $('#accountForm').onsubmit = async e => {
    e.preventDefault();
    try {
      let fresh;
      if (accMode === 'add') {
        const name = ($('#accName').value || '').trim();
        if (!name) throw new Error('账号名不能为空');
        fresh = await Store.addAccount(name);
        toast(`已添加账号「${name}」`);
      } else if (accMode === 'rename') {
        const name = ($('#accName').value || '').trim();
        if (!name) throw new Error('账号名不能为空');
        fresh = await Store.renameAccount(accId, name);
        toast('已改名，历史记录同步更新');
      } else if (accMode === 'delete') {
        const sel = $('#accMoveTo');
        fresh = await Store.deleteAccount(accId, sel ? sel.value : '');
        toast('账号已删除');
      }
      closeAccModal();
      adoptFresh(fresh);
    } catch (err) { toast(err.message || err.error || '操作失败'); }
  };

  // ---------- 导出（带上当前时间范围） ----------
  function rangeQuery() {
    const { from, to } = state.range;
    return (from || to) ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
  }
  function doSnapshot() {
    if (READONLY || Store.mode === 'github') { snapshotLocal(); return; }
    window.location.href = '/api/snapshot' + rangeQuery();
  }
  $('#btnSnapshot').onclick = doSnapshot;
  $('#actSnapshot').onclick = doSnapshot;
  $('#actExportCsv').onclick = () => {
    if (READONLY || Store.mode === 'github') { exportCsvLocal(); return; }
    window.location.href = '/api/export.csv' + rangeQuery();
  };
  $('#actRefresh').onclick = async () => { await load(true); toast('数据已刷新'); };

  // 云端/快照模式：前端内嵌当前数据生成只读单文件 HTML
  function snapshotLocal() {
    const payload = Object.assign({}, state.data, { db: state.db, readonly: true });
    const style = document.querySelector('link[rel=stylesheet]');
    const css = style ? style.href : '';
    const scriptSrc = Array.from(document.scripts).map(s => s.src).filter(Boolean);
    // 静态部署时 style.css / storage.js / app.js 与 index 同目录，直接内联
    Promise.all([
      fetch('style.css').then(r => r.text()),
      fetch('storage.js').then(r => r.text()),
      fetch('app.js').then(r => r.text()),
      fetch('index.html').then(r => r.text()),
    ]).then(([cssText, storageText, appText, html]) => {
      const embed = `<script>window.__SNAPSHOT__ = ${JSON.stringify(payload).replace(/</g, '\\u003c')};<\/script>`;
      html = html.replace(/<link[^>]*href=["'][^"']*style\.css["'][^>]*>/i, `<style>\n${cssText}\n</style>`);
      html = html.replace(/<script[^>]*src=["'][^"']*storage\.js["'][^>]*><\/script>/i, '');
      html = html.replace(/<script[^>]*src=["'][^"']*app\.js["'][^>]*><\/script>/i,
        `${embed}\n<script>\n${storageText}\n</script>\n<script>\n${appText}\n</script>`);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'jc-ledger-snapshot.html'; a.click();
      URL.revokeObjectURL(a.href);
    }).catch(() => toast('快照生成失败，请检查静态文件是否完整'));
  }

  function exportCsvLocal() {
    const rows = state.data.records;
    const head = ['id', 'account', 'seq', 'date', 'plan', 'stake', 'payout', 'profit', 'note'];
    const escv = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = '\uFEFF' + [head.join(',')].concat(rows.map(r => head.map(h => escv(r[h])).join(','))).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'jc-ledger.csv'; a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- 筛选事件 ----------
  ['#filterAccount', '#filterResult'].forEach(s => $(s).addEventListener('change', renderLedger));
  $('#filterKw').addEventListener('input', renderLedger);

  // 时间范围
  $$('.range-chip').forEach(b => b.onclick = () => {
    if (b.dataset.range === 'custom') {
      // 进入自定义：沿用当前已选区间或今天
      const cur = state.range;
      setRange('custom', cur.from || ymd(new Date()), cur.to || ymd(new Date()), false);
    } else {
      setRange(b.dataset.range);
    }
  });
  $('#rangeApply').onclick = () => {
    const from = $('#rangeFrom').value, to = $('#rangeTo').value;
    if (from && to && from > to) { toast('开始日期不能晚于结束日期'); return; }
    if (!from && !to) { toast('请至少选择一个日期'); return; }
    setRange('custom', from, to);
  };

  load(true);
})();
