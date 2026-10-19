# Our Free Model — container image.
#
# Four facts drive every choice below, all established by probing the upstream
# source (Ebony-Vinyl/dsh-our-free-model @ 2.5.5) and running the real code,
# never by assuming. `node verify.mjs` in this repo re-checks all of them.
#
#  1. Zero dependencies. Root `package.json` has `dependencies: {}`; the only
#     dev deps are `jose`, `undici`, `typescript`, used by tests and the
#     *frontend* build. The two large modules — `channels/business.mjs` and
#     `vendor/channel-pack/pack.js` — are pre-bundled, and their `node_modules`
#     references exist only inside generated comments and bundler path strings.
#     Verified: `business.mjs` requires nothing but `node:*` modules. So there is
#     *no* `npm ci`, no `node_modules`, and no install-time network access.
#
#  2. The runtime is 81 files / 2.33 MiB, established by walking the real ESM
#     import graph from both entry points (`packages/standalone/cli.mjs` and
#     `channels/worker.mjs`), then adding the load-time reads no import graph
#     can see: `management.mjs` → `./web/assets.json` and the assets it names,
#     `service.mjs` → `./package.json`, and — the one that bit the first draft —
#     `src/providers/index.js` reading `registry.json` through a *variable*
#     (`path.join(dirname(...), 'registry.json')` + readFileSync), which no
#     specifier-based dependency scan ever finds. Losing that file crashes the
#     service at module load, before it binds a socket.
#
#  3. The standalone service will not bind a routable address. `service.mjs`
#     refuses anything `isLoopbackHost()` rejects, and that set is exactly
#     `127.0.0.1`, `localhost`, `::1`, `[::1]`. So the plain service port can
#     never be published from a container, by design. The only door that binds
#     `0.0.0.0` is the LAN relay, which is why the entrypoint enables it — see
#     docker/entrypoint.sh and the "Ports" section of the README.
#
#  4. Node >= 22.19 or >= 24. Upstream `engines` is `^22.19.0 || >=24.0.0`.
#     `node:22-alpine` is the whole runtime: Alpine's musl is fine here because
#     the only native artifact is a 298 KB `.wasm` (instantiated through
#     WebAssembly; there is no `.node` addon anywhere), so nothing couples the
#     image to glibc.
#
# The build is linux/amd64 only, per the deployment target.

ARG UPSTREAM_REPO=Ebony-Vinyl/dsh-our-free-model
ARG UPSTREAM_REF=main
ARG NODE_VERSION=22-alpine
ARG TARGETPLATFORM

# ---------------------------------------------------------------- source ---
# Pinned to a single ref and recorded in the image, so an image is
# reproducible and traceable to the upstream commit it was cut from.
FROM alpine:3.21 AS source

# TARGETPLATFORM is re-declared inside each stage that needs it; an ARG is
# scoped to the stage that declares it. BuildKit injects it (e.g. linux/amd64);
# on a plain `docker build` it is simply empty, which the label tolerates.
ARG TARGETPLATFORM

ARG UPSTREAM_REPO
ARG UPSTREAM_REF

RUN apk add --no-cache ca-certificates tar

# The GitHub API tarball URL is used rather than `git clone` so the build needs
# no git config, no credential handling, and no protocol negotiation.
RUN set -eux; \
    COMMIT_JSON=$(wget -qO- "https://api.github.com/repos/${UPSTREAM_REPO}/commits/${UPSTREAM_REF}"); \
    case "$COMMIT_JSON" in *'"sha"'*) ;; *) echo "fatal: could not resolve ${UPSTREAM_REPO}@${UPSTREAM_REF}" >&2; exit 1;; esac; \
    export UPSTREAM_SHA=$(echo "$COMMIT_JSON" | grep -o '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]\{40\}"' | head -1 | grep -o '[0-9a-f]\{40\}'); \
    echo "Upstream ${UPSTREAM_REPO}@${UPSTREAM_REF} = ${UPSTREAM_SHA}"; \
    wget -qO /src.tar.gz "https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${UPSTREAM_SHA}"; \
    mkdir -p /src; \
    tar -xzf /src.tar.gz -C /src --strip-components=1; \
    test -f /src/packages/standalone/cli.mjs; \
    echo "$UPSTREAM_SHA" > /src/.upstream-commit

# Verify the pinned Node engine requirement is still satisfied before building.
# This catches the case where upstream bumps `engines` past our base image.
RUN set -eux; \
    node_version=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/src/package.json","utf8")).engines.node)'); \
    echo "package.json engines.node: $node_version"; \
    node_major=$(node -p 'process.versions.node.split(".")[0]'); \
    node_minor=$(node -p 'process.versions.node.split(".")[1]'); \
    echo "build node: v$node_major.$node_minor"; \
    if [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; then \
      echo "fatal: node $node_version required, have v$node_major.$node_minor" >&2; exit 1; \
    fi; \
    if [ "$node_major" -lt 22 ]; then \
      echo "fatal: node $node_version required, have v$node_major.$node_minor" >&2; exit 1; \
    fi

# Drop everything the runtime does not need. Two reasons this is worth doing at
# all rather than shipping the repo: the image carries no dead weight, and an
# accidental extra file cannot sneak in — the tree below is what the COPY gets,
# and every line of it is asserted afterwards.
#
# The listed paths are the ones upstream keeps that the standalone runtime
# provably does not touch: docs/, the frontend *sources* (the built output in
# packages/standalone/web/ is what management.mjs serves — the sources are not),
# the desktop packaging tree, the DSH *plugin* entrypoints (index.js, client.js,
# adapter/, cordis.patch.yml), and the root scripts/ (test and build tooling).
#
# Files that do not exist in a given upstream revision are tolerated — upstream
# occasionally renames them — so this never fails a build on a ref that has
# already dropped one of them. The `test -f` block after the loop is the real
# guard: it proves the tree left behind is the expected shape.
#
# `packages/standalone/web/` is *committed build output*. `management.mjs`
# builds its asset table by reading `assets.json` and mapping each listed name
# to `/assets/<name>`, so anything else in that directory is a stale artifact
# from an older build and is never served. Dropping the unlisted ones means an
# upstream frontend rebuild that renames a chunk cannot leave an orphan behind.
# Modules reachable only through the DSH plugin entry (`index.js`, removed
# above): verified unreferenced by walking the real import graph from
# `packages/standalone/cli.mjs` and `channels/worker.mjs`. They are deleted
# here rather than trusted by inspection, and the tree must still boot — which
# the workflow's `verify` job proves.
#
# The web-asset prune above is the same idea one level up: `management.mjs`
# builds its asset table from `assets.json`, so anything else in that directory
# is a stale artifact from an older build and can never be served.
RUN set -eu; \
    for target in .github .gitignore .gitattributes docs scripts \
                 PACKAGING.md README.md README_EN.md icon.svg \
                 index.js client.js adapter cordis.patch.yml \
                 tsconfig.json package-lock.json locale feed worker \
                 packages/desktop packages/standalone/frontend \
                 packages/standalone/components.json packages/standalone/tsconfig.json \
                 packages/standalone/vite.config.mjs packages/standalone/package-lock.json \
                 packages/standalone/README.md; do \
      rm -rf "/src/$target"; \
    done; \
    node -e 'const fs=require("node:fs");const dir="/src/packages/standalone/web";const keep=new Set(["index.html","splash.html","assets.json",...JSON.parse(fs.readFileSync(dir+"/assets.json","utf8"))]);for(const e of fs.readdirSync(dir)){if(!keep.has(e)){fs.rmSync(dir+"/"+e,{force:true});console.log("pruned stale web asset: "+e)}}'; \
    for dead in src/chan-relay.js src/feed.js src/image-pricing.d.ts \
                src/open-external.js src/picks.js src/push.js src/reload.js \
                src/sponsor.css src/sponsor.js src/updater.js \
                src/token-saver/rtk/registry.js; do \
      rm -f "/src/$dead"; \
    done; \
    test -f /src/packages/standalone/cli.mjs; \
    test -f /src/packages/standalone/service.mjs; \
    test -f /src/packages/standalone/channels/worker.mjs; \
    test -f /src/packages/standalone/channels/business.mjs; \
    # registry.json is load-time read through a variable: \
    # `path.join(path.dirname(...), 'registry.json')` + fs.readFileSync. It is \
    # invisible to any import-graph check, and losing it crashes the service at \
    # module load, before it ever binds a socket. Assert it explicitly. \
    test -f /src/src/providers/registry.json; \
    test -f /src/vendor/channel-pack/qoder-auth-wasm.wasm; \
    test -f /src/packages/standalone/web/index.html; \
    test -f /src/packages/standalone/web/assets.json; \
    test ! -f /src/index.js; \
    test ! -d /src/docs; \
    test ! -d /src/packages/standalone/frontend; \
    test -f /src/LICENSE; \
    echo "runtime tree pruned: $(find /src -type f | wc -l) files remain"

# ----------------------------------------------------------------- build ---
# No build stage is required (no frontend rebuild, no compilation) — the
# committed `web/` assets are already the built output, which `management.mjs`
# serves directly.

# ----------------------------------------------------------------- final ---
FROM node:${NODE_VERSION}

ARG UPSTREAM_REPO
ARG UPSTREAM_REF
ARG UPSTREAM_SHA
ARG BUILD_DATE
ARG VCS_URL
ARG VERSION
ARG TARGETPLATFORM

LABEL org.opencontainers.image.title="dsh-our-free-model" \
      org.opencontainers.image.description="Our Free Model — DeepSeek Harness standalone service container" \
      org.opencontainers.image.url="https://github.com/Ebony-Vinyl/dsh-our-free-model" \
      org.opencontainers.image.documentation="https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/main/packages/standalone/README.md" \
      org.opencontainers.image.source="https://github.com/${VCS_URL}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${UPSTREAM_SHA}" \
      org.opencontainers.image.base.name="docker.io/library/node:${NODE_VERSION}" \
      org.opencontainers.image.platform="${TARGETPLATFORM}" \
      com.our-free-model.upstream.repo="${UPSTREAM_REPO}" \
      com.our-free-model.upstream.ref="${UPSTREAM_REF}" \
      com.our-free-model.upstream.sha="${UPSTREAM_SHA}"

# `--minimal` keeps node but drops npm: there is nothing to install at runtime,
# and dropping npm shrinks the image and removes an attack surface.
ENV NODE_ENV=production \
    OFM_HOME=/data \
    OFM_PORT=18900 \
    OFM_LAN_PORT=0 \
    OFM_ENABLE_REFRESH=1 \
    TINI_SUBREAPER=1

# tini only. curl is deliberately absent: the health check below and the
# verify workflow step both use node's own http client, so nothing needs it,
# and every extra package is another CVE surface to track.
RUN apk add --no-cache --no-scripts tini >/dev/null && \
    rm -rf /var/cache/apk/* /tmp/*

# The runtime tree, from the source stage.
COPY --from=source --chown=node:node /src/packages/standalone/ /app/packages/standalone/
COPY --from=source --chown=node:node /src/src/               /app/src/
COPY --from=source --chown=node:node /src/vendor/channel-pack/qoder-auth-wasm.wasm /app/vendor/channel-pack/qoder-auth-wasm.wasm
COPY --from=source --chown=node:node /src/LICENSE            /app/LICENSE
COPY --from=source --chown=node:node /src/.upstream-commit   /app/.upstream-commit

# The container entrypoint. Written here so it is versioned with the image
# rather than re-derived at run time.
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/ofm-entrypoint.sh

# The service is a daemon: it must own its data directory, and it must not run
# as root. /data is a volume mount point. Sticky-bit-free: only the service
# itself (and its uid) should ever write here.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data

# `/health` answers on the *loopback* listener, which the container can always
# reach itself — so this probe is meaningful and can never be satisfied by an
# unrelated process on the host network. It uses node's own http client, so no
# curl is needed in the final image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e 'const p=process.env.OFM_PORT||18900;require("http").get({host:"127.0.0.1",port:p,path:"/health"},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))'

USER node
WORKDIR /app

# There is deliberately no EXPOSE.
#
# The only port that *can* be reached from outside the container is the LAN
# relay, and it listens on the host's eth0 — a loopback bind would be invisible
# to `docker run -p`. But the relay port is chosen dynamically by default
# (`lanPort: 0`), because a fixed port that is already taken must not be a
# hard failure for a service whose real job is inference. EXPOSE-ing a fixed
# number would therefore document a port that is usually *not* the one used.
#
# Set OFM_LAN_PORT to a fixed value if you need a stable one, and publish that:
#     docker run -p 18901:18901 -e OFM_LAN_PORT=18901 <image>
# The README's "Ports" section explains this in full, including why the plain
# service port is absent on purpose.

VOLUME ["/data"]

# tini reaps the Worker threads and forwards SIGTERM so the service can clean
# up `service.lock` instead of leaving a stale lock behind on restart.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/ofm-entrypoint.sh"]
