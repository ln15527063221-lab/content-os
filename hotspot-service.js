/**
 * Content OS — 热点数据中台 (hotspot-service)
 *
 * 唯一数据入口。前端禁止直接请求第三方网站。
 *
 * 部署：
 *   node hotspot-service.js
 *   监听 http://localhost:8300
 *
 * API：
 *   GET /api/hotspots        → 返回标准化热点列表（微博+百度+知乎）
 *   GET /api/hotspots/health → 健康检查
 *   GET /*                   → 静态文件服务（content-os.html 等）
 *
 * 缓存：内存 Map，5 分钟 TTL，避免重复抓取被封。
 *
 * 架构：
 *   Browser  →  fetch /api/hotspots  →  hotspot-service  →  微博/百度/知乎 API
 *            ←  { mode, from_cache, timestamp, items:[...] }
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8300;
const ROOT = __dirname;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ============ 缓存 ============
let _cache = null;       // { items, timestamp }
let _cacheTime = 0;

// ============ MIME ============
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
};

// ============ 核心：fetch 封装 ============
function doFetch(fetchUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(fetchUrl);
    const reqOpts = {
      hostname: parsed.hostname, port: parsed.port || 443, path: parsed.path,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
      timeout: opts.timeout || 15000,
    };
    const req = https.request(reqOpts, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => resolve({ status: resp.statusCode, body, headers: resp.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ============ 各源采集 + 标准化 ============

async function fetchWeibo() {
  try {
    const { status, body } = await doFetch('https://weibo.com/ajax/side/hotSearch', {
      headers: { 'Referer': 'https://weibo.com/', 'Accept': 'application/json' },
      timeout: 12000,
    });
    if (status !== 200) return { ok: false, error: 'HTTP ' + status, items: [] };
    const json = JSON.parse(body);
    const list = json?.data?.realtime || [];
    const items = list.slice(0, 10).map((item, i) => ({
      title: (item.word || '').replace(/<[^>]*>/g, ''),
      heat: item.num || item.raw_hot || 0,
      heatLevel: i < 2 ? 5 : i < 5 ? 4 : 3,
      source: 'weibo',
      sourceName: '微博',
      url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(item.word || ''),
      rank: i + 1,
      mid: item.mid || '',
      timestamp: new Date().toISOString(),
    }));
    return { ok: true, items, count: items.length };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
}

async function fetchBaidu() {
  try {
    const { status, body } = await doFetch('https://top.baidu.com/board?tab=realtime', {
      headers: { 'Referer': 'https://top.baidu.com/', 'Accept': 'text/html' },
      timeout: 12000,
    });
    if (status !== 200) return { ok: false, error: 'HTTP ' + status, items: [] };

    const words = []; const scores = [];
    let m;
    const reWord = /"word"\s*:\s*"([^"]+)"/g;
    const reScore = /"hotScore"\s*:\s*"([^"]+)"/g;
    while ((m = reWord.exec(body)) !== null && words.length < 10) words.push(m[1]);
    while ((m = reScore.exec(body)) !== null && scores.length < 10) scores.push(m[1]);

    const items = words.map((w, i) => ({
      title: w,
      heat: parseInt(scores[i] || '0') || 0,
      heatLevel: i < 2 ? 5 : i < 5 ? 4 : 3,
      source: 'baidu',
      sourceName: '百度',
      url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(w),
      rank: i + 1,
      mid: '',
      timestamp: new Date().toISOString(),
    }));
    return { ok: true, items, count: items.length };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
}

async function fetchZhihu() {
  const zhihuCookie = process.env.ZHIHU_COOKIE || '';
  try {
    const headers = { 'Referer': 'https://www.zhihu.com/', 'Accept': 'application/json' };
    if (zhihuCookie) headers['Cookie'] = zhihuCookie;

    const { status, body } = await doFetch(
      'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=10',
      { headers, timeout: 12000 }
    );
    if (status === 401) return { ok: false, error: '401 (需 Cookie)', items: [], skipped: true };
    if (status !== 200) return { ok: false, error: 'HTTP ' + status, items: [] };

    const json = JSON.parse(body);
    const list = json?.data || [];
    const items = list.slice(0, 10).map((item, i) => ({
      title: item.target?.title || item.target?.question?.title || '',
      heat: item.detail_text || item.target?.metrics?.raw?.heat_count || 0,
      heatLevel: i < 2 ? 5 : i < 5 ? 4 : 3,
      source: 'zhihu',
      sourceName: '知乎',
      url: item.target?.url || 'https://www.zhihu.com/question/' + (item.target?.id || ''),
      rank: i + 1,
      mid: String(item.target?.id || ''),
      timestamp: new Date().toISOString(),
    }));
    return { ok: true, items, count: items.length };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
}

// ============ 统一采集入口 ============

async function collectAllHotspots() {
  console.log('🔄 [' + new Date().toLocaleTimeString() + '] 采集热点...');

  const results = await Promise.allSettled([fetchWeibo(), fetchBaidu(), fetchZhihu()]);

  const sources = [];
  const allItems = [];
  let realCount = 0;
  const errors = [];

  const names = ['微博', '百度', '知乎'];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.ok) {
      r.value.items.forEach(item => allItems.push(item));
      realCount++;
      sources.push(names[i]);
    } else {
      const err = r.status === 'fulfilled' ? r.value.error : r.reason?.message || '未知';
      if (r.status === 'fulfilled' && r.value.skipped) {
        errors.push(names[i] + ': SKIP (' + err + ')');
      } else {
        errors.push(names[i] + ': ' + err);
      }
    }
  });

  // 去重（标题相似）
  const norm = s => (s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  const unique = [];
  for (const item of allItems) {
    const n = norm(item.title);
    if (n.length < 2) continue;
    if (unique.some(u => norm(u.title) === n)) continue;
    unique.push(item);
  }

  return {
    mode: realCount > 0 ? 'REAL' : 'MOCK',
    from_cache: false,
    timestamp: new Date().toISOString(),
    sources,
    realCount,
    totalSources: 3,
    totalItems: unique.length,
    items: unique,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ============ 缓存读取 ============

async function getHotspots() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) {
    return { ..._cache, from_cache: true, cacheAge: Math.round((now - _cacheTime) / 1000) };
  }

  const result = await collectAllHotspots();
  _cache = result;
  _cacheTime = now;
  return result;
}

// ============ HTTP 服务器 ============

const server = http.createServer((req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  // ---- /api/hotspots ----
  if (pathname === '/api/hotspots') {
    getHotspots()
      .then(result => {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        const cacheTag = result.from_cache ? ' [缓存]' : '';
        console.log(`  → ${result.mode} ${result.totalItems}条 | ${result.sources.join('·')}${cacheTag}`);
      })
      .catch(err => {
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode: 'error', error: err.message }));
      });
    return;
  }

  // ---- /api/hotspots/health ----
  if (pathname === '/api/hotspots/health') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cacheTTL: CACHE_TTL, cacheAge: Math.round((Date.now() - _cacheTime) / 1000) }));
    return;
  }

  // ---- /api/hotspots/refresh (强制刷新) ----
  if (pathname === '/api/hotspots/refresh') {
    _cacheTime = 0; // 过期缓存
    getHotspots()
      .then(result => {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode: 'error', error: err.message }));
      });
    return;
  }

  // ---- 静态文件 ----
  let filePath = pathname === '/' ? '/content-os.html' : pathname;
  filePath = path.join(ROOT, filePath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      return res.end(err.code === 'ENOENT' ? 'Not Found' : 'Error');
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('⚡ Content OS 热点数据中台');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('  API:');
  console.log('    GET /api/hotspots          → 热点列表');
  console.log('    GET /api/hotspots/refresh  → 强制刷新');
  console.log('    GET /api/hotspots/health   → 健康检查');
  console.log('');
  console.log('  缓存: ' + (CACHE_TTL / 1000) + 's | 知乎Cookie: ' + (process.env.ZHIHU_COOKIE ? '已配置' : '未配置'));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
});
