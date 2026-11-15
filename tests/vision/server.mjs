#!/usr/bin/env node
/**
 * server.mjs — 视觉测试台的静态服务。
 *
 * 只干一件事：把 index.html 和跑分结果吐出来。
 * 用 3091 端口，跟 risk-sim 的 3081 分开，免得两边互相踩。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VISION_PORT || 3091);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  try {
    if (path === '/' || path === '/index.html') {
      const html = await readFile(join(__dirname, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: PORT }));
      return;
    }
    if (path === '/results') {
      try {
        const j = await readFile(join(__dirname, 'results.json'), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(j);
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, runs: [] }));
      }
      return;
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.message || e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`vision-test on http://127.0.0.1:${PORT}`);
});
