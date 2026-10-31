# Build a DSH Web profile with the dsh-team-bots plugin installed.
FROM node:24-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG DSH_VERSION=

RUN corepack enable \
    && npm config set registry "$NPM_REGISTRY" --global \
    && COREPACK_NPM_REGISTRY="$NPM_REGISTRY" pnpm config set registry "$NPM_REGISTRY" --global

WORKDIR /src
COPY package.json index.js cordis.patch.yml README.md NOTICE LICENSE ./
COPY src ./src
COPY ui ./ui
COPY docker/resolve-dsh-version.mjs /usr/local/bin/resolve-dsh-version.mjs

RUN RESOLVED_DSH_VERSION="${DSH_VERSION}" \
    && if [ -z "$RESOLVED_DSH_VERSION" ]; then RESOLVED_DSH_VERSION=$(node /usr/local/bin/resolve-dsh-version.mjs); fi \
    && echo "Installing DSH $RESOLVED_DSH_VERSION" \
    && npm install -g "@deepseek-ai/dsh@${RESOLVED_DSH_VERSION}" \
        --allow-scripts=@deepseek-ai/dsh-subprocess-local,node-pty,koffi,@google/genai,protobufjs \
    && printf '%s' "$RESOLVED_DSH_VERSION" > /opt/dsh-version

RUN npm pack --pack-destination /tmp \
    && mv /tmp/dsh-team-bots-*.tgz /tmp/dsh-team-bots.tgz \
    && DSH_HOME=/opt/dsh-template dsh plugin --profile bots add /tmp/dsh-team-bots.tgz

FROM node:24-bookworm-slim

ARG NPM_REGISTRY=https://registry.npmjs.org/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash git curl ca-certificates \
        python3 python3-pip python3-venv \
        build-essential jq ripgrep unzip zip ffmpeg less procps gosu \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY --from=build /usr/local/ /usr/local/
COPY --from=build /opt/dsh-template /opt/dsh-template
COPY --from=build /opt/dsh-version /opt/dsh-version
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/docker.patch.yml /opt/dsh-team/docker.patch.yml

ENV DSH_HOME=/home/node/.dsh \
    DSH_PROFILE=bots \
    DSH_PERMISSION_MODE=danger-full-access \
    DSH_TEAM_WORKSPACE=/workspace \
    DSH_TEAM_DATA=/workspace/.data \
    DSH_TELEMETRY_DISABLED=1 \
    NPM_REGISTRY=${NPM_REGISTRY}

WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
