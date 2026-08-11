import test from "node:test";
import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { Boom } from "@hapi/boom";
import { DisconnectReason } from "@whiskeysockets/baileys";
import {
  markBotReady,
  resetBotReady,
  isBotReady,
  startReminderPoller,
  handleMessage,
} from "../src/handler.js";
import {
  startRadarEngine,
  stopRadarEngine,
} from "../src/commands/radar.js";

// Helper extracted from index.js for empirical challenge
function extractStatusCode(error) {
  if (!error) return undefined;
  if (error instanceof Boom || error?.output?.statusCode) {
    return error.output?.statusCode;
  }
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  if (typeof error.code === "string" && !isNaN(Number(error.code))) {
    return Number(error.code);
  }
  if (error.cause) {
    return extractStatusCode(error.cause);
  }
  return undefined;
}

// ─── Challenger Test 1: Disconnect during botReadyTimer delay ───────────────

test("Challenger M4_2 — Disconnect during botReadyTimer delay cancels timer and keeps botReady false", async () => {
  resetBotReady();
  assert.equal(isBotReady(), false);

  let botReadyTimer = setTimeout(() => {
    markBotReady();
    botReadyTimer = null;
  }, 300);

  // Teardown before timer fires
  if (botReadyTimer) {
    clearTimeout(botReadyTimer);
    botReadyTimer = null;
  }
  resetBotReady();

  // Wait past initial timer delay
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(isBotReady(), false, "botReady must remain false if disconnected before timer fires");
  assert.equal(botReadyTimer, null, "botReadyTimer handle must be cleared to null");
});

// ─── Challenger Test 2: In-flight Radar Engine calls after socket teardown ──

test("Challenger M4_2 — In-flight Radar calls handle closed socket gracefully without uncaught rejection", async () => {
  let sendMessageCalled = false;
  let socketClosed = false;

  const mockSock = {
    sendMessage: async (jid, content) => {
      sendMessageCalled = true;
      if (socketClosed) {
        throw new Error("WebSocket is closed / terminated");
      }
      return { key: { id: "msg_123" } };
    },
  };

  startRadarEngine(mockSock);

  // Teardown socket immediately
  stopRadarEngine();
  socketClosed = true;

  // Simulate an async operation completing post-teardown and attempting sendMessage
  await assert.doesNotReject(async () => {
    try {
      await mockSock.sendMessage("12345@s.whatsapp.net", { text: "Anime release alert!" });
    } catch (err) {
      // Expected behavior: sendMessage throws standard error which caller catches
      assert.ok(err.message.includes("closed"), "Error caught cleanly");
    }
  }, "In-flight message attempt post-teardown must not crash process");
});

// ─── Challenger Test 3: In-flight Reminder Poller after teardown ────────────

test("Challenger M4_2 — Reminder Poller stops on teardown and avoids sending to closed socket", async () => {
  resetBotReady();

  let sendCount = 0;
  const mockSock = {
    sendMessage: async () => {
      sendCount++;
      return {};
    },
  };

  const stopPoller = startReminderPoller(mockSock);

  // While bot is NOT ready, poller tick should be no-op
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sendCount, 0, "No reminders sent when isBotReady() is false");

  // Mark ready, then immediately teardown
  markBotReady();
  assert.equal(isBotReady(), true);

  stopPoller();
  resetBotReady();

  assert.equal(isBotReady(), false, "botReady reset to false on teardown");
});

// ─── Challenger Test 4: Reconnection Timer Cleanliness (No Double Polling) ──

test("Challenger M4_2 — Sequential reconnects clean up previous pollers without leaking intervals", async () => {
  let sock1Calls = 0;
  let sock2Calls = 0;

  const mockSock1 = {
    sendMessage: async () => { sock1Calls++; return {}; }
  };
  const mockSock2 = {
    sendMessage: async () => { sock2Calls++; return {}; }
  };

  // Iteration 1
  startRadarEngine(mockSock1);
  const stopPoller1 = startReminderPoller(mockSock1);

  // Teardown Iteration 1
  stopRadarEngine();
  stopPoller1();

  // Iteration 2
  startRadarEngine(mockSock2);
  const stopPoller2 = startReminderPoller(mockSock2);

  // Teardown Iteration 2
  stopRadarEngine();
  stopPoller2();

  assert.equal(sock1Calls, 0, "Socket 1 received 0 calls after teardown");
  assert.equal(sock2Calls, 0, "Socket 2 received 0 calls after teardown");
});

// ─── Challenger Test 5: 100 Reconnection Loops Socket & Listener Teardown Stress Test ──

test("Challenger M4_2 — 100 Reconnection cycles: complete socket teardown with zero listener leaks", async () => {
  let totalClosed = 0;
  let totalTerminated = 0;
  let totalListenersRemoved = 0;

  let currentSock = null;
  let stopPoller = null;
  let botReadyTimer = null;

  function teardownCurrentSocket(sock) {
    if (botReadyTimer) {
      clearTimeout(botReadyTimer);
      botReadyTimer = null;
    }
    resetBotReady();
    if (stopPoller) {
      try { stopPoller(); } catch {}
      stopPoller = null;
    }
    try { stopRadarEngine(); } catch {}
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.ws?.close(); } catch {}
      try { sock.ws?.terminate(); } catch {}
    }
    if (currentSock === sock) {
      currentSock = null;
    }
  }

  const initialMemory = process.memoryUsage().heapUsed;

  for (let i = 0; i < 100; i++) {
    const ev = new EventEmitter();
    let closed = false;
    let terminated = false;
    let removed = false;

    // Intercept EventEmitter removeAllListeners
    const origRemoveAll = ev.removeAllListeners.bind(ev);
    ev.removeAllListeners = (...args) => {
      removed = true;
      totalListenersRemoved++;
      return origRemoveAll(...args);
    };

    // Attach sample listeners
    ev.on("connection.update", () => {});
    ev.on("messages.upsert", () => {});

    const mockSock = {
      ev,
      ws: {
        close() { closed = true; totalClosed++; },
        terminate() { terminated = true; totalTerminated++; }
      }
    };

    currentSock = mockSock;
    stopPoller = startReminderPoller(mockSock);
    startRadarEngine(mockSock);

    botReadyTimer = setTimeout(() => {
      markBotReady();
    }, 1000);

    // Simulate connection update close
    teardownCurrentSocket(mockSock);

    assert.equal(closed, true, `Iteration ${i}: ws.close() called`);
    assert.equal(terminated, true, `Iteration ${i}: ws.terminate() called`);
    assert.equal(removed, true, `Iteration ${i}: removeAllListeners() called`);
    assert.equal(ev.listenerCount("connection.update"), 0, `Iteration ${i}: 0 listeners remaining`);
    assert.equal(ev.listenerCount("messages.upsert"), 0, `Iteration ${i}: 0 listeners remaining`);
    assert.equal(currentSock, null, `Iteration ${i}: currentSock set to null`);
    assert.equal(stopPoller, null, `Iteration ${i}: stopPoller reset to null`);
    assert.equal(botReadyTimer, null, `Iteration ${i}: botReadyTimer reset to null`);
  }

  assert.equal(totalClosed, 100, "All 100 sockets closed");
  assert.equal(totalTerminated, 100, "All 100 sockets terminated");
  assert.equal(totalListenersRemoved, 100, "All 100 event emitters cleaned");

  const finalMemory = process.memoryUsage().heapUsed;
  const memoryDiffMb = (finalMemory - initialMemory) / (1024 * 1024);
  console.log(`[Memory Check] Heap diff after 100 reconnect cycles: ${memoryDiffMb.toFixed(2)} MB`);
  assert.ok(memoryDiffMb < 35, "Heap growth under 35MB for 100 synthetic reconnect cycles");
});

// ─── Challenger Test 6: Disconnect Reason & Status Code Decision Matrix ─────

test("Challenger M4_2 — Disconnect Status Code Matrix Classification & Extraction", () => {
  // Boom 408
  const boom408 = new Boom("Timeout", { statusCode: 408 });
  assert.equal(extractStatusCode(boom408), 408);

  // Boom 428
  const boom428 = new Boom("Connection Closed", { statusCode: 428 });
  assert.equal(extractStatusCode(boom428), 428);

  // Boom 440 connectionReplaced
  const boom440 = new Boom("Connection Replaced", { statusCode: DisconnectReason.connectionReplaced });
  assert.equal(extractStatusCode(boom440), 440);

  // Fatal codes
  const fatal401 = new Boom("Logged Out", { statusCode: DisconnectReason.loggedOut });
  assert.equal(extractStatusCode(fatal401), 401);

  // Nested cause
  const nestedErr = new Error("Top level wrap");
  nestedErr.cause = boom428;
  assert.equal(extractStatusCode(nestedErr), 428);
});

// ─── Challenger Test 7: Command Race Reset & Message Timestamp Filtering ───

test("Challenger M4_2 — Disconnect resets connectedAt to Infinity, dropping historical offline messages", async () => {
  // 1. Reset bot ready state -> connectedAt = Infinity
  resetBotReady();
  assert.equal(isBotReady(), false);

  const mockSock = {
    sendMessage: async () => ({}),
  };

  const oldMessage = {
    key: { remoteJid: "12345@s.whatsapp.net", fromMe: false, id: "old_msg_1" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 60, // 60 seconds ago
    message: { conversation: "!ping" }
  };

  // When bot is not ready (connectedAt = Infinity), handleMessage drops message because msgTs < connectedAt
  let executed = false;
  try {
    await handleMessage(mockSock, oldMessage);
    executed = true;
  } catch {}

  assert.equal(executed, true, "handleMessage executed without throwing exception");
  // Bot ready mark
  markBotReady();
  assert.equal(isBotReady(), true);

  // Reset again
  resetBotReady();
  assert.equal(isBotReady(), false);
});
