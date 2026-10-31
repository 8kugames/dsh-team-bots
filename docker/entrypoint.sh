#!/bin/sh
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}
groupmod -o -g "$PGID" node
usermod -o -u "$PUID" node

export HOME=/home/node
export DSH_HOME=${DSH_HOME:-/home/node/.dsh}
export DSH_PROFILE=${DSH_PROFILE:-bots}
export DSH_TEAM_DATA=${DSH_TEAM_DATA:-/workspace/.data}
export NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org/}
CURRENT_VERSION=$(cat /opt/dsh-version 2>/dev/null || true)
export DSH_RUNTIME_VERSION=${CURRENT_VERSION:-unknown}

# Preserve the host's global ~/.dsh configuration. Only seed the dedicated
# `bots` profile on first use; never replace other host profiles or settings.
mkdir -p "$DSH_HOME/profiles"
if [ ! -d "$DSH_HOME/profiles/$DSH_PROFILE" ]; then
  cp -a "/opt/dsh-template/profiles/$DSH_PROFILE" "$DSH_HOME/profiles/$DSH_PROFILE"
  chown -R node:node "$DSH_HOME/profiles/$DSH_PROFILE"
fi

# All mutable team state lives under the workspace mount; there is no /data volume.
mkdir -p /workspace /workspace/.agents/skills "$DSH_TEAM_DATA"
if [ -z "$(ls -A /workspace)" ]; then
  chown node:node /workspace
fi
chown -h node:node /workspace/.agents 2>/dev/null || true
chown node:node /workspace/.agents/skills "$DSH_TEAM_DATA"

HOST=${DSH_HOST:-0.0.0.0}
LISTEN_PORT=${DSH_LISTEN_PORT:-3080}
case "$HOST" in
  0.0.0.0|127.0.0.1) ;;
  *) echo "entrypoint: DSH_HOST must be 0.0.0.0 or 127.0.0.1 (got '$HOST')" >&2; exit 1 ;;
esac
case "$LISTEN_PORT" in
  ''|*[!0-9]*) echo "entrypoint: DSH_LISTEN_PORT must be a port number (got '$LISTEN_PORT')" >&2; exit 1 ;;
esac

cat > /tmp/listen.patch.yml <<EOF
- id: webserver
  config:
    host: $HOST
    port: $LISTEN_PORT
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
EOF

UPGRADE_FILE="$DSH_TEAM_DATA/dsh-upgrade.json"
CHILD=
on_term() {
  trap - TERM INT
  if [ -n "$CHILD" ]; then
    kill -TERM "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
  exit 0
}
trap on_term TERM INT

echo "dsh-team: DSH ${DSH_RUNTIME_VERSION}, profile ${DSH_PROFILE}, data ${DSH_TEAM_DATA}"
while :; do
  # A settings-panel upgrade writes a target version and exits DSH with code 75.
  # Install it as root, then relaunch DSH in this same container.
  if [ -f "$UPGRADE_FILE" ]; then
    TARGET=$(node -e 'try { const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(data.version||"")) } catch {}' "$UPGRADE_FILE" 2>/dev/null || true)
    rm -f "$UPGRADE_FILE"
    case "$TARGET" in
      [0-9]*)
        case "$TARGET" in
          *[!0-9A-Za-z.+-]*) TARGET='' ;;
        esac
        ;;
      *) TARGET='' ;;
    esac
    if [ -n "$TARGET" ] && [ "$TARGET" != "$CURRENT_VERSION" ]; then
      echo "dsh-team: installing DSH $TARGET"
      if npm install -g "@deepseek-ai/dsh@$TARGET" \
        --registry "$NPM_REGISTRY" \
        --allow-scripts=@deepseek-ai/dsh-subprocess-local,node-pty,koffi,@google/genai,protobufjs; then
        CURRENT_VERSION="$TARGET"
        printf '%s' "$CURRENT_VERSION" > /opt/dsh-version
      else
        echo "dsh-team: DSH upgrade failed; staying on $CURRENT_VERSION" >&2
      fi
    fi
    export DSH_RUNTIME_VERSION="$CURRENT_VERSION"
  fi

  set -- dsh --profile "$DSH_PROFILE" \
    --patch /opt/dsh-team/docker.patch.yml --patch /tmp/listen.patch.yml \
    --no-open

  if [ -n "${DSH_TRUSTED_HOST:-}" ]; then
    old_ifs=$IFS
    IFS=','
    for trusted in $DSH_TRUSTED_HOST; do
      [ -n "$trusted" ] && set -- "$@" --trusted-host "$trusted"
    done
    IFS=$old_ifs
  fi

  cd /workspace
  gosu node "$@" &
  CHILD=$!
  set +e
  wait "$CHILD"
  CODE=$?
  set -e
  CHILD=

  if [ "$CODE" -eq 75 ]; then
    echo "dsh-team: DSH requested a hot restart"
    continue
  fi
  exit "$CODE"
done
