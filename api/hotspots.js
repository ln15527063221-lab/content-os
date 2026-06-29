/**
 * Content OS — 热点采集 API (Vercel Serverless)
 *
 * 部署后路径: GET /api/hotspots
 *
 * 负责: 从微博/百度/知乎采集热点 → 去重 → 标准化 → 返回 JSON
 * 缓存: Vercel 无状态，每次冷启动重新采集（外部 API 调用 < 10s）
 */

// ========== 外网请求工具 ==========

async function doFetch(fetchUrl, opts = {}) {
  const parsed = new URL(fetchUrl);
  const mod = parsed.protocol === 'https:' ? require('https') : require('http');

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', ...(opts.headers || {}) },
      timeout: opts.timeout || 12000,
    };
    const req = mod.request(reqOpts, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => resolve({ status: resp.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ========== 各源采集 ==========

async function fetchWeibo() {
  try {
    const { status, body } = await doFetch('https://weibo.com/ajax/side/hotSearch', {
      headers: { 'Referer': 'https://weibo.com/', 'Accept': 'application/json' }, timeout: 12000,
    });
    if (status !== 200) return { ok: false, error: 'HTTP ' + status, items: [] };
    const json = JSON.parse(body);
    const list = json?.data?.realtime || [];
    return {
      ok: true,
      items: list.slice(0, 10).map((item, i) => ({
        title: (item.word || '').replace(/<[^>]*>/g, ''),
        heat: item.num || 0,
        heatLevel: i < 2 ? 5 : i < 5 ? 4 : 3,
        source: 'weibo', sourceName: '微博',
        url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(item.word || ''),
        rank: i + 1, mid: item.mid || '', timestamp: new Date().toISOString(),
      })),
      count: Math.min(list.length, 10),
    };
  } catch (e) { return { ok: false, error: e.message, items: [] }; }
}

async function fetchBaidu() {
  try {
    const { status, body } = await doFetch('https://top.baidu.com/board?tab=realtime', {
      headers: { 'Referer': 'https://top.baidu.com/', 'Accept': 'text/html' }, timeout: 12000,
    });
    if (status !== 200) return { ok: false, error: 'HTTP ' + status, items: [] };

    const words = [], scores = [];
    let m;
    while ((m = /"word"\s*:\s*"([^"]+)"/g.exec(body)) !== null && words.length < 10) words.push(m[1]);
    while ((m = /"hotScore"\s*:\s*"([^"]+)"/g.exec(body)) !== null && scores.length < 10) scores.push(m[1]);

    return {
      ok: true,
      items: words.map((w, i) => ({
        title: w, heat: parseInt(scores[i] || '0') || 0,
        heatLevel: i < 2 ? 5 : i < 5 ? 4 : 3,
        source: 'baidu', sourceName: '百度',
        url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(w),
        rank: i + 1, mid: '', timestamp: new Date().toISOString(),
      })),
      count: words.length,
    };
  } catch (e) { return { ok: false, error: e.message, items: [] }; }
}

async function fetchZhihu() {
  try {
    const headers = { 'Referer': 'https://www.zhihu.com/', 'Accept': 'application/json' };
    if (process.env.ZHIHU_COOKIE) headers['Cookie'] = process.env.ZHIHU_COOKIE;

    const { status, body } = await doFetch('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=10', { headers, timeout: 12000 });
    if (status === 401) return { ok: false, error: '401 (需 Cookie)', items: [], skipped: true };
    if (status !== 200) return { ok: false, error: 'HTTP ' + status, items: [] };

    const json = JSON.parse(body);
    const list = json?.data || [];
    return {
      ok: true,
      items: list.slice(0, 10).map((item, i) => ({
        title: item.target?.title || item.target?.question?.title || '',
        heat: item.detail_text || item.target?.metrics?.raw?.heat_count || 0,
        heatLevel: i < 2 ? 5 : i < 5 ? 4 : 3,
        source: 'zhihu', sourceName: '知乎',
        url: item.target?.url || 'https://www.zhihu.com/question/' + (item.target?.id || ''),
        rank: i + 1, mid: String(item.target?.id || ''), timestamp: new Date().toISOString(),
      })),
      count: Math.min(list.length, 10),
    };
  } catch (e) { return { ok: false, error: e.message, items: [] }; }
}

// ========== 主处理器 ==========

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  console.log('🔄 [' + new Date().toLocaleTimeString() + '] 采集热点...');

  const results = await Promise.allSettled([fetchWeibo(), fetchBaidu(), fetchZhihu()]);

  const sources = [], allItems = [], errors = [];
  let realCount = 0;

  const names = ['微博', '百度', '知乎'];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.ok) {
      r.value.items.forEach(item => allItems.push(item));
      realCount++; sources.push(names[i]);
    } else {
      const err = r.status === 'fulfilled' ? r.value.error : r.reason?.message || '未知';
      const tag = (r.status === 'fulfilled' && r.value.skipped) ? 'SKIP: ' : '';
      errors.push(names[i] + ': ' + tag + err);
    }
  });

  // 去重
  const norm = s => (s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  const unique = [];
  for (const item of allItems) {
    if (norm(item.title).length < 2) continue;
    if (unique.some(u => norm(u.title) === norm(item.title))) continue;
    unique.push(item);
  }

  const result = {
    mode: realCount > 0 ? 'REAL' : 'MOCK',
    from_cache: false,
    timestamp: new Date().toISOString(),
    sources, realCount, totalSources: 3,
    totalItems: unique.length, items: unique,
    errors: errors.length > 0 ? errors : undefined,
  };

  console.log(` → ${result.mode} ${result.totalItems}条 | ${sources.join('·')}`);
  res.status(200).json(result);
};
