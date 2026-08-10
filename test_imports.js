(async () => {
  try {
    console.log("Loading pino...");
    await import("pino");
    console.log("Loading lru-cache...");
    await import("lru-cache");
    console.log("Loading config...");
    await import("./src/config.js");
    console.log("Loading redisSession...");
    await import("./src/auth/redisSession.js");
    console.log("Loading badMacInterceptor...");
    await import("./src/auth/badMacInterceptor.js");
    console.log("Loading handler...");
    await import("./src/handler.js");
    console.log("Loading wordfilter...");
    await import("./src/commands/wordfilter.js");
    console.log("Loading antilink...");
    await import("./src/commands/antilink.js");
    console.log("Loading aliases...");
    await import("./src/commands/aliases.js");
    console.log("Loading antidelete...");
    await import("./src/commands/antidelete.js");
    console.log("Loading messages...");
    await import("./src/events/messages.js");
    console.log("Loading groups...");
    await import("./src/events/groups.js");
    console.log("Loading calls...");
    await import("./src/events/calls.js");
    console.log("Loading cache...");
    await import("./src/cache.js");
    console.log("Loading server...");
    await import("./src/server.js");
    console.log("Loading downloader...");
    await import("./src/downloader.js");
    console.log("All loaded!");
  } catch(e) {
    console.error("Crash:", e);
  }
})();
