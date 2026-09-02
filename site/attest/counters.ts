// site/attest/counters.ts: the gallery's own entrypoint for the attestation
// counters. Bundled by site/build.ts into site/dist/attest-counters.js.
//
// A second, tiny bundle rather than loading the flash page's attest.js on
// the landing page: that one pulls in the devlink protocol, the Web Serial
// transport, the shared replay and the shared pixel comparison, because it
// drives a board. The landing page reads four integers. Shipping the first
// to do the second would be several tens of kilobytes of serial protocol on
// a page with no board anywhere near it.
//
// The empty state is already in the HTML (site/build.ts renders
// ATTEST_EMPTY_STATE into every counter node), so this script only ever
// replaces text that already said something true.

import { paintAttestCounters } from "../attest-client";

void paintAttestCounters();
