"""Offline AST-only adapter seam tests: never import the SDK or the full adapter."""
import ast
import fcntl
import json
import os
import re
import importlib.util
from unittest.mock import patch
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
AFTER = "68f4c2a3c0a3aa75436a15828e325bd279995435d83931d93b12516cca303962"
TREE = ast.parse((ROOT / "src/omnigent.py").read_text())
ORIGINAL_CLASS = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == "Plugin")


class AdapterGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.events = []
        self.proof = {"schema": "plugin-native-maintenance-preservation/v2", "ok": True,
                      "state": "verified", "sourceSha256": AFTER, "sdkImported": False,
                      "distribution": "omnigent", "coreVersion": "0.16.0",
                      "consoleEntryPoint": "omnigent.cli:main", "consoleScriptValidated": True,
                      "pythonExecutable": sys.executable, "consoleScript": str(self.directory / "omnigent"),
                      "consoleScriptSha256": "a" * 64}
        self.fail_run = None
        self.refusal = None
        def run(argv, **options):
            self.events.append(("guard", argv, options))
            if self.fail_run:
                raise self.fail_run
            if self.refusal is not None:
                return types.SimpleNamespace(returncode=1, stdout=self.refusal)
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(self.proof))
        def popen(argv, **options):
            self.events.append(("spawn", argv, options))
            return types.SimpleNamespace(pid=1234)
        fake_subprocess = types.SimpleNamespace(run=run, Popen=popen, DEVNULL=subprocess.DEVNULL,
                                                PIPE=subprocess.PIPE, TimeoutExpired=subprocess.TimeoutExpired)
        selected = [n for n in ORIGINAL_CLASS.body if isinstance(n, ast.FunctionDef)
                    and n.name in ("require_maintenance_preservation", "ensure_host")]
        error = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == "PluginError")
        helpers = [n for n in TREE.body
                   if (isinstance(n, ast.FunctionDef) and n.name in ("maintenance_refusal_reason", "maintenance_message"))
                   or (isinstance(n, ast.Assign) and any(getattr(x, "id", None) == "_MAINTENANCE_REASON" for x in n.targets))]
        self.assertEqual(len(helpers), 3)
        program = ast.Module(body=[error, *helpers, ast.ClassDef(name="FixturePlugin", bases=[], keywords=[],
                             body=selected, decorator_list=[])], type_ignores=[])
        ns = dict(Path=Path, sys=sys, json=json, re=re, subprocess=fake_subprocess, os=os, shutil=shutil,
                  fcntl=fcntl, _SCRIPT_DIR=ROOT / "src", atomic_json=lambda *a: None)
        exec(compile(ast.fix_missing_locations(program), "adapter-seam-fixture", "exec"), ns)
        self.error = ns['PluginError']
        self.plugin = ns['FixturePlugin']()
        p = self.plugin
        p.request = {"omnigentBin": str(self.directory / "omnigent"), "allowManagedHost": True}
        Path(p.request['omnigentBin']).write_text('SYNTHETIC EXECUTABLE NEVER RUN\n')
        Path(p.request['omnigentBin']).chmod(0o700)
        p.state_dir = self.directory / 'state'
        p.workspace = self.directory
        p.local_host = lambda: self.events.append(('local-host',)) or {"managerRunning": True}
        p.managed_host_pid = lambda server: None
        p.process_identity = lambda pid: {}

    def test_existing_manager_early_return_still_requires_guard(self):
        self.assertEqual(self.plugin.ensure_host('https://fixture.invalid'), 'kit')
        self.assertEqual([e[0] for e in self.events], ['guard', 'local-host'])
        _, argv, options = self.events[0]
        self.assertEqual(argv[:3], [sys.executable, '-I', '-B'])
        self.assertEqual(argv[3], str(ROOT / 'src/maintenance_preservation.py'))
        self.assertEqual(options['timeout'], 30)
        self.assertEqual(options['stdin'], subprocess.DEVNULL)

    def test_drift_blocks_before_existing_manager_lookup_and_no_spawn(self):
        self.proof['sourceSha256'] = '0' * 64
        with self.assertRaises(self.error) as caught:
            self.plugin.ensure_host('https://fixture.invalid')
        self.assertEqual(caught.exception.code, 'MAINTENANCE_PRESERVATION_REQUIRED')
        self.assertEqual([e[0] for e in self.events], ['guard'])
        self.assertFalse(self.plugin.state_dir.exists())

    def test_guard_reason_reaches_the_error_message(self):
        self.refusal = json.dumps({"ok": False, "code": "MAINTENANCE_PRESERVATION_REQUIRED", "reason": "unsafe-source-file"})
        with self.assertRaises(self.error) as caught:
            self.plugin.ensure_host('https://fixture.invalid')
        self.assertEqual(caught.exception.code, 'MAINTENANCE_PRESERVATION_REQUIRED')
        self.assertIn('unsafe-source-file', caught.exception.message)
        self.assertIn('pi-omnigent repair --update', caught.exception.message)
        self.assertFalse(any(e[0] == 'spawn' for e in self.events))

    def test_refusal_text_that_is_not_a_token_never_reaches_the_message(self):
        for stdout in ('SENSITIVE /home/user/secret', '[' * 100000, json.dumps({"ok": False, "code": "MAINTENANCE_PRESERVATION_REQUIRED",
                                                                  "reason": "/home/user/SENSITIVE"}),
                       json.dumps({"ok": False, "code": "OTHER", "reason": "unsafe-source-file"})):
            with self.subTest(stdout=stdout):
                self.refusal = stdout
                with self.assertRaises(self.error) as caught:
                    self.plugin.ensure_host('https://fixture.invalid')
                self.assertIn('guard-refused', caught.exception.message)
                self.assertNotIn('SENSITIVE', caught.exception.message)

    def test_failure_kinds_have_fixed_reasons(self):
        self.proof['sourceSha256'] = '0' * 64
        with self.assertRaises(self.error) as caught:
            self.plugin.ensure_host('https://fixture.invalid')
        self.assertIn('unexpected-guard-result', caught.exception.message)
        self.fail_run = subprocess.TimeoutExpired('fixture-guard', 30)
        with self.assertRaises(self.error) as caught:
            self.plugin.ensure_host('https://fixture.invalid')
        self.assertIn('guard-run-failed', caught.exception.message)

    def test_timeout_and_os_errors_cannot_start_host(self):
        for failure in (subprocess.TimeoutExpired('fixture-guard', 30), OSError('synthetic refusal')):
            with self.subTest(failure=type(failure).__name__):
                self.fail_run = failure
                with self.assertRaises(self.error):
                    self.plugin.ensure_host('https://fixture.invalid')
        self.assertFalse(any(e[0] == 'spawn' for e in self.events))

    def test_malformed_or_checked_proof_cannot_start_host(self):
        for value in (None, [], {}, {**self.proof, 'state': 'checked'},
                      {**self.proof, 'sdkImported': True}, {**self.proof, 'ok': False}):
            with self.subTest(proof=value):
                self.proof = value
                with self.assertRaises(self.error):
                    self.plugin.ensure_host('https://fixture.invalid')
        self.assertFalse(any(e[0] == 'spawn' for e in self.events))

    def test_guard_runs_again_under_launch_lock_immediately_before_fake_spawn(self):
        self.plugin.local_host = lambda: {'managerRunning': False}
        original = dict(os.environ)
        try:
            for k in ('OG_HOST_ENABLED',):os.environ.pop(k, None)
            os.environ.update(PYTHONPATH='FOREIGN', PYTHONHOME='FOREIGN', PYTHONPYCACHEPREFIX='FOREIGN')
            self.assertEqual(self.plugin.ensure_host('https://fixture.invalid'), 'plugin')
        finally:
            os.environ.clear();os.environ.update(original)
        self.assertEqual([e[0] for e in self.events], ['guard', 'guard', 'spawn'])
        _, argv, options = self.events[-1]
        self.assertEqual(argv[:5], [sys.executable, '-I', '-B', self.plugin.request['omnigentBin'], 'host'])
        self.assertFalse(any(k in options['env'] for k in ('PYTHONPATH', 'PYTHONHOME', 'PYTHONPYCACHEPREFIX')))
        self.assertEqual(options['env']['PYTHONNOUSERSITE'], '1')
        self.assertEqual(options['env']['PYTHONSAFEPATH'], '1')

    def test_connect_and_resume_both_use_guarded_ensure_host_boundary(self):
        for name in ('connect', 'resume'):
            method = next(n for n in ORIGINAL_CLASS.body if isinstance(n, ast.FunctionDef) and n.name == name)
            calls = [n for n in ast.walk(method) if isinstance(n, ast.Call)
                     and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
                     and n.func.value.id == 'self' and n.func.attr == 'ensure_host']
            self.assertEqual(len(calls), 1, name)


class IdentityReadBoundsTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('owned_identity_guard_fixture', ROOT / 'src/maintenance_preservation.py')
        self.guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.guard)  # stdlib-only guard, no SDK import.
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_infinite_directory_generator_stops_during_enumeration_by_global_cap(self):
        guard = self.guard
        class Stream:
            count = 0
            def __enter__(self):return self
            def __exit__(self, *args):return False
            def __iter__(self):return self
            def __next__(self):
                self.count += 1
                return types.SimpleNamespace(name=f'ordinary-package-{self.count}')
        stream = Stream()
        with patch.object(guard.os, 'scandir', return_value=stream) as scan:
            with self.assertRaises(guard.PreservationRequired):
                guard.distribution_identity(self.root, '0.16.0', guard.IdentityBudget())
        self.assertEqual(stream.count, 8193)
        self.assertIsInstance(scan.call_args.args[0], int)

    def test_enumeration_deadline_progress_checked_before_count_cap(self):
        guard = self.guard
        class Stream:
            count = 0
            def __enter__(self):return self
            def __exit__(self, *args):return False
            def __iter__(self):return self
            def __next__(self):
                self.count += 1
                return types.SimpleNamespace(name=f'ordinary-{self.count}')
        stream = Stream()
        with patch.object(guard.time, 'monotonic', side_effect=iter(range(10000))), \
                patch.object(guard.os, 'scandir', return_value=stream):
            with self.assertRaises(guard.PreservationRequired):
                guard.distribution_identity(self.root, '0.16.0', guard.IdentityBudget())
        self.assertEqual(stream.count, 11)

    def test_stable_console_read_rejects_replaced_path_identity(self):
        guard = self.guard
        target = self.root / 'omnigent'
        target.write_bytes(b'#!/fixture/python\n')
        original = Path.lstat
        def changed(path):
            info = original(path)
            if path != target:return info
            keys = ('st_dev','st_ino','st_mode','st_nlink','st_uid','st_gid','st_size','st_mtime_ns','st_ctime_ns')
            result = types.SimpleNamespace(**{k:getattr(info,k) for k in keys})
            result.st_ino += 1
            return result
        with patch.object(Path, 'lstat', changed):
            with self.assertRaises(guard.PreservationRequired):
                guard.read_plain(target, 4096)

    def test_metadata_budget_shared_and_no_bulk_listdir_path(self):
        guard = self.guard
        budget = guard.IdentityBudget()
        budget.tick(names=8190)
        budget.tick(names=2)
        with self.assertRaises(guard.PreservationRequired):budget.tick(names=1)
        tree = ast.parse((ROOT / 'src/maintenance_preservation.py').read_text())
        self.assertFalse(any(isinstance(n, ast.Attribute) and n.attr == 'listdir' for n in ast.walk(tree)))


if __name__ == '__main__':
    unittest.main(verbosity=2)
