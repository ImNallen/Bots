import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../desktop/copy-base-profile.sh", import.meta.url));
const run = promisify(execFile);

let base: string;
let profiles: string;
const final = () => join(profiles, "bot1");

function copy() {
  return run("/bin/sh", [SCRIPT], { env: { PATH: process.env.PATH, BOT_ID: "bot1", BASE_PROFILE: base, PROFILES_DIR: profiles } });
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "copy-base-profile-"));
  base = join(root, "profile");
  profiles = join(root, "profiles");
  await mkdir(join(base, "Default"), { recursive: true });
  await writeFile(join(base, "Default", "Cookies"), "a login");
  await symlink("bots-user-201-897", join(base, "SingletonLock"));
  await symlink("/tmp/gone", join(base, "SingletonSocket"));
});

describe("copy-base-profile.sh", () => {
  it("gives a new bot a copy of the base, with no trace of the browser that held the base", async () => {
    await copy();
    expect(await readFile(join(final(), "Default", "Cookies"), "utf8")).toBe("a login");
    expect((await readdir(final())).filter((name) => name.startsWith("Singleton"))).toEqual([]);
    expect((await readdir(profiles)).sort()).toEqual(["bot1"]);
  });

  it("leaves the base as it was", async () => {
    await copy();
    expect((await readdir(base)).sort()).toEqual(["Default", "SingletonLock", "SingletonSocket"]);
  });

  it("does nothing once the profile exists", async () => {
    await copy();
    await writeFile(join(final(), "Default", "Cookies"), "this bot's own login");
    await writeFile(join(base, "Default", "Cookies"), "a newer base");
    await copy();
    expect(await readFile(join(final(), "Default", "Cookies"), "utf8")).toBe("this bot's own login");
  });

  it("replaces what a killed copy left behind", async () => {
    await mkdir(join(`${final()}.tmp`, "Default"), { recursive: true });
    await writeFile(join(`${final()}.tmp`, "half"), "half a copy");
    await copy();
    expect((await readdir(final())).includes("half")).toBe(false);
    expect((await readdir(profiles)).sort()).toEqual(["bot1"]);
    expect(await readFile(join(final(), "Default", "Cookies"), "utf8")).toBe("a login");
  });

  it("gives an empty profile on a computer with no base", async () => {
    base = join(profiles, "..", "no-such-base");
    await copy();
    expect((await stat(final())).isDirectory()).toBe(true);
    expect(await readdir(final())).toEqual([]);
  });
});
