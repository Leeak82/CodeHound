import assert from "node:assert/strict";
import test from "node:test";
import { alertReason, extractPriceFromHtml, sameProduct, summarizeHistory } from "../price.js";

const JSON_LD = `
<html><head>
  <script type="application/ld+json">
    {"@type":"Product","name":"Sony WH-1000XM5 Headphones","image":"https://example.com/xm5.jpg","gtin13":"0272429195207","offers":{"@type":"Offer","price":"49.99","priceCurrency":"USD"}}
  </script>
</head><body>
  <p>Save $20</p>
  <p>or $8.25/mo</p>
</body></html>`;

test("JSON-LD price ignores a savings amount and a monthly payment", () => {
  const quote = extractPriceFromHtml(JSON_LD, "https://www.bestbuy.com/site/sony-wh-1000xm5/123.p");
  assert.equal(quote.price, 49.99);
  assert.equal(quote.name, "Sony WH-1000XM5 Headphones");
  assert.equal(quote.currency, "USD");
  assert.equal(quote.upc, "0272429195207");
  assert.equal(quote.store, "Best Buy");
  assert.equal(quote.image, "https://example.com/xm5.jpg");
});

test("meta product price is used when the page has no JSON-LD", () => {
  const html = `<html><head>
    <meta property="og:title" content="Kindle Paperwhite" />
    <meta property="product:price:amount" content="129.99" />
    <meta property="product:price:currency" content="USD" />
  </head><body><p>Save $30</p></body></html>`;
  const quote = extractPriceFromHtml(html, "https://www.amazon.com/dp/B0EXAMPLE");
  assert.equal(quote.price, 129.99);
  assert.equal(quote.name, "Kindle Paperwhite");
  assert.equal(quote.store, "Amazon");
});

test("a visible price is kept and save or monthly text is not", () => {
  const html = `<html><body>
    <div>Save $20</div>
    <div>$8.25/mo</div>
    <span class="a-price">$49.99</span>
  </body></html>`;
  const quote = extractPriceFromHtml(html, "https://www.amazon.com/dp/B0EXAMPLE");
  assert.equal(quote.price, 49.99);
});

test("same product requires the model, not a nearby one", () => {
  assert.equal(sameProduct({ name: "Sony WH-1000XM5 Headphones", upc: null }, "Sony WH-1000XM5 Wireless Headphones"), true);
  assert.equal(sameProduct({ name: "Sony WH-1000XM5 Headphones", upc: "111" }, "Other", "222"), false);
  assert.equal(sameProduct({ name: "Sony WH-1000XM5 Headphones", upc: "111" }, "Sony WH-1000XM5", "111"), true);
  assert.equal(sameProduct({ name: "Sony WH-1000XM5", upc: null }, "Sony WH-1000XM4 Headphones"), false);
});

test("history verdict stays inside the days actually tracked", () => {
  const now = Date.parse("2026-11-18T00:00:00.000Z");
  const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  const tracked = summarizeHistory(
    [
      { at: at(90), price: 40, source: "page" },
      { at: at(60), price: 55, source: "page" },
      { at: at(0), price: 40, source: "page" },
    ],
    "90d",
    now,
  );
  assert.equal(tracked.low, 40);
  assert.equal(tracked.high, 55);
  assert.equal(tracked.verdict, "Lowest price in 90 days, good time to buy");
  assert.match(tracked.note, /not a prediction/i);

  const waiting = summarizeHistory(
    [
      { at: at(10), price: 10, source: "page" },
      { at: at(5), price: 10, source: "page" },
      { at: at(0), price: 20, source: "page" },
    ],
    "all",
    now,
  );
  assert.equal(waiting.verdict, "Above average, consider waiting");

  const fresh = summarizeHistory([{ at: at(0), price: 12, source: "page" }], "30d", now);
  assert.match(fresh.verdict, /Tracking just started/);
  assert.match(fresh.verdict, /not a forecast/i);
});

test("alerts fire for a target, a new low, or a real drop", () => {
  assert.equal(alertReason(25, [], 24), "target");
  assert.equal(alertReason(null, [], 24), null);
  assert.equal(alertReason(null, [40, 36], 30), "lowest");
  assert.equal(alertReason(null, [30, 40], 37), "drop");
  assert.equal(alertReason(null, [20, 40], 39), null);
});
