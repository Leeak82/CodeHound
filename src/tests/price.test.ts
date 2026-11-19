import assert from "node:assert/strict";
import test from "node:test";
import { alertReason, extractPriceFromHtml, filterGroundedOffers, firstGoodPrice, fragmentTitle, isProductPage, junkTitle, offersFromSearchHits, offersFromShopping, retailerFromUrl, retailerShoppingQuery, sameProduct, shoppingIncludesRetailer, summarizeHistory, titleCaseProduct, trustedReferencePrice, usableName } from "../price.js";

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

test("retail snippets become one price per store and skip other models", () => {
  assert.equal(junkTitle("page open prime modal"), true);
  assert.equal(junkTitle("Product not found"), true);
  assert.equal(usableName("page open prime modal", "Apple AirPods Pro 2"), "Apple AirPods Pro 2");
  assert.equal(sameProduct({ name: "Apple AirPods Pro 2" }, "Apple AirPods Pro (2nd Generation) USB-C"), true);
  assert.equal(sameProduct({ name: "Apple AirPods Pro 2" }, "Apple AirPods Max"), false);
  assert.equal(sameProduct({ name: "Ninja AF101 air fryer" }, "Ninja AF101 Air Fryer 4 Quart"), true);
  assert.equal(sameProduct({ name: "Ninja AF101 air fryer" }, "Ninja AF161 Max XL"), false);
  assert.equal(sameProduct({ name: "Sony WH-1000XM5" }, "Sony WH-1000XM4 Headphones"), false);
  assert.equal(sameProduct({ name: "Sony WH-1000XM5 Headphones", upc: "111" }, "Sony WH-1000XM5", "111"), true);
  const offers = offersFromSearchHits("Apple AirPods Pro 2", [
    { title: "Apple AirPods Pro 2 USB-C", url: "https://www.amazon.com/dp/B0CHWRXH8B", snippet: "Buy new $249.00. Save $20." },
    { title: "page open prime modal", url: "https://www.amazon.com/gp/prime", snippet: "$265.78" },
    { title: "Apple AirPods Pro 2nd generation", url: "https://www.walmart.com/ip/airpods-pro-2/123", snippet: "Current price $239.00" },
    { title: "Apple AirPods Pro 2", url: "https://www.bestbuy.com/site/apple-airpods-pro-2/123.p", snippet: "$244.99" },
    { title: "Apple AirPods Max", url: "https://www.target.com/p/apple-airpods-max/-/A-1", snippet: "$549.00" },
  ]);
  assert.deepEqual(offers.map((offer) => offer.store), ["Walmart", "Best Buy", "Amazon"]);
  assert.deepEqual(offers.map((offer) => offer.price), [239, 244.99, 249]);
  assert.equal(firstGoodPrice("Save $20 or $8.25/mo then $249.00"), 249);
});

test("Serper shopping keeps one new price per store", () => {
  const shopping = [
    { source: "Best Buy", price: "$229.99", title: "Sony WH-1000XM5 Wireless Headphones", link: "https://www.bestbuy.com/site/sony-wh-1000xm5/6505727.p", imageUrl: "https://example.com/xm5.jpg", rating: 4.8, ratingCount: 1200, delivery: "Free delivery", productId: "1", position: 1 },
    { source: "Target", price: "$239.99", title: "Sony WH-1000XM5 Headphones", link: "https://www.target.com/p/sony-wh-1000xm5/-/A-85978622", imageUrl: "https://example.com/xm5b.jpg", rating: 4.7, ratingCount: 800, delivery: "Ready within 2 hours", productId: "2", position: 2 },
    { source: "Lowe's", price: "$249.00", title: "Sony WH-1000XM5", link: "", imageUrl: "", rating: 4.6, ratingCount: 40, delivery: "", productId: "3", position: 3 },
    { source: "Newegg.com - Teds Electronics", price: "$219.00", title: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones", link: "https://www.google.com/search?ibp=oshop&q=sony", imageUrl: "https://example.com/ted.jpg", rating: 4.5, ratingCount: 12, delivery: "$6.99 delivery", productId: "4", position: 4 },
    { source: "Newegg.com - Other Shop", price: "$260.00", title: "Sony WH-1000XM5 Headphones", link: "https://www.newegg.com/p/1", imageUrl: "", rating: 4, ratingCount: 2, delivery: "", productId: "5", position: 5 },
    { source: "Best Buy", price: "$199.00", title: "Sony WH-1000XM4 Headphones", link: "https://www.bestbuy.com/site/sony-wh-1000xm4/1.p", imageUrl: "", rating: 4.8, ratingCount: 10, delivery: "", productId: "6", position: 6 },
    { source: "Walmart", price: "$49.99", title: "Sony WH-1000XM5 Replacement Ear Pads", link: "https://www.walmart.com/ip/pads/1", imageUrl: "", rating: 4, ratingCount: 3, delivery: "", productId: "7", position: 7 },
    { source: "eBay", price: "$180.00", title: "Sony WH-1000XM5 Refurbished", link: "https://www.ebay.com/itm/123", imageUrl: "", rating: 4, ratingCount: 5, delivery: "", productId: "8", position: 8 },
    { source: "Macy's", price: "$89.00", title: "Sony WH-1000XM5 Wireless Headphones", link: "https://www.macys.com/shop/product/sony-wh-1000xm5?ID=1", imageUrl: "", rating: 4, ratingCount: 1, delivery: "", productId: "9", position: 9 },
  ];
  const offers = offersFromShopping("Sony WH-1000XM5", shopping).offers;
  assert.deepEqual(offers.map((offer) => offer.store), ["Newegg.com", "Best Buy", "Target", "Lowe's"]);
  assert.deepEqual(offers.map((offer) => offer.price), [219, 229.99, 239.99, 249]);
  assert.equal(offers[0]?.seller, "Teds Electronics");
  assert.equal(offers[1]?.image, "https://example.com/xm5.jpg");
  assert.equal(offers[1]?.rating, 4.8);
  assert.equal(offers[1]?.delivery, "Free delivery");
  assert.match(offers[3]?.url ?? "", /google\.com\/search\?tbm=shop/);
  assert.equal(offers.some((offer) => offer.price === 89), false);
  assert.equal(offers.some((offer) => /XM4|Refurbished|Ear Pads/i.test(offer.title)), false);
});

test("AirPods shopping hides resale markets and prices from major stores", () => {
  const rows = [
    { source: "Mercari", price: "$99.00", title: "Apple AirPods Pro 2", link: "https://www.mercari.com/us/item/1" },
    { source: "mercari.com", price: "$66.00", title: "Apple AirPods Pro 2 USB-C", link: "https://www.mercari.com/us/item/2" },
    { source: "Mercari", price: "$80.00", title: "Apple AirPods Pro 2", link: "https://www.mercari.com/us/item/3" },
    { source: "Poshmark", price: "$111.00", title: "Apple AirPods Pro 2", link: "https://poshmark.com/listing/1" },
    { source: "Poshmark", price: "$50.00", title: "Apple AirPods Pro 2", link: "https://poshmark.com/listing/2" },
    { source: "Whatnot", price: "$50.00", title: "Apple AirPods Pro 2", link: "https://www.whatnot.com/listing/1" },
    { source: "eBay", price: "$64.82", title: "Apple AirPods Pro 2", link: "https://www.ebay.com/itm/1" },
    { source: "eBay", price: "$69.00", title: "Apple AirPods Pro 2", link: "https://www.ebay.com/itm/2" },
    { source: "Shop app", price: "$90.00", title: "Apple AirPods Pro 2", link: "https://shop.app/products/1" },
    { source: "OfferUp", price: "$70.00", title: "Apple AirPods Pro 2", link: "https://offerup.com/item/1" },
    { source: "Depop", price: "$72.00", title: "Apple AirPods Pro 2", link: "https://www.depop.com/products/1" },
    { source: "Swappa", price: "$180.00", title: "Apple AirPods Pro 2", link: "https://swappa.com/listing/1" },
    { source: "ReCell Exchange", price: "$75.00", title: "Apple AirPods Pro 2", link: "https://recellexchange.com/p/1" },
    { source: "Back Market", price: "$160.00", title: "Apple AirPods Pro 2", link: "https://www.backmarket.com/p/1" },
    { source: "Decluttr", price: "$155.00", title: "Apple AirPods Pro 2", link: "https://www.decluttr.com/p/1" },
    { source: "VXB.com Bearings", price: "$412.95", title: "Apple AirPods Pro 2", link: "https://vxb.com/bearings" },
    { source: "mhpanel.cl", price: "$200.00", title: "Apple AirPods Pro 2", link: "https://mhpanel.cl/p/1" },
    { source: "Target", price: "$249.00", title: "Apple AirPods Pro 2 with MagSafe Case USB-C", link: "https://www.target.com/p/apple-airpods-pro-2/-/A-85978612" },
    { source: "Best Buy", price: "$239.99", title: "Apple AirPods Pro (2nd Generation) USB-C", link: "https://www.bestbuy.com/site/apple-airpods-pro-2/6450860.p" },
    { source: "Amazon", price: "$229.00", title: "Apple AirPods Pro 2 USB-C", link: "https://www.amazon.com/dp/B0CHWRXH8B" },
    { source: "Walmart", price: "$549.00", title: "Apple AirPods Max", link: "https://www.walmart.com/ip/Apple-AirPods-Max/123456" },
  ];
  const split = offersFromShopping("Apple AirPods Pro 2", rows);
  assert.deepEqual(split.offers.map((offer) => offer.store), ["Amazon", "Best Buy", "Target"]);
  assert.equal(trustedReferencePrice(split.offers), 239.99);
  assert.equal(split.offers.some((offer) => offer.price === 50 || offer.price === 64.82), false);
  assert.equal(split.resale.find((offer) => /mercari/i.test(offer.store))?.price, 66);
  assert.ok(split.resale.some((offer) => /poshmark/i.test(offer.store) && offer.price === 50));
  assert.ok(split.resale.some((offer) => /whatnot/i.test(offer.store)));
  assert.ok(split.resale.some((offer) => /ebay/i.test(offer.store) && offer.price === 64.82));
  assert.ok(["OfferUp", "Depop", "Swappa", "ReCell Exchange", "Back Market", "Decluttr", "Shop app"].every((store) => split.resale.some((offer) => offer.store === store)));
  assert.equal([...split.offers, ...split.resale].some((offer) => /bearings|mhpanel|AirPods Max/i.test(`${offer.store} ${offer.title}`)), false);
});

test("Ninja AF101 shopping keeps major stores ahead of resale", () => {
  const rows = [
    { source: "Mercari", price: "$66.00", title: "Ninja AF101 Air Fryer", link: "https://www.mercari.com/us/item/n1" },
    { source: "Poshmark", price: "$50.00", title: "Ninja AF101", link: "https://poshmark.com/listing/n1" },
    { source: "Whatnot", price: "$50.00", title: "Ninja AF101 Air Fryer", link: "https://www.whatnot.com/listing/n1" },
    { source: "eBay", price: "$69.00", title: "Ninja AF101", link: "https://www.ebay.com/itm/9" },
    { source: "Walmart", price: "$99.99", title: "Ninja AF101 Air Fryer", link: "https://www.walmart.com/ip/Ninja-AF101/1" },
    { source: "Target", price: "$94.99", title: "Ninja AF101 Air Fryer", link: "https://www.target.com/p/ninja-af101/-/A-1" },
    { source: "Best Buy", price: "$89.99", title: "Ninja AF101 Air Fryer", link: "https://www.bestbuy.com/site/ninja-af101/1.p" },
    { source: "VXB.com Bearings", price: "$412.95", title: "Ninja AF101", link: "https://vxb.com/x" },
    { source: "mhpanel.cl", price: "$80.00", title: "Ninja AF101", link: "https://mhpanel.cl/n" },
  ];
  const split = offersFromShopping("Ninja AF101", rows);
  assert.deepEqual(split.offers.map((offer) => `${offer.store}:${offer.price}`), ["Best Buy:89.99", "Target:94.99", "Walmart:99.99"]);
  assert.equal(split.offers.every((offer) => offer.kind === "trusted"), true);
  assert.equal(trustedReferencePrice(split.offers), 94.99);
  assert.ok(split.resale.some((offer) => /mercari/i.test(offer.store) && offer.price === 66));
  assert.equal(split.offers.some((offer) => offer.price === 50 || offer.price === 69), false);
});

test("a retailer URL keeps that store and ignores a cheap resale price", () => {
  const url = "https://www.target.com/p/apple-airpods-pro-2nd-generation/-/A-85978612";
  assert.equal(retailerFromUrl(url), "Target");
  const missing = [{ source: "Whatnot", price: "$50.00", title: "Apple AirPods Pro 2", link: "https://www.whatnot.com/listing/1" }];
  assert.equal(shoppingIncludesRetailer(missing, "Target"), false);
  assert.equal(retailerShoppingQuery("Apple AirPods Pro 2", "Target"), "Apple AirPods Pro 2 Target");
  const rows = missing.concat([{ source: "Target", price: "$249.00", title: "Apple AirPods Pro 2 USB-C", link: url }]);
  assert.equal(shoppingIncludesRetailer(rows, "Target"), true);
  const split = offersFromShopping("Apple AirPods Pro 2", rows);
  assert.equal(split.offers.some((offer) => offer.store === "Target" && offer.price === 249), true);
  assert.equal(trustedReferencePrice(split.offers), 249);
  assert.equal(split.offers.some((offer) => offer.price === 50), false);
  assert.equal(split.resale.some((offer) => /whatnot/i.test(offer.store)), true);
});

test("eBay is shown for a new title, or when it is the only store", () => {
  const named = offersFromShopping("Apple AirPods Pro 2", [
    { source: "Best Buy", price: "$249.00", title: "Apple AirPods Pro 2", link: "https://www.bestbuy.com/site/apple-airpods-pro-2/1.p" },
    { source: "eBay", price: "$199.00", title: "Brand New Apple AirPods Pro 2", link: "https://www.ebay.com/itm/3" },
    { source: "eBay", price: "$64.82", title: "Apple AirPods Pro 2", link: "https://www.ebay.com/itm/4" },
  ]);
  assert.equal(named.offers.some((offer) => /ebay/i.test(offer.store) && offer.price === 199), true);
  assert.equal(named.offers.some((offer) => offer.price === 64.82), false);
  assert.equal(named.resale.some((offer) => offer.price === 64.82), true);
  const only = offersFromShopping("Apple AirPods Pro 2", [
    { source: "eBay", price: "$189.00", title: "Apple AirPods Pro 2", link: "https://www.ebay.com/itm/5" },
  ]);
  assert.equal(only.offers.length, 1);
  assert.equal(only.offers[0]?.price, 189);
  assert.equal(trustedReferencePrice(only.offers), null);
});

test("unknown stores are labeled other seller and checked against major-store prices", () => {
  const split = offersFromShopping("Sony WH-1000XM5", [
    { source: "Best Buy", price: "$229.99", title: "Sony WH-1000XM5 Wireless Headphones", link: "https://www.bestbuy.com/site/sony-wh-1000xm5/6505727.p" },
    { source: "Target", price: "$239.99", title: "Sony WH-1000XM5 Headphones", link: "https://www.target.com/p/sony-wh-1000xm5/-/A-1" },
    { source: "Entrepreneur", price: "$184.99", title: "Sony WH-1000XM5 Wireless Headphones", link: "https://entrepreneur.com/p/sony-wh-1000xm5" },
    { source: "Whatnot", price: "$50.00", title: "Sony WH-1000XM5 Headphones", link: "https://www.whatnot.com/listing/s" },
    { source: "amazon.co.uk", price: "$210.00", title: "Sony WH-1000XM5 Wireless Headphones", link: "https://www.amazon.co.uk/dp/B0B1234567" },
  ]);
  assert.deepEqual(split.offers.map((offer) => offer.store), ["Best Buy", "Target", "Entrepreneur"]);
  assert.equal(split.offers.at(-1)?.kind, "other");
  assert.equal(trustedReferencePrice(split.offers), 234.99);
  assert.equal(split.offers.some((offer) => offer.price === 50 || /co\.uk/i.test(offer.store)), false);
});

test("grounded retailer offers drop search pages, fragments, and stray low prices", () => {
  assert.equal(isProductPage("https://www.amazon.com/s?k=airpods"), false);
  assert.equal(isProductPage("https://www.amazon.com/dp/B0CHWRXH8B"), true);
  assert.equal(fragmentTitle("Sony Wh-1000xm5 Weight"), true);
  assert.equal(fragmentTitle("Amazon.com : sony wh-1000xm5"), true);
  assert.equal(titleCaseProduct("apple airpods pro 2"), "Apple AirPods Pro 2");
  assert.equal(titleCaseProduct("sony wh-1000xm5"), "Sony WH-1000XM5");
  const amazon = "https://www.amazon.com/dp/B0CHWRXH8B";
  const walmart = "https://www.walmart.com/ip/Apple-AirPods-Pro-2/123456";
  const target = "https://www.target.com/p/apple-airpods-pro-2/-/A-85978612";
  const search = "https://www.amazon.com/s?k=sony+wh-1000xm5";
  const offers = filterGroundedOffers("Apple AirPods Pro 2", [
    { title: "Apple AirPods Pro 2 USB-C", price: 249, url: amazon },
    { title: "Apple AirPods Pro 2", price: 239, url: walmart },
    { title: "Apple AirPods Pro 2 USB-C", price: 89, url: target },
    { title: "Amazon.com : sony wh-1000xm5", price: 378, url: search },
    { title: "Sony WH-1000XM5 Weight", price: 199.99, url: "https://www.walmart.com/ip/Sony-Wh-1000xm5-Weight/999" },
  ], [amazon, walmart, target, search]);
  assert.deepEqual(offers.map((offer) => `${offer.store}:${offer.price}`), ["Walmart:239", "Amazon:249"]);
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
