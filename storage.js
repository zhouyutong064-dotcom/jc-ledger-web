/* 竞彩台账 —— 统一数据源层
 * 挂 window.Store，非 ES module（快照 file:// 下也能内联运行）
 * 两种模式：
 *   server  —— 本地 node 服务 + SQLite（可读写）
 *   github  —— GitHub 私有仓库 data.json（可读写，Contents API）
 * 两种模式返回完全同构的数据结构，前端无需分支。
 */
(function () {
  'use strict';

  var CFG_KEY = 'jc_ledger_store_config_v1';
  var API_BASE = 'https://api.github.com';

  // ---------- 配置 ----------
  function isLocalPage() {
    try {
      var h = (window.location && window.location.hostname) || '';
      return h === 'localhost' || h === '127.0.0.1' || h === '' || h === 'file:';
    } catch (e) { return true; }
  }
  function defaultConfig() {
    return {
      mode: isLocalPage() ? 'server' : 'github', // 云端部署默认走 GitHub
      owner: '',
      repo: '',
      path: 'data.json',
      branch: 'main',
      token: ''
    };
  }
  function getConfig() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      var c = raw ? JSON.parse(raw) : {};
      var d = defaultConfig();
      return {
        mode: c.mode === 'server' ? 'server' : c.mode === 'github' ? 'github' : d.mode,
        owner: c.owner || '', repo: c.repo || '', path: c.path || 'data.json',
        branch: c.branch || 'main', token: c.token || ''
      };
    } catch (e) { return defaultConfig(); }
  }
  function setConfig(c) {
    var d = defaultConfig();
    var next = {
      mode: c.mode === 'github' ? 'github' : 'server',
      owner: c.owner || '', repo: c.repo || '', path: c.path || 'data.json',
      branch: c.branch || 'main', token: c.token || ''
    };
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
    return next;
  }

  // ---------- 中文安全的 base64 ----------
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- GitHub 请求 ----------
  function ghHeaders(cfg) {
    return {
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
  }
  function contentUrl(cfg) {
    return API_BASE + '/repos/' + encodeURIComponent(cfg.owner) + '/' +
      encodeURIComponent(cfg.repo) + '/contents/' + cfg.path.replace(/^\//, '');
  }
  // 内存缓存：云端数据拉一次后放这里，切筛选/切页/切换视图都不再打网络
  var _ghCache = null; // { key, sha, raw }
  function ghCacheKey(cfg) {
    return [cfg.owner, cfg.repo, cfg.path, cfg.branch].join('|');
  }
  function ghCacheGet(cfg) {
    if (_ghCache && _ghCache.key === ghCacheKey(cfg)) return _ghCache;
    return null;
  }
  function ghCacheSet(cfg, sha, raw) {
    _ghCache = { key: ghCacheKey(cfg), sha: sha, raw: raw };
  }
  function ghCacheClear() { _ghCache = null; }

  // force=true 时强制读网络（首次加载/手动刷新/写入前拿最新 sha），否则命中缓存直接返回
  async function ghGetFile(cfg, force) {
    if (!force) {
      var hit = ghCacheGet(cfg);
      if (hit) return { sha: hit.sha, raw: hit.raw, cached: true };
    }
    var url = contentUrl(cfg) + '?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now();
    var r = await fetch(url, { headers: ghHeaders(cfg), cache: 'no-store' });
    if (r.status === 404) {
      var empty = emptyRaw();
      ghCacheSet(cfg, null, empty);
      return { sha: null, raw: empty, cached: false };
    }
    if (!r.ok) throw new Error('读取云端数据失败 (HTTP ' + r.status + ')');
    var j = await r.json();
    var raw = JSON.parse(b64ToUtf8(j.content));
    ghCacheSet(cfg, j.sha, raw);
    return { sha: j.sha, raw: raw, cached: false };
  }
  async function ghPutFile(cfg, raw, sha, message) {
    var body = {
      message: message || 'update ledger via workbench',
      content: utf8ToB64(JSON.stringify(raw, null, 2)),
      branch: cfg.branch
    };
    if (sha) body.sha = sha; // 先 GET 拿 sha 再 PUT；sha 不匹配 GitHub 会 409
    var r = await fetch(contentUrl(cfg), {
      method: 'PUT', headers: ghHeaders(cfg), body: JSON.stringify(body)
    });
    if (!r.ok) {
      var msg = '';
      try { var j = await r.json(); msg = j.message || ''; } catch (e) {}
      if (r.status === 409) throw new Error('云端数据已被其他设备更新，请刷新后再试');
      throw new Error('写入云端失败 (HTTP ' + r.status + ') ' + msg);
    }
    var out = await r.json();
    return out && out.content ? out.content.sha : sha;
  }
  function emptyRaw() {
    return {
      meta: { source: 'GitHub 云端仓库', version: 1 },
      accountList: [], records: [], multiplier: { steps: [] },
      nextId: 1, nextAccountId: 1
    };
  }

  // ---------- 聚合：把云端的精简数据补齐成与 /api/data 同构 ----------
  function niceStep(range, target) {
    var raw = range / target;
    var mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var n = raw / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }
  function enrich(raw, range) {
    range = range || {};
    var from = range.from || null, to = range.to || null;
    var accts = (raw.accountList || []).slice().sort(function (a, b) {
      return (a.sort_order || 0) - (b.sort_order || 0) || (a.id || 0) - (b.id || 0);
    });
    var acctNames = accts.map(function (a) { return a.name; });

    var rows = (raw.records || []).map(function (r) { return Object.assign({}, r); });
    if (from || to) {
      rows = rows.filter(function (r) {
        if (!r.date) return false;
        if (from && r.date < from) return false;
        if (to && r.date > to) return false;
        return true;
      });
    }
    rows.sort(function (a, b) {
      var ka = String(a.account), kb = String(b.account);
      if (ka !== kb) return ka < kb ? -1 : 1;
      if (Number(a.seq) !== Number(b.seq)) return Number(a.seq) - Number(b.seq);
      return Number(a.id || 0) - Number(b.id || 0);
    });

    var runningBy = {};
    rows.forEach(function (r) {
      var k = r.account;
      runningBy[k] = (runningBy[k] || 0) + Number(r.profit || 0);
      r.running = Math.round(runningBy[k] * 100) / 100;
    });

    var accounts = {};
    acctNames.forEach(function (name) {
      accounts[name] = { account: name, count: 0, stake: 0, payout: 0, profit: 0, win: 0, series: [] };
    });
    var dailyMap = {};
    rows.forEach(function (r) {
      var k = r.account;
      if (!accounts[k]) accounts[k] = { account: k, count: 0, stake: 0, payout: 0, profit: 0, win: 0, series: [] };
      var a = accounts[k];
      a.count += 1;
      a.stake += Number(r.stake || 0);
      a.payout += Number(r.payout || 0);
      a.profit += Number(r.profit || 0);
      if (Number(r.profit) > 0) a.win += 1;
      a.series.push({ label: r.date || ('#' + r.seq), profit: r.running });
      var d = r.date || '未记录日期';
      if (!dailyMap[d]) dailyMap[d] = { date: d, stake: 0, payout: 0, profit: 0, count: 0 };
      dailyMap[d].stake += Number(r.stake || 0);
      dailyMap[d].payout += Number(r.payout || 0);
      dailyMap[d].profit += Number(r.profit || 0);
      dailyMap[d].count += 1;
    });
    Object.keys(accounts).forEach(function (k) {
      var a = accounts[k];
      a.hitRate = a.count ? Math.round(a.win / a.count * 1000) / 10 : 0;
      a.roi = a.stake ? Math.round(a.profit / a.stake * 1000) / 10 : 0;
      ['stake', 'payout', 'profit'].forEach(function (key) {
        a[key] = Math.round(a[key] * 100) / 100;
      });
    });
    var daily = Object.keys(dailyMap).map(function (k) { return dailyMap[k]; }).sort(function (x, y) {
      if (x.date === '未记录日期') return 1;
      if (y.date === '未记录日期') return -1;
      return x.date < y.date ? -1 : x.date > y.date ? 1 : 0;
    });

    var totalStake = rows.reduce(function (s, r) { return s + Number(r.stake || 0); }, 0);
    var totalPayout = rows.reduce(function (s, r) { return s + Number(r.payout || 0); }, 0);
    var totalProfit = rows.reduce(function (s, r) { return s + Number(r.profit || 0); }, 0);
    var winCount = rows.filter(function (r) { return Number(r.profit) > 0; }).length;
    var computed = {
      totalStake: Math.round(totalStake * 100) / 100,
      totalPayout: Math.round(totalPayout * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      roi: totalStake ? Math.round(totalProfit / totalStake * 1000) / 10 : 0,
      hitRate: rows.length ? Math.round(winCount / rows.length * 1000) / 10 : 0,
      betCount: rows.length, winCount: winCount, accountCount: accts.length
    };

    return {
      meta: Object.assign({}, raw.meta || {}, { source: raw.meta && raw.meta.source || 'GitHub 云端仓库', generatedAt: new Date().toISOString(), from: from, to: to, filtered: !!(from || to) }),
      records: rows, accounts: accounts, accountList: accts, daily: daily,
      computed: computed, tabs: acctNames, byTab: accounts,
      multiplier: raw.multiplier || { steps: [] }
    };
  }

  // ---------- 读取 ----------
  var _serverRaw = null; // 本地模式下也缓存一份全量，供切筛选本地重算

  // force=true 才真正打网络；默认用内存缓存（切筛选/切页秒开）
  async function load(range, force) {
    var cfg = getConfig();
    if (cfg.mode === 'github') {
      if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('请先配置 GitHub 仓库与令牌');
      var got = await ghGetFile(cfg, !!force);
      var data = enrich(got.raw, range);
      data._cached = !!got.cached;
      return data;
    }
    // 本地模式：始终取全量，筛选在本地做（数据小，省掉来回请求）
    var r = await fetch('/api/data' + (force ? '?_=' + Date.now() : ''));
    var j = await r.json();
    if (!j.ok) throw new Error(j.error || '载入失败');
    _serverRaw = j.data;
    return enrich(j.data, range);
  }

  // 本地重算：用已缓存的全量数据按新区间重新聚合，零网络
  function reFilter(range) {
    var cfg = getConfig();
    var raw = null;
    if (cfg.mode === 'github') {
      var hit = ghCacheGet(cfg);
      raw = hit && hit.raw;
    } else {
      raw = _serverRaw;
    }
    if (!raw) return null;
    return enrich(raw, range);
  }

  // dbInfo 只读缓存，绝不额外发请求（数据来自 load 的那一次拉取）
  async function dbInfo() {
    var cfg = getConfig();
    if (cfg.mode === 'github') {
      var hit = ghCacheGet(cfg);
      var raw = hit ? hit.raw : emptyRaw();
      return {
        path: 'GitHub: ' + cfg.owner + '/' + cfg.repo + '/' + cfg.path + ' (' + cfg.branch + ')',
        sizeKB: Math.round(JSON.stringify(raw).length / 1024 * 10) / 10,
        tables: ['Contents API'], count: (raw.records || []).length,
        accountCount: (raw.accountList || []).length,
        lastWrite: raw.meta && raw.meta.exportedAt || new Date().toISOString(),
        cloud: true
      };
    }
    var r = await fetch('/api/db');
    var j = await r.json();
    return j.db || {};
  }

  // ---------- 云端写入公共流程：GET sha -> 改 raw -> PUT ----------
  async function githubMutate(message, mutate) {
    var cfg = getConfig();
    if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('请先配置 GitHub 仓库与令牌');
    // 写入前必须拿最新 sha，防止多设备覆盖；这次网络请求不能省
    var got = await ghGetFile(cfg, true);
    var raw = got.raw;
    if (!raw.accountList) raw.accountList = [];
    if (!raw.records) raw.records = [];
    if (!raw.nextId) raw.nextId = Math.max(0, Math.max.apply(null, [0].concat(raw.records.map(function (r) { return Number(r.id) || 0; })))) + 1;
    if (!raw.nextAccountId) raw.nextAccountId = Math.max(0, Math.max.apply(null, [0].concat(raw.accountList.map(function (a) { return Number(a.id) || 0; })))) + 1;
    var result = mutate(raw, cfg);
    var newSha = await ghPutFile(cfg, raw, got.sha, message);
    // 写回后立即刷新缓存：后续切筛选/切页都用这份最新数据，不用再请求
    ghCacheSet(cfg, newSha, raw);
    return enrich(raw, {});
  }

  function nowStr() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ---------- 记录增删改 ----------
  async function addRecord(body) {
    var cfg = getConfig();
    if (cfg.mode !== 'github') {
      var r = await fetch('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var j = await r.json(); if (!j.ok) throw new Error(j.error || '保存失败'); return j.data;
    }
    return githubMutate('add record', function (raw) {
      var account = String(body.account || '').trim();
      if (!account) throw new Error('请选择账号');
      if (!raw.accountList.some(function (a) { return a.name === account; })) {
        raw.accountList.push({ id: raw.nextAccountId++, name: account, sort_order: raw.accountList.length });
      }
      var seq = Number(body.seq);
      if (!seq) {
        seq = Math.max.apply(null, [0].concat(raw.records.filter(function (r) { return r.account === account; }).map(function (r) { return Number(r.seq) || 0; }))) + 1;
      }
      var stake = Number(body.stake) || 0, payout = Number(body.payout) || 0;
      raw.records.push({
        id: raw.nextId++, account: account, seq: seq, date: body.date || null,
        plan: body.plan || '', stake: stake, payout: payout,
        profit: Math.round((payout - stake) * 100) / 100, note: body.note || '',
        created_at: nowStr(), updated_at: nowStr()
      });
    });
  }

  async function updateRecord(id, body) {
    var cfg = getConfig();
    if (cfg.mode !== 'github') {
      var r = await fetch('/api/records/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var j = await r.json(); if (!j.ok) throw new Error(j.error || '保存失败'); return j.data;
    }
    return githubMutate('update record ' + id, function (raw) {
      var rec = raw.records.find(function (r) { return Number(r.id) === Number(id); });
      if (!rec) throw new Error('记录不存在');
      var account = String(body.account !== undefined ? body.account : rec.account).trim();
      if (!raw.accountList.some(function (a) { return a.name === account; })) {
        raw.accountList.push({ id: raw.nextAccountId++, name: account, sort_order: raw.accountList.length });
      }
      var stake = body.stake !== undefined ? Number(body.stake) : Number(rec.stake);
      var payout = body.payout !== undefined ? Number(body.payout) : Number(rec.payout);
      rec.account = account;
      if (body.seq !== undefined) rec.seq = Number(body.seq);
      rec.date = body.date !== undefined ? (body.date || null) : rec.date;
      rec.plan = body.plan !== undefined ? body.plan : rec.plan;
      rec.stake = stake; rec.payout = payout;
      rec.profit = Math.round((payout - stake) * 100) / 100;
      rec.note = body.note !== undefined ? body.note : rec.note;
      rec.updated_at = nowStr();
    });
  }

  async function deleteRecord(id) {
    var cfg = getConfig();
    if (cfg.mode !== 'github') {
      var r = await fetch('/api/records/' + id, { method: 'DELETE' });
      var j = await r.json(); if (!j.ok) throw new Error(j.error || '删除失败'); return j.data;
    }
    return githubMutate('delete record ' + id, function (raw) {
      var before = raw.records.length;
      raw.records = raw.records.filter(function (r) { return Number(r.id) !== Number(id); });
      if (raw.records.length === before) throw new Error('记录不存在');
    });
  }

  // ---------- 账号增删改 ----------
  async function addAccount(name) {
    var cfg = getConfig();
    if (cfg.mode !== 'github') {
      var r = await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
      var j = await r.json(); if (!j.ok) throw new Error(j.error || '添加失败'); return j.data;
    }
    return githubMutate('add account ' + name, function (raw) {
      name = String(name || '').trim();
      if (!name) throw new Error('账号名不能为空');
      if (raw.accountList.some(function (a) { return a.name === name; })) throw new Error('账号已存在');
      raw.accountList.push({ id: raw.nextAccountId++, name: name, sort_order: raw.accountList.length });
    });
  }

  async function renameAccount(id, name) {
    var cfg = getConfig();
    if (cfg.mode !== 'github') {
      var r = await fetch('/api/accounts/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
      var j = await r.json(); if (!j.ok) throw new Error(j.error || '改名失败'); return j.data;
    }
    return githubMutate('rename account ' + id, function (raw) {
      name = String(name || '').trim();
      if (!name) throw new Error('账号名不能为空');
      var acc = raw.accountList.find(function (a) { return Number(a.id) === Number(id); });
      if (!acc) throw new Error('账号不存在');
      if (acc.name === name) return;
      if (raw.accountList.some(function (a) { return a.name === name; })) throw new Error('账号名已被占用');
      var old = acc.name;
      acc.name = name; // 联动：所有历史记录一起改名
      raw.records.forEach(function (r) { if (r.account === old) r.account = name; });
    });
  }

  async function deleteAccount(id, moveTo) {
    var cfg = getConfig();
    if (cfg.mode !== 'github') {
      var r = await fetch('/api/accounts/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moveTo: moveTo || '' }) });
      var j = await r.json(); if (!j.ok) throw new Error(j.error || '删除失败'); return j.data;
    }
    return githubMutate('delete account ' + id, function (raw) {
      var acc = raw.accountList.find(function (a) { return Number(a.id) === Number(id); });
      if (!acc) throw new Error('账号不存在');
      var mine = raw.records.filter(function (r) { return r.account === acc.name; });
      if (mine.length) {
        moveTo = String(moveTo || '').trim();
        if (!moveTo) throw new Error('该账号下还有 ' + mine.length + ' 笔记录，请选择转移到哪个账号');
        if (moveTo === acc.name) throw new Error('不能转移到自己');
        if (!raw.accountList.some(function (a) { return a.name === moveTo; })) throw new Error('目标账号不存在');
        var maxSeq = Math.max.apply(null, [0].concat(raw.records.filter(function (r) { return r.account === moveTo; }).map(function (r) { return Number(r.seq) || 0; })));
        mine.forEach(function (r, i) { r.account = moveTo; r.seq = maxSeq + i + 1; r.updated_at = nowStr(); });
      }
      raw.accountList = raw.accountList.filter(function (a) { return Number(a.id) !== Number(id); });
    });
  }

  // ---------- 连接测试 ----------
  async function testGithub(config) {
    var c = getConfig();
    var merged = Object.assign({}, c, config || {});
    if (!merged.owner || !merged.repo || !merged.token) throw new Error('请填全用户名、仓库名和令牌');
    var url = API_BASE + '/repos/' + encodeURIComponent(merged.owner) + '/' + encodeURIComponent(merged.repo);
    var r = await fetch(url, { headers: ghHeaders(merged), cache: 'no-store' });
    if (!r.ok) {
      if (r.status === 404) throw new Error('仓库不存在或令牌无权限（检查用户名/仓库名，以及令牌是否授权该仓库）');
      if (r.status === 401) throw new Error('令牌无效或已过期');
      throw new Error('连接失败 (HTTP ' + r.status + ')');
    }
    var repo = await r.json();
    var got = await ghGetFile(merged, true); // 测试连接强制拉最新，同时刷新缓存
    var data = enrich(got.raw, {});
    return { ok: true, repo: repo.full_name, private: repo.private,
      count: got.raw.records.length, accounts: (got.raw.accountList || []).length,
      profit: data.computed.totalProfit, sha: !!got.sha };
  }

  window.Store = {
    getConfig: getConfig, setConfig: setConfig,
    get mode() { return getConfig().mode; },
    load: load, reFilter: reFilter, dbInfo: dbInfo, enrich: enrich,
    addRecord: addRecord, updateRecord: updateRecord, deleteRecord: deleteRecord,
    addAccount: addAccount, renameAccount: renameAccount, deleteAccount: deleteAccount,
    testGithub: testGithub, invalidate: ghCacheClear,
    helpers: { utf8ToB64: utf8ToB64, b64ToUtf8: b64ToUtf8, emptyRaw: emptyRaw }
  };
})();
