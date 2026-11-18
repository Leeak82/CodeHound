import { matchPrices } from "../dist/price.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error("Usage: npm run price:smoke -- \"Apple AirPods Pro 2\"");
  process.exit(1);
}

const result = await matchPrices(query, AbortSignal.timeout(40_000));
console.log(JSON.stringify({
  name: result.product.name,
  price: result.product.price,
  store: result.product.store,
  source: result.product.source,
  offers: result.offers.map((offer) => ({
    store: offer.store,
    price: offer.price,
    title: offer.title,
    url: offer.url,
    source: offer.source,
  })),
}, null, 2));
