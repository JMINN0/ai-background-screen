/**
 * risk-sim —— 本地风控模拟器。
 *
 * 目的：在本机造一个"像真风控一样的裁判"，把自动化工具的破绽一条条量出来。
 * 不上报任何数据到外网，报告只存在本机内存和 reports/ 目录里。
 *
 * 用法：
 *   node server.mjs            → 监听 3081
 *   node server.mjs --port 4000
 *
 * 页面：
 *   /            被保护的测试页（有表单、按钮、需要"人"的操作）
 *   /dashboard   看所有检测报告
 *   /api/report  POST 检测结果
 *   /api/reports GET  报告列表
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const REPORT_DIR = join(HERE, 'reports');

const argPort = process.argv.indexOf('--port');
const PORT = argPort > 0 ? Number(process.argv[argPort + 1]) : 3081;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** 内存里留最近 100 份，同时落盘 */
const reports = [];

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function serveStatic(res, path) {
  try {
    const buf = await readFile(join(PUBLIC, path));
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      // 调试期拿 no-store：否则浏览器缓存旧检测脚本，看到的永远是上一版结果
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 允许自动化工具从任何源发过来（本机玩具，不做 CORS 收紧）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return serveStatic(res, 'index.html');
  }
  if (req.method === 'GET' && url.pathname === '/dashboard') {
    return serveStatic(res, 'dashboard.html');
  }
  if (req.method === 'GET' && url.pathname === '/detect.js') {
    return serveStatic(res, 'detect.js');
  }
  // 严苛模式：比 detect.js 严得多，专门抓机器特征
  if (req.method === 'GET' && (url.pathname === '/strict' || url.pathname === '/strict.html')) {
    return serveStatic(res, 'strict.html');
  }
  if (req.method === 'GET' && url.pathname === '/strict.js') {
    return serveStatic(res, 'strict.js');
  }
  // 环境指纹探针：页面能读到哪些"我不是真机"的信号
  if (req.method === 'GET' && (url.pathname === '/probe' || url.pathname === '/probe.html')) {
    return serveStatic(res, 'probe.html');
  }
  if (req.method === 'GET' && url.pathname === '/probe.js') {
    return serveStatic(res, 'probe.js');
  }
  // 视频平台互动检测
  if (req.method === 'GET' && (url.pathname === '/video' || url.pathname === '/video.html')) {
    return serveStatic(res, 'video.html');
  }
  if (req.method === 'GET' && url.pathname === '/video.js') {
    return serveStatic(res, 'video.js');
  }

  if (req.method === 'POST' && url.pathname === '/api/report') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: '不是合法 JSON' }); }

    const rec = {
      id: reports.length + 1,
      at: new Date().toISOString(),
      // 服务端补的：真实来源 IP、UA、时间，
      // 真风控一定不信客户端自报的东西，会拿服务端看到的做交叉比对
      server: {
        remoteAddress: req.socket.remoteAddress,
        userAgent: req.headers['user-agent'] || '',
        headers: {
          'accept-language': req.headers['accept-language'] || '',
          'sec-ch-ua': req.headers['sec-ch-ua'] || '',
          'sec-ch-ua-mobile': req.headers['sec-ch-ua-mobile'] || '',
          'sec-ch-ua-platform': req.headers['sec-ch-ua-platform'] || '',
          referer: req.headers.referer || '',
        },
      },
      client: body,
    };

    // 服务端交叉校验：客户端说自己是移动端，UA 里得有 Mobile
    const cross = [];
    const uaC = String(body?.fingerprint?.userAgent || '');
    const uaS = rec.server.userAgent;
    if (uaC && uaS && uaC !== uaS) {
      cross.push({ id: 'cross.ua-mismatch', ok: false, detail: '客户端自报 UA 与请求头不一致（改了 UA）' });
    } else {
      cross.push({ id: 'cross.ua-match', ok: true, detail: 'UA 一致' });
    }
    const claimsMobile = (body?.fingerprint?.maxTouchPoints || 0) > 0;
    const uaSaysMobile = /Mobile|Android|iPhone/i.test(uaS);
    cross.push({
      id: 'cross.mobile-consistency',
      ok: claimsMobile === uaSaysMobile,
      detail: `maxTouchPoints>0=${claimsMobile}，UA 说是移动端=${uaSaysMobile}`,
    });
    rec.crossChecks = cross;

    reports.push(rec);
    if (reports.length > 100) reports.shift();

    try {
      await mkdir(REPORT_DIR, { recursive: true });
      await writeFile(join(REPORT_DIR, `${String(rec.id).padStart(4, '0')}-${Date.now()}.json`),
        JSON.stringify(rec, null, 2));
    } catch { /* 落盘失败不影响返回 */ }

    return json(res, 200, { ok: true, id: rec.id, score: body?.summary?.score ?? null });
  }

  if (req.method === 'GET' && url.pathname === '/api/reports') {
    return json(res, 200, {
      ok: true,
      count: reports.length,
      // 列表不带完整指纹，避免 dashboard 太慢
      items: reports.map((r) => ({
        id: r.id, at: r.at,
        score: r.client?.summary?.score ?? null,
        passed: r.client?.summary?.passed ?? null,
        failed: r.client?.summary?.failed ?? null,
        failedChecks: (r.client?.checks || []).filter((c) => !c.ok).map((c) => c.id),
      })),
    });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/report/')) {
    const id = Number(url.pathname.split('/').pop());
    const r = reports.find((x) => x.id === id);
    return r ? json(res, 200, { ok: true, report: r }) : json(res, 404, { ok: false, error: '没有这份报告' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { json(res, 500, { ok: false, error: e?.message || String(e) }); } catch { /* ignore */ }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[risk-sim] http://127.0.0.1:${PORT}`);
  console.log(`  测试页    http://127.0.0.1:${PORT}/`);
  console.log(`  报告看板  http://127.0.0.1:${PORT}/dashboard`);
});
