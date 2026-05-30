import { GOOGLE_IMG_SCRAP } from "google-img-scrap";

async function test() {
  try {
    const res = await GOOGLE_IMG_SCRAP({
      search: "superman",
      domains: ["pinterest.com"],
      limit: 10
    });
    console.log(res.result.map(r => r.url).slice(0, 5));
  } catch (err) {
    console.error(err);
  }
}
test();
