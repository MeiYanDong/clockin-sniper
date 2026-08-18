import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareOfficialSiteObservations,
  observeOfficialSite,
} from "../src/control/official-site-monitor.js";

describe("official website semantic monitor", () => {
  it("keeps framework-only byte changes below the action boundary", () => {
    const previous = observeOfficialSite(`
      <html><body><h1>ClockIn</h1><p>Stonk Launcher Coming Soon</p>
      <script src="/_next/chunk-a.js">window.buildId="one"</script></body></html>
    `);
    const current = observeOfficialSite(`
      <html><body><h1>ClockIn</h1><p>Stonk Launcher Coming Soon</p>
      <script src="/_next/chunk-b.js">window.buildId="two"</script></body></html>
    `);
    const change = compareOfficialSiteObservations(previous, current);
    assert.equal(change.rawChanged, true);
    assert.equal(change.semanticChanged, false);
    assert.equal(change.statusChanged, false);
    assert.equal(change.addressSetChanged, false);
    assert.equal(current.launchStatus, "COMING_SOON");
  });

  it("raises a semantic change when an official page opens the launch", () => {
    const previous = observeOfficialSite("<main>Clock In - Coming Soon</main>");
    const current = observeOfficialSite("<main>Clock In - Launch Now</main>");
    const change = compareOfficialSiteObservations(previous, current);
    assert.equal(previous.launchStatus, "COMING_SOON");
    assert.equal(current.launchStatus, "OPEN");
    assert.equal(change.semanticChanged, true);
    assert.equal(change.statusChanged, true);
    assert.equal(change.addressSetChanged, false);
  });

  it("does not confuse live partner projects with the launcher status", () => {
    const observation = observeOfficialSite(
      `
        <main>
          <h1>Stonk Launcher Coming Soon</h1>
          <p>Signal scrambled. DEX integration underway.</p>
          <section>Special Projects Live now</section>
          <a>Safe Launch live now</a>
          <button>Buy DERP</button><button>Buy MANCER</button>
        </main>
      `,
      { scope: "LAUNCHER" },
    );
    assert.equal(observation.launchStatus, "COMING_SOON");
    assert.deepEqual(observation.statusMarkers, [
      "COMING_SOON",
      "SIGNAL_SCRAMBLED",
      "SAFE_LAUNCH_OPEN",
    ]);
  });

  it("extracts visible and labelled candidate addresses without trusting arbitrary bundle data", () => {
    const visibleAddress = "0x3333333333333333333333333333333333333333";
    const labelledAddress = "0x2222222222222222222222222222222222222222";
    const arbitraryBundleAddress = "0x1111111111111111111111111111111111111111";
    const observation = observeOfficialSite(`
      <main>ClockIn on Robinhood Chain CA: ${visibleAddress}</main>
      <script>
        window.noise = "${arbitraryBundleAddress}";
        window.config = { tokenAddress: "${labelledAddress}", chainId: 4663 };
      </script>
    `);
    assert.deepEqual(observation.candidateAddresses, [labelledAddress, visibleAddress]);
    assert.equal(observation.clockInMentioned, true);
    assert.equal(observation.robinhoodChainMentioned, true);
    assert.equal(observation.candidateAddresses.includes(arbitraryBundleAddress), false);
  });

  it("reports exact candidate additions and removals", () => {
    const removed = "0x1111111111111111111111111111111111111111";
    const retained = "0x2222222222222222222222222222222222222222";
    const added = "0x3333333333333333333333333333333333333333";
    const previous = observeOfficialSite(`<main>CA ${removed} Token ${retained}</main>`);
    const current = observeOfficialSite(`<main>Token ${retained} Pool ${added}</main>`);
    const change = compareOfficialSiteObservations(previous, current);
    assert.equal(change.addressSetChanged, true);
    assert.deepEqual(change.addedAddresses, [added]);
    assert.deepEqual(change.removedAddresses, [removed]);
  });

  it("accepts only a mainnet Launcher Factory from official docs", () => {
    const mainnet = "0x4444444444444444444444444444444444444444";
    const testnet = "0x5555555555555555555555555555555555555555";
    const observation = observeOfficialSite(
      `<main>
        <h2>Contract Addresses</h2>
        <p>Live mainnet deployment addresses on Robinhood Chain.</p>
        <p>Launcher Factory | ${mainnet}</p>
        <h3>Testnet Archive (Hackathon Demo)</h3>
        <p>Do not use on mainnet. Launcher Factory (testnet) | ${testnet}</p>
      </main>`,
      { scope: "LAUNCHER_DOCS" },
    );
    assert.deepEqual(observation.candidateAddresses, [mainnet]);
  });

  it("does not promote the archived testnet Factory when mainnet is unpublished", () => {
    const testnet = "0x5555555555555555555555555555555555555555";
    const observation = observeOfficialSite(
      `<main>
        <h2>Contract Addresses</h2>
        <p>Live mainnet deployment addresses on Robinhood Chain.</p>
        <h3>Upcoming protocol modules</h3>
        <h3>Testnet Archive (Hackathon Demo)</h3>
        <p>Do not use on mainnet. Launcher Factory (testnet) | ${testnet}</p>
      </main>`,
      { scope: "LAUNCHER_DOCS" },
    );
    assert.deepEqual(observation.candidateAddresses, []);
  });
});
