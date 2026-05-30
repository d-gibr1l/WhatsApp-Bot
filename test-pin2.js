import ruhend from 'ruhend-scraper-vip';

async function test() {
  try {
    const results = await ruhend.pinterest('superman');
    console.log(results.slice(0, 5));
  } catch (err) {
    console.error(err);
  }
}
test();
