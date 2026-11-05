import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { holderText, SLOTS, streamPort } from "./desktops.ts";

const DESKTOP_DIR = new URL("../desktop/", import.meta.url);
const read = (name: string) => readFile(new URL(name, DESKTOP_DIR), "utf8");
const execStart = (unit: string) => /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "";

describe("the files a desktop runs from", () => {
  it("keeps the sandbox on in every file", async () => {
    for (const name of await readdir(fileURLToPath(DESKTOP_DIR))) {
      expect(await read(name)).not.toContain("--no-sandbox");
    }
  });

  it("keeps every listener on loopback", async () => {
    expect(execStart(await read("computerd-chromium@.service"))).toContain("--remote-debugging-address=127.0.0.1");
    expect(execStart(await read("computerd-vnc@.service"))).toContain("-localhost -noipv6 -rfbportv6 -1");
    expect(execStart(await read("computerd-input@.service"))).toContain("-localhost -noipv6 -rfbportv6 -1");
    expect(execStart(await read("computerd-xvfb@.service"))).toContain("-nolisten tcp");
  });

  it("keeps the stream view-only", async () => {
    expect(execStart(await read("computerd-vnc@.service"))).toContain("-viewonly");
  });

  it("lets the input stream end by itself, with nothing to bring it back", async () => {
    const unit = await read("computerd-input@.service");
    expect(execStart(unit)).toContain("-once");
    expect(execStart(unit)).toContain("-timeout 15");
    expect(execStart(unit)).not.toContain("-forever");
    expect(execStart(unit)).not.toContain("-shared");
    expect(execStart(unit)).not.toContain("-viewonly");
    expect(unit).not.toMatch(/^Restart=/m);
    expect(unit).not.toMatch(/^\[Install\]/m);
    expect(await read("computerd-desktop@.target")).not.toContain("computerd-input");
  });

  it("keeps what a person types out of the journal", async () => {
    expect(execStart(await read("computerd-input@.service"))).toContain(" -q");
  });

  it("gives computerd exactly the commands it runs, for exactly the slots there are", async () => {
    const sudoers = await readFile(new URL("../sudoers", import.meta.url), "utf8");
    const first = Math.min(...SLOTS);
    const last = Math.max(...SLOTS);
    expect(sudoers).toContain(
      `computerd ALL=(root) NOPASSWD: /usr/bin/systemctl start --quiet computerd-desktop@[${first}-${last}].target, /usr/bin/systemctl stop --quiet computerd-xvfb@[${first}-${last}].service, /usr/bin/systemctl restart --quiet computerd-input@[${first}-${last}].service\n`,
    );
    expect(SLOTS).toEqual(Array.from({ length: last - first + 1 }, (_, index) => first + index));
  });

  it("puts each stream on the port that streamPort names, for every slot", async () => {
    const input = await read("computerd-input@.service");
    for (const slot of SLOTS) {
      expect(execStart(input).replaceAll("%i", String(slot))).toContain(`-rfbport ${streamPort(slot, "control")} `);
      expect(holderText("bot", slot)).toContain(`VNC_PORT=${streamPort(slot, "watch")}\n`);
    }
    expect(execStart(await read("computerd-vnc@.service"))).toContain("-rfbport ${VNC_PORT} ");
  });

  it("reads only the keys that a holder file has", async () => {
    const keys = new Set([...holderText("bot", 1).matchAll(/^(\w+)=/gm)].map((match) => match[1]));
    for (const name of ["computerd-chromium@.service", "computerd-vnc@.service"]) {
      const unit = await read(name);
      for (const [, key] of unit.matchAll(/\$\{(\w+)\}/g)) {
        expect(keys).toContain(key);
      }
    }
  });
});
