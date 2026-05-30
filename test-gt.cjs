const googlethis = require('googlethis');

async function test() {
  try {
    const images = await googlethis.image('superman site:pinterest.com');
    const urls = images.map(i => i.url);
    console.log(urls.slice(0, 5));
  } catch (err) {
    console.error(err);
  }
}
test();
