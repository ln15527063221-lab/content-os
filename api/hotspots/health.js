/**
 * Content OS — 健康检查 (Vercel Serverless)
 *
 * 路径: GET /api/hotspots/health
 * 返回服务状态
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.status(200).json({
    ok: true,
    mode: 'serverless',
    timestamp: new Date().toISOString(),
  });
};
