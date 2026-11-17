import assert from "node:assert/strict";
import { type PageView, type PageAim } from "../packages/protocol/src/index.ts";

export function fixtureAim(page: PageView | undefined, ref: number): Extract<PageAim, { kind: "element" }> {
  assert.ok(page, "fixture needs a captured page");
  const target = page.targets.find(target => target.ref === ref);
  assert.ok(target, `fixture ref ${ref} missing from page`);
  return { kind: "element", snapshotId: page.snapshotId, origin: page.origin, target };
}

export const PASSWORD_VALUE_GUARD = `(() => {
  const key = Symbol.for('bots.fixture.password-value');
  if (globalThis[key]) return;
  globalThis[key] = { normal: 0 };
  const get = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get;
  Object.defineProperty(HTMLInputElement.prototype, 'value', { get() {
    if (this.type === 'password') throw new Error('password read');
    globalThis[key].normal++;
    return get.call(this);
  } });
})()`;
export const NORMAL_VALUE_READS = `globalThis[Symbol.for('bots.fixture.password-value')]?.normal ?? 0`;
