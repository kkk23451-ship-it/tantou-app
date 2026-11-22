"use strict";
// 教材の閲覧ページ（財計のテキスト・問題集の HTML を読む）
// 教材の HTML は非公開リポジトリ（account_general の zaikei/）にあり、短答アプリと同じトークンで読む。
// このファイルに教材の文章は入れない。読んだ HTML と図は端末に保存し、通信なしでも開けるようにする。
// URL の形：kyozai.html#text/c25/rei12（zaikei/text/c25.html の id="rei12"）。# の後ろが無ければ教材の一覧。

const REPO = "kkk23451-ship-it/account_general";
const ROOT = "zaikei";
const API = `https://api.github.com/repos/${REPO}/contents/${ROOT}`;
const DEV = ["localhost", "127.0.0.1"].includes(location.hostname);
const DEV_BASE = "dev/zaikei/";            // 手元で試すときの置き場所（公開しない）
const CACHE = "kyozai-data";               // 端末の保存先（アプリの枠の入れ物とは別）

const $ = (s) => document.querySelector(s);
const token = () => { try { return JSON.parse(localStorage.getItem("tt.token") || '""'); } catch { return ""; } };
const shas = { get() { try { return JSON.parse(localStorage.getItem("kz.shas") || "{}"); } catch { return {}; } },
               set(v) { try { localStorage.setItem("kz.shas", JSON.stringify(v)); } catch {} } };

let curFile = null;      // 表示中のファイル（zaikei/ からの相対パス。例 text/c25.html）
let imgURLs = [];
let target = "";         // 飛んだ先。図が後から読み込まれて位置がずれたら、読み手が動かすまで合わせ直す
["touchstart", "wheel", "keydown"].forEach((ev) => window.addEventListener(ev, () => { target = ""; }, { passive: true }));

function toast(t) { const el = $("#ktoast"); el.textContent = t; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 1600); }
function msg(t) { $("#kmsg").textContent = t || ""; $("#kmsg").style.display = t ? "block" : "none"; }

// ---------- 取ってくる ----------
async function fromCache(path) {
  try { const r = await (await caches.open(CACHE)).match(path); return r || null; } catch { return null; }
}
async function toCache(path, resp) {
  try { await (await caches.open(CACHE)).put(path, resp); } catch {}
}
async function fetchNet(path, asBlob) {
  if (DEV) {
    const r = await fetch(DEV_BASE + path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status}`);
    return r;
  }
  const t = token();
  if (!t) throw new Error("トークンがありません");
  const r = await fetch(`${API}/${path}`, { cache: "no-store",
    headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github.raw+json" } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r;
}
// 保存したものがあればそれを返し、無ければ取ってきて保存する
async function getText(path) {
  const hit = await fromCache(path);
  if (hit) return hit.text();
  const r = await fetchNet(path);
  const text = await r.text();
  await toCache(path, new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  return text;
}
async function getBlob(path) {
  const hit = await fromCache(path);
  if (hit) return hit.blob();
  const r = await fetchNet(path);
  const blob = await r.blob();
  await toCache(path, new Response(blob, { headers: { "Content-Type": "image/png" } }));
  return blob;
}
// 開いたファイルが更新されていたら取り直す（フォルダーの一覧の sha と比べる）
async function refreshIfChanged(path) {
  if (DEV || !navigator.onLine || !token()) return false;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    const r = await fetch(`${API}${dir ? "/" + dir : ""}`, { cache: "no-store",
      headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json" } });
    if (!r.ok) return false;
    const list = await r.json();
    const f = list.find((x) => x.name === name);
    if (!f) return false;
    const s = shas.get();
    if (s[path] === f.sha) return false;
    const known = s[path] !== undefined;
    const resp = await fetchNet(path);
    const text = await resp.text();
    await toCache(path, new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    s[path] = f.sha; shas.set(s);
    return known;   // 初めて sha を覚えたときは、表示中のものをそのまま使う
  } catch { return false; }
}

// ---------- 表示 ----------
// フォルダーとファイル名は、英数字と - _ だけを読む。ほかの形（.. や \ を含むものなど）は教材の一覧にする。
// # の後ろから zaikei/ の外のファイル（ほかの人のリポジトリを含む）を読ませないため。
const NAME = /^[A-Za-z0-9_-]+$/;
function parseHash() {
  const home = { file: "index.html", anchor: "" };
  let h = "";
  try { h = decodeURIComponent(location.hash.replace(/^#/, "")); } catch { return home; }
  if (!h) return home;
  const parts = h.split("/");
  // text/c25/rei12 → text/c25.html#rei12
  if (parts.length >= 2) {
    if (!NAME.test(parts[0]) || !NAME.test(parts[1])) return home;
    const anchor = parts.length >= 3 ? parts.slice(2).join("/") : "";
    return { file: `${parts[0]}/${parts[1]}.html`, anchor };
  }
  if (!NAME.test(parts[0])) return home;
  return { file: `${parts[0]}.html`, anchor: "" };
}
function routeOf(file, anchor) {
  const f = file.replace(/\.html$/, "");
  return f === "index" ? "" : (anchor ? `${f}/${anchor}` : f);
}
function linkTo(file, anchor) {
  return `${location.origin}${location.pathname}#${routeOf(file, anchor)}`;
}
// 相対リンク（../text/c29-1.html#rei3 など）を、閲覧ページの URL の形にする
function resolve(href, baseFile) {
  if (/^[a-z]+:/i.test(href)) return null;
  if (href.startsWith("#")) return { file: baseFile, anchor: href.slice(1) };
  const u = new URL(href, `https://x/${ROOT}/${baseFile}`);
  const p = u.pathname.replace(`/${ROOT}/`, "");
  return { file: p, anchor: u.hash.replace(/^#/, "") };
}

let styled = false;
async function ensureStyle() {
  if (styled) return;
  try {
    const css = await getText("style.css");
    const st = document.createElement("style"); st.textContent = css; document.head.prepend(st);
    styled = true;
  } catch {}
}

async function show() {
  const { file, anchor } = parseHash();
  msg("");
  await ensureStyle();
  if (file !== curFile) {
    $("#kmain").innerHTML = '<p class="kmute">読み込み中…</p>';
    let text;
    try { text = await getText(file); }
    catch (e) {
      $("#kmain").innerHTML = "";
      if (token() || DEV) { msg(`読み込めませんでした（${e.message}）。通信の状態を確かめてください。`); return; }
      askToken();
      return;
    }
    render(text, file);
    curFile = file;
    refreshIfChanged(file).then((changed) => {
      if (changed && curFile === file) { getText(file).then((t) => { render(t, file); jump(parseHash().anchor, false); toast("新しい版にしました"); }); }
    });
  }
  jump(anchor, true);
  // 字の書体や表の幅が決まってから、もう一度合わせる
  setTimeout(() => { if (target) jump(target, false, true); }, 300);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (target) jump(target, false, true); });
}

// リンクを Notion などから開くと、ホーム画面のアプリとは別の保存場所になり、トークンが無いことがある
function askToken() {
  $("#ktitle").textContent = "教材";
  $("#kmain").innerHTML = `<div class="ktok"><p>この画面では、まだトークンが入っていません。短答アプリで使っている GitHub のトークン（account_general だけに絞ったもの）を貼り付けてください。この端末のこのアプリの中だけに保存されます。</p>
    <input id="ktok" type="password" autocomplete="off" placeholder="github_pat_…">
    <button id="ktoksave" class="kbtn" type="button">保存して開く</button></div>`;
  $("#ktoksave").onclick = () => {
    const v = $("#ktok").value.trim();
    if (!v) return;
    try { localStorage.setItem("tt.token", JSON.stringify(v)); } catch {}
    curFile = null; show();
  };
}

function render(text, file) {
  imgURLs.forEach((u) => URL.revokeObjectURL(u)); imgURLs = [];
  const doc = new DOMParser().parseFromString(text, "text/html");
  const main = doc.querySelector("main") || doc.body;
  const title = (doc.querySelector("h1") || {}).textContent || doc.title || "教材";
  $("#ktitle").textContent = title;
  document.title = title;
  const box = $("#kmain");
  box.innerHTML = main.innerHTML;
  // 目次は上のボタンで開く
  const nav = box.querySelector("nav.toc");
  $("#ktoc").style.visibility = nav ? "visible" : "hidden";
  if (nav) { nav.classList.add("hidden"); }
  // 図は保存したものか、取ってきたものを見せる
  const io = "IntersectionObserver" in window ? new IntersectionObserver((ents) => {
    ents.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); loadImg(en.target, file); } });
  }, { rootMargin: "600px" }) : null;
  box.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    img.removeAttribute("src");
    img.dataset.src = src;
    if (io) io.observe(img); else loadImg(img, file);
  });
  // 見出しと紙面の印に「リンクをコピー」を付ける
  box.querySelectorAll("h2[id], h3[id], section.rei[id] > h4, .pg[id]").forEach((el) => {
    const id = el.id || el.parentElement.id;
    const b = document.createElement("button");
    b.className = "klink"; b.type = "button"; b.textContent = "🔗"; b.title = "リンクをコピー";
    b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); copy(linkTo(file, id)); };
    el.appendChild(b);
  });
}

async function loadImg(img, file) {
  const r = resolve(img.dataset.src, file);
  if (!r) return;
  try {
    const blob = await getBlob(r.file);
    const u = URL.createObjectURL(blob); imgURLs.push(u);
    img.onload = () => { if (target) jump(target, false, true); };
    img.src = u;
  } catch { img.alt = "図（通信できないため表示できません）"; }
}

function jump(anchor, smooth, again) {
  if (!again) target = anchor;
  if (!anchor) { window.scrollTo(0, 0); return; }
  const el = document.getElementById(anchor);
  if (el) el.scrollIntoView({ block: "start", behavior: smooth ? "auto" : "auto" });
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("リンクをコピーしました"); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("リンクをコピーしました"); } catch { prompt("リンク", text); }
    ta.remove();
  }
}

// 本文の中のリンク：同じ閲覧ページの中で開く
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a");
  if (!a || !$("#kmain").contains(a)) return;
  if (a.classList.contains("img")) { ev.preventDefault(); return; }
  const href = a.getAttribute("href") || "";
  const r = resolve(href, curFile || "index.html");
  if (!r) return;
  ev.preventDefault();
  const nav = $("#kmain nav.toc");
  if (nav && nav.contains(a)) nav.classList.add("hidden");
  const route = routeOf(r.file, r.anchor);
  if (location.hash.replace(/^#/, "") === route) jump(r.anchor, true);
  else location.hash = route;
});

$("#khome").onclick = () => { location.hash = ""; };
$("#ktoc").onclick = () => {
  const nav = $("#kmain nav.toc");
  if (!nav) return;
  nav.classList.toggle("hidden");
  if (!nav.classList.contains("hidden")) nav.scrollIntoView({ block: "start" });
};
window.addEventListener("hashchange", show);
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
if ("serviceWorker" in navigator && !DEV) navigator.serviceWorker.register("sw.js").catch(() => {});
show();
