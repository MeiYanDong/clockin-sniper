import assert from "node:assert/strict";
import test from "node:test";

import { OfficialCaMonitor, extractOfficialCa, type Hex } from "../src/index.js";

const TOKEN = `0x${"11".repeat(20)}` as Hex;
const OTHER = `0x${"22".repeat(20)}` as Hex;

test("extracts only the configured official contractAddress field", () => {
  assert.equal(extractOfficialCa(TOKEN), TOKEN);
  assert.equal(extractOfficialCa(`{"treasury":"${OTHER}","contractAddress":"${TOKEN}"}`), TOKEN);
  assert.equal(extractOfficialCa('{"contractAddress":"TBA — dropping at launch"}'), null);
});

test("keeps official announcement polling off the hot path and confirms the frozen CA", async () => {
  let call = 0;
  const fetchFn: typeof fetch = async () => {
    call += 1;
    return new Response(
      call === 1
        ? '{"contractAddress":"TBA — dropping at launch"}'
        : `{"contractAddress":"${TOKEN}"}`,
      { status: 200 },
    );
  };
  const monitor = new OfficialCaMonitor({
    expectedToken: TOKEN,
    url: "https://clockin.example/",
    pollMs: 1_000,
    fetchFn,
  });
  assert.equal((await monitor.pollOnce()).state, "pending");
  const confirmed = await monitor.pollOnce();
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.observedAddress, TOKEN);
  assert.equal(confirmed.source, "url");
});

test("makes a contradictory official CA terminal instead of overwriting Factory identity", async () => {
  const monitor = new OfficialCaMonitor({
    expectedToken: TOKEN,
    initialAddress: OTHER,
  });
  const snapshot = await monitor.pollOnce();
  assert.equal(snapshot.state, "mismatch");
  assert.equal(snapshot.expectedToken, TOKEN);
  assert.equal(snapshot.observedAddress, OTHER);
});
