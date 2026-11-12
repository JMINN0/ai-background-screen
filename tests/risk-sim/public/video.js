/**
 * 视频平台互动检测 —— 模拟 B 站/YouTube 这类平台的风控思路。
 *
 * 和 detect.js / strict.js 的区别：
 *   那两个看「你操作得像不像人」，
 *   这一个看「你的观看和互动数据像不像真人产生的」。
 *
 * 真实平台最在意的不是鼠标轨迹，是行为分布：
 *   一个账号每天点赞固定数量、每条都看完、间隔规律 —— 用统计就能抓出来，
 *   根本不需要指纹检测。
 */
(function(){
'use strict';

const DUR = 180;               // 视频时长（秒）
const V = {
  startedAt: Date.now(),
  pos: 0,                       // 已播放时长
  playing: true,
  lastTick: 0,
  ticks: [],                    // 每秒采样 {t, pos, hidden, focused}
  actions: [],                  // {type, t, pos}
  videosWatched: 0,
  videoStartAt: Date.now(),
  perVideo: [],                 // 每个视频的观看时长
};

let raf = null;

function tick(){
  const now = Date.now();
  if (V.playing){
    const dt = (now - (V.lastTick || now)) / 1000;
    V.pos = Math.min(DUR, V.pos + dt);
  }
  V.lastTick = now;
  V.ticks.push({
    t: now - V.startedAt,
    pos: Math.round(V.pos * 10) / 10,
    hidden: document.hidden,
    focused: document.hasFocus(),
  });
  if (V.ticks.length > 3000) V.ticks.shift();
  updateUI();
  raf = setTimeout(tick, 1000);
}

function updateUI(){
  const bar = document.getElementById('bar');
  const time = document.getElementById('time');
  if (bar) bar.style.width = (V.pos / DUR * 100).toFixed(1) + '%';
  if (time) time.textContent = V.pos.toFixed(1) + ' / ' + DUR.toFixed(1) + 's';
}

function record(type){
  V.actions.push({ type, t: Date.now() - V.startedAt, pos: Math.round(V.pos * 10) / 10 });
  const btn = document.getElementById(type);
  if (btn){ btn.classList.add('on'); }
}

function nextVideo(){
  V.perVideo.push(Math.round((Date.now() - V.videoStartAt) / 1000));
  V.videosWatched += 1;
  V.pos = 0;
  V.videoStartAt = Date.now();
}

function cv(a){
  if (a.length < 2) return null;
  const m = a.reduce((x,y)=>x+y,0)/a.length;
  if (!m) return null;
  const sd = Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));
  return sd/m;
}

function run(){
  const flags = [];
  const add = (id, hit, detail) => flags.push({ id, hit: Boolean(hit), detail });

  const acts = V.actions;
  const likes = acts.filter(a => a.type === 'like');
  const coins = acts.filter(a => a.type === 'coin');
  const favs = acts.filter(a => a.type === 'fav');
  const follows = acts.filter(a => a.type === 'follow');

  // ① 互动间隔过于规律
  const gaps = [];
  for (let i = 1; i < acts.length; i++) gaps.push(acts[i].t - acts[i-1].t);
  const gc = cv(gaps);
  add('vid.interval-cv', gc !== null && gaps.length >= 5 && gc < 0.12,
    gc === null ? '互动太少，无法判断' : `互动间隔变异系数 ${gc.toFixed(3)}（真人 0.5+）`);

  // ② 不看就互动：播放进度还没到就点赞
  const early = acts.filter(a => (a.type === 'like' || a.type === 'coin') && a.pos < 5);
  add('vid.interact-before-watch', early.length > 0,
    `${early.length} 次互动发生在播放 5 秒内`);

  // ③ 同一秒内多种互动（真人不会同时点赞+投币+收藏）
  const bySec = {};
  acts.forEach(a => { const s = Math.floor(a.t / 1000); bySec[s] = (bySec[s] || 0) + 1; });
  const maxSameSec = Math.max(0, ...Object.values(bySec));
  add('vid.same-second-burst', maxSameSec >= 3,
    `同一秒内最多 ${maxSameSec} 次互动`);

  // ④ 观看时页面不可见/失焦但仍在互动
  const hiddenTicks = V.ticks.filter(t => t.hidden).length;
  const hiddenRatio = V.ticks.length ? hiddenTicks / V.ticks.length : 0;
  add('vid.hidden-interaction', hiddenRatio > 0.5 && acts.length > 0,
    `${(hiddenRatio*100).toFixed(0)}% 的时间页面不可见，期间有 ${acts.length} 次互动`);

  // ⑤ 完成率异常：每个视频都 100% 看完
  const fullWatched = V.perVideo.filter(s => s >= DUR - 3).length;
  add('vid.perfect-completion', V.perVideo.length >= 3 && fullWatched === V.perVideo.length,
    `看了 ${V.perVideo.length} 个视频，其中 ${fullWatched} 个看完全程（真人会有大量中途切走）`);

  // ⑥ 互动总量异常
  const total = acts.length;
  const minutes = Math.max(1, (Date.now() - V.startedAt) / 60000);
  const perMin = total / minutes;
  add('vid.interaction-rate', perMin > 6,
    `每分钟 ${perMin.toFixed(1)} 次互动（真人通常 <3）`);

  // ⑦ 点赞率高得离谱（看的视频全点赞）
  const likeRate = V.videosWatched > 0 ? likes.length / Math.max(1, V.videosWatched + 1) : 0;
  add('vid.like-rate', likeRate > 0.8 && likes.length >= 3,
    `点赞率 ${(likeRate*100).toFixed(0)}%（真人通常 5-20%）`);

  // ⑧ 播放进度伪造：进度增长比真实时间快
  let forged = 0;
  for (let i = 1; i < V.ticks.length; i++){
    const dPos = V.ticks[i].pos - V.ticks[i-1].pos;
    const dT = (V.ticks[i].t - V.ticks[i-1].t) / 1000;
    if (dT > 0 && dPos > dT * 1.5 + 0.5) forged += 1;
  }
  add('vid.progress-forged', forged > 2, `${forged} 次播放进度跳跃超过真实时间`);

  const risk = Math.min(100, flags.filter(f=>f.hit).length * 18);
  let verdict;
  if (risk >= 45) verdict = { level:'bot', label:'明显刷量', action:'清空数据/限流' };
  else if (risk >= 18) verdict = { level:'sus', label:'行为可疑', action:'加验证码' };
  else verdict = { level:'ok', label:'像正常用户', action:'放行' };

  return {
    risk, verdict, flags,
    stats: {
      观看视频数: V.videosWatched,
      互动总数: acts.length,
      点赞: likes.length, 投币: coins.length, 收藏: favs.length, 关注: follows.length,
      每分钟互动: Number(perMin.toFixed(2)),
      页面不可见占比: Number((hiddenRatio*100).toFixed(1)),
      每个视频观看秒数: V.perVideo,
      采样点数: V.ticks.length,
    },
  };
}

window.VideoDetect = {
  run,
  raw: V,
  reset(){
    V.ticks=[]; V.actions=[]; V.videosWatched=0; V.perVideo=[];
    V.pos=0; V.startedAt=Date.now(); V.videoStartAt=Date.now();
  },
};

document.addEventListener('DOMContentLoaded', () => {
  ['like','coin','fav','follow'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => record(id));
  });
  const nb = document.getElementById('next');
  if (nb) nb.addEventListener('click', nextVideo);
  const pb = document.getElementById('pause');
  if (pb) pb.addEventListener('click', () => { V.playing = !V.playing; });
  tick();
});
})();
