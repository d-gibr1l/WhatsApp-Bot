import { cachedGetSetting } from "../cache.js";

export function bindCallEvents(sock) {
  sock.ev.on("call", async (calls) => {
    try {
      const rejectCalls = cachedGetSetting("reject_calls", "false");
      if (rejectCalls !== "true") return;
      for (const call of calls) {
        if (call.status === "offer") {
          await sock.rejectCall(call.id, call.from);
          console.log(`📵 Rejected call from ${call.from}`);
        }
      }
    } catch (err) {
      console.error("Call reject error:", err.message);
    }
  });
}
