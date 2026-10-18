# Third-party notices and provenance

- **Appium WebDriverAgent** — https://github.com/appium/WebDriverAgent, pinned at `3d6a4e03cdd673e540289c610f7e189f8ffea434` through a Git submodule. Copyright (c) 2015-present, Facebook, Inc. All rights reserved. BSD-3-Clause terms are preserved in `third_party/WebDriverAgent-LICENSE.txt` and the upstream submodule. The patch under `patches/` modifies that BSD-licensed source and retains those terms.
- **Codex CLI** — runtime dependency installed separately as `@openai/codex@0.163.0`; no login credentials or runtime package binaries are redistributed here. Upstream: https://github.com/openai/codex.
- **Qizhan7/wda-mcp** — investigated and locally modified in the initial direct-WDA experiment. The final HTTPS architecture does not include that project's source. This repository is an independent project rather than a GitHub fork of wda-mcp.

New application code in `cloud/`, `devbox/`, `device/`, and `scripts/` is provided under this repository's MIT license, except third-party source and patches as identified above.
