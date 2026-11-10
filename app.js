"use strict";
// 財理 短答アプリ
// 問題と記録は非公開リポジトリに置き、端末にため込んで使う。このファイルに教材の文章は入れない。

const REPO = "kkk23451-ship-it/account_general";
const DIR = "app";
const API = `https://api.github.com/repos/${REPO}/contents/${DIR}`;
const DEV = ["localhost", "127.0.0.1"].includes(location.hostname);

// ---------- 端末への保存 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("tt." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tt." + k, JSON.stringify(v)); } catch {} },
};
const cacheData = {
  async get(name) { try { const r = await (await caches.open("data")).match(name); return r ? r.text() : null; } catch { return null; } },
  async set(name, text) { try { await (await caches.open("data")).put(name, new Response(text)); } catch {} },
};

let device = store.get("device", null);
if (!device) { device = "d" + Math.random().toString(36).slice(2, 10); store.set("device", device); }

let Q = [];                 // 問題
let byId = new Map();
let titles = {};
let logs = store.get("logs", {});        // 端末ID → [{i, t, r}]
let pending = store.get("pending", []);  // この端末の未送信の記録
let meta = store.get("meta", { qsha: null, shas: {} });
let scope = store.get("scope", { type: "all" });
let cur = store.get("cur", null);        // {id, stage: "q"|"a", ok}
let recent = [];                          // この回に解いた問題（すぐ同じ問題を出さない）
let view = "quiz";
let openState = store.get("open", {});    // 一覧で開いている章・節

// ---------- 優先度（Notion「問題」DB の式を一問ごとに使う） ----------
const EXAM = new Date(2027, 4, 30);       // 試験日 2027-05-30
const QUOTA_LINE = 11;                    // 優先度がこれを超える問題が今日のノルマ
const IMP = { "Ａ": 1, "Ｂ": 0.5, "Ｃ": 0, "Ｄ": -0.5 }; // Notion の「重要度」の欄に当てる値（AI問題は 0.5）
const DAY = 86400000;
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const daysBetween = (a, b) => Math.round((dayStart(a) - dayStart(b)) / DAY);
const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
let stats = new Map();   // id → {n, w, s, l, last, x}
let memos = new Map();   // id → メモ（いちばん新しいもの）

function rebuildStats() {
  stats = new Map();
  for (const q of Q) {
    const i = q.init;
    if (i) stats.set(q.id, { n: i.n || 0, w: i.w || 0, s: i.s ?? null, l: i.l ?? null, last: i.d ? parseDay(i.d) : null, x: !!i.x });
  }
  const all = [];
  for (const arr of Object.values(logs)) for (const x of arr) all.push(x);
  all.sort((a, b) => a.t - b.t);
  memos = new Map();
  for (const x of all) {
    if (x.m !== undefined) { memos.set(x.i, x.m); continue; }   // メモの記録
    const s = stats.get(x.i) || { n: 0, w: 0, s: null, l: null, last: null, x: false };
    s.n++; if (!x.r) s.w++;
    s.s = x.r ? (s.s || 0) + 1 : 0; s.l = x.r; s.last = x.t; s.x = false;
    stats.set(x.i, s);
  }
}
function priority(q, now = Date.now()) {
  const s = stats.get(q.id);
  if (!s || !s.n) return 0;                          // 一度も解いていない問題は0（2026-11-10 本人指定）
  if (s.x) return 0;                                 // Notion で重要度 -1（出さない）にしていた節
  const n = s.n, w = s.w, c = n - w;
  const D = s.last == null ? 0 : Math.max(0, daysBetween(now, s.last));
  const imp = q.src ? 0.5 : (IMP[q.imp] ?? 0);
  const sf = s.s == null ? 2 - (s.l || 0) : s.s === 0 ? 3 : s.s === 1 ? 2 : s.s === 2 ? 1.5 : 1;
  const toExam = Math.max(daysBetween(EXAM, now), 14);
  return ((Math.pow(w, 1.01) + 10) / (n + 10)) * (n / 4 + 3) / Math.pow(c + 6, 1.05)
    * ((D + 1) / Math.pow(c + 1, 1.9)) * (imp + 1) * sf * (273 / toExam) / 4 * 100;
}
// 今日のノルマ：優先度 > 11 で、今日まだ解いていない（Notion の復習用ビューと同じ条件）
const seen = (q) => { const s = stats.get(q.id); return !!(s && s.n); };
function inQuota(q, now = Date.now()) {
  if (!seen(q) || priority(q, now) <= QUOTA_LINE) return false;
  const s = stats.get(q.id);
  return s.last == null || daysBetween(now, s.last) > 0;
}
// 習熟度（ゲージ）：連続正答3回で到達（Notion の維持フェーズの基準）。未着手は0。
function mastery(q) {
  const s = stats.get(q.id);
  if (!s || !s.n) return 0;
  if (s.x) return 1;
  return Math.min(s.s ?? (s.l ? 1 : 0), 3) / 3;
}

// この問題を解いた記録（古い順）
function answersOf(id) {
  const out = [];
  for (const arr of Object.values(logs)) for (const x of arr) if (x.i === id && x.m === undefined) out.push(x);
  return out.sort((a, b) => a.t - b.t);
}
const md = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
function historyLine(q) {
  const a = answersOf(q.id);
  const init = q.init && q.init.n ? `<span class="muted">Notion ${q.init.n}回</span> ` : "";
  if (!a.length && !init) return "";
  const marks = a.slice(-12).map((x) => `<span class="${x.r ? "hok" : "hng"}">${md(x.t)}${x.r ? "○" : "×"}</span>`).join(" ");
  return `<div class="hline">履歴 ${init}${a.length > 12 ? "… " : ""}${marks}</div>`;
}

// ---------- 範囲と出題 ----------
function inScope(q, sc = scope) {
  if (sc.type === "ch") return q.ch === sc.ch;
  if (sc.type === "sec") return q.ch === sc.ch && q.sec === sc.sec;
  if (sc.type === "one") return q.id === sc.id;
  return true;
}
function scopeLabel(sc = scope) {
  if (sc.type === "ch") return `第${sc.ch}章 ${titles[sc.ch] || ""}`;
  if (sc.type === "sec") return `第${sc.ch}章 ${sc.sec}`;
  if (sc.type === "one") return `この問題だけ`;
  return "おまかせ（優先度の高い順）";
}
// 出す順：優先度の高い順（同じなら問題集の順）。ただし今日すでに解いた問題は後ろへ回す
function solvedToday(q, now) { const s = stats.get(q.id); return !!(s && s.n && s.last != null && daysBetween(now, s.last) <= 0); }
function pickNext() {
  const now = Date.now();
  let bestQ = null, bestKey = null;
  for (const q of Q) {
    if (!inScope(q) || recent.includes(q.id)) continue;
    const key = [solvedToday(q, now) ? 1 : 0, -priority(q, now)];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { bestQ = q; bestKey = key; }
  }
  if (bestQ) return bestQ;
  recent = [];
  return Q.find((q) => inScope(q)) || null;
}
function quota() {
  const now = Date.now(), today = dayStart(now);
  let left = 0;
  for (const q of Q) if (inQuota(q, now)) left++;
  const done = new Set();
  for (const arr of Object.values(logs)) for (const x of arr) if (x.t >= today && x.m === undefined) done.add(x.i);
  return { left, done: done.size };
}

// ---------- 表示の部品 ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function rich(text) {
  return String(text || "").split(/\n{2,}/).filter((p) => p.trim()).map((p) =>
    "<p>" + esc(p).replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>") + "</p>").join("");
}
const plain = (t) => String(t || "").replace(/\*\*/g, "").replace(/\s+/g, "");
function chips(q) {
  return `${q.imp ? `<span class="chip">重要度${esc(q.imp)}</span>` : ""}`
    + (q.pk || []).map((k) => `<span class="chip">${k === "類題" ? "過去問類題" : "過去問"}</span>`).join("")
    + (q.src ? `<span class="chip ai">AI問題</span>` : "");
}
function gauge(v) {
  const pct = Math.round(v * 100);
  return `<span class="gauge" title="習熟度 ${pct}%"><span style="width:${pct}%"></span></span>`;
}
function answerHtml(q) {
  const tf = q.v === "正しい" || q.v === "誤り";
  return `<div class="head">解答：${esc(tf ? q.v : q.b)}</div>
    ${tf && q.b ? `<div class="basis">${esc(q.b)}</div>` : ""}
    <div class="qtext">${rich(q.e) || '<p class="muted">（解説なし）</p>'}</div>`;
}
function setCur(c) { cur = c; store.set("cur", c); }
function setScope(sc) { scope = sc; store.set("scope", sc); updateBar(); }
function updateBar() {
  $("#scope-label").textContent = scopeLabel();
  const { left, done } = quota();
  let inSc = "";
  if (scope.type !== "all" && Q.length) {
    const now = Date.now(); let k = 0;
    for (const q of Q) if (inScope(q) && inQuota(q, now)) k++;
    inSc = `（この範囲 ${k}）<button id="to-all" class="link">おまかせに戻す</button>`;
  }
  $("#quota").innerHTML = Q.length ? `ノルマ 残り<b>${left}</b>${inSc}・今日 ${done}問` : "";
  const ta = $("#to-all");
  if (ta) ta.onclick = () => { setScope({ type: "all" }); recent = []; if (cur && cur.stage === "q") setCur(null); renderQuiz(); window.scrollTo(0, 0); };
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === view));
}

// ---------- 解く画面 ----------
function renderQuiz() {
  view = "quiz"; updateBar();
  const main = $("#main");
  if (!Q.length) { main.innerHTML = `<p class="muted pad">問題がまだ読み込まれていません。⚙ から設定してください。</p>`; return; }
  let q = cur && byId.get(cur.id);
  if (!q || (cur.stage === "q" && !inScope(q))) {
    q = pickNext();
    if (!q) { main.innerHTML = `<p class="muted pad">この範囲に問題がありません。</p>`; return; }
    setCur({ id: q.id, stage: "q" });
  }
  const s = stats.get(q.id);
  const p = priority(q);
  const tf = q.v === "正しい" || q.v === "誤り";
  let body = `<div class="card"><div class="meta"><span class="chip">第${q.ch}章 ${q.no ? "問題" + q.no : esc(q.id)}</span>${chips(q)}${inQuota(q) ? '<span class="chip quota">ノルマ</span>' : ""}</div>
    <div class="meta">${esc(q.sec)}</div><div class="qtext">${rich(q.q)}</div></div>`;
  let buttons;
  if (cur.stage === "q") {
    buttons = tf
      ? `<button data-a="正しい">正しい</button><button data-a="誤り">誤り</button>`
      : `<button class="primary" data-a="show">解答を見る</button>`;
  } else {
    const graded = cur.ok !== undefined;
    body += `<div class="result ${graded ? (cur.ok ? "ok" : "ng") : ""}">
      ${graded && tf ? `<div class="mark">${cur.ok ? "○ 正解" : "× 不正解"}</div>` : ""}${answerHtml(q)}</div>
      <label class="f" for="memo">メモ</label><textarea id="memo" rows="3" placeholder="この問題のメモ">${esc(memos.get(q.id) || "")}</textarea>`;
    buttons = graded
      ? `<button class="primary" data-a="next">次へ</button>`
      : `<button data-a="self1">○ できた</button><button data-a="self0">× できなかった</button>`;
  }
  if (s && s.n) body += `<div class="stats">${s.n}回・誤り${s.w}回・連続正答${s.s ?? "-"}・最後 ${s.last ? new Date(s.last).toLocaleDateString("ja-JP") : "-"}・優先度 ${p.toFixed(1)}</div>`;
  else body += `<div class="stats">未着手・優先度 0</div>`;
  body += historyLine(q);
  main.innerHTML = body + `<div class="answers">${buttons}</div>`;
  main.querySelectorAll(".answers button").forEach((b) => b.addEventListener("click", () => { saveMemo(q); onAnswer(q, b.dataset.a); }));
  const m = $("#memo");
  if (m) { m.addEventListener("blur", () => saveMemo(q)); m.addEventListener("input", () => store.set("memoDraft", { id: q.id, m: m.value })); const d = store.get("memoDraft", null); if (d && d.id === q.id) m.value = d.m; }
}
function saveMemo(q) {
  const m = $("#memo");
  if (!m) return;
  const v = m.value.replace(/\s+$/, "");
  store.set("memoDraft", null);
  if (v === (memos.get(q.id) || "")) return;
  const x = { i: q.id, t: Date.now(), m: v };
  (logs[device] ||= []).push(x); pending.push(x);
  memos.set(q.id, v);
  store.set("logs", logs); store.set("pending", pending);
  showSync(); scheduleSync();
}

function onAnswer(q, a) {
  if (a === "next") {
    recent = [...recent.slice(-4), q.id];
    if (scope.type === "one") setScope({ type: "all" });
    const n = pickNext();
    setCur(n ? { id: n.id, stage: "q" } : null);
    renderQuiz(); window.scrollTo(0, 0); return;
  }
  if (a === "show") { setCur({ id: q.id, stage: "a" }); renderQuiz(); return; }
  const ok = a === "self1" ? 1 : a === "self0" ? 0 : (a === q.v ? 1 : 0);
  record(q.id, ok);
  setCur({ id: q.id, stage: "a", ok });
  renderQuiz();
}

function record(id, r) {
  const x = { i: id, t: Date.now(), r };
  (logs[device] ||= []).push(x);
  pending.push(x);
  store.set("logs", logs); store.set("pending", pending);
  rebuildStats(); showSync(); scheduleSync();
}

// ---------- 一覧（章＞節＞問題＞本文と解答、習熟度のゲージ） ----------
function groupQ() {
  const chs = new Map();
  for (const q of Q) {
    let c = chs.get(q.ch);
    if (!c) { c = { qs: [], secs: new Map() }; chs.set(q.ch, c); }
    c.qs.push(q);
    if (!c.secs.has(q.sec)) c.secs.set(q.sec, []);
    c.secs.get(q.sec).push(q);
  }
  return chs;
}
function summary(qs, now) {
  let m = 0, left = 0, nw = 0;
  for (const q of qs) { m += mastery(q); if (!seen(q)) nw++; else if (inQuota(q, now)) left++; }
  return { m: qs.length ? m / qs.length : 0, left, nw, n: qs.length };
}
const cnt = (o) => `<span class="count">${o.left ? `<b>ノルマ${o.left}</b> ` : ""}未${o.nw}/${o.n}</span>`;
const solveBtn = (sc) => `<button class="solve" data-sc='${esc(JSON.stringify(sc))}'>解く</button>`;

function renderList() {
  view = "list"; updateBar();
  const now = Date.now();
  const chs = groupQ();
  const all = summary(Q, now);
  let html = `<div class="card total"><div class="row0"><span class="name">全体</span>${gauge(all.m)}<span class="pct">${Math.round(all.m * 100)}%</span></div>
    <div class="top-actions"><button data-sc='{"type":"all"}'>今日のノルマから解く（残り${all.left}）</button></div></div>`;
  for (const [ch, c] of chs) {
    const o = summary(c.qs, now);
    const key = "c" + ch;
    html += `<details class="ch" data-k="${key}" ${openState[key] ? "open" : ""}><summary><span class="ch-title">第${ch}章 ${esc(titles[ch] || "")}</span>${gauge(o.m)}${cnt(o)}</summary>
      <div class="row"><span class="name">この章ぜんぶ</span>${solveBtn({ type: "ch", ch })}</div>`;
    for (const [sec, qs] of c.secs) {
      const so = summary(qs, now);
      const sk = key + "|" + sec;
      html += `<details class="sec" data-k="${esc(sk)}" data-ch="${ch}" data-sec="${esc(sec)}" ${openState[sk] ? "open" : ""}>
        <summary><span class="name">${esc(sec || "（節なし）")}</span>${gauge(so.m)}${cnt(so)}</summary><div class="qs"></div></details>`;
    }
    html += `</details>`;
  }
  const main = $("#main");
  main.innerHTML = html;
  main.querySelectorAll("details[data-k]").forEach((d) => {
    d.addEventListener("toggle", () => {
      if (d.open) openState[d.dataset.k] = 1; else delete openState[d.dataset.k];
      store.set("open", openState);
      if (d.classList.contains("sec") && d.open) fillSection(d);
    });
    if (d.classList.contains("sec") && d.open) fillSection(d);
  });
  main.onclick = onListClick;
}
function fillSection(d) {
  const box = d.querySelector(".qs");
  if (box.dataset.done) return;
  const ch = Number(d.dataset.ch), sec = d.dataset.sec, now = Date.now();
  let html = `<div class="row"><span class="name">この節ぜんぶ</span>${solveBtn({ type: "sec", ch, sec })}</div>`;
  for (const q of Q) {
    if (q.ch !== ch || q.sec !== sec) continue;
    const title = `${q.no ? "問題" + q.no : "AI問題"}　${esc(plain(q.q).slice(0, 26))}…`;
    html += `<details class="q"><summary><span class="name">${title}</span>${gauge(mastery(q))}${inQuota(q, now) ? '<span class="count"><b>ノルマ</b></span>' : ""}</summary>
      <div class="qbody" data-id="${esc(q.id)}"></div></details>`;
  }
  box.innerHTML = html; box.dataset.done = 1;
  box.querySelectorAll("details.q").forEach((qd) => qd.addEventListener("toggle", () => {
    const b = qd.querySelector(".qbody");
    if (!qd.open || b.dataset.done) return;
    const q = byId.get(b.dataset.id);
    const s = stats.get(q.id);
    b.innerHTML = `<div class="meta">${chips(q)}</div><div class="qtext">${rich(q.q)}</div>
      <details class="ans"><summary>解答と解説</summary>${answerHtml(q)}</details>
      ${memos.get(q.id) ? `<div class="memo-view"><span class="muted">メモ</span>${rich(memos.get(q.id))}</div>` : ""}
      <div class="stats">${s && s.n ? `${s.n}回・誤り${s.w}回・連続正答${s.s ?? "-"}` : "未着手"}</div>
      ${historyLine(q)}
      ${solveBtn({ type: "one", id: q.id })}`;
    b.dataset.done = 1;
  }));
}
function onListClick(e) {
  const b = e.target.closest("[data-sc]");
  if (!b) return;
  e.preventDefault();
  const sc = JSON.parse(b.dataset.sc);
  setScope(sc);
  recent = [];
  // 範囲を選び直したら、表示中の問題を引き継がず、その範囲でいちばん優先度の高い問題から出す
  setCur(sc.type === "one" ? { id: sc.id, stage: "q" } : null);
  renderQuiz(); window.scrollTo(0, 0);
}

// ---------- 履歴（解いた記録を新しい順に） ----------
let histFilter = store.get("histFilter", "all");   // all | ng
let histLimit = 100;
function renderHistory() {
  view = "history"; updateBar();
  const all = [];
  for (const arr of Object.values(logs)) for (const x of arr) if (x.m === undefined && byId.has(x.i)) all.push(x);
  all.sort((a, b) => b.t - a.t);
  const rows = histFilter === "ng" ? all.filter((x) => !x.r) : all;
  const wk = ["日", "月", "火", "水", "木", "金", "土"];
  // 日ごとの集計（絞り込みに関係なく、その日に解いた数）
  const perDay = new Map();
  for (const x of all) { const k = dayStart(x.t); const o = perDay.get(k) || { n: 0, ok: 0 }; o.n++; if (x.r) o.ok++; perDay.set(k, o); }
  let html = `<div class="filter"><button data-f="all" class="${histFilter === "all" ? "on" : ""}">すべて</button><button data-f="ng" class="${histFilter === "ng" ? "on" : ""}">× だけ</button></div>`;
  if (!rows.length) html += `<p class="muted pad">${all.length ? "× の記録はありません。" : "まだ記録がありません。解くとここに残ります。"}</p>`;
  let day = null;
  for (const x of rows.slice(0, histLimit)) {
    const k = dayStart(x.t);
    if (k !== day) {
      if (day !== null) html += `</div>`;
      day = k; const d = new Date(k), o = perDay.get(k);
      html += `<div class="hday"><div class="hhead">${d.getMonth() + 1}月${d.getDate()}日（${wk[d.getDay()]}）<span class="count">${o.n}問・○${o.ok} ×${o.n - o.ok}</span></div>`;
    }
    const q = byId.get(x.i), t = new Date(x.t);
    const hm = `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
    html += `<details class="q h"><summary><span class="${x.r ? "hok" : "hng"} hm">${x.r ? "○" : "×"}</span><span class="name">${esc(`第${q.ch}章 ${q.no ? "問題" + q.no : "AI問題"}　${plain(q.q).slice(0, 22)}…`)}</span><span class="count">${hm}</span></summary>
      <div class="qbody" data-id="${esc(q.id)}"></div></details>`;
  }
  if (day !== null) html += `</div>`;
  if (rows.length > histLimit) html += `<button class="btn sub" id="more">もっと見る（あと${rows.length - histLimit}件）</button>`;
  const main = $("#main");
  main.innerHTML = html;
  main.querySelectorAll(".filter button").forEach((b) => b.onclick = () => { histFilter = b.dataset.f; store.set("histFilter", histFilter); histLimit = 100; renderHistory(); });
  const more = $("#more"); if (more) more.onclick = () => { histLimit += 100; renderHistory(); };
  main.querySelectorAll("details.q").forEach((qd) => qd.addEventListener("toggle", () => {
    const b = qd.querySelector(".qbody");
    if (!qd.open || b.dataset.done) return;
    const q = byId.get(b.dataset.id);
    b.innerHTML = `<div class="meta"><span class="chip">${esc(q.sec)}</span>${chips(q)}</div><div class="qtext">${rich(q.q)}</div>
      <details class="ans"><summary>解答と解説</summary>${answerHtml(q)}</details>
      ${memos.get(q.id) ? `<div class="memo-view"><span class="muted">メモ</span>${rich(memos.get(q.id))}</div>` : ""}
      ${historyLine(q)}${solveBtn({ type: "one", id: q.id })}`;
    b.dataset.done = 1;
  }));
  main.onclick = onListClick;
}

// ---------- 設定 ----------
function renderSettings() {
  view = "settings"; updateBar();
  const token = store.get("token", "");
  const n = Object.values(logs).reduce((a, x) => a + x.length, 0);
  const seeded = Q.filter((q) => q.init).length;
  $("#main").innerHTML = `<div class="card">
    <label class="f">GitHub のトークン（account_general の読み書きだけに絞ったもの）</label>
    <input id="tok" type="password" autocomplete="off" value="${esc(token)}" placeholder="github_pat_…">
    <button class="btn" id="save">保存して同期</button>
    <p class="note">トークンはこの端末の中だけに保存されます。</p>
    <p class="note">記録 ${n}件（未送信 ${pending.length}件）・問題 ${Q.length}問（Notion の記録を初期値にした問題 ${seeded}問）・この端末 ${esc(device)}</p>
    <p class="note" id="msg"></p>
    <button class="btn sub" id="sync-now">今すぐ同期</button></div>`;
  $("#save").onclick = () => { store.set("token", $("#tok").value.trim()); meta = { qsha: null, shas: {} }; store.set("meta", meta); runSync(true); };
  $("#sync-now").onclick = () => runSync(true);
}

// ---------- 同期 ----------
function showSync(text) {
  const el = $("#sync");
  if (text) { el.textContent = text; return; }
  if (!store.get("token", "")) { el.textContent = DEV ? "試験用" : "未設定"; return; }
  el.textContent = pending.length ? `未送信 ${pending.length}` : (navigator.onLine ? "同期済み" : "オフライン");
}
let syncTimer = null, syncing = false;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, 1500); }

async function gh(path, opts = {}) {
  const token = store.get("token", "");
  return fetch(API + path, {
    cache: "no-store", ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: opts.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", ...(opts.headers || {}) },
  });
}
function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function rerender() { if (view === "list") renderList(); else if (view === "history") renderHistory(); else if (view === "settings") renderSettings(); else if (!cur || cur.stage === "q") renderQuiz(); else updateBar(); }

async function runSync(verbose) {
  const msg = (t) => { const m = $("#msg"); if (m) m.textContent = t; };
  if (!store.get("token", "") || syncing || !navigator.onLine) { showSync(); return; }
  syncing = true; showSync("同期中…");
  let changed = false;
  try {
    // 1. 問題（変わったときだけ取り直す）
    const list = await gh("");
    if (!list.ok) throw new Error(`一覧 ${list.status}`);
    const files = await list.json();
    const qf = files.find((f) => f.name === "questions.json");
    if (qf && (qf.sha !== meta.qsha || !Q.length)) {   // 端末の問題が消えていたら取り直す
      const r = await gh("/questions.json", { raw: true });
      if (!r.ok) throw new Error(`問題 ${r.status}`);
      const text = await r.text();
      await cacheData.set("questions.json", text);
      loadQuestions(text);
      meta.qsha = qf.sha; store.set("meta", meta); changed = true;
    }
    // 2. ほかの端末の記録
    const lr = await gh("/logs");
    const lfiles = lr.ok ? await lr.json() : [];
    for (const f of lfiles) {
      const id = f.name.replace(/\.json$/, "");
      if (id === device || meta.shas[id] === f.sha) continue;
      const r = await gh(`/logs/${f.name}`, { raw: true });
      if (!r.ok) continue;
      logs[id] = JSON.parse(await r.text()); meta.shas[id] = f.sha; changed = true;
    }
    // 3. この端末の記録を送る
    if (pending.length) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur0 = await gh(`/logs/${device}.json`);
        let sha, remote = [];
        if (cur0.ok) { const j = await cur0.json(); sha = j.sha; remote = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)))); }
        const seen = new Set(remote.map((x) => x.t + x.i));
        const merged = remote.concat((logs[device] || []).filter((x) => !seen.has(x.t + x.i))).sort((a, b) => a.t - b.t);
        const put = await gh(`/logs/${device}.json`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: `log ${device}`, content: b64(JSON.stringify(merged)), ...(sha ? { sha } : {}) }),
        });
        if (put.ok) { logs[device] = merged; pending = []; changed = true; break; }
        if (put.status !== 409 && put.status !== 422) throw new Error(`送信 ${put.status}`);
      }
    }
    store.set("logs", logs); store.set("pending", pending); store.set("meta", meta);
    if (changed) { rebuildStats(); rerender(); }
    if (verbose) msg("同期しました。");
  } catch (e) {
    if (verbose) msg("同期できませんでした：" + e.message);
  } finally {
    syncing = false; showSync();
  }
}

function loadQuestions(text) {
  const d = JSON.parse(text);
  Q = d.questions; titles = d.titles || {};
  byId = new Map(Q.map((q) => [q.id, q]));
  rebuildStats();
}

// ---------- 起動 ----------
async function boot() {
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.v;
    if (v === "quiz") renderQuiz(); else if (v === "list") renderList(); else if (v === "history") renderHistory(); else renderSettings();
    window.scrollTo(0, 0);
  }));
  let text = await cacheData.get("questions.json");
  if (DEV && !store.get("token", "")) {
    try { const r = await fetch("dev/questions.json", { cache: "no-store" }); if (r.ok) { text = await r.text(); await cacheData.set("questions.json", text); } } catch {}
  }
  if (text) loadQuestions(text);
  showSync();
  if (!text && !store.get("token", "")) renderSettings(); else renderQuiz();
  runSync();
  addEventListener("online", () => runSync());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { runSync(); if (view !== "settings") updateBar(); } });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
boot();
