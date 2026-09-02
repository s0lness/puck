// buttonWiring.ts: the one place that decides, from a device.json's own
// "buttons" array, which declared index feeds which signal. Pulled out of
// wasm/build.ts's generateDeviceHeader() so gate/device-agrees.ts can assert
// the same thing that function bakes into the compiled module, without
// spawning zig: this pack's gate is fast and hardware-free by convention
// (docs/convention/device-pack.md, AGENTS.md's "Pack-specific gates"), and a
// full compile is neither.
//
// THE BUG THIS CLOSES: a device.json may declare any number of "click" and
// "key" buttons (docs/convention/device-pack.md's silhouette section - a
// Watchy declares four clicks and no key at all), but wasm/build.ts used to
// pick the FIRST click-role button and the FIRST key-role button and stop
// there, silently. Every other declared button still got a ghost button on
// the page (host/host.ts draws one per declared control and always has) and
// still called emu_button(index, ...) on every press - the wasm module just
// never listened at that index, so the press did nothing and nothing said
// so. bun run verdict already reasons about substitution correctly (a click
// standing in for a missing key, tools/verdict.ts's buttonCheck): this
// module is what makes the compiled module actually deliver on that promise
// instead of only printing it.
//
// app.h's app_frame_t (vendored byte-for-byte from the RP2350 sibling, see
// runtime/app.h's own note) carries exactly one merged click signal
// (bootClicked) and one merged key signal (key), and that is not something
// this pack gets to change out from under every existing port. So this
// module still names ONE primary click and ONE primary key - those are
// BTN_BOOT/BTN_PWR, and every existing app.h-reading port keeps compiling
// and behaving exactly as before. What is new is that every OTHER declared
// click/key button is also named (clickIndices/keyIndices, in full), so
// wasm/emu_shim.c can track it instead of dropping it, and a key demand
// with no key-role button gets a real substitute - a SPARE click-role
// button, not silence.

export interface WiringButton {
  role?: string;
}

export interface ButtonWiring {
  /** Index of every declared role:"click" button, in device.json order. */
  clickIndices: number[];
  /** Index of every declared role:"key" button, in device.json order. */
  keyIndices: number[];
  /** BTN_BOOT: the primary click index, or -1 when the device declares none. */
  primaryClick: number;
  /**
   * BTN_PWR: the primary key index. An exact role:"key" button when the
   * device declares one; otherwise a SPARE click-role button (any declared
   * click other than primaryClick) standing in for it, the same
   * substitution tools/verdict.ts's buttonCheck already reasons about; -1
   * when neither exists.
   */
  primaryKey: number;
  /** Every index that is wired to something: clickIndices union keyIndices, sorted. */
  wiredIndices: number[];
}

export function computeButtonWiring(buttons: WiringButton[]): ButtonWiring {
  const clickIndices: number[] = [];
  const keyIndices: number[] = [];
  buttons.forEach((b, i) => {
    if (b.role === "click") clickIndices.push(i);
    else if (b.role === "key") keyIndices.push(i);
  });

  const primaryClick = clickIndices.length > 0 ? clickIndices[0]! : -1;
  const exactKey = keyIndices.length > 0 ? keyIndices[0]! : -1;
  const spareClick = clickIndices.find((i) => i !== primaryClick);
  const primaryKey = exactKey >= 0 ? exactKey : spareClick !== undefined ? spareClick : -1;

  const wiredIndices = [...new Set([...clickIndices, ...keyIndices])].sort((a, b) => a - b);

  return { clickIndices, keyIndices, primaryClick, primaryKey, wiredIndices };
}
