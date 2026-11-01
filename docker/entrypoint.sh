#!/bin/sh
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Only remap when the id actually differs; `usermod`/`groupmod` print
# "no changes" on every start otherwise, which reads like a failure.
if [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node
fi
if [ "$(id -u node)" != "$PUID" ]; then
  usermod -o -u "$PUID" node
fi

export HOME=/home/node
export DSH_HOME=${DSH_HOME:-/home/node/.dsh}
export DSH_PROFILE=${DSH_PROFILE:-team-bots}
export DSH_TEAM_DATA=${DSH_TEAM_DATA:-/workspace/.data}
export NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org/}
CURRENT_VERSION=$(cat /opt/dsh-version 2>/dev/null || true)
export DSH_RUNTIME_VERSION=${CURRENT_VERSION:-unknown}

PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"

# Preserve the host's global ~/.dsh configuration. Only seed the dedicated
# `team-bots` profile on first use; never replace other host profiles or settings.
mkdir -p "$DSH_HOME/profiles"
if [ -L "$PROFILE_DIR" ] && [ ! -d "$PROFILE_DIR" ]; then
  echo "dsh-team: $PROFILE_DIR is a broken or looping symlink; removing it" >&2
  rm -f "$PROFILE_DIR"
fi
if [ ! -d "$PROFILE_DIR" ]; then
  cp -a "/opt/dsh-template/profiles/$DSH_PROFILE" "$PROFILE_DIR"
  chown -R node:node "$PROFILE_DIR"
fi

# The profile survives container upgrades, so an older plugin copy would stay
# installed forever while the UI and web routes move on. Compare the packaged
# tarball's checksum with what was last installed and reinstall on mismatch.
# A version comparison is not enough: in-place fixes ship under the same version.
PLUGIN_TGZ=/opt/dsh-team/dsh-team-bots.tgz
if [ -f "$PLUGIN_TGZ" ]; then
  SHIPPED_SHA=$(sha256sum "$PLUGIN_TGZ" | cut -d' ' -f1)
  MARKER="$PROFILE_DIR/.dsh-team-plugin.sha256"
  INSTALLED_SHA=$(cat "$MARKER" 2>/dev/null || true)
  if [ -n "$SHIPPED_SHA" ] && [ "$SHIPPED_SHA" != "$INSTALLED_SHA" ]; then
    echo "dsh-team: installing the team plugin from the image"
    # Unpack directly: the plugin has no runtime dependencies, and this avoids
    # touching the registry (or fighting pnpm's store) just to refresh a profile.
    STAGE=$(mktemp -d)
    TARGET="$PROFILE_DIR/node_modules/dsh-team-bots"
    if tar -xzf "$PLUGIN_TGZ" -C "$STAGE" && [ -d "$STAGE/package" ]; then
      rm -rf "$TARGET"
      mkdir -p "$PROFILE_DIR/node_modules"
      mv "$STAGE/package" "$TARGET"
      chown -R node:node "$TARGET" 2>/dev/null || true
      printf '%s' "$SHIPPED_SHA" > "$MARKER"
      chown node:node "$MARKER" 2>/dev/null || true
    else
      echo "dsh-team: plugin update failed; keeping the installed copy" >&2
    fi
    rm -rf "$STAGE"
  fi
fi

# The profile is named `team-bots` but must load DSH's Web application bundle.
# Patch only the bundle list; preserve the profile's own config and plugins.
# A foreign profile (e.g. the host's `zed`) does not list the team plugin, so
# append it — otherwise the tarball below refreshes node_modules that the
# loader never reads and the plugin silently stays inactive.
if [ -f "$PROFILE_DIR/package.json" ]; then
  node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.dsh??={};j.dsh.profile??={};const b=Array.isArray(j.dsh.profile.bundles)?j.dsh.profile.bundles:[];const rest=b.filter(x=>x!=="@deepseek-ai/dsh-base"&&x!=="@deepseek-ai/dsh-web-app");const bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app",...rest];if(!bundles.includes("dsh-team-bots"))bundles.push("dsh-team-bots");j.dsh.profile.bundles=bundles;fs.writeFileSync(p,JSON.stringify(j,null,2))' "$PROFILE_DIR/package.json"
  chown node:node "$PROFILE_DIR/package.json"
fi

# The Agent Teams layer ships inside the image; this flag only decides whether
# the profile loads it. Off by default: it replaces the subagent tools and lets
# every worker spawn named teammates.
AGENT_TEAM_PKG="@deepseek-ai/dsh-experimental-agent-team-profile"
PROFILE_PKG="$PROFILE_DIR/package.json"
if [ -f "$PROFILE_PKG" ]; then
  AGENT_TEAM_ON=0
  if [ "${DSH_TEAM_AGENT_TEAM:-0}" = "1" ]; then AGENT_TEAM_ON=1; fi
  node -e 'const fs=require("fs");const [p,team,on]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(p,"utf8"));j.dsh??={};j.dsh.profile??={};let b=Array.isArray(j.dsh.profile.bundles)?j.dsh.profile.bundles:[];const had=b.includes(team);b=b.filter(x=>x!==team&&x!=="@deepseek-ai/dsh-experimental-agent-team-web-profile");if(on==="1")b.push(team);j.dsh.profile.bundles=b;fs.writeFileSync(p,JSON.stringify(j,null,2));if(on==="1"&&!had)process.stderr.write("dsh-team: enabled "+team+" in the profile bundles\n")' "$PROFILE_PKG" "$AGENT_TEAM_PKG" "$AGENT_TEAM_ON"
  chown node:node "$PROFILE_PKG"
  if [ "$AGENT_TEAM_ON" = "1" ]; then
    echo "dsh-team: Agent Teams on - teammates share the project workspace"
  fi
fi

# All mutable team state lives under the workspace mount; there is no /data volume.
#
# A previous run, a sync client, or a hand-made `ln -s` can leave `.agents` (or
# `.data`) as a broken or self-referencing symlink. `mkdir -p` then fails with
# ELOOP and kills the container, so check first and only fix what is broken.
ensure_dir() {
  dir=$1
  if [ -L "$dir" ]; then
    resolved=$(readlink -f "$dir" 2>/dev/null || true)
    if [ -n "$resolved" ] && [ -d "$resolved" ]; then
      return 0
    fi
    echo "dsh-team: $dir is a broken or looping symlink; replacing it with a real directory" >&2
    rm -f "$dir"
  fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    echo "dsh-team: $dir exists but is not a directory" >&2
    return 1
  fi
  [ -d "$dir" ] || mkdir -p "$dir"
}

ensure_dir /workspace
# Docker creates a missing bind-mount source as root. Only take ownership when
# the node user cannot already write there, so an existing host tree that is
# correctly mapped by PUID/PGID is left untouched.
if ! gosu node test -w /workspace 2>/dev/null; then
  chown node:node /workspace 2>/dev/null || echo "dsh-team: warning: /workspace is not writable by node; check PUID/PGID and mount permissions" >&2
fi
ensure_dir /workspace/.agents
ensure_dir /workspace/.agents/skills
ensure_dir "$DSH_TEAM_DATA"
chown -h node:node /workspace/.agents 2>/dev/null || true
if ! chown node:node /workspace/.agents/skills "$DSH_TEAM_DATA" 2>/dev/null; then
  echo "dsh-team: warning: could not chown /workspace/.agents/skills or $DSH_TEAM_DATA; check PUID/PGID and mount permissions" >&2
fi

HOST=${DSH_HOST:-auto}
LISTEN_PORT=${DSH_LISTEN_PORT:-3080}
if [ "$HOST" = "auto" ] || [ "$HOST" = "0.0.0.0" ]; then
  HOST=$(node -e 'const os=require("os");const all=Object.values(os.networkInterfaces()).flat().filter(Boolean);const ip=all.find(i=>i.family==="IPv4"&&!i.internal);if(!ip){console.error("no non-loopback IPv4 interface");process.exit(1)}process.stdout.write(ip.address)')
fi
case "$HOST" in
  127.0.0.1|::1) ;;
  *[!0-9A-Fa-f:.]*|'') echo "entrypoint: DSH_HOST must resolve to a concrete local IP (got '$HOST')" >&2; exit 1 ;;
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
