/**
 * Content OS — 刷新端点 (Vercel Serverless)
 *
 * 路径: GET /api/hotspots/refresh
 * Vercel 无状态，每次调用即实采，同主端点行为
 */

// 直接重用主端点逻辑
const hotspots = require('../hotspots');
module.exports = (req, res) => hotspots(req, res);
