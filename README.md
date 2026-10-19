# dsh-our-free-model · container image

Builds the [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
**standalone service** into an OCI image and publishes it to
`ghcr.io/<owner>/<repo>` — nightly by schedule, or on demand.

The image contains the upstream *standalone service* (the one that runs without
DSH, via `packages/standalone/cli.mjs`), not the DSH plugin itself. The plugin
is mounted into a running DSH host and has nothing to containerize; the
standalone service is a real daemon with a data directory, which is what a
container wants.

---

## What it does

| | |
|---|---|
| **Triggers** | `schedule` (daily 02:17 UTC) · `workflow_dispatch` (manual) · `push` to `main` (image-affecting paths) · `pull_request` (dry build, no push) |
| **Registry** | `ghcr.io/<owner>/<repo>` |
| **Platforms** | `linux/amd64` only |
| **Tags** | `latest`, `nightly-YYYYMMDD`, `YYYYMMDD`, `sha-<short>` |
| **Auth** | `GITHUB_TOKEN` with `permissions: packages: write` — no PAT needed |

The workflow is deliberately thin: it resolves the upstream ref to an immutable
SHA, hands that SHA to the Dockerfile as a build arg, and stops deciding
anything. The Dockerfile owns what the image *is*, so upstream evolving does
not force workflow changes.

### Why resolve an SHA first

`main` is a moving target. A nightly run that fetches `main` at three different
moments (label step, build step, verify step) can produce three different
images, and a `latest` tag that does not match whatever the user pulls. The
`resolve` job pins the SHA once and every later job builds that same tree.

---

## Quick start

```bash
docker run -d --name ofm \
  -v ofm-data:/data \
  ghcr.io/<owner>/<repo>:latest
```

Then read the key out of the log and call it:

```bash
docker logs ofm        # prints the LAN relay key once, at first start
docker logs ofm --since 1h | grep -o 'ofm-[A-Za-z0-9_-]*'
```

To get a fixed, publishable port instead of the default dynamic one:

```bash
docker run -d --name ofm \
  -p 18901:18901 \
  -e OFM_LAN_PORT=18901 \
  -v ofm-data:/data \
  ghcr.io/<owner>/<repo>:latest

curl -s http://localhost:18901/v1/models \
  -H "Authorization: Bearer <LAN key from the log>"
```

`docker-compose.yml` in this repo is the same thing, with the port pinned.

---

## Ports, and the one that cannot be published

This is the part that is not obvious, so it is worth being precise.

The upstream standalone service **refuses to bind a routable address**:

```js
// packages/standalone/service.mjs
if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
```

`isLoopbackHost()` accepts exactly `127.0.0.1`, `localhost`, `::1`, `[::1]`.
That is upstream's deliberate design — not an oversight this image works around.
The free lanes are priced against *this machine's* egress, so handing them to a
whole subnet through a bind string is precisely what that fence exists to stop.

Inside a container that has one consequence: `docker run -p HOST:CONTAINER`
reaches the container's `eth0` address, which is not loopback, so the plain
service port **can never be published** — and weakening that fence is not
something this image should do silently.

The one door upstream intentionally opens wider is the **LAN relay**
(`src/forward.js` → `startLanRelay`). It binds `0.0.0.0`, carries only the
inference routes, and has its own separately generated, separately rotatable
key.

So this image runs the relay, and only the relay is externally reachable:

| port | binds | reachable from outside? | what it serves |
|---|---|---|---|
| `OFM_PORT` (default `18900`) | `127.0.0.1` only | **No, and never will be** | local API + management page |
| `OFM_LAN_PORT` (default `0` = auto) | `0.0.0.0` | **Yes, this is the door** | `/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens` |

Reaching the management page:

```bash
docker exec -it ofm sh
# then open the management URL the service printed at startup
```

That is not a limitation of this image — the relay carries the inference routes
and nothing else by design, and the management listener is fenced to loopback
by upstream. Upstream's own
[standalone README](https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/main/packages/standalone/README.md)
documents the same constraint for Docker/FPK/NAS deployments.

> In this case the container is *not* the LAN boundary. Publishing the relay is
> the same act as `--lan` on a desktop install: anyone who can reach the port
> and hold the key gets the free lanes. Keep the key secret, and bind the
> published port to a trusted interface (`-p 127.0.0.1:18901:18901`) unless you
> really mean to share it.

---

## Verified behaviour

These claims were established by probing the upstream source and running the
real code, not by reading documentation. Reproduce with
`node _probe/relay-post.mjs ._probe/dsh-our-free-model-main`:

- With **no credentials at all**, a fresh data dir, and `--lan`, a real
  `POST /v1/chat/completions` through the relay returns `200` with a completion
  (9 models from the anonymous + Kilo free lanes).
- The relay **rejects the local `forwardKey`** with
  `401 missing or invalid LAN key` — the two keys really are separate, and
  rotating the LAN key does not touch the local one.
- The relay **refuses management paths** (`/`, `/health`, `/api/management/*`)
  — its surface is inference only.
- The local listener is reachable on `127.0.0.1` and **on no routable address**,
  which is the loopback fence holding.
- The build needs **no `npm ci`**: upstream's root `package.json` has
  `dependencies: {}`, and the two bundled modules (`channels/business.mjs`,
  `vendor/channel-pack/pack.js`) require only `node:*` modules. The
  `node_modules` strings inside them live in generated comments and bundler
  path labels.

The `verify` job in the workflow runs the equivalent assertions against the
pushed image, so a broken `latest` fails the run instead of being published
quietly.

---

## The free lane depends on your network exit

This is the single most important operational fact about this image, and it is
not something the packaging can fix.

The lane is keyed to the **machine's network egress**. Upstream answers with,
for example:

```
403 OpenCode's free models aren't available from your current network
      because we've detected abusive traffic from this IP address.
      This isn't related to your account.
```

So the same image, same data volume, same key works from one host and is
refused from another — or from the same host after the IP changes. Verified
during development by running `verify.mjs`, which walks every advertised model
through the relay and records the verdict:

| status | meaning | whose answer |
|---|---|---|
| `200` | a real completion | the lane |
| `403` | egress refused — "abusive traffic", or "not available in your country" | the lane |
| `400` | "Model is unavailable" today | the lane |
| `410` | deprecated (e.g. `mimo-v2.5-free`) | the lane |
| `404` | id not found in that lane | the lane |
| `502` | a `combo:` row whose every candidate failed | the lane's own composite |
| `401` | **bad/missing LAN key** | the relay |
| `ECONNREFUSED` | **the container is not up** | yours |

**The relay itself is proven sound by all of the first six.** When `verify.mjs`
reports `403` it means the image authenticated correctly, reached the lane, and
returned the lane's own refusal verbatim. That is a pass, not a failure — an
earlier version of this check demanded a `200` and failed a perfectly good
image, which is why the distinction is spelled out here.

Practical consequences:

- **A VPN or proxy changes your egress.** If every model returns `403`, the
  first thing to try is turning the proxy off, exactly as the message says.
- **CI cannot be used as an availability check.** GitHub's runners have their
  own egress; a `403` there says nothing about your deployment.
- The `verify` workflow job therefore asserts the *relay contract* (`/health`
  200, keyed models 200, anonymous 401, management 404) and never asserts that
  a given lane will actually serve a completion.

---

## The relay's port is assigned at runtime

`settings.json` records `standaloneLanPort` as the **requested** port, not the
live one. In the default configuration that value is `0` — *"pick a free port"*
— and the service then binds an ephemeral port while leaving `0` on disk:

```
live relay port 51182; the disk says 0
```

Verified directly: a TCP probe of `standaloneLanPort` (0) fails while a probe of
the real port succeeds. So **never read the relay port out of `settings.json`**;
a script that does will connect to nothing.

The image solves this two ways:

- The entrypoint prints the **live** port at startup, read from the service's own
  `/api/management/summary` (`lan.port`), not from disk.
- The workflow's `verify` job does the same rather than trusting the file.
  (Its first draft did trust it and got `ECONNREFUSED` — which is how this
  became a documented fact instead of a surprise.)

For a stable, publishable port, set it explicitly:

```bash
docker run -p 18901:18901 -e OFM_LAN_PORT=18901 -v ofm-data:/data ghcr.io/<owner>/<repo>:latest
```

A fixed port that is already taken is **not** fatal: upstream degrades to
`relayError` (surfaced in the summary and the CLI) and keeps serving inference
locally, while `-p` simply forwards to nothing. Check
`GET /api/management/summary` → `lan.error` if the relay is unexpectedly absent.

---

## Configuration

| env | default | meaning |
|---|---|---|
| `OFM_HOME` | `/data` | data directory (must be a volume, or it is lost on restart) |
| `OFM_PORT` | `18900` | loopback listener — never publish this |
| `OFM_LAN_PORT` | `0` | LAN relay port; `0` picks a free one, a fixed number makes it publishable and stable |
| `OFM_ENABLE_REFRESH` | `1` | set `0` to pass `--no-refresh` (offline/CI) |
| `OFM_DATA_DIR_OVERRIDE` | — | not used; `--data-dir` is derived from `OFM_HOME` |

Everything else — model switches, account channels, EAC, proxy — is configured
through the management page or by mounting `$OFM_HOME/settings.json`.

---

## Pipeline

```
schedule / dispatch / push
        │
        ▼
   ┌─────────┐   resolves upstream ref → immutable SHA + version
   │ resolve │──────────────────────────┐
   └─────────┘                          │
        └──────────────┬────────────────┘
                       ▼
                ┌──────────┐  build linux/amd64, push to ghcr.io
                │  build   │  (GHA layer cache)
                └──────────┘
                       │
                       ▼
                ┌──────────┐  run the pushed image, assert /health 200,
                │  verify  │  assert relay 401 without key / 200 with key
                └──────────┘
                       │
                       ▼
                ┌──────────┐
                │ summary  │  always-on run summary
                └──────────┘
```

`verify` is not optional decoration: a nightly image that starts but crashes is
worse than no image, because it occupies `latest` and lies to whoever pulls it.
A failed verify fails the run.

---

## Local build

```bash
docker build -t ofm:local .
# against a specific upstream tag
docker build --build-arg UPSTREAM_REF=v2.5.5 -t ofm:v255 .
```

> This image has not been built locally in the repo's development environment —
> no Docker daemon was available there. The build, the runtime file set, and the
> LAN relay contract were each verified independently (see *Verified behaviour*),
> and the workflow's `verify` job is what exercises the real image in CI.

---

## Updating the tracked ref

The image builds `Ebony-Vinyl/dsh-our-free-model@main` by default. To track a
different repo or ref:

- **Default for every run**: change `vars.UPSTREAM_REPO` in the repository, or
  the fallback default in the `resolve` job.
- **One-off**: trigger `workflow_dispatch` with `upstream_ref` set to a branch,
  tag or commit SHA.

The Dockerfile *fails the build* when upstream's `package.json` declares a Node
engine newer than the base image, so a silent "runs on an unsupported Node"
image is impossible. It also drops every file the runtime does not import, so
the image cannot grow an accidental repo checkout.

---

## Testing it locally

```bash
node test.mjs          # everything, in order, stops at the first failure
```

What that does, and why each step exists:

| step | what it proves |
|---|---|
| `download.mjs` | fetches the upstream tree the image builds from, and resolves the ref to an immutable SHA first (same as the build) |
| `verify.mjs` | walks the real ESM import graph to build the runtime inventory; confirms every Dockerfile deletion is safe; **builds the pruned tree and boots the real service from it**, asserting `/health` 200, keyed models 200, anonymous 401, management 404; and a real completion attempt through the relay (see *The free lane depends on your network exit*) |
| `run-workflow-verify.mjs` | **extracts the verify script out of the workflow and runs it** — the first draft of that script mixed `require` with top-level `await` and failed to parse, and its port came from `settings.json` instead of the live service; both bugs would have surfaced in CI and nowhere else |
| `test-entrypoint-helpers.mjs` | the entrypoint's `ofm_setting` / `ofm_relay_port` helpers against the real service, including the persisted-port trap above |

`verify.mjs` also asserts the workflow contract, so a change that drops the
daily trigger or the AMD64 pin fails locally rather than after a silent nightly.

> These run without Docker. In the development environment there was no Docker
> daemon, which is why the *pruned tree boots the real service* check exists —
> it is the closest available substitute for `docker build && docker run`, and it
> caught two missing-file bugs that static inspection had declared fine.

---

## Attribution

The upstream project is MIT-licensed, © 2026 Ebony-Vinyl. Its `LICENSE` is
copied into the image. This repository contributes packaging only — no upstream
code is modified, and the build fetches an unmodified upstream tarball.
