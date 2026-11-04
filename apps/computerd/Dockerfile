FROM node:26-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends sudo procps ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@11.23.0 \
  && useradd --system --create-home --shell /usr/sbin/nologin computerd \
  && useradd --create-home --shell /bin/bash agent \
  && install --directory --owner computerd --group computerd --mode 0700 /var/lib/computerd \
  && install --directory --owner agent --group agent --mode 0755 /workspace

COPY --chmod=0440 apps/computerd/sudoers /etc/sudoers.d/computerd

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/computerd apps/computerd
RUN pnpm install --frozen-lockfile --prod --filter @bots/computerd...

USER computerd
CMD ["node", "apps/computerd/src/main.ts"]
