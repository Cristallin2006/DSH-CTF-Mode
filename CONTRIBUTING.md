# Contributing

欢迎改善知识、复现材料、安装体验和宿主兼容性。首次贡献可从文档修正、合成示例或单一工具兼容性开始；请先描述具体问题和预期行为。中文、English、日本語均欢迎。

## Useful reports

- Installation: OS/WSL, Python/Node/DSH versions, installation mode and the failing step.
- Knowledge: the missing method, conditions where it applies, a public reference and a small reproducible example.
- Runtime: expected/observed behavior and a synthetic fixture. State whether the issue involves fresh installation, upgrade or cancellation.

Please remove API keys, cookies, VPN details, private target addresses, profile files and real session/database contents. A minimal redacted error is better than a full private dump. Do not attach real credentials or target data.

## Local checks

Run in Linux/WSL with Python 3.10+ and Node.js 24+:

```bash
python3 tests/setup.py
python3 tests/recovery.py
python3 tests/knowledge-contracts.py
python3 tests/knowledge.py
node tests/knowledge-package.mjs
python3 tests/run.py
```

Optional native-host checks need installed DSH (validated on 0.1.5-rc.3):

```bash
export DSH_NATIVE_PACKAGE_ROOT="$(npm root -g)/@deepseek-ai/dsh"
python3 tests/run.py --native
node tests/setup-native.mjs
node tests/knowledge-package.mjs --native
```

Tests use synthetic inputs and local deterministic adapters. They must not call external model services or live targets. Fixture reports and state belong in temporary/ignored directories. Test installation changes in a fresh home; do not overwrite an active installation.

Keep specialist methods in skills/references, durable constraints in the runtime, and analysis judgments with the model. Knowledge does not grant permissions. Avoid benchmark-specific answers, forced enumeration counts and unsupported performance claims. Explain what a check proves and what remains uncertain.

When adding or removing installable files, update `tools/install-manifest.json`. Only its listed public files are copied; unlisted local files are intentionally excluded. Validate a full-mode preview against the distribution as well as running the fixture tests.

Describe changes with a concrete before/after, validation and relevant compatibility limits. Maintain the three README overviews when changing public installation or capability claims. Credit borrowed code/knowledge and check license terms; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
