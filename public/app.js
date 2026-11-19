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
const sourceState = new Map();
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
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => undefined);
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
  stream.addEventListener("source", (event) => {
    const item = JSON.parse(event.data);
    updateSource(item);
    log(`${item.label || item.id}: ${sourceText(item)}`);
  });
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
  for (const item of list) sourceState.set(item.id, item);
  sourcesEl.innerHTML = SOURCES.map(([id, label]) => {
    const item = sourceState.get(id) || { id, status: "searching", detail: "Searching", count: 0, items: [] };
    return `<li class="source">
      <button class="source-toggle" type="button" data-source="${escapeAttr(id)}" aria-expanded="false">
        <span class="dot ${escapeHtml(item.status)}"></span>
        <b>${escapeHtml(label)}</b>
        <span class="source-status">${escapeHtml(sourceText(item))}</span>
      </button>
      <div class="source-panel" hidden></div>
    </li>`;
  }).join("");
}

function updateSource(item) {
  sourceState.set(item.id, item);
  const button = sourcesEl.querySelector(`[data-source="${item.id}"]`);
  if (!button) return;
  const row = button.closest(".source");
  const dot = row.querySelector(".dot");
  dot.className = `dot ${item.status}`;
  row.querySelector(".source-status").textContent = sourceText(item);
  if (button.getAttribute("aria-expanded") === "true") row.querySelector(".source-panel").innerHTML = panelHtml(item);
}

function panelHtml(item) {
  const items = Array.isArray(item.items) ? item.items : [];
  const line = !items.length
    ? "Nothing was opened for this source."
    : items.every((row) => !row.codes)
      ? `Checked ${items.length} posts, none had a working code`
      : `Checked ${items.length} posts`;
  const rows = items.map((row) => {
    const when = row.date ? String(row.date).slice(0, 10) : "";
    return `<li>
      <a href="${escapeAttr(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title || row.url)}</a>
      ${when ? `<time>${escapeHtml(when)}</time>` : ""}
      ${row.codes ? `<span class="had-codes">had codes</span>` : ""}
    </li>`;
  }).join("");
  return `<p>${escapeHtml(line)}</p>${rows ? `<ul>${rows}</ul>` : ""}`;
}

sourcesEl.addEventListener("click", (event) => {
  const button = event.target.closest(".source-toggle");
  if (!button || !sourcesEl.contains(button)) return;
  const panel = button.closest(".source").querySelector(".source-panel");
  const open = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", open ? "false" : "true");
  if (open) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = panelHtml(sourceState.get(button.dataset.source) || { items: [] });
});

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
  const scamNote = card.scam ? `<p class="note">${escapeHtml(card.scam.reasons.join(" "))}</p>` : "";
  const why = (card.reasons || []).join(" · ");
  return `<article class="card" data-code="${escapeAttr(card.code)}">
    <div class="card-top"><span class="badge">${escapeHtml(labelType(card.type))}</span><span class="meta">${card.confidence}</span></div>
    <div class="code">${escapeHtml(card.code)}</div>
    ${card.reward ? `<p class="reward">${escapeHtml(card.reward)}</p>` : ""}
    <div class="meter" aria-label="Confidence ${card.confidence}"><i style="--p:${card.confidence}%"></i></div>
    ${why ? `<details class="why"><summary>Why ${card.confidence}</summary><p>${escapeHtml(why)}</p></details>` : ""}
    <button class="copy" type="button" data-copy="${escapeAttr(card.code)}">Copy ${escapeHtml(card.code)}</button>
    <p class="note">${escapeHtml(card.note)}</p>
    <p class="meta">${escapeHtml(card.ageLabel)} · ${card.sourceCount} source${card.sourceCount === 1 ? "" : "s"}</p>
    <div class="links">${links}</div>
    ${scamNote}
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
  const previous = myVote(currentBrand, code);
  if (previous === choice) return;
  const response = await fetch("/api/votes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brand: currentBrand, code, vote: choice, previous: previous || null }),
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
    const summary = card.querySelector(".why summary");
    const line = card.querySelector(".why p");
    if (summary) summary.textContent = `Why ${body.confidence}`;
    if (line && Array.isArray(body.reasons)) line.textContent = body.reasons.join(" · ");
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
  if (active) return;
  const list = loadWatch();
  const stale = list.find((item) => Date.now() - (item.checkedAt || 0) > 30 * 60 * 1000);
  if (!stale) return;
  const quiet = new EventSource(`/api/search?q=${encodeURIComponent(stale.brand)}`);
  quiet.addEventListener("done", (event) => {
    const data = JSON.parse(event.data);
    const sources = data.sources || [];
    const down = sources.length > 0 && sources.every((source) => source.status === "failed" || source.status === "blocked");
    if (down && !(data.codes || []).length) {
      log(`Watch re-check for ${stale.brand} failed. Kept the previous list.`);
      quiet.close();
      return;
    }
    const item = loadWatch().find((row) => row.brand.toLowerCase() === stale.brand.toLowerCase());
    const seen = item?.seen || {};
    const fresh = (data.codes || []).filter((card) => !card.scam && card.confidence >= 60 && !seen[card.code]);
    if (fresh.length) notify(`New ${stale.brand} code: ${fresh[0].code}`, fresh[0].reward || "High confidence");
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
  if (item.status === "blocked") return item.detail ? `Blocked · ${item.detail}` : "Blocked";
  if (item.status === "nothing" && /^checked \d+ posts, no codes$/.test(item.detail || "")) return item.detail;
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

function log(line) {
  const el = document.querySelector("#log");
  if (!el) return;
  if (el.textContent === "Ready.") el.textContent = "";
  el.textContent += `${line}\n`;
  el.scrollTop = el.scrollHeight;
}
function notify(title, body) {
  log(`${title} — ${body}`);
  try {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
  } catch { /* the page log still has the note */ }
}
document.querySelector("#test-run").addEventListener("click", () => {
  input.value = "Freecash";
  log("Test run: Freecash");
  startSearch("Freecash");
});
document.querySelector("#clear-cache").addEventListener("click", async () => {
  const brand = (currentBrand || input.value).trim();
  if (!brand) return;
  const response = await fetch(`/api/cache?q=${encodeURIComponent(brand)}`, { method: "DELETE" });
  log(response.ok ? `Cleared cache for ${brand}` : "Could not clear the cache");
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
renderHome();
setInterval(refreshWatch, 60 * 1000);
shotNote.textContent = "A screenshot of a code field. The server reads it with Gemini when GEMINI_API_KEY is set.";

const codesMode = document.querySelector("#codes-mode");
const pricesMode = document.querySelector("#prices-mode");
const priceStatus = document.querySelector("#price-status");
const priceResults = document.querySelector("#price-results");
let priceMatch = null;
let priceWatch = null;
let priceRange = "30d";

document.querySelector("#mode-codes").addEventListener("click", () => setMode("codes"));
document.querySelector("#mode-prices").addEventListener("click", () => setMode("prices"));

function setMode(mode) {
  const prices = mode === "prices";
  codesMode.hidden = prices;
  pricesMode.hidden = !prices;
  document.querySelector("#mode-codes").classList.toggle("on", !prices);
  document.querySelector("#mode-prices").classList.toggle("on", prices);
  document.querySelector("#mode-codes").setAttribute("aria-pressed", String(!prices));
  document.querySelector("#mode-prices").setAttribute("aria-pressed", String(prices));
  if (prices) loadPriceConfig();
}

async function loadPriceConfig() {
  const response = await fetch("/api/price/config");
  const config = response.ok ? await response.json() : { email: false };
  priceResults.dataset.email = config.email ? "1" : "0";
}

document.querySelector("#price-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = document.querySelector("#product").value.trim();
  if (query.length < 2) return;
  priceStatus.hidden = false;
  priceStatus.textContent = "Checking store prices…";
  priceResults.innerHTML = "";
  let response;
  let body;
  try {
    response = await fetch("/api/price/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    body = await response.json();
  } catch {
    priceStatus.textContent = "The price check didn't finish. Check the connection and try again.";
    return;
  }
  if (!response.ok || (body.error && !(body.offers || []).length && !(body.resale || []).length)) {
    priceStatus.textContent = body.error || "Price match failed.";
    return;
  }
  priceMatch = body;
  priceStatus.hidden = true;
  renderPriceMatch(body);
});

function offerLabel(offer) {
  if (offer.thirdParty && offer.seller) return `Sold by ${offer.seller} on ${offer.store}`;
  return offer.seller ? `${offer.store} · ${offer.seller}` : offer.store;
}

function offerCard(offer, index, list) {
  const badges = [
    offer.kind === "other" ? "Other seller" : "",
    offer.kind === "resale" ? "Used/Resale" : "",
    offer.likely ? "Likely match" : "",
  ].filter(Boolean);
  return `<article class="offer">
      ${offer.image ? `<img class="offer-image" alt="" src="${escapeAttr(offer.image)}" />` : ""}
      <div>
        <a href="${escapeAttr(offer.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(offerLabel(offer))}</a>
        ${badges.map((badge) => `<div class="badge">${escapeHtml(badge)}</div>`).join("")}
        ${offer.seller && !offer.thirdParty ? `<div class="fine">Seller: ${escapeHtml(offer.seller)}</div>` : ""}
        <div class="fine">${escapeHtml(offer.title)}</div>
        ${offer.rating ? `<div class="fine">${offer.rating} stars${offer.ratingCount ? ` (${offer.ratingCount})` : ""}</div>` : ""}
        ${offer.delivery ? `<div class="fine">${escapeHtml(offer.delivery)}</div>` : ""}
        ${offer.source === "search" ? `<div class="badge">Price from search results</div>` : ""}
      </div>
      <div>
        <strong>${money(offer.price)}</strong>
        <button class="ghost watch-pick" type="button" data-list="${list}" data-index="${index}">Watch</button>
      </div>
    </article>`;
}

function renderPriceMatch(body) {
  priceMatch = body;
  delete priceResults.dataset.pick;
  delete priceResults.dataset.list;
  const product = body.product || {};
  const offers = body.offers || [];
  const resale = body.resale || [];
  const emailOn = priceResults.dataset.email === "1";
  const hasTrusted = offers.some((offer) => offer.kind === "trusted");
  const priceText = product.price == null ? "No major-store price" : body.priceBasis === "lowest" ? `${money(product.price)} lowest major-store price` : hasTrusted ? `${money(product.price)} median of major stores` : money(product.price);
  const storeText = hasTrusted ? "" : product.store || "";
  const rows = offers.map((offer, index) => offerCard(offer, index, "offers")).join("");
  const resaleRows = resale.map((offer, index) => offerCard(offer, index, "resale")).join("");
  const empty = resale.length
    ? `<p class="fine">No major-store prices. Used and resale listings stay hidden until you turn them on.</p>`
    : `<p class="fine">No same-product prices at other stores turned up.</p>`;
  priceResults.innerHTML = `<article class="price-card">
      <div class="price-hero">
        ${product.image ? `<img alt="" src="${escapeAttr(product.image)}" />` : ""}
        <div>
          <h2>${escapeHtml(product.name || "Product")}</h2>
          <p>${priceText}${storeText ? ` · ${escapeHtml(storeText)}` : ""}</p>
        </div>
      </div>
    </article>
    ${body.note ? `<p class="discontinued">${escapeHtml(body.note)}</p>` : ""}
    ${rows || empty}
    ${resale.length ? `<label class="resale-toggle"><input id="show-resale" type="checkbox" /> Show used/resale</label><div id="resale-offers" hidden>${resaleRows}</div>` : ""}
    <form id="watch-form" class="watch-form price-card">
      <h2>Watch this price</h2>
      <p id="watch-choice">Tap Watch on a store to choose it.</p>
      <p class="fine" id="watch-note">${emailOn ? "Checked once a day. History starts the day tracking begins. This is not a forecast." : "Email alerts are not turned on yet. You can still save a watch with a free ntfy.sh topic, and the chart will update on the daily check."}</p>
      <p id="watch-feedback" class="watch-feedback" role="status" hidden></p>
      <input id="watch-email" type="email" inputmode="email" autocomplete="email" placeholder="Email" maxlength="180" />
      <input id="watch-target" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Target price (optional)" />
      <input id="watch-ntfy" type="text" placeholder="ntfy.sh topic (optional)" maxlength="64" />
      <button id="watch-submit" class="hunt" type="submit">Watch this price</button>
    </form>
    <div id="price-chart"></div>`;
  priceResults.querySelectorAll(".watch-pick").forEach((button) => {
    button.addEventListener("click", () => chooseOffer(button));
  });
  priceResults.querySelector("#show-resale")?.addEventListener("change", (event) => {
    const list = priceResults.querySelector("#resale-offers");
    if (list) list.hidden = !event.target.checked;
  });
  priceResults.querySelector("#watch-form").addEventListener("submit", submitWatch);
  showWatchChoice();
}

function chooseOffer(button) {
  priceResults.dataset.pick = button.getAttribute("data-index");
  priceResults.dataset.list = button.getAttribute("data-list") || "offers";
  priceResults.querySelectorAll(".watch-pick").forEach((item) => { item.textContent = "Watch"; });
  button.textContent = "Selected";
  showWatchChoice();
  const form = document.querySelector("#watch-form");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  const email = document.querySelector("#watch-email");
  email.focus({ preventScroll: true });
}

function showWatchChoice() {
  const choice = document.querySelector("#watch-choice");
  const feedback = document.querySelector("#watch-feedback");
  if (!choice) return;
  const product = pickedProduct();
  if (!product || product.price == null) {
    choice.textContent = "This listing doesn't have a price yet, so it can't be watched. Pick a store that shows a dollar amount.";
    return;
  }
  choice.textContent = `${product.store || "This store"} · ${money(product.price)}`;
  if (feedback) feedback.hidden = true;
}

function watchMessage(text, ok) {
  const feedback = document.querySelector("#watch-feedback");
  if (!feedback) return;
  feedback.hidden = false;
  feedback.className = ok ? "watch-feedback ok" : "watch-feedback bad";
  feedback.textContent = text;
}

async function submitWatch(event) {
  event.preventDefault();
  const product = pickedProduct();
  const submit = document.querySelector("#watch-submit");
  if (!product || product.price == null) {
    watchMessage("There's no price on this listing yet, so there's nothing to watch. Choose a store that shows a dollar amount.", false);
    document.querySelector("#watch-form")?.scrollIntoView({ block: "nearest" });
    return;
  }
  const email = document.querySelector("#watch-email").value.trim();
  const ntfy = document.querySelector("#watch-ntfy").value.trim();
  const target = document.querySelector("#watch-target").value;
  submit.disabled = true;
  submit.textContent = "Saving…";
  watchMessage("Saving the watch…", true);
  try {
    const response = await fetch("/api/watch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, ntfy, target, product }),
    });
    let body = {};
    try {
      body = await response.json();
    } catch {
      throw new Error("The server didn't answer in a way the page could read. Try again.");
    }
    if (!response.ok) {
      watchMessage(body.error || "Could not save that watch.", false);
      return;
    }
    priceWatch = { id: body.id, token: body.token };
    const stop = `/api/watch/stop?id=${encodeURIComponent(body.id)}&token=${encodeURIComponent(body.token)}`;
    const feedback = document.querySelector("#watch-feedback");
    feedback.hidden = false;
    feedback.className = "watch-feedback ok";
    feedback.innerHTML = `Watching ${escapeHtml(product.store || "this store")} at ${money(product.price)}. <a href="${stop}">Stop watching</a>`;
    renderChart(body.summary, body.history);
    document.querySelector("#price-chart")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    watchMessage(error instanceof Error ? error.message : "The watch didn't save. Check the connection and try again.", false);
  } finally {
    submit.disabled = false;
    submit.textContent = "Watch this price";
  }
}

function pickedProduct() {
  const index = priceResults.dataset.pick;
  const list = priceResults.dataset.list || "offers";
  const offer = index !== "" && index != null ? priceMatch?.[list]?.[Number(index)] : null;
  if (offer) {
    return { name: offer.title, image: offer.image || priceMatch.product.image, price: offer.price, currency: offer.currency || "USD", url: offer.url, store: offerLabel(offer), source: offer.source, upc: priceMatch.product.upc || null };
  }
  return priceMatch.product;
}

function renderChart(summary, history) {
  const host = document.querySelector("#price-chart");
  if (!host || !summary) return;
  const points = summary.points || history || [];
  const width = 320;
  const height = 140;
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const coords = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - ((point.price - min) / span) * (height - 16) - 8;
    return `${x},${y}`;
  }).join(" ");
  host.innerHTML = `<article class="chart-card">
      <div class="ranges">
        ${["7d", "30d", "90d", "all"].map((range) => `<button class="ghost${range === priceRange ? " on" : ""}" type="button" data-range="${range}">${range}</button>`).join("")}
      </div>
      <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Price history"><polyline fill="none" stroke="#3dff8a" stroke-width="3" points="${coords}" /></svg>
      <p>Low ${money(summary.low)} · High ${money(summary.high)} · Avg ${money(summary.avg)}</p>
      <p>${escapeHtml(summary.verdict)}</p>
      <p class="fine">${escapeHtml(summary.note)}</p>
    </article>`;
  host.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => loadRange(button.getAttribute("data-range")));
  });
}

async function loadRange(range) {
  priceRange = range;
  if (!priceWatch) return;
  const response = await fetch(`/api/watch/${priceWatch.id}?token=${encodeURIComponent(priceWatch.token)}&range=${range}`);
  if (!response.ok) return;
  const body = await response.json();
  renderChart(body.summary, body.history);
}

function money(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount));
}
