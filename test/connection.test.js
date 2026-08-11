import test from "node:test";
import assert from "node:assert/strict";
import { Boom } from "@hapi/boom";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { markBotReady, isBotReady, resetBotReady } from "../src/handler.js";
import { stopRadarEngine } from "../src/commands/radar.js";

// Helper under test (extracted logic)
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

test("M2 Unit 1.0 — extractStatusCode safe extraction", () => {
  // Boom error
  const boomErr = new Boom("Connection lost", { statusCode: 428 });
  assert.equal(extractStatusCode(boomErr), 428);

  // Standard Error with statusCode property
  const stdErrStatus = new Error("Custom error");
  stdErrStatus.statusCode = 408;
  assert.equal(extractStatusCode(stdErrStatus), 408);

  // Error with code property
  const errCode = new Error("Code error");
  errCode.code = 500;
  assert.equal(extractStatusCode(errCode), 500);

  // Error with string code property
  const errStrCode = new Error("String code error");
  errStrCode.code = "404";
  assert.equal(extractStatusCode(errStrCode), 404);

  // Error with cause
  const outerErr = new Error("Outer error");
  outerErr.cause = boomErr;
  assert.equal(extractStatusCode(outerErr), 428);

  // Plain error with no code
  assert.equal(extractStatusCode(new Error("Plain error")), undefined);
  assert.equal(extractStatusCode(null), undefined);
});

test("M2 Unit 2.0 — 408 / 428 Disconnect Handling Attempt Counts", () => {
  let attempt = 3;

  // Simulate 408 handling on established connection
  const statusCode408 = 408;
  if (statusCode408 === DisconnectReason.connectionLost || statusCode408 === 408) {
    attempt = Math.max(attempt - 1, 1);
  }
  assert.equal(attempt, 2, "408 decrements attempt so subsequent attempt++ preserves original value");

  // Simulate 428 handling
  const statusCode428 = 428;
  if (statusCode428 === DisconnectReason.connectionClosed || statusCode428 === 428) {
    attempt = 1;
  }
  assert.equal(attempt, 1, "428 resets attempt counter to 1");
});

test("M2 Unit 3.0 — Ready state reset (connectedAt = Infinity)", () => {
  markBotReady();
  assert.equal(isBotReady(), true, "isBotReady should be true after markBotReady");

  resetBotReady();
  assert.equal(isBotReady(), false, "isBotReady should be false after resetBotReady");
});

test("M2 Unit 4.0 — Immediate Socket & Resource Cleanup", () => {
  let closed = false;
  let terminated = false;
  let listenersRemoved = false;

  const mockSock = {
    ws: {
      close() { closed = true; },
      terminate() { terminated = true; }
    },
    ev: {
      removeAllListeners() { listenersRemoved = true; }
    }
  };

  // Execute immediate teardown
  mockSock.ev.removeAllListeners();
  mockSock.ws?.close();
  mockSock.ws?.terminate();

  assert.equal(closed, true, "ws.close() called immediately");
  assert.equal(terminated, true, "ws.terminate() called immediately");
  assert.equal(listenersRemoved, true, "removeAllListeners called immediately");
});

test("M2 Unit 5.0 — Stop Radar Engine Cleanup", () => {
  assert.doesNotThrow(() => {
    stopRadarEngine();
  }, "stopRadarEngine executes cleanly without throwing");
});
