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
  // 見出しと紙面の印にコピーボタンを付ける（コントレの問題・解答見出しは問題文と回答をコピー）
  const isContre = file.startsWith("contre/");
  box.querySelectorAll("h2[id], h3[id], section.rei[id] > h4, .pg[id]").forEach((el) => {
    const id = el.id || el.parentElement.id;
    const b = document.createElement("button");
    b.className = "klink"; b.type = "button";
    if (isContre && /^(mon|kai)[\d-]+$/.test(id)) {
      b.textContent = "📋"; b.title = "問題文と回答をコピー";
      b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); copy(contreText(box, id.slice(3)), "問題文と回答"); };
    } else {
      b.textContent = "🔗"; b.title = "リンクをコピー";
      b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); copy(linkTo(file, id), "リンク"); };
    }
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

function inlineText(node) {
  if (node.nodeType === 3) return node.nodeValue.replace(/[ \t\r\n]+/g, " ");
  if (node.nodeType !== 1) return "";
  if (node.classList.contains("gen") || node.classList.contains("klink")) return "";
  const tag = node.tagName;
  if (tag === "STYLE" || tag === "SCRIPT" || tag === "IMG") return "";
  if (tag === "BR") return "\n";
  if (node.classList.contains("fr") && node.children.length >= 2) {
    return `(${inlineText(node.children[0]).trim()})／(${inlineText(node.children[1]).trim()})`;
  }
  let out = "";
  for (const ch of node.childNodes) out += inlineText(ch);
  return out;
}

function tlText(tl) {
  const lines = ["[タイム・テーブル]"];
  const joinRow = (el, sep) => Array.from(el.children)
    .map((c) => inlineText(c).replace(/\n+/g, "").trim()).filter(Boolean).join(sep);
  const addRow = (row) => {
    const boxes = row.querySelector(".tl-boxes");
    if (boxes) {
      const name = boxes.querySelector(".tl-name, .tl-sub");
      const parts = Array.from(boxes.querySelectorAll(".tl-box")).map((b) => inlineText(b).trim()).filter(Boolean);
      const tot = boxes.querySelector(".tl-total");
      const head = name ? inlineText(name).trim() + ": " : "";
      const body = parts.join(" | ") + (tot ? ` (計 ${inlineText(tot).trim()})` : "");
      if (head || body) lines.push(head + body);
    }
    const f = row.querySelector(".tl-formula");
    if (f) {
      for (const d of f.children) {
        const s = inlineText(d).trim();
        if (s) lines.push(s);
      }
    }
  };
  for (const ch of tl.children) {
    if (ch.classList.contains("tl-line")) continue;
    if (ch.classList.contains("tl-marks")) { const s = joinRow(ch, " / "); if (s) lines.push(s); }
    else if (ch.classList.contains("tl-dates") || ch.classList.contains("tl-months") || ch.classList.contains("tl-noteline")) {
      const s = joinRow(ch, "  "); if (s) lines.push(s);
    } else if (ch.classList.contains("tl-row")) {
      addRow(ch);
    } else if (ch.classList.contains("tl-grp")) {
      const gn = ch.querySelector(".tl-gname");
      if (gn) lines.push(inlineText(gn).trim());
      ch.querySelectorAll(":scope > .tl-row").forEach(addRow);
    }
  }
  return lines.join("\n");
}

function tableText(tbl) {
  const rows = Array.from(tbl.querySelectorAll("tr"));
  if (rows.length === 1) {
    const cells = rows[0].querySelectorAll("td, th");
    if (cells.length === 1 && cells[0].querySelector("p")) {
      return Array.from(cells[0].querySelectorAll("p")).map((p) => inlineText(p).trim()).filter(Boolean).join("\n");
    }
  }
  return rows.map((tr) => Array.from(tr.querySelectorAll("td, th"))
    .map((td) => inlineText(td).replace(/\n+/g, " ").replace(/\s+/g, " ").trim())
    .join(" | ")).filter(Boolean).join("\n");
}

function sectionText(box, id) {
  const head = document.getElementById(id);
  if (!head || !box.contains(head)) return "";
  const parts = [];
  let prevBox = false;
  for (let el = head; el; el = el.nextElementSibling) {
    if (el !== head && (el.tagName === "H2" || el.tagName === "H1")) break;
    if (el.classList.contains("gen") || el.tagName === "STYLE" || el.tagName === "SCRIPT" || el.tagName === "NAV") continue;
    let txt = "";
    if (el.tagName === "TABLE") txt = tableText(el);
    else if (el.classList.contains("tl")) txt = tlText(el);
    else if (el.tagName === "FIGURE") {
      const cap = el.querySelector("figcaption");
      txt = cap ? inlineText(cap).trim() : "";
    } else {
      txt = inlineText(el).trim();
    }
    if (!txt) continue;
    const isBox = el.tagName === "H2" || el.tagName === "TABLE" || el.classList.contains("tl");
    const isBreak = isBox || el.tagName === "H3" || el.tagName === "H4";
    parts.push({ txt, gap: parts.length > 0 && (isBreak || prevBox) });
    prevBox = isBox;
  }
  return parts.map((p, i) => (i === 0 ? "" : (p.gap ? "\n\n" : "\n")) + p.txt).join("");
}

function contreText(box, num) {
  return [sectionText(box, `mon${num}`), sectionText(box, `kai${num}`)].filter(Boolean).join("\n\n---\n\n");
}

async function copy(text, label = "リンク") {
  try { await navigator.clipboard.writeText(text); toast(`${label}をコピーしました`); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { ta.setSelectionRange(0, text.length); } catch {}
    try { document.execCommand("copy"); toast(`${label}をコピーしました`); } catch { prompt(label, text); }
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
