import googlethis from "googlethis";

async function testGifs() {
  try {
    const images = await googlethis.image("michael jackson", { 
      safe: false, 
      additional_params: {
        tbs: "itp:animated" // Filter for animated gifs
      }
    });
    
    const gifs = images
      .map(img => img.url)
      .filter(url => url && url.startsWith("http") && url.endsWith(".gif"));
      
    console.log("GIFs:", gifs.slice(0, 5));
  } catch (err) {
    console.error(err);
  }
}

testGifs();
