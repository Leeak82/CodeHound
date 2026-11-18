const SOURCES = [
  ["official", "Official pages"],
  ["social", "Socials"],
  ["reddit", "Reddit"],
  ["coupons", "Coupon sites"],
  ["web", "Web search"],
  ["youtube", "YouTube"],
  ["gemini", "Gemini"],
];

const form = document.querySelector("#search-form");
const input = document.querySelector("#q");
const home = document.querySelector("#home");
const caseEl = document.querySelector("#case");
const sourcesEl = document.querySelector("#sources");
const resultsEl = document.querySelector("#results");
const flaggedEl = document.querySelector("#flagged");
const statusEl = document.querySelector("#status");
const hintEl = document.querySelector("#hint");
const watchBtn = document.querySelector("#watch");
const shotNote = document.querySelector("#shot-note");
let stream = null;
let active = false;
let currentBrand = "";
let lastCodes = [];

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const brand = input.value.trim();
  if (brand.length < 2) {
    showStatus("Type an app, game, or store name.", true);
    return;
  }
  startSearch(brand);
});

document.querySelector("#back").addEventListener("click", () => {
  stopStream();
  caseEl.hidden = true;
  home.hidden = false;
  statusEl.hidden = true;
  hintEl.hidden = true;
  renderHome();
});

document.querySelector("#shot").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 4_000_000) {
    showStatus("Use a PNG, JPEG, WebP, or GIF under 4 MB.", true);
    return;
  }
  showStatus("Reading the screenshot…");
  const dataUrl = await readFile(file);
  const response = await fetch("/api/screenshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mimeType: file.type, image: dataUrl.slice(dataUrl.indexOf(",") + 1) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    showStatus(body.error || "The screenshot could not be read.", true);
    return;
  }
  if (!body.brand) {
    showStatus("No brand was visible. Type the name and hunt.", true);
    return;
  }
  input.value = body.brand;
  hintEl.hidden = false;
  hintEl.textContent = [labelType(body.codeType), body.hints].filter(Boolean).join(" · ");
  startSearch(body.brand, { type: body.codeType || "", hint: body.hints || "" });
});

watchBtn.addEventListener("click", () => {
  if (!currentBrand) return;
  const list = loadWatch();
  const index = list.findIndex((item) => item.brand.toLowerCase() === currentBrand.toLowerCase());
  if (index >= 0) {
    list.splice(index, 1);
    watchBtn.textContent = "Watch this app";
  } else {
    const seen = {};
    for (const card of lastCodes) seen[card.code] = true;
    list.unshift({ brand: currentBrand, seen, codes: lastCodes.filter((card) => !card.scam).map(compact), checkedAt: Date.now() });
    watchBtn.textContent = "Watching";
  }
  saveWatch(list);
  renderHome();
});

document.querySelector("#install").addEventListener("click", async () => {
  if (!window.deferredInstall) return;
  window.deferredInstall.prompt();
  await window.deferredInstall.userChoice;
  window.deferredInstall = null;
  document.querySelector("#install").hidden = true;
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  window.deferredInstall = event;
  document.querySelector("#install").hidden = false;
});

function startSearch(brand, extra = {}) {
  stopStream();
  currentBrand = brand;
  lastCodes = [];
  active = true;
  rememberRecent(brand);
  home.hidden = true;
  caseEl.hidden = false;
  hintEl.hidden = !extra.hint && hintEl.hidden;
  resultsEl.innerHTML = "";
  flaggedEl.innerHTML = "";
  showStatus("Checking public pages…");
  renderSources(SOURCES.map(([id, label]) => ({ id, label, status: "searching", detail: "Searching", count: 0 })));
  watchBtn.textContent = isWatching(brand) ? "Watching" : "Watch this app";
  const params = new URLSearchParams({ q: brand });
  if (extra.type) params.set("type", extra.type);
  if (extra.hint) params.set("hint", extra.hint);
  let settled = false;
  stream = new EventSource(`/api/search?${params.toString()}`);
  stream.addEventListener("source", (event) => updateSource(JSON.parse(event.data)));
  stream.addEventListener("results", (event) => renderCodes(JSON.parse(event.data).codes || []));
  stream.addEventListener("done", (event) => {
    settled = true;
    const data = JSON.parse(event.data);
    renderSources(data.sources || []);
    renderCodes(data.codes || [], data.hint || "");
    const visible = (data.codes || []).filter((card) => !card.scam);
    statusEl.hidden = true;
    if (!visible.length) {
      resultsEl.innerHTML = `<div class="empty">No full public code turned up for ${escapeHtml(brand)}. Nothing was guessed. Try the name printed on the app icon, or check again later.</div>`;
    }
    if (data.cached) showStatus("Saved result from the last few hours.");
    updateWatchFromResult(brand, data.codes || []);
    stream.close();
    active = false;
  });
  stream.addEventListener("error", (event) => {
    if (settled) return;
    let message = "The search stopped before every source finished.";
    if (event instanceof MessageEvent && event.data) {
      try { message = JSON.parse(event.data).error || message; } catch { /* keep the fallback */ }
    }
    showStatus(message, true);
    stream.close();
    active = false;
  });
}

function stopStream() {
  if (stream) stream.close();
  stream = null;
  active = false;
}

function renderSources(list) {
  const byId = new Map(list.map((item) => [item.id, item]));
  sourcesEl.innerHTML = SOURCES.map(([id, label]) => {
    const item = byId.get(id) || { status: "searching", detail: "Searching", count: 0 };
    const text = sourceText(item);
    return `<li class="source"><span class="dot ${escapeHtml(item.status)}"></span><b>${escapeHtml(label)}</b><span>${escapeHtml(text)}</span></li>`;
  }).join("");
}

function updateSource(item) {
  const row = [...sourcesEl.children].find((node) => node.querySelector("b")?.textContent === labelFor(item.id));
  if (!row) return;
  const dot = row.querySelector(".dot");
  dot.className = `dot ${item.status}`;
  row.querySelector("span:last-child").textContent = sourceText(item);
}

function renderCodes(codes, hint) {
  lastCodes = codes;
  const visible = codes.filter((card) => !card.scam);
  const hidden = codes.filter((card) => card.scam);
  resultsEl.innerHTML = visible.map((card) => cardHtml(card)).join("");
  flaggedEl.innerHTML = hidden.length
    ? `<details class="flagged"><summary>${hidden.length} code${hidden.length === 1 ? "" : "s"} hidden · scam check</summary>${hidden.map((card) => cardHtml(card)).join("")}</details>`
    : "";
  if (hint) {
    hintEl.hidden = false;
    hintEl.textContent = hint;
  }
  wireCards();
}

function cardHtml(card) {
  const mine = myVote(currentBrand, card.code);
  const links = card.sources
    .slice(0, 4)
    .map((source) => `<a href="${escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(hostOf(source.url))}</a>`)
    .join("");
  const reasons = card.scam ? `<p class="note">${escapeHtml(card.scam.reasons.join(" "))}</p>` : "";
  return `<article class="card" data-code="${escapeAttr(card.code)}">
    <div class="card-top"><span class="badge">${escapeHtml(labelType(card.type))}</span><span class="meta">${card.confidence}</span></div>
    <div class="code">${escapeHtml(card.code)}</div>
    ${card.reward ? `<p class="reward">${escapeHtml(card.reward)}</p>` : ""}
    <div class="meter" aria-label="Confidence ${card.confidence}"><i style="--p:${card.confidence}%"></i></div>
    <button class="copy" type="button" data-copy="${escapeAttr(card.code)}">Copy ${escapeHtml(card.code)}</button>
    <p class="note">${escapeHtml(card.note)}</p>
    <p class="meta">${escapeHtml(card.ageLabel)} · ${card.sourceCount} source${card.sourceCount === 1 ? "" : "s"}</p>
    <div class="links">${links}</div>
    ${reasons}
    <div class="votes">
      <button class="vote ${mine === "worked" ? "on" : ""}" type="button" data-vote="worked">Worked${card.workedVotes ? ` ${card.workedVotes}` : ""}</button>
      <button class="vote ${mine === "failed" ? "on" : ""}" type="button" data-vote="failed">Didn't work${card.failedVotes ? ` ${card.failedVotes}` : ""}</button>
    </div>
  </article>`;
}

function wireCards() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const code = button.getAttribute("data-copy");
      try { await navigator.clipboard.writeText(code); }
      catch { fallbackCopy(code); }
      const original = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = original; }, 1200);
    });
  });
  document.querySelectorAll("[data-vote]").forEach((button) => {
    button.addEventListener("click", () => vote(button));
  });
}

async function vote(button) {
  const card = button.closest(".card");
  const code = card.getAttribute("data-code");
  const choice = button.getAttribute("data-vote");
  if (myVote(currentBrand, code)) return;
  const response = await fetch("/api/votes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brand: currentBrand, code, vote: choice }),
  });
  if (!response.ok) {
    showStatus("That vote didn't save.", true);
    return;
  }
  const body = await response.json();
  rememberVote(currentBrand, code, choice);
  button.classList.add("on");
  const count = choice === "worked" ? body.worked : body.failed;
  button.textContent = `${choice === "worked" ? "Worked" : "Didn't work"} ${count}`;
  if (typeof body.confidence === "number") {
    card.querySelector(".card-top .meta").textContent = String(body.confidence);
    card.querySelector(".meter i").style.setProperty("--p", `${body.confidence}%`);
  }
}

function renderHome() {
  const trending = document.querySelector("#trending");
  const recent = document.querySelector("#recent");
  const watch = document.querySelector("#watch-home");
  recent.innerHTML = chips(loadRecent(), "No searches yet.");
  watch.innerHTML = watchChips();
  fetch("/api/trending")
    .then((response) => response.json())
    .then((body) => {
      const rows = (body.searches || []).map((item) => item.label);
      trending.innerHTML = chips(rows, "Searches will show up here.");
      wireChips();
    })
    .catch(() => {
      trending.innerHTML = `<p class="fine">Trending is unavailable right now.</p>`;
    });
  wireChips();
}

function chips(names, empty) {
  if (!names.length) return `<p class="fine">${escapeHtml(empty)}</p>`;
  return names.map((name) => `<button class="chip" type="button" data-brand="${escapeAttr(name)}">${escapeHtml(name)}</button>`).join("");
}

function watchChips() {
  const list = loadWatch();
  if (!list.length) return `<p class="fine">Save an app after a hunt. New high-confidence codes get a badge here.</p>`;
  return list
    .map((item) => {
      const unseen = (item.codes || []).filter((code) => code.confidence >= 55 && !item.seen?.[code.code]).length;
      return `<button class="chip" type="button" data-brand="${escapeAttr(item.brand)}">${escapeHtml(item.brand)}${unseen ? `<span class="new">${unseen} new</span>` : ""}</button>`;
    })
    .join("");
}

function wireChips() {
  document.querySelectorAll("[data-brand]").forEach((button) => {
    button.onclick = () => {
      const brand = button.getAttribute("data-brand");
      input.value = brand;
      markSeen(brand);
      startSearch(brand);
    };
  });
}

function updateWatchFromResult(brand, codes) {
  const list = loadWatch();
  const item = list.find((row) => row.brand.toLowerCase() === brand.toLowerCase());
  if (!item) return;
  const previous = new Set((item.codes || []).map((code) => code.code));
  item.codes = codes.filter((card) => !card.scam).map(compact);
  item.checkedAt = Date.now();
  for (const code of item.codes) {
    if (!previous.has(code.code)) item.seen[code.code] = false;
  }
  saveWatch(list);
}

function refreshWatch() {
  if (active || document.hidden) return;
  const list = loadWatch();
  const stale = list.find((item) => Date.now() - (item.checkedAt || 0) > 30 * 60 * 1000);
  if (!stale) return;
  const quiet = new EventSource(`/api/search?q=${encodeURIComponent(stale.brand)}`);
  quiet.addEventListener("done", (event) => {
    const data = JSON.parse(event.data);
    updateWatchFromResult(stale.brand, data.codes || []);
    if (home.hidden === false) renderHome();
    quiet.close();
  });
  quiet.onerror = () => quiet.close();
}

function loadWatch() {
  try { return JSON.parse(localStorage.getItem("codehound.watch") || "[]"); } catch { return []; }
}
function saveWatch(list) { localStorage.setItem("codehound.watch", JSON.stringify(list.slice(0, 20))); }
function isWatching(brand) { return loadWatch().some((item) => item.brand.toLowerCase() === brand.toLowerCase()); }
function markSeen(brand) {
  const list = loadWatch();
  const item = list.find((row) => row.brand.toLowerCase() === brand.toLowerCase());
  if (!item) return;
  for (const code of item.codes || []) item.seen[code.code] = true;
  saveWatch(list);
}
function loadRecent() {
  try { return JSON.parse(localStorage.getItem("codehound.recent") || "[]"); } catch { return []; }
}
function rememberRecent(brand) {
  const recent = [brand, ...loadRecent().filter((item) => item.toLowerCase() !== brand.toLowerCase())].slice(0, 8);
  localStorage.setItem("codehound.recent", JSON.stringify(recent));
}
function myVote(brand, code) {
  const votes = JSON.parse(localStorage.getItem("codehound.votes") || "{}");
  return votes[`${brand.toLowerCase()}|${code}`] || "";
}
function rememberVote(brand, code, vote) {
  const votes = JSON.parse(localStorage.getItem("codehound.votes") || "{}");
  votes[`${brand.toLowerCase()}|${code}`] = vote;
  localStorage.setItem("codehound.votes", JSON.stringify(votes));
}
function compact(card) { return { code: card.code, confidence: card.confidence }; }
function sourceText(item) {
  if (item.status === "found") return `Found ${item.count}`;
  if (item.status === "searching") return "Searching";
  const label = item.status === "failed" ? "Failed" : "Nothing";
  return item.detail ? `${label} · ${item.detail}` : label;
}
function labelFor(id) { return SOURCES.find((item) => item[0] === id)?.[1] || id; }
function labelType(type) {
  return { signup: "Sign-up", bonus: "Bonus", coupon: "Coupon", referral: "Referral", lottery: "Lottery", promo: "Promo" }[type] || "Code";
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function showStatus(message, isError) {
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.className = isError ? "status error" : "status";
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function escapeAttr(value) { return escapeHtml(value); }
function fallbackCopy(value) {
  const area = document.createElement("textarea");
  area.value = value;
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
renderHome();
setInterval(refreshWatch, 60 * 1000);
shotNote.textContent = "A screenshot of a code field. The server reads it with Gemini when GEMINI_API_KEY is set.";
