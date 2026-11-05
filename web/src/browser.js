/**
 * 浏览器选择。
 *
 * 用户 2026-11-05 的意见：不要写死某个浏览器，让他按任务选。
 * 之前我直接改成 Chrome 是错的——那是把他的习惯换了，而不是给工具加选项。
 *
 * 三个 Chromium 系浏览器的 devtools socket 名都是 chrome_devtools_remote，
 * 但**同一时刻只有一个进程能绑这个 socket**，所以选之前要确认另一个没在跑。
 */
export const BROWSERS = {
  edge: { key: 'edge', pkg: 'com.microsoft.emmx', name: 'Edge', proc: 'emmx', socket: 'chrome_devtools_remote' },
  chrome: { key: 'chrome', pkg: 'com.android.chrome', name: 'Chrome', proc: 'com.android.chrome', socket: 'chrome_devtools_remote' },
  nubia: { key: 'nubia', pkg: 'cn.nubia.browser', name: '红魔浏览器', proc: 'cn.nubia.browser', socket: 'chrome_devtools_remote' },
};

// 默认还是 Edge——用户平时就用它，不该被我改掉
let current = process.env.WEB_BROWSER || 'edge';

export function listBrowsers() {
  return Object.values(BROWSERS).map((b) => ({ key: b.key, name: b.name, pkg: b.pkg, current: b.key === current }));
}

/** 选浏览器；不传就返回当前的，不报错。 */
export function selectBrowser(key) {
  if (!key) return BROWSERS[current];
  const k = String(key).toLowerCase();
  if (!BROWSERS[k]) {
    return { error: `不认识的浏览器「${key}」。可选：${Object.keys(BROWSERS).join(' / ')}` };
  }
  current = k;
  return BROWSERS[k];
}

export function currentBrowser() {
  return BROWSERS[current];
}
