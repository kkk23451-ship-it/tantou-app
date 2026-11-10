"use strict";
// 財理 短答アプリ（試作）
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
let cur = store.get("cur", null);        // {id, stage: "q"|"a", pick, ok}
let recent = [];                          // この回に解いた問題（すぐ同じ問題を出さない）
let view = "quiz";

// ---------- 優先度（仮の式） ----------
const WEIGHT = { "Ａ": 3, "Ｂ": 2, "Ｃ": 1, "Ｄ": 0.5 };
const INTERVAL_DAYS = [1, 3, 7, 14, 30, 60]; // 連続正解の数ごとの次の出題までの日数
const DAY = 86400000;
let stats = new Map();

function rebuildStats() {
  stats = new Map();
  const all = [];
  for (const arr of Object.values(logs)) for (const x of arr) all.push(x);
  all.sort((a, b) => a.t - b.t);
  for (const x of all) {
    const s = stats.get(x.i) || { n: 0, ok: 0, last: 0, lastR: 0, streak: 0 };
    s.n++; s.ok += x.r; s.last = x.t; s.lastR = x.r; s.streak = x.r ? s.streak + 1 : 0;
    stats.set(x.i, s);
  }
}
function dueness(s, now) {
  const days = INTERVAL_DAYS[Math.min(s.streak, INTERVAL_DAYS.length - 1)];
  return (now - s.last) / (days * DAY);
}
function score(q, now) {
  const w = WEIGHT[q.imp] ?? 1.5;
  const s = stats.get(q.id);
  if (!s) return w;                                  // 未着手
  const d = dueness(s, now);
  if (d < 1) return w * d * 0.3;                     // まだ復習の時期でない
  return w * (1 + Math.min(d - 1, 2) * 0.5) * (s.lastR ? 1 : 1.5);
}
function status(q, now) {
  const s = stats.get(q.id);
  if (!s) return "new";
  return dueness(s, now) >= 1 ? "due" : "ok";
}

// ---------- 範囲 ----------
function inScope(q, sc = scope) {
  if (sc.type === "ch") return q.ch === sc.ch;
  if (sc.type === "sec") return q.ch === sc.ch && q.sec === sc.sec;
  return true;
}
function scopeLabel(sc = scope) {
  if (sc.type === "ch") return `第${sc.ch}章 ${titles[sc.ch] || ""}`;
  if (sc.type === "sec") return `第${sc.ch}章 ${sc.sec}`;
  return "おまかせ（全章）";
}
function pickNext() {
  const now = Date.now();
  let best = null, bestScore = -1;
  for (const q of Q) {
    if (!inScope(q) || recent.includes(q.id)) continue;
    const sc = score(q, now) + Math.random() * 0.01;
    if (sc > bestScore) { best = q; bestScore = sc; }
  }
  if (!best) { recent = []; return Q.find((q) => inScope(q)) || null; }
  return best;
}

// ---------- 表示 ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function rich(text) {
  return String(text || "").split(/\n{2,}/).filter((p) => p.trim()).map((p) =>
    "<p>" + esc(p).replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>") + "</p>").join("");
}
function setCur(c) { cur = c; store.set("cur", c); }
function setScope(sc) { scope = sc; store.set("scope", sc); $("#scope-label").textContent = scopeLabel(); }

function renderQuiz() {
  view = "quiz";
  const main = $("#main");
  if (!Q.length) { main.innerHTML = `<p class="muted pad">問題がまだ読み込まれていません。⚙ から設定してください。</p>`; return; }
  let q = cur && byId.get(cur.id);
  if (!q || (cur.stage === "q" && !inScope(q))) {
    q = pickNext();
    if (!q) { main.innerHTML = `<p class="muted pad">この範囲に問題がありません。</p>`; return; }
    setCur({ id: q.id, stage: "q" });
  }
  const s = stats.get(q.id);
  const tf = q.v === "正しい" || q.v === "誤り";
  const metaHtml = `<div class="meta">
      <span class="chip">第${q.ch}章 ${q.no ? "問題" + q.no : esc(q.id)}</span>
      ${q.imp ? `<span class="chip">重要度${esc(q.imp)}</span>` : ""}
      ${q.src ? `<span class="chip">${esc(q.src)}</span>` : ""}
      ${q.pe ? `<span>${esc(q.pe)}</span>` : ""}
    </div><div class="meta">${esc(q.sec)}</div>`;
  let body = `<div class="card">${metaHtml}<div class="qtext">${rich(q.q)}</div></div>`;
  let buttons;
  if (cur.stage === "q") {
    buttons = tf
      ? `<button data-a="正しい">正しい</button><button data-a="誤り">誤り</button>`
      : `<button class="primary" data-a="show">解答を見る</button>`;
  } else {
    const graded = cur.ok !== undefined;
    const ok = cur.ok;
    const head = !tf ? `解答：${esc(q.b)}` : `${graded ? (ok ? "○ 正解" : "× 不正解") : ""}　解答：${esc(q.v)}`;
    body += `<div class="result ${graded ? (ok ? "ok" : "ng") : ""}">
        <div class="head">${head}</div>
        ${tf && q.b ? `<div class="basis">${esc(q.b)}</div>` : ""}
        <div class="qtext">${rich(q.e) || '<p class="muted">（解説なし）</p>'}</div></div>`;
    buttons = graded
      ? `<button class="primary" data-a="next">次へ</button>`
      : `<button data-a="self1">○ できた</button><button data-a="self0">× できなかった</button>`;
  }
  if (s) body += `<div class="stats">これまで ${s.n}回・正解 ${s.ok}回・最後 ${new Date(s.last).toLocaleDateString("ja-JP")}</div>`;
  main.innerHTML = body + `<div class="answers">${buttons}</div>`;
  main.querySelectorAll(".answers button").forEach((b) => b.addEventListener("click", () => onAnswer(q, b.dataset.a)));
}

function onAnswer(q, a) {
  if (a === "next") {
    recent = [...recent.slice(-4), q.id];
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

function renderHome() {
  view = "home";
  const now = Date.now();
  const chs = new Map();
  for (const q of Q) {
    let c = chs.get(q.ch);
    if (!c) { c = { n: 0, nw: 0, due: 0, secs: new Map() }; chs.set(q.ch, c); }
    let s = c.secs.get(q.sec);
    if (!s) { s = { n: 0, nw: 0, due: 0 }; c.secs.set(q.sec, s); }
    const st = status(q, now);
    for (const o of [c, s]) { o.n++; if (st === "new") o.nw++; if (st === "due") o.due++; }
  }
  const cnt = (o) => `<span class="count">未${o.nw}${o.due ? ` <b>復習${o.due}</b>` : ""} / ${o.n}</span>`;
  let html = `<div class="top-actions"><button data-sc='{"type":"all"}'>おまかせで解く</button></div>`;
  for (const [ch, c] of chs) {
    const isCur = scope.ch === ch;
    html += `<details class="ch" ${isCur ? "open" : ""}><summary><span class="ch-title">第${ch}章 ${esc(titles[ch] || "")}</span>${cnt(c)}</summary>
      <div class="row ${scope.type === "ch" && isCur ? "current" : ""}"><span class="name">この章ぜんぶ</span><button data-sc='${esc(JSON.stringify({ type: "ch", ch }))}'>解く</button></div>`;
    for (const [sec, s] of c.secs) {
      const sc = { type: "sec", ch, sec };
      const on = scope.type === "sec" && isCur && scope.sec === sec;
      html += `<div class="row ${on ? "current" : ""}"><span class="name">${esc(sec || "（節なし）")}</span>${cnt(s)}<button data-sc='${esc(JSON.stringify(sc))}'>解く</button></div>`;
    }
    html += `</details>`;
  }
  $("#main").innerHTML = html;
  $("#main").querySelectorAll("[data-sc]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    setScope(JSON.parse(b.dataset.sc));
    recent = [];
    if (cur && cur.stage !== "q") setCur(null);
    renderQuiz(); window.scrollTo(0, 0);
  }));
}

function renderSettings() {
  view = "settings";
  const token = store.get("token", "");
  const n = Object.values(logs).reduce((a, x) => a + x.length, 0);
  $("#main").innerHTML = `<div class="card">
    <label class="f">GitHub のトークン（account_general の読み書きだけに絞ったもの）</label>
    <input id="tok" type="password" autocomplete="off" value="${esc(token)}" placeholder="github_pat_…">
    <button class="btn" id="save">保存して同期</button>
    <p class="note">トークンはこの端末の中だけに保存されます。</p>
    <p class="note">記録 ${n}件（未送信 ${pending.length}件）・問題 ${Q.length}問・この端末 ${esc(device)}</p>
    <p class="note" id="msg"></p>
    <button class="btn sub" id="sync-now">今すぐ同期</button>
    <button class="btn sub" id="back">戻る</button></div>`;
  $("#save").onclick = () => { store.set("token", $("#tok").value.trim()); meta = { qsha: null, shas: {} }; store.set("meta", meta); runSync(true); };
  $("#sync-now").onclick = () => runSync(true);
  $("#back").onclick = renderQuiz;
}

// ---------- 同期 ----------
function showSync(text) {
  const el = $("#sync");
  if (text) { el.textContent = text; return; }
  if (!store.get("token", "")) { el.textContent = DEV ? "試験用（端末のみ）" : "未設定"; return; }
  el.textContent = pending.length ? `未送信 ${pending.length}` : (navigator.onLine ? "同期済み" : "オフライン");
}
let syncTimer = null, syncing = false;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, 1500); }

async function gh(path, opts = {}) {
  const token = store.get("token", "");
  const r = await fetch(API + path, {
    cache: "no-store", ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: opts.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", ...(opts.headers || {}) },
  });
  return r;
}
function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function runSync(verbose) {
  const msg = (t) => { const m = $("#msg"); if (m) m.textContent = t; };
  if (!store.get("token", "") || syncing || !navigator.onLine) { showSync(); return; }
  syncing = true; showSync("同期中…");
  try {
    // 1. 問題（変わったときだけ取り直す）
    const list = await gh("");
    if (!list.ok) throw new Error(`一覧 ${list.status}`);
    const files = await list.json();
    const qf = files.find((f) => f.name === "questions.json");
    if (qf && qf.sha !== meta.qsha) {
      const r = await gh("/questions.json", { raw: true });
      if (!r.ok) throw new Error(`問題 ${r.status}`);
      const text = await r.text();
      await cacheData.set("questions.json", text);
      loadQuestions(text);
      meta.qsha = qf.sha; store.set("meta", meta);
      if (view === "home") renderHome(); else if (view === "quiz" && (!cur || cur.stage === "q")) renderQuiz();
    }
    // 2. ほかの端末の記録
    const lr = await gh("/logs");
    const lfiles = lr.ok ? await lr.json() : [];
    let changed = false;
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
    if (changed) { rebuildStats(); if (view === "home") renderHome(); }
    if (view === "settings") renderSettings();
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
  $("#scope-label").textContent = scopeLabel();
}

// ---------- 起動 ----------
async function boot() {
  $("#btn-home").onclick = () => (view === "home" ? renderQuiz() : renderHome());
  $("#btn-settings").onclick = () => (view === "settings" ? renderQuiz() : renderSettings());
  rebuildStats();
  let text = await cacheData.get("questions.json");
  if (!text && DEV && !store.get("token", "")) {
    try { const r = await fetch("dev/questions.json"); if (r.ok) { text = await r.text(); await cacheData.set("questions.json", text); } } catch {}
  }
  if (text) loadQuestions(text);
  showSync();
  if (!text && !store.get("token", "")) renderSettings(); else renderQuiz();
  runSync();
  addEventListener("online", () => runSync());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") runSync(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
boot();
