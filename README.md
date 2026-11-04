# Bots

A self-hosted agent platform. See the [architecture](docs/architecture.md) and the [roadmap](docs/roadmap.md).

This repository is at roadmap step 1a. It runs Convex in Docker, the orchestrator in dev mode, and the web shell on one Mac.

## Requirements

- Node 26 and pnpm 11
- Docker with Compose

## Run it

```sh
pnpm install
pnpm bootstrap
pnpm dev
```

Open http://localhost:5173. The Convex dashboard is at http://127.0.0.1:6791. To sign in to it, use the admin key in `packages/convex/.env.local`.

`pnpm bootstrap` generates the signing key, starts the containers, and deploys the Convex functions. It is safe to rerun, and it never replaces a key that still works.

To run the built app instead, use `pnpm build` and then `pnpm start`. It serves on http://127.0.0.1:8787.

## Check it

| Command | What it proves |
|---|---|
| `pnpm typecheck` | Every package typechecks |
| `pnpm test` | Identity resolution and config parsing behave as specified |
| `pnpm verify:auth` | Tokens, live queries, user isolation, the dev guard, and file serving work against the real Convex backend and the built orchestrator |

`pnpm verify:auth` needs the containers from `pnpm bootstrap`. It starts its own orchestrator on a free port, so it can run alongside `pnpm dev`. Each run leaves a few rows under test identities in Convex. They never appear for `dev@localhost`.

## Stop it

```sh
docker compose --file infra/control-vm/compose.yaml down
```

Add `--volumes` to delete the Convex data as well.
