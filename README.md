# donsetch-dsh

First-class DonSeTch web access for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). One install line, and every dsh agent gets the full DonSeTch suite: fetch, search, and crawl with browser-grade stealth, keyless engines, BYOK providers, and an auto-updating native binary. No API key required to start.

## Install

```bash
dsh plugin --profile web add github:dondai44423/donsetch-dsh
```

Restart `dsh web` (bundle plugins activate on the next boot). On first start the plugin downloads the correct DonSeTch binary for your platform from GitHub Releases, verifies its SHA256 against the release sidecar, and registers the tools. That is the whole setup: no API key, no config file.

Add the `dsh-plugin` topic to your repo mentions: this repo is already on it. The plugin also works in headless profiles:

```bash
npx @deepseek-ai/dsh --profile headless "research the latest donsetch release notes"
```

## What you get

- `donsetch_web_fetch`: one URL to full markdown, browser-grade rendering and stealth where needed
- `donsetch_web_search`: keyless engines out of the box, or your own keys via BYOK providers (Exa, Tavily, Serper, SerpApi, SerpBase, Bright Data, TinyFish, plus plugin adapters)
- `donsetch_web_crawl`: whole-site crawling with sitemap discovery
- `donsetch_status`: self-diagnostics (degraded daemons get one automatically)

The tools are registered in-process on the harness tool registry, not as `mcp__*` imports, so they flow through dsh's permission, timeout, and cancellation pipeline like any native tool, and they show call/result cards in the Web workbench.

## Why it is not just an MCP config

dsh ships a built-in MCP client. Pointing it at `donsetch mcp` works, but this plugin is the first-class version:

| | built-in MCP config | this plugin |
| --- | --- | --- |
| Install | you write a config row | one plugin add |
| Binary download + SHA256 verify | manual install | automatic |
| Auto-updates with donsetch releases | never | yes, throttled, swappable between calls |
| Tool names | `mcp__donsetch__...` | `donsetch_...` |
| Config changes from the CLI | restart everything | live daemon restart on config file change |
| Workbench cards | generic | per-tool call/result summaries |
| Status + doctor for the agent | none | `donsetch_status` |
| Harness schema contract | none | parameters comply with the enforced raw JSON Schema contract |
| Correctness gate in CI | none | the plugin runs inside a real dsh ToolRuntime on every push |

## How customization works

The plugin uses the exact same config file the standard DonSeTch CLI uses, so every part of DonSeTch's normal customization applies unchanged:

```bash
donsetch keys add exa <key>         # add a provider key
donsetch keys default exa           # switch default provider
donsetch doctor                     # engine diagnostics
donsetch mcp ...                    # identical surface elsewhere
```

CLI changes land in the live dsh plugin within seconds: the plugin watches the config file and swaps the daemon without a dsh restart.

## Configuration

All defaults are sensible; the plugin works with zero configuration. Options come from the bundle patch (edit `$DSH_HOME/cordis.patch.yml` to override) plus environment variables.

| option | default | description |
| --- | --- | --- |
| `toolPrefix` | `donsetch` | Model-facing tool name prefix, `[A-Za-z0-9_]{1,16}` |
| `channel` | `stable` | Update channel: `stable` (releases) or `latest` (includes prereleases) |
| `autoUpdate` | `true` | Check GitHub Releases and swap in newer verified binaries between calls |
| `updateIntervalHours` | `24` | Minimum gap between update checks |
| `callTimeoutMs` | `180000` | Per-tool-call timeout |
| `bootTimeoutMs` | `20000` | Daemon initialize + tools/list timeout |
| `fallbackToPath` | `true` | Use a `donsetch` already on PATH when the download fails (degraded mode, told honestly in `donsetch_status`) |
| `pinnedVersion` | current | donsetch release a fresh install pins (floor, not ceiling) |

Environment: `DONSETCH_DSH_PREFIX`, `DONSETCH_DSH_CHANNEL`, `DONSETCH_DSH_AUTOUPDATE=off`, `DONSETCH_BIN` (path to a local donsetch binary), `DONSETCH_DSH_CACHE_DIR`.

Patch-layer example (`$DSH_HOME/cordis.patch.yml`, later layers win):

```yaml
- override:
    - id: donsetch
      config:
        toolPrefix: web
        autoUpdate: false
```

## Updates

Two-layer update story. The plugin glue is a bundle: re-running `dsh plugin add` against a newer pin (or letting the repository panel track the branch) keeps it current. The donsetch binary updates itself: on a throttled schedule it checks GitHub Releases on your channel, and when a newer release appears it downloads, SHA256-verifies against the release sidecar, and swaps the daemon between in-flight calls. A failed verify aborts the install and keeps the current binary; nothing partial ever replaces a working daemon.

The baseline DonSeTch pin auto-tracks published releases every 6 hours.

## Reliability notes

- The daemon runs supervised (`donsetch mcp --supervised`), so crashes restart transparently and the next tool call revives cleanly.
- Cancellations reach the real daemon (`notifications/cancelled`), the in-flight fetch or crawl actually stops.
- Plugin unload kills the daemon: hot-reload leaves no orphan processes.
- Downloads are atomic: temp dir, hash check, rename into place, stale dirs removed.
- The update check never blocks tool service and never runs a paid query.

## Compatibility

Developer preview caveat: DeepSeek Harness is iterating fast and its APIs are moving. This plugin pins no host-train imports at all (it talks to the harness only through the `ctx` handed to `apply()`), which keeps it installable across harness updates. Verified against:

| harness | npm dsh | dsh-tools |
| --- | --- | --- |
| DeepSeek Harness 0.1.1-rc.2 (npm latest) | `@deepseek-ai/dsh` | 0.1.x train |
| DeepSeek Harness 0.1.2-alpha.1 (source docs) | source | 0.1.x train |

Node `^22.19.0 || >=24.0.0` (the harness requirement).

Known upstream gap: the npm dsh CLI cannot boot `dsh web` on Linux GitHub runners because the `pty.node` linux-x64 prebuild is missing from the published package (upstream discussion #1686). The plugin itself does not need pty; only the web boot smoke is affected, which CI runs on Windows instead.

## Troubleshooting

**Tools are missing in a session.** Ask the agent to call `donsetch_status`, or check the plugin log lines (`[donsetch] ...`) on the dsh host. The status tool reports the daemon state, binary version, last boot error, and the `donsetch doctor` output.

**First install failed.** Offline? The plugin falls back to a `donsetch` on PATH (degraded, told honestly). To pin a local binary instead, set `DONSETCH_BIN=/path/to/donsetch`.

**I want the old-version binary.** Delete the versioned dir under `~/.cache/donsetch/dsh/bin/` and the plugin reinstalls the pinned release.

## Development

```bash
npm install
npm test        # typecheck + build + unit/integration suite (fake daemon harness)
npm run live    # real donsetch binary: handshake + tools/list + fetch + search
npm run lint    # house style (no em-dashes in shipped text)
```

`dist/` is committed on purpose: git installs then skip build scripts entirely and dsh users never see the pnpm 10 `allowBuilds` prompt.

The repo is structured like donsetch itself: `project.md` + `status.md` are private working docs, gitignored, updated after every finished task.

## License

AGPL-3.0-only, matching DonSeTch. See [donsetch](https://github.com/dondai44423/donsetch).