# Attribution and provenance

## Source snapshot

This package was assembled on November 13, 2026 from a customized Windows Herdr configuration.
The inspected desktop executable reported `herdr-app 0.1.15`; the installed core reported `hc 0.1.21`.
The original layout and mod `cloned_from` metadata are retained.
The snapshot contains only the runtime source and assets explicitly listed in [bundle.json](bundle.json), the theme, and selected custom key bindings.
No live settings, user state, terminal/session data, generated API typings, backups, or credentials are distributed.

## Shipped-derived code

| Bundled item | Recorded origin |
| --- | --- |
| `layouts\files-left.json` | Herdr `main`, version `0.1.15` |
| `layout-chrome` | Herdr `workspace-chrome`, version `0.1.15`; sidebar mark replaced |
| `files-tiled` | Herdr `files`, version `0.1.15` |
| `agents-titles` | Herdr `agents`, version `0.1.15` |
| `tabs-tiling` | Herdr `tabs`, version `0.1.15` |
| `pane-fork` | Herdr `pane`, version `0.1.15` |
| `scratchpad-markdown` | Local `scratchpad-space` clone, recorded version `0.1.15` |
| `custom-palette` | Customized Herdr-style palette and workspace status code; no clone metadata in its manifest |
| `files-switch` | Local Files/Changes stack-switch helper |
| Theme | Aurum, a locally customized palette inspired by Ayu Dark |

The shipped-derived code and associated SVG glyphs remain attributable to their original Herdr contributors.
Several shipped glyphs identify Lucide in their SVG class names and remain attributable to the original icon contributors.
The palette contains adapted shipped-style command listing, fuzzy ranking, scrolling, and status-strip behavior.
Local customizations include the agent/space tree, conversation titles, split dispatch and balancing, real conversation fork helper, bounded explorer, Markdown save protection, and unified custom actions.

For packaging, Files is initially visible and every copied Copilot launch array omits unrestricted mode.
Toolbar launch tooltips now derive from those arrays.
Feature logic was otherwise preserved.
Runtime JavaScript files carry prominent modification notices; these identify modifications without asserting that locally added helpers originated upstream.
The focused title, palette, and scratchpad tests were adapted from local regression tests to use repository-relative source paths.

## Branding and licenses

The previous Microsoft product mark is excluded from this public package.
`mods\layout-chrome\mark.svg` uses the owner's requested three-leaf fan geometry, adapted as a theme-tinted mask with distinct leaf opacities.
Neither it nor the illustrative preview implies product or employer endorsement.
Herdr, GitHub Copilot, and other product names remain attributable to their respective owners.

[Herdr's public site](https://herdr.dev) identifies the app, core, and TUI as Apache-2.0 open source.
The [public app repository](https://github.com/herdrdev/herdr-app) provides its [Apache-2.0 license](https://github.com/herdrdev/herdr-app/blob/master/LICENSE) and [third-party notices](https://github.com/herdrdev/herdr-app/blob/master/THIRD-PARTY-NOTICES).
Upstream portions retain those terms and their original notices.
The included [LICENSE](LICENSE), [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES), and [Lucide notice](LICENSE-Lucide.txt) preserve the applicable upstream texts.
The owner requested public redistribution of the local customizations; this document does not invent a blanket license for them or grant trademark rights.

## Public-readiness review

The review read all 55 tracked text files in the source snapshot and copied only explicitly tracked distributable files into a fresh directory, without Git history.
The original image and previous product mark were excluded; the public preview is illustrative sample content.
The reviewed text contained no identified internal project source, internal service endpoints, embedded credentials, personal email addresses, or session data.
Runtime references to local Copilot session files describe functionality, not bundled conversations.
This is a content review of the snapshot, not proof of authorship, employment-related ownership, complete upstream provenance, or the absence of every possible confidential detail.
Public publication still requires review of the final preview, notices, and fresh commit metadata.
