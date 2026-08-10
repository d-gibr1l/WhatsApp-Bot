(async () => {
  try {
    console.log("Loading registry...");
    await import("./src/commands/registry.js");
    console.log("Loading helpers...");
    await import("./src/commands/helpers.js");
    console.log("Loading ai...");
    await import("./src/commands/ai.js");
    console.log("Loading sticker...");
    await import("./src/commands/sticker.js");
    console.log("All loaded!");
  } catch(e) {
    console.error("Crash:", e);
  }
})();
