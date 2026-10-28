#!/usr/bin/env python3
"""Isolated installer safety tests; never uses the user's DSH home."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('distribution_setup', ROOT / 'tools/setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class InstallerTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'Managed RE bridge requires Linux')
    def test_re_bridge_is_opt_in_and_does_not_edit_profiles(self):
        home=Path(tempfile.gettempdir())/('dsh-re-install-contract-'+__import__('uuid').uuid4().hex)
        with patch.object(setup,'ROOT',ROOT):default=setup.plan(home,'full')
        self.assertNotIn('plugins/re-workbench/index.mjs',default)
        with patch.object(setup,'ROOT',ROOT):selected=setup.plan(home,'full',re_owner_root='/tmp/explicit-re-owner',re_realm='test')
        self.assertIn('plugins/re-workbench/index.mjs',selected)
        overlay=json.loads(selected['launch/re-workbench.patch.json'])
        self.assertEqual(overlay[0]['insert'][0]['config']['realm'],'test')
        self.assertFalse(any(p.startswith('profiles/') for p in selected))

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dsh-setup-test-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.home = self.base / 'home'
        # Tiny independent distribution fixture; the real package is exercised by setup-native.mjs.
        source = self.base / 'source'
        files = {'skills/ghidra-core/SKILL.md': b'# Synthetic skill',
                 'skills/second/SKILL.md': b'# Another synthetic skill',
                 'runtime/analysis-v1/session.py': b'# Synthetic runtime placement',
                 'plugins/analysis-hooks-sandbox/index.mjs': b'// Synthetic adapter placement',
                 'plugins/analysis-memory/index.mjs': b'// Synthetic memory placement',
                 'plugins/analysis-orchestration/index.mjs': b'// Synthetic orchestration placement',
                 'dsh-hooks/analysis_hook.py': b'# Synthetic hook placement'}
        for rel, data in files.items():
            path = source / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (source / 'tools').mkdir()
        (source / 'tools/install-manifest.json').write_text(json.dumps(list(files)))
        self.addCleanup(patch.stopall)
        patch.object(setup, 'ROOT', source).start()

    def test_unlisted_files_are_not_copied_and_missing_sources_fail(self):
        (setup.ROOT / 'skills/private.txt').write_text('not public')
        self.run_setup('--apply')
        self.assertFalse((self.home / 'skills/private.txt').exists())
        (setup.ROOT / 'skills/second/SKILL.md').unlink()
        with self.assertRaisesRegex(ValueError, 'Required public source file missing'):
            self.run_setup()

    def run_setup(self, *args):
        stream = io.StringIO()
        with patch.object(sys, 'argv', ['setup.py', '--home', str(self.home), *args]), contextlib.redirect_stdout(stream):
            code = setup.main()
        self.assertEqual(code, 0)
        return json.loads(stream.getvalue())

    def test_preview_does_not_create_home(self):
        result = self.run_setup()
        self.assertFalse(result['applied'])
        self.assertGreater(result['changed_files'], 0)
        self.assertFalse(self.home.exists())

    def test_install_idempotent_and_unrelated_file_preserved(self):
        self.home.mkdir()
        unrelated = self.home / 'keep.txt'
        unrelated.write_text('private unrelated fixture')
        result = self.run_setup('--apply')
        self.assertTrue(result['applied'])
        self.assertTrue((self.home / 'skills/ghidra-core/SKILL.md').is_file())
        self.assertEqual(unrelated.read_text(), 'private unrelated fixture')
        self.assertFalse((self.home / 'profiles').exists())
        self.assertFalse((self.home / 'analysis-state').exists())
        self.assertTrue(self.run_setup('--apply')['unchanged'])

    def test_conflict_requires_replace_and_original_is_backed_up(self):
        path = self.home / 'skills/ghidra-core/SKILL.md'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'LOCAL FIXTURE')
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            self.run_setup('--apply')
        self.assertEqual(path.read_bytes(), b'LOCAL FIXTURE')
        result = self.run_setup('--apply', '--replace')
        backup = Path(result['backup'])
        self.assertEqual((backup / 'original/skills/ghidra-core/SKILL.md').read_bytes(), b'LOCAL FIXTURE')
        self.assertNotEqual(path.read_bytes(), b'LOCAL FIXTURE')
        if sys.platform == 'linux':
            self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
            self.assertEqual((backup / 'manifest.json').stat().st_mode & 0o777, 0o600)

    def test_hook_merge_preserves_other_groups_and_keys(self):
        path = self.home / 'hooks/hooks.json'
        path.parent.mkdir(parents=True)
        original = {'private_fixture': 7, 'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'echo fixture'}]}]}}
        path.write_text(json.dumps(original))
        value = json.loads(setup.hooks_config(self.home))
        self.assertEqual(value['private_fixture'], 7)
        self.assertEqual(value['hooks']['Stop'][0], original['hooks']['Stop'][0])
        self.assertEqual(len(value['hooks']), 6)
        path.write_bytes(setup.encoded(value))
        self.assertEqual(json.loads(setup.hooks_config(self.home)), value)

    def test_conflicting_hook_in_later_group_is_refused(self):
        path = self.home / 'hooks/hooks.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'hooks': {'Stop': [{'hooks': []}, {'hooks': [{'command': 'wrong analysis_hook.py'}]}]}}))
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            setup.hooks_config(self.home)

    def test_active_work_blocks_writes(self):
        state = self.home / 'analysis-state'
        state.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(state / 'state.sqlite3')) as db:
            db.execute('CREATE TABLE orch_work(data TEXT)')
            db.execute('INSERT INTO orch_work VALUES(?)', (json.dumps({'state': 'cleanup_unknown'}),))
            db.commit()
        with self.assertRaisesRegex(ValueError, 'active or cleanup'):
            self.run_setup('--apply')
        self.assertFalse((self.home / 'skills').exists())

    @unittest.skipUnless(sys.platform == 'linux', 'Linux symlinks')
    def test_destination_and_state_symlinks_are_refused(self):
        outside = self.base / 'outside'
        outside.mkdir()
        self.home.mkdir()
        (self.home / 'skills').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            self.run_setup('--apply')
        (self.home / 'skills').unlink()
        (self.home / 'analysis-state').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlink state'):
            self.run_setup('--apply')
        self.assertFalse(list(outside.iterdir()))

    @unittest.skipUnless(sys.platform == 'linux', 'Full integration requires Linux')
    def test_full_mode_generates_overlay_without_profile_or_database(self):
        self.run_setup('--mode', 'full')
        self.assertFalse(self.home.exists())
        self.run_setup('--mode', 'full', '--apply')
        rows = json.loads((self.home / 'launch/ctf-orchestration.patch.json').read_text())[0]['insert']
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[-1]['config']['stateRoot'], str(self.home / 'analysis-state'))
        self.assertTrue((self.home / 'runtime/analysis-v1/session.py').is_file())
        self.assertFalse((self.home / 'profiles').exists())
        self.assertFalse((self.home / 'analysis-state/state.sqlite3').exists())

    def test_failed_write_restores_completed_writes(self):
        original_atomic = setup.atomic
        count = 0
        def fail_once(path, data, mode=0o644):
            nonlocal count
            if path.is_relative_to(self.home / 'skills'):
                count += 1
                if count == 2:
                    raise OSError('synthetic write failure')
            return original_atomic(path, data, mode)
        with patch.object(setup, 'atomic', side_effect=fail_once), self.assertRaisesRegex(OSError, 'synthetic'):
            self.run_setup('--apply')
        self.assertFalse(any(path.is_file() for path in (self.home / 'skills').rglob('*')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
