# Changelog

## v0.7.0 Preview — 2026-10-21

Experimental distribution release. Runtime orchestration remains version 0.7.0; the new onboarding tools do not alter an existing installation automatically.

- Continuable native Solvers, explicit handoffs, supervision, review and durable task state.
- Required skill/reference delivery before child inference, while keeping other skills discoverable.
- Scoped read-only memory grants, separate source permissions, neutral review and premise invalidation.
- Finite byte-transform search with explicit ranges, coverage, candidate criteria and replay.
- New read-only installation preview, conflict backups, dependency doctor and separate full-mode overlay.
- Two reproducible synthetic examples, three-language README entry points, contribution guide and synthetic CI.

Distribution acceptance: 10 Linux installer tests (8 applicable tests on Windows, 2 Linux-only skips), 13 recovery tests, 15 existing synthetic/native regression groups, both examples, and a native-host boot using the installer-generated overlay. All model adapters were local/deterministic; no configured model service was called.

Validated host: Linux/WSL, DSH 0.1.5-rc.3, Node.js 24.21.0, Python 3.10+. Native Windows plugin integration is not accepted by this release. Specialist tools and model configuration are installed separately. Full installation requires the explicit database initialization and new-profile steps in [QUICKSTART](docs/QUICKSTART.md).

Synthetic tests exercise mechanisms without external model or target requests. They do not establish real-model solving quality. The **2026-10-18 TSecBench v1 local-mode** record (96.94, 22300 points, 71/74 flags) predates this distribution release; it is not a fresh v0.7.0 evaluation or a claim of benchmark improvement.

Orchestration remains opt-in and experimental. See the README for resource-control and lifecycle limitations. When upgrading, pause/drain work, inspect the installer preview and preserve current state; do not restore an old database over newer work.
