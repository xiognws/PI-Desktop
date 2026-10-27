# Bundled plugins

Plugins that ship inside the application instead of the user data directory.
They survive a data-directory reset and are present on a fresh install, so a
first start already has the toolset this distribution is built around.

Adding a plugin here means **redistributing someone else's code**. Every entry
below records the version and the sha256 the package was verified against, so a
review can trace it back to the catalog it came from.

- Source catalog: `https://plugins.aiuo.net/catalog.json`
- Artifact base: `https://raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main`
- Total size: 22.1 MB (20 plugins)

## Inventory

| Plugin | Version | Author | License | sha256 (first 16) | Size |
|---|---|---|---|---|---|
| `cc.fee.pi-terminal` | 1.0.0 | Sunrise | Apache-2.0 | 75f9641e3df48ac1… | 5.8 MB |
| `cn.star.skill-learning` | 0.1.8 | TheFlareStar | MPL-2.0 | c19a352f62e80a22… | 0.1 MB |
| `com.opencode2pi` | 0.5.5 | — | MIT | c9fbaf59aa9d7762… | 0.2 MB |
| `community.workbuddy-connect` | 0.4.1 | — | MIT | dd22733e0c80495a… | 0.5 MB |
| `hawchou.mumu-player` | 0.3.1 | hawchou1995 | MIT | 498c2cdc1e23bf79… | 0.3 MB |
| `io.github.chengzhi-c.pi-desktop-wtq-pool` | 1.1.0 | chengzhi-c (PI-Desktop port of XDTrees/dsh-workbuddy-xdpool) | MIT | ff92a5f95da8cdd8… | 1.0 MB |
| `io.github.czp0312.subscription-quota` | 0.4.2 | czp0312 | MIT | 840ccf87ae96b269… | 0.1 MB |
| `io.github.eureka-0x01.open-with` | 0.1.0 | Eureka-0x01 | MIT | 71a70359eefe9a29… | 0.1 MB |
| `io.github.mafeis.layout-control` | 0.1.4 | mafeis | MIT | 15bb048a108905a0… | 0.0 MB |
| `io.github.techd81.pi-desktop-usage` | 0.1.1 | Techd81 | MIT | 37cb41d7ec01bc06… | 0.3 MB |
| `io.github.xideadev.skill-hub` | 0.1.0 | xidea | MIT | 29b9c435fd5023f9… | 0.1 MB |
| `local.diff-view` | 1.4.50 | new-Beginner | MIT | 3bd079699a6facae… | 2.8 MB |
| `local.pi-canvas` | 0.1.5 | payAgain | MIT | 8fddac21ff72cf33… | 7.4 MB |
| `local.pi-commandcode-desktop` | 0.2.0 | PI-Desktop port of patlux/pi-commandcode-provider | MIT | d33155a2a1e1d27f… | 0.5 MB |
| `local.pi-desktop-workbuddy` | 1.0.7 | PI-Desktop port of aosi526/dsh-workbuddy-xdpool | MIT | 87f6e75a0c876b0d… | 0.3 MB |
| `local.pi-session-filter` | 0.4.0 | mai-ming | MIT | d4f44cae088812fe… | 0.1 MB |
| `pi.browser` | 1.0.0 | PI-Desktop | not declared | — | 0.0 MB |
| `pi.file-manager` | 0.5.3-pi.1 | Tioit-Wang | MIT | — | 1.4 MB |
| `pi.prompt-enhancement` | 1.3.0 | vastsa | LGPL-3.0-only | 474f81401817d1fe… | 0.0 MB |
| `pi.theme.studio` | 1.5.0 | PI-Desktop | not declared | 3d3bbd50ef59d52c… | 1.0 MB |

## Rules

- **A bundled plugin is not a marketplace install.** It reports
  `source: "builtin"` and `bundled: true`, cannot be uninstalled, and can still
  be updated from the marketplace (ADR 0241).
- **`pi.browser` and `pi.file-manager` are maintained here**, not upstream:
  `pi.file-manager` is the `-pi` fork. Do not overwrite either with a
  marketplace package — a marketplace `pi.file-manager` drops `UPSTREAM.md`,
  its `LICENSE` and the local patches.
- **Licenses are recorded, not inferred.** `pi.browser` and `pi.theme.studio`
  declare none in their manifests; treat them as "no license stated" and ask the
  author before shipping this bundle outside the organisation.
- Refreshing a plugin means re-verifying its sha256 against the catalog, never
  copying whatever the newest archive happens to be.
