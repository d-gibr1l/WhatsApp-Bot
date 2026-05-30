const scraper = require('@myno_21/pinterest-scraper');

async function test() {
  try {
    const results = await scraper.searchPins('superman');
    console.log(results.slice(0, 5));
  } catch (err) {
    console.error(err);
  }
}
test();
