# Spike: a desktop for each bot

These scripts ran on a throwaway clone of the template, on 5 November 2026. They are a record of the test and a start for the real checks, so they are not production code. [The roadmap](../../roadmap.md) has the results and the plan.

1. On the Proxmox host, clone a VM with `clone-user-vm.sh`, and wait until `cloud-init status` says `done`.
2. In the VM, run `setup.sh` as root, and copy `desktop.sh` and `chrome.sh` to `/opt`.
3. For each N from 1 to 4, run `desktop.sh N` and `chrome.sh N /home/browser/profile/Fork-N` as the `browser` user.
4. In the VM, run `node everything.mjs` and `node typing.mjs` as root.

`everything.mjs` covers every test. Its typing section reads results too early, so it reports leaks that are only late keys. `typing.mjs` is the correct version of that section, and it waits until delivery settles.

Remove the VM afterward. Its input streams accept keys with no password on loopback. A real VM must open an input stream only during a take-over.
