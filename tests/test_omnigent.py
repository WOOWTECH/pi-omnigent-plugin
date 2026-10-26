"""Isolated contract tests; no real server login or agent turn is sent."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pi_omnigent_adapter", ROOT / "src" / "omnigent.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class FakeAuth:
    def __init__(self, token="existing-test-token"):
        self.value = token
        self.saved = []
        self.reads = []
        self.cleared = []

    def token(self, server, *, refresh=True):
        self.reads.append((server, refresh))
        return self.value

    def save(self, server, body):
        self.saved.append((server, body))
        self.value = body["token"]

    def clear(self, server):
        self.cleared.append(server)
        self.value = None


class FakeClient:
    def __init__(self, auth_mode="accounts", readiness=True, items=None, offline=False):
        self.auth_mode = auth_mode
        self.readiness = readiness
        self.items = items if items is not None else [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": adapter.SENTINEL}]}]
        self.offline = offline
        self.calls = []
        self.poll_error = None
        self.session_info = {}
        self.stop_error = None
        self.stop_errors = []
        self.stop_attempts = []
        self.cleanup_options = None
        self.held_token = None

    def hold_token(self, token):
        self.held_token = token

    def auth_probe(self):
        return self.auth_mode

    def request(self, method, path, payload=None, *, authenticated=True, timeout_seconds=15.0, refresh_auth=None):
        self.calls.append((method, path, payload, authenticated))
        if path == "/auth/login":
            return {"token": "server-test-token", "refresh_token": "server-test-refresh", "user": {"id": "test-user"}, "expires_in": 3600}
        if path == "/v1/me":
            return {"id": "test-user"}
        if path == "/v1/hosts":
            return {"hosts": [{"host_id": "another-machine", "status": "online"},
                              {"host_id": "this-machine", "name": "test host", "status": "offline" if self.offline else "online",
                               "configured_harnesses": {data["harness"]: self.readiness for data in adapter.ENGINES.values()}}]}
        if path == "/v1/harnesses":
            return {"data": [{"id": "claude-native", "label": "Claude Code", "unknownSecret": "do-not-output-this"}]}
        if path.startswith("/v1/agents?"):
            return {"data": [{"id": "agent-" + key, "name": data["agent"], "harness": data["harness"]} for key, data in adapter.ENGINES.items()], "has_more": False}
        if path.endswith("/model-options"):
            return {"models": [{"id": "real-model", "displayName": "Real Model", "isDefault": True, "api_key": "do-not-output-this"}]}
        if path == "/v1/sessions" and method == "POST":
            return {"id": "own-verification-session"}
        if path == "/v1/sessions/own-verification-session" and method == "GET":
            return self.session_info
        if "/items?" in path:
            if self.poll_error:
                raise self.poll_error
            return {"data": self.items}
        if path.endswith("/events"):
            self.cleanup_options = {"timeout_seconds": timeout_seconds, "refresh_auth": refresh_auth}
            if payload.get("type") == "stop_session":
                self.stop_attempts.append(self.cleanup_options)
                if self.stop_errors:
                    raise self.stop_errors.pop(0)
            if self.stop_error:
                raise self.stop_error
            return {"ok": True}
        raise AssertionError((method, path))


class FakeClock:
    value = 0

    def clock(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class AdapterTests(unittest.TestCase):
    def setUp(self):
        import yaml

        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.config_home = self.home / "config"
        self.config_home.mkdir()
        self.environment = patch.dict(os.environ, {"HOME": str(self.home), "OMNIGENT_CONFIG_HOME": str(self.config_home),
                                                   "OMNIGENT_DATA_DIR": str(self.config_home), "OG_HOST_ENABLED": "0", "CODEX_HOME": str(self.home / '.codex'),
                                                   "OG_STATUS_FILE": str(self.home / "absent-status.json")})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.tmp.cleanup)
        self.initial_config = {"server": "https://server.example", "host": {"host_id": "this-machine", "name": "original host"},
                               "custom": {"keep": True}, "providers": {"existing-pi": {"kind": "subscription", "cli": "pi", "default": "pi"}}}
        (self.config_home / "config.yaml").write_text(yaml.safe_dump(self.initial_config))
        self.auth = FakeAuth()
        self.client = FakeClient()
        self.clock = FakeClock()

    def plugin(self, **request):
        return adapter.Plugin({"configHome": str(self.config_home), "workspace": str(self.home), **request},
                              auth=self.auth, client_factory=lambda *args: self.client,
                              sleeper=self.clock.sleep, clock=self.clock.clock)

    def assert_code(self, expected, function):
        with self.assertRaises(adapter.PluginError) as context:
            function()
        self.assertEqual(context.exception.code, expected)

    def test_normalization_rejects_credentials_and_query_tokens(self):
        self.assertEqual(adapter.normalize_server("HTTPS://SERVER.EXAMPLE/base/"), "https://server.example/base")
        for value in ("https://user:secret@server.example", "https://server.example?token=secret", "javascript:alert(1)", "http://server.example", "https://server.example/#secret", "https://server.example\n"):
            if value.endswith("\n"):
                # Whitespace around a URL can be pasted safely.
                self.assertEqual(adapter.normalize_server(value), "https://server.example")
            else:
                self.assert_code("INVALID_SERVER", lambda value=value: adapter.normalize_server(value))
        self.assertEqual(adapter.normalize_server("http://127.0.0.1:6767"), "http://127.0.0.1:6767")

    def test_status_is_read_only_and_online_requires_exact_identity(self):
        before = {path.relative_to(self.home): path.read_bytes() for path in self.home.rglob("*") if path.is_file()}
        with patch.object(adapter.shutil, "which", return_value=None):
            result = self.plugin().status()
        after = {path.relative_to(self.home): path.read_bytes() for path in self.home.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertTrue(result["host"]["connected"])
        self.assertEqual(result["host"]["id"], "this-machine")
        self.assertEqual(set(result["engines"]), {"claude", "codex", "pi"})
        self.client.offline = True
        self.assertFalse(self.plugin().status()["host"]["connected"])

    def test_status_uses_inventory_without_duplicate_cli_probes_but_checks_host_each_time(self):
        inventory = {key: {"installed": True, "version": "1.2.3"} for key in adapter.ENGINES}
        with patch.object(adapter.subprocess, "run", side_effect=AssertionError("duplicate version probe")):
            self.assertTrue(self.plugin(engineInventory=inventory).status()["host"]["connected"])
            self.client.offline = True
            result = self.plugin(engineInventory=inventory).status()
        self.assertFalse(result["host"]["connected"])
        self.assertEqual(result["engines"]["pi"]["version"], "1.2.3")
        self.assertEqual(sum(call[1] == "/v1/hosts" for call in self.client.calls), 2)

    def test_verify_only_fetches_selected_engine_models(self):
        result = self.plugin(engine="pi", model="real-model").verify()
        self.assertTrue(result["ok"])
        paths = [call[1] for call in self.client.calls]
        self.assertEqual([path for path in paths if path.endswith("/model-options")],
                         ["/v1/hosts/this-machine/harnesses/pi-native/model-options"])
        self.assertNotIn("/v1/harnesses", paths)

    def test_claude_probe_uses_session_default_mode_and_settles_before_its_only_prompt(self):
        original = self.client.request
        events = []
        def request(method, path, payload=None, **kwargs):
            if path.endswith('/events') and payload.get('type') == 'message':
                events.append(self.clock.clock())
            return original(method, path, payload, **kwargs)
        self.client.request = request
        self.assertTrue(self.plugin(engine='claude').verify()['ok'])
        self.assertEqual(events, [3.0])
        created = next(call[2] for call in self.client.calls if call[1] == '/v1/sessions')
        self.assertNotIn('permission_mode', created)
        self.assertNotIn('policy', created)
        self.assertEqual(created['terminal_launch_args'], ['--permission-mode', 'default'])

    def test_claude_startup_deadline_stops_session_without_sending_a_late_prompt(self):
        result = self.plugin(engine='claude', timeoutSeconds=1).verify()
        self.assertEqual(result['reason'], 'NATIVE_START_TIMEOUT')
        self.assertEqual(result['cleanup'], 'stopped')
        self.assertFalse(any(call[1].endswith('/events') and call[2].get('type') == 'message' for call in self.client.calls))

    def test_unavailable_engines_do_not_request_model_options(self):
        self.client.readiness = 'binary-missing'
        self.plugin().catalog()
        self.assertFalse(any(call[1].endswith('/model-options') for call in self.client.calls))

    def test_only_complete_fixed_probe_inside_last_composer_can_be_recovered(self):
        rule = '─' * 80
        self.assertTrue(adapter.Plugin.exact_probe_draft(f'{rule}\n❯ {adapter.PROBE_PROMPT}\n{rule}'))
        self.assertTrue(adapter.Plugin.exact_probe_draft(f'{rule}\n❯ \n  {adapter.PROBE_PROMPT}\n\n{rule}'))
        for text in [f'❯ {adapter.PROBE_PROMPT}\n{rule}\n❯ \n{rule}',
                     f'{rule}\n❯ {adapter.PROBE_PROMPT} extra\n{rule}',
                     f'{rule}\n❯ 2. Yes\n{rule}',
                     f'{rule}\n❯ Reply exactly\n{rule}', adapter.PROBE_PROMPT]:
            self.assertFalse(adapter.Plugin.exact_probe_draft(text))

    def test_native_probe_recovers_one_submit_without_posting_another_message(self):
        self.client.items = []
        calls = []
        def recover(sid):
            calls.append(sid)
            self.client.items = [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": adapter.SENTINEL}]}]
            return True
        p = self.plugin(engine='claude');p.probe_submit = recover
        result = p.verify()
        self.assertTrue(result['ok']);self.assertTrue(result['nativeSubmitRecovered'])
        self.assertEqual(calls, ['own-verification-session'])
        self.assertEqual(sum(call[1].endswith('/events') and call[2].get('type') == 'message' for call in self.client.calls), 1)

    def test_default_verification_preserves_existing_native_model_configuration(self):
        result = self.plugin(engine='codex').verify()
        self.assertIsNone(result['model'])
        self.assertNotIn('model_override',next(call[2] for call in self.client.calls if call[1] == '/v1/sessions'))

    def test_submit_guard_never_types_into_another_session_or_pending_dialog(self):
        from omnigent.harnesses.claude_native import bridge
        root=self.home/'bridges';directory=root/'own';directory.mkdir(parents=True)
        (directory/'tmux.json').write_text(json.dumps({'socket_path':'/own/socket','tmux_target':'own'}))
        p=self.plugin()
        with patch.object(bridge, '_BRIDGE_ROOT', root), patch.object(bridge, 'read_active_session_id', return_value='other'):
            with patch.object(adapter.subprocess, 'run', side_effect=AssertionError('must not touch other sessions')):
                self.assertFalse(p.submit_owned_probe_draft('own'))
        with patch.object(bridge, '_BRIDGE_ROOT', root), patch.object(bridge, 'read_active_session_id', return_value='own'), \
                patch.object(bridge, 'has_pending_user_prompt', return_value=True):
            with patch.object(adapter.subprocess, 'run', side_effect=AssertionError('must not answer dialogs')):
                self.assertFalse(p.submit_owned_probe_draft('own'))

    def test_submit_guard_checks_stable_exact_draft_then_sends_only_one_enter(self):
        from omnigent.harnesses.claude_native import bridge
        root=self.home/'bridges';directory=root/'own';directory.mkdir(parents=True)
        (directory/'tmux.json').write_text(json.dumps({'socket_path':'/own/socket','tmux_target':'own'}))
        rule='─'*80;pane=f'{rule}\n❯ \n {adapter.PROBE_PROMPT}\n{rule}'
        result=types.SimpleNamespace(returncode=0,stdout=pane)
        with patch.object(bridge, '_BRIDGE_ROOT', root), patch.object(bridge, 'read_active_session_id', return_value='own'), \
                patch.object(bridge, 'has_pending_user_prompt', return_value=False), \
                patch.object(bridge, '_terminal_dialog_headline', return_value=None), \
                patch.object(bridge, 'auto_mode_billing_notice_visible', return_value=False), \
                patch.object(bridge, '_history_search_footer_shown', return_value=False), \
                patch.object(adapter.time, 'sleep'), patch.object(adapter.subprocess, 'run', return_value=result) as run:
            self.assertTrue(self.plugin().submit_owned_probe_draft('own'))
        self.assertEqual(run.call_count,4)
        self.assertEqual(run.call_args_list[-1].args[0],['tmux','-S','/own/socket','send-keys','-t','own','Enter'])

    def test_submit_guard_rejects_a_draft_that_changes_during_capture(self):
        from omnigent.harnesses.claude_native import bridge
        root=self.home/'bridges';directory=root/'own';directory.mkdir(parents=True)
        (directory/'tmux.json').write_text(json.dumps({'socket_path':'/own/socket','tmux_target':'own'}))
        rule='─'*80;pane=f'{rule}\n❯ {adapter.PROBE_PROMPT}\n{rule}'
        results=[types.SimpleNamespace(returncode=0,stdout=pane),types.SimpleNamespace(returncode=0,stdout=f'{rule}\n❯\n{rule}')]
        with patch.object(bridge, '_BRIDGE_ROOT', root), patch.object(bridge, 'read_active_session_id', return_value='own'), \
                patch.object(bridge, 'has_pending_user_prompt', return_value=False), \
                patch.object(bridge, '_terminal_dialog_headline', return_value=None), \
                patch.object(bridge, 'auto_mode_billing_notice_visible', return_value=False), \
                patch.object(bridge, '_history_search_footer_shown', return_value=False), \
                patch.object(adapter.time, 'sleep'), patch.object(adapter.subprocess, 'run', side_effect=results) as run:
            self.assertFalse(self.plugin().submit_owned_probe_draft('own'))
        self.assertEqual(run.call_count,2)

    def test_disconnect_clears_exact_server_and_checks_own_host_offline(self):
        before = (self.config_home / "config.yaml").read_bytes()
        self.client.offline = True
        result = self.plugin().disconnect()
        self.assertEqual(self.auth.cleared, ["https://server.example"])
        self.assertEqual(self.client.held_token, "existing-test-token")
        self.assertFalse(result["host"]["connected"])
        self.assertEqual(result["host"]["id"], "this-machine")
        self.assertTrue(result["registrationRetained"])
        self.assertEqual(before, (self.config_home / "config.yaml").read_bytes())
        self.assertTrue(all(call[0] == "GET" for call in self.client.calls))
        self.assertNotIn("existing-test-token", json.dumps(result))

    def test_disconnect_timeout_does_not_claim_offline(self):
        self.assert_code("HOST_DISCONNECT_TIMEOUT", self.plugin(timeoutSeconds=2).disconnect)
        self.assertEqual(self.auth.cleared, ["https://server.example"])

    def test_disconnect_rejects_wrong_deployment_server_before_clearing_login(self):
        plugin = self.plugin(server="https://other.example")
        with patch.dict(os.environ, {"OG_SERVER_URL": "https://deployment.example"}), patch.object(plugin, "local_host", return_value={"managerRunning": True}):
            self.assert_code("SERVER_MANAGED_BY_DEPLOYMENT", plugin.disconnect)
        self.assertEqual(self.auth.cleared, [])
        self.assertEqual(self.client.calls, [])

    def test_catalog_only_queries_own_host_and_whitelists_fields(self):
        result = self.plugin().catalog()
        encoded = json.dumps(result)
        self.assertNotIn("do-not-output-this", encoded)
        self.assertNotIn("another-machine", encoded)
        self.assertTrue(result["engines"]["codex"]["ready"])
        self.assertEqual(result["modules"], [{"key": "claude-native", "name": "Claude Code"}])
        self.assertTrue(all(method == "GET" for method, _, _, _ in self.client.calls))
        queried = [path for _, path, _, _ in self.client.calls if "model-options" in path]
        self.assertEqual(len(queried), 3)
        self.assertTrue(all("this-machine" in path for path in queried))

    def test_codex_gateway_uses_declared_models_instead_of_stale_cli_catalog(self):
        import yaml

        self.initial_config["providers"]["codex-gateway"] = {"kind": "gateway", "default": "openai", "openai": {
            "base_url": "https://gateway.example/v1", "wire_api": "responses",
            "auth_command": "printf private-token", "models": {
                "default": "deepseek/v4-flash", "fast": "deepseek/v4-flash"}}}
        (self.config_home / "config.yaml").write_text(yaml.safe_dump(self.initial_config))
        catalog = self.plugin().catalog()
        models = catalog["engines"]["codex"]["models"]
        self.assertEqual(models, [{"id": "deepseek/v4-flash", "model": "deepseek/v4-flash",
                                   "displayName": "deepseek/v4-flash", "isDefault": True}])
        self.assertFalse(any("codex-native/model-options" in path for _, path, _, _ in self.client.calls))
        self.assertNotIn("private-token", json.dumps(catalog))
        with patch.object(adapter.Plugin, 'sync_codex_catalog'):
            result = self.plugin(engine="codex", model="deepseek/v4-flash").verify()
        self.assertTrue(result["ok"])
        created = next(payload for method, path, payload, _ in self.client.calls
                       if method == "POST" and path == "/v1/sessions")
        self.assertEqual(created["model_override"], "deepseek/v4-flash")

    def gateway_plugin(self):
        import yaml
        binary = patch.object(adapter.shutil, 'which', return_value=sys.executable)
        binary.start(); self.addCleanup(binary.stop)
        self.initial_config['providers']['gateway'] = {'kind': 'gateway', 'default': 'openai', 'openai': {
            'base_url': 'https://gateway.example/v1', 'wire_api': 'responses',
            'auth_command': 'printf private-token', 'models': {'default': 'vendor/model', 'fast': 'vendor/model'}}}
        (self.config_home / 'config.yaml').write_text(yaml.safe_dump(self.initial_config))
        return self.plugin()

    def test_sync_skips_missing_engine_without_changing_any_settings(self):
        plugin = self.gateway_plugin()
        with patch.object(adapter.shutil, 'which', return_value=None):
            self.assertEqual(plugin.sync_codex_catalog(), {'changed': False, 'reason': 'binary-missing'})
        self.assertFalse((self.home / '.codex').exists())

    def test_sync_updates_provider_models_and_preserves_old_session_catalog_on_restore(self):
        import yaml, tomlkit
        plugin = self.gateway_plugin()
        with patch.object(adapter.Plugin, 'codex_bundled_catalog', return_value={'models': [{'slug':'native'}]}):
            plugin.sync_codex_catalog()
            self.initial_config['providers']['gateway']['openai']['models'] = {'default':'vendor/new'}
            (self.config_home / 'config.yaml').write_text(yaml.safe_dump(self.initial_config))
            self.assertTrue(plugin.sync_codex_catalog()['changed'])
        managed = plugin.state_dir / 'codex-model-catalog.json'
        self.assertEqual([x['slug'] for x in json.loads(managed.read_text())['models']], ['vendor/new'])
        plugin.sync_codex_catalog(restore=True)
        self.assertTrue(managed.exists())
        self.assertNotIn('model_catalog_json', tomlkit.parse((self.home / '.codex/config.toml').read_text()))

    def test_sync_codex_catalog_projects_gateway_and_is_idempotent(self):
        import tomlkit
        plugin = self.gateway_plugin()
        source = self.home / '.codex'; source.mkdir()
        config = source / 'config.toml'
        config.write_text('# keep comment\n[features]\nmulti_agent = true\n')
        native = {'models': [{'slug': 'native-model', 'base_instructions': 'native instructions',
                              'supported_reasoning_levels': [{'effort': 'medium'}]}]}
        with patch.object(adapter.Plugin, 'codex_bundled_catalog', return_value=native) as probe:
            first = plugin.sync_codex_catalog()
            document = tomlkit.parse(config.read_text())
            catalog = Path(document['model_catalog_json'])
            contents = json.loads(catalog.read_text())
            self.assertEqual([x['slug'] for x in contents['models']], ['vendor/model'])
            self.assertNotIn('private-token', catalog.read_text())
            self.assertIn('# keep comment', config.read_text())
            self.assertTrue(document['features']['multi_agent'])
            self.assertEqual(catalog.stat().st_mode & 0o777, 0o600)
            stamp = (catalog.stat().st_mtime_ns, config.stat().st_mtime_ns)
            second = plugin.sync_codex_catalog()
            self.assertEqual(stamp, (catalog.stat().st_mtime_ns, config.stat().st_mtime_ns))
            self.assertTrue(first['changed']); self.assertFalse(second['changed'])
            self.assertEqual(probe.call_count, 1)

    def test_sync_preserves_user_catalog_and_reports_conflict(self):
        plugin = self.gateway_plugin()
        source = self.home / '.codex'; source.mkdir()
        original = 'model_catalog_json = "/user/custom.json"\n'
        (source / 'config.toml').write_text(original)
        self.assert_code('CODEX_CATALOG_CONFLICT', plugin.sync_codex_catalog)
        self.assertEqual((source / 'config.toml').read_text(), original)

    def test_sync_subscription_restores_only_owned_setting(self):
        import tomlkit
        plugin = self.plugin()
        source = self.home / '.codex'; source.mkdir()
        catalog = plugin.state_dir / 'codex-model-catalog.json'
        (source / 'config.toml').write_text('model_catalog_json = ' + json.dumps(str(catalog)) + '\nmodel = "user-model"\n')
        result = plugin.sync_codex_catalog()
        document = tomlkit.parse((source / 'config.toml').read_text())
        self.assertTrue(result['changed'])
        self.assertNotIn('model_catalog_json', document)
        self.assertEqual(document['model'], 'user-model')

    def test_sync_invalid_config_or_probe_failure_does_not_change_config(self):
        plugin = self.gateway_plugin()
        source = self.home / '.codex'; source.mkdir()
        config = source / 'config.toml'; config.write_text('invalid [ toml')
        self.assert_code('INVALID_CODEX_CONFIG', plugin.sync_codex_catalog)
        self.assertEqual(config.read_text(), 'invalid [ toml')
        config.write_text('# unchanged\n')
        with patch.object(adapter.Plugin, 'codex_bundled_catalog', return_value={}):
            self.assert_code('CODEX_CATALOG_UNAVAILABLE', plugin.sync_codex_catalog)
        self.assertEqual(config.read_text(), '# unchanged\n')

    def test_pi_error_event_classifies_payment_failure_without_exporting_text(self):
        self.client.items = [{'type':'error', 'code':'RuntimeError',
                             'message':'Pi model error: 402: private-provider-error-secret'}]
        result = self.plugin(engine='pi').verify()
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'PROVIDER_PAYMENT_REQUIRED')
        self.assertNotIn('private-provider-error-secret', json.dumps(result))
        self.assertEqual(result['cleanup'], 'stopped')

    def test_connect_reuses_auth_and_kit_without_second_host(self):
        plugin = self.plugin()
        with patch.object(plugin, "ensure_host", return_value="kit") as ensure, patch.object(adapter.shutil, "which", return_value="/test/bin/engine"):
            result = plugin.connect()
        self.assertTrue(result["host"]["connected"])
        ensure.assert_called_once_with("https://server.example")
        self.assertEqual(self.auth.saved, [])
        self.assertFalse(any(path == "/auth/login" for _, path, _, _ in self.client.calls))
        config = plugin.config()
        self.assertEqual(config["host"]["host_id"], "this-machine")
        self.assertEqual(config["custom"], {"keep": True})
        self.assertEqual(config["providers"]["existing-pi"], self.initial_config["providers"]["existing-pi"])
        self.assertNotIn("pi-subscription", config["providers"])
        self.assertEqual(config["providers"]["codex-subscription"], {"kind": "subscription", "cli": "codex", "default": "openai"})
        self.assertEqual((self.config_home / "config.yaml").stat().st_mode & 0o777, 0o600)

    def test_connect_login_requests_refresh_but_never_persists_password(self):
        self.auth.value = None
        plugin = self.plugin(username="test-user", password="test-password")
        with patch.object(plugin, "ensure_host", return_value="kit"), patch.object(adapter.shutil, "which", return_value=None):
            result = plugin.connect()
        self.assertEqual(len(self.auth.saved), 1)
        login = next(call for call in self.client.calls if call[1] == "/auth/login")
        self.assertEqual(login[2], {"username": "test-user", "password": "test-password", "issue_refresh": True})
        self.assertFalse(login[3])
        for path in self.home.rglob("*"):
            if path.is_file():
                self.assertNotIn("test-password", path.read_text())
        self.assertNotIn("test-password", json.dumps(result))

    def test_oidc_never_receives_password_login(self):
        self.client.auth_mode = "oidc"
        self.assert_code("NEEDS_BROWSER_AUTH", lambda: self.plugin(username="user", password="secret").connect())
        self.assertEqual(self.client.calls, [])

    def test_missing_login_never_changes_config(self):
        self.auth.value = None
        before = (self.config_home / "config.yaml").read_bytes()
        self.assert_code("NEEDS_LOGIN", lambda: self.plugin().connect())
        self.assertEqual(before, (self.config_home / "config.yaml").read_bytes())

    def test_existing_default_gateway_is_preserved(self):
        import yaml

        self.initial_config["providers"]["gateway"] = {"kind": "gateway", "default": "openai", "openai": {"base_url": "https://gateway.example/v1", "api_key_ref": "env:EXAMPLE_KEY"}}
        (self.config_home / "config.yaml").write_text(yaml.safe_dump(self.initial_config))
        plugin = self.plugin()
        with patch.object(adapter.shutil, "which", return_value="/test/bin/engine"):
            plugin.merge_config("https://server.example")
        self.assertEqual(plugin.config()["providers"]["gateway"], self.initial_config["providers"]["gateway"])
        self.assertNotIn("default", plugin.config()["providers"]["codex-subscription"])

    def test_merge_repairs_a_missing_standard_cli_path_after_engine_moves(self):
        import yaml

        binary = self.home / "new-bin" / "claude"
        binary.parent.mkdir()
        binary.write_text("#!/bin/sh\nexit 0\n")
        binary.chmod(0o755)
        old = str(self.home / "old-bin" / "claude")
        self.initial_config["harness"] = {"claude-native": {"command": old, "launch_args": ["--verbose"]}}
        (self.config_home / "config.yaml").write_text(yaml.safe_dump(self.initial_config))
        plugin = self.plugin()
        with patch.object(adapter.shutil, "which", side_effect=lambda key: str(binary) if key == "claude" else None):
            plugin.merge_config("https://server.example")
        self.assertEqual(plugin.config()["harness"]["claude-native"], {"command": str(binary), "launch_args": ["--verbose"]})
        self.assertEqual(plugin.config()["host"]["host_id"], "this-machine")

    def test_merge_preserves_working_or_custom_harness_commands(self):
        import yaml

        binary = self.home / "claude"
        binary.write_text("#!/bin/sh\nexit 0\n")
        binary.chmod(0o755)
        for command in (str(binary), str(self.home / "custom-launcher")):
            self.initial_config["harness"] = {"claude-native": {"command": command}}
            (self.config_home / "config.yaml").write_text(yaml.safe_dump(self.initial_config))
            plugin = self.plugin()
            with patch.object(adapter.shutil, "which", return_value=str(binary)):
                plugin.merge_config("https://server.example")
            self.assertEqual(plugin.config()["harness"]["claude-native"]["command"], command)

    def test_verify_reports_native_start_failure_without_waiting_for_reply_timeout(self):
        self.client.items = [{"type": "error", "code": "native_terminal_start_failed", "message": "sensitive raw error"}]
        result = self.plugin(engine="claude").verify()
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "NATIVE_TERMINAL_START_FAILED")
        self.assertEqual(result["cleanup"], "stopped")
        self.assertEqual(self.clock.value, 3.0)  # Startup settling only; no reply polling wait.
        self.assertNotIn("sensitive raw error", json.dumps(result))

    @staticmethod
    def terminal_event(action='deleted', *, engine='pi', event_id='terminal-event', **fields):
        return {'type': 'resource_event', 'event_type': f'session.resource.{action}',
                'resource_type': 'terminal', 'resource_id': f'terminal_{engine}_main',
                'id': event_id, **fields}

    def run_terminal_lifecycle(self, pages, *, engine='pi', **options):
        """Feed descending pages into the real verifier with a fake clock/client."""
        request = self.client.request
        observations = []
        def scripted(method, path, *args, **kwargs):
            if '/items?' in path:
                self.client.items = pages[min(len(observations), len(pages) - 1)]
                observations.append(self.clock.value)
            return request(method, path, *args, **kwargs)
        with patch.object(self.client, 'request', side_effect=scripted):
            result = self.plugin(engine=engine, timeoutSeconds=options.pop('timeoutSeconds', 120), **options).verify()
        return result, observations

    def test_idle_native_terminal_removal_ends_wait_before_cleanup(self):
        for engine in ('pi', 'claude'):
            with self.subTest(engine=engine):
                self.clock.value = 0
                self.client.calls.clear()
                self.client.session_info = {'status': 'idle', 'last_task_error': None}
                created = self.terminal_event('created', engine=engine, event_id='created')
                deleted = self.terminal_event(engine=engine, event_id='deleted', message='private-output')
                result, polls = self.run_terminal_lifecycle([[created], [created], [deleted, created]], engine=engine)
                self.assertEqual(result['reason'], 'NATIVE_TERMINAL_REMOVED')
                self.assertFalse(result['ok'])
                self.assertEqual(result['cleanup'], 'stopped')
                self.assertLessEqual(self.clock.value, 9)
                self.assertEqual(len(polls), 4)
                self.assertEqual(result['terminalDiagnostic'], {
                    'resourceId': f'terminal_{engine}_main', 'event': 'session.resource.deleted',
                    'phase': 'before_cleanup', 'exitCode': None})
                self.assertNotIn('private-output', json.dumps(result))
                posts = [body['type'] for method, path, body, _ in self.client.calls if path.endswith('/events')]
                self.assertEqual(posts, ['message', 'stop_session'])

    def test_terminal_replacement_and_late_reply_cancel_removal_candidate(self):
        created = self.terminal_event('created', event_id='original')
        deleted = self.terminal_event(event_id='deleted')
        replacement = self.terminal_event('created', event_id='replacement')
        reply = {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': adapter.SENTINEL}]}
        # A newer create wins over a stale delete, including across polls.
        for pages in ([[deleted, created], [replacement, deleted, created], [reply]],
                      [[replacement, deleted, created], [reply]],
                      [[deleted, created], [reply, deleted, created]]):
            with self.subTest(pages=pages):
                self.clock.value = 0
                result, _ = self.run_terminal_lifecycle(pages)
                self.assertTrue(result['ok'])
                self.assertNotIn('terminalDiagnostic', result)

    def test_only_matching_native_main_terminal_can_end_wait(self):
        for engine, event in [('codex', self.terminal_event(engine='codex')),
                              ('pi', self.terminal_event(resource_id='terminal_pi_secondary')),
                              ('pi', self.terminal_event(resource_type='browser')),
                              ('pi', self.terminal_event(type='message')),
                              ('pi', self.terminal_event(session_id='unrelated-session')),
                              ('pi', self.terminal_event(resource={'session_id': 'unrelated-session'})),
                              ('pi', self.terminal_event(id=None))]:
            with self.subTest(engine=engine, event=event):
                self.clock.value = 0
                result, _ = self.run_terminal_lifecycle([[event]], engine=engine, timeoutSeconds=6)
                self.assertEqual(result['reason'], 'REPLY_TIMEOUT')
                self.assertNotIn('terminalDiagnostic', result)

    def test_removal_already_present_on_first_poll_is_not_own_cleanup(self):
        result, polls = self.run_terminal_lifecycle([[self.terminal_event()]])
        self.assertEqual(result['reason'], 'NATIVE_TERMINAL_REMOVED')
        self.assertEqual(polls, [0, 2])
        self.assertEqual(result['terminalDiagnostic']['phase'], 'before_cleanup')

    def test_new_terminal_generation_gets_its_own_removal_grace(self):
        first = self.terminal_event(event_id='first-removal', exit_status=1)
        replacement = self.terminal_event('created', event_id='replacement')
        second = self.terminal_event(event_id='second-removal', exit_status=2)
        result, polls = self.run_terminal_lifecycle([[first], [replacement, first], [second, replacement, first]])
        self.assertEqual(polls, [0, 2, 4, 6])
        self.assertEqual(result['reason'], 'NATIVE_TERMINAL_REMOVED')
        self.assertEqual(result['terminalDiagnostic']['exitCode'], 2)

    def test_terminal_diagnostic_keeps_only_explicit_numeric_exit_status(self):
        for value in (None, 0, 1, 137, -9, True, '1 private-output', 1.5, 2**63):
            with self.subTest(value=value):
                self.clock.value = 0
                result, _ = self.run_terminal_lifecycle([[self.terminal_event(exit_status=value)]])
                expected = value if type(value) is int and -(2**31) <= value < 2**31 else None
                self.assertEqual(result['terminalDiagnostic']['exitCode'], expected)
                self.assertNotIn('private-output', json.dumps(result))

    def test_structured_error_keeps_priority_over_terminal_loss(self):
        deleted = self.terminal_event()
        for event_error in (True, False):
            with self.subTest(event_error=event_error):
                self.clock.value = 0
                error = {'type': 'error', 'code': 'native_error', 'status_code': 402, 'message': 'private-output'}
                self.client.session_info = {} if event_error else {'last_task_error': error}
                result, _ = self.run_terminal_lifecycle([[deleted], [error, deleted]] if event_error else [[deleted]])
                self.assertEqual(result['reason'], 'PROVIDER_PAYMENT_REQUIRED')
                self.assertNotIn('private-output', json.dumps(result))

    def test_terminal_loss_does_not_require_successful_session_info_lookup(self):
        request = self.client.request
        def unavailable(method, path, *args, **kwargs):
            if method == 'GET' and path == '/v1/sessions/own-verification-session':
                self.assertEqual(kwargs['timeout_seconds'], 3.0)
                self.assertFalse(kwargs['refresh_auth'])
                raise adapter.PluginError('server_unreachable', 'private-output')
            return request(method, path, *args, **kwargs)
        with patch.object(self.client, 'request', side_effect=unavailable):
            result, polls = self.run_terminal_lifecycle([[self.terminal_event()]])
        self.assertEqual(result['reason'], 'NATIVE_TERMINAL_REMOVED')
        self.assertEqual(polls, [0, 2])
        self.assertEqual(result['cleanup'], 'stopped')

    def test_cleanup_exit_does_not_turn_success_or_timeout_into_early_failure(self):
        request = self.client.request
        def stopping(method, path, payload=None, **kwargs):
            if method == 'POST' and payload.get('type') == 'stop_session':
                self.client.items = [self.terminal_event()]
            return request(method, path, payload, **kwargs)
        for reply in (True, False):
            with self.subTest(reply=reply):
                self.clock.value = 0
                self.client.items = [{'type': 'message', 'role': 'assistant', 'content': [
                    {'type': 'output_text', 'text': adapter.SENTINEL}]}] if reply else []
                with patch.object(self.client, 'request', side_effect=stopping):
                    result = self.plugin(engine='pi', timeoutSeconds=2).verify()
                self.assertEqual(result['ok'], reply)
                self.assertEqual(result['reason'], None if reply else 'REPLY_TIMEOUT')
                self.assertNotIn('terminalDiagnostic', result)

    def test_cleanup_failure_preserves_prior_terminal_loss_evidence(self):
        self.client.stop_errors = [adapter.PluginError('forbidden', 'private-output')]
        result, _ = self.run_terminal_lifecycle([[self.terminal_event(exit_status=1)]])
        self.assertEqual(result['reason'], 'NATIVE_TERMINAL_REMOVED')
        self.assertEqual(result['cleanup'], 'stop_failed')
        self.assertEqual(result['terminalDiagnostic']['exitCode'], 1)

    def test_config_backup_is_private_exact_and_only_when_changed(self):
        original = (self.config_home / "config.yaml").read_bytes()
        plugin = self.plugin()
        with patch.object(adapter.shutil, "which", return_value=None):
            plugin.merge_config("https://server.example")
        self.assertEqual(list(self.config_home.glob(".pi-web-plugin-backup-*.yaml")), [])
        with patch.object(adapter.shutil, "which", return_value=None):
            plugin.merge_config("https://other.example")
            plugin.merge_config("https://other.example")
        backups = list(self.config_home.glob(".pi-web-plugin-backup-*.yaml"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

    def test_managed_server_mismatch_is_rejected_before_auth_and_config(self):
        runtime = self.home / "server-url"
        runtime.write_text("https://deployment.example\n")
        before = (self.config_home / "config.yaml").read_bytes()
        plugin = self.plugin(server="https://other.example", username="user", password="secret")
        with patch.dict(os.environ, {"OG_SERVER_URL_FILE": str(runtime)}), patch.object(plugin, "local_host", return_value={"managerRunning": True}):
            self.assert_code("SERVER_MANAGED_BY_DEPLOYMENT", plugin.connect)
        self.assertEqual(before, (self.config_home / "config.yaml").read_bytes())
        self.assertEqual(self.auth.saved, [])
        self.assertEqual(self.auth.reads, [])
        self.assertEqual(self.client.calls, [])

    def test_status_server_mismatch_is_also_rejected_before_auth(self):
        status = self.home / "status.json"
        status.write_text(json.dumps({"server": "https://deployment.example"}))
        plugin = self.plugin(server="https://other.example")
        with patch.dict(os.environ, {"OG_STATUS_FILE": str(status), "OG_SERVER_URL": "", "OG_SERVER_URL_FILE": ""}), patch.object(plugin, "local_host", return_value={"managerRunning": True}):
            self.assert_code("SERVER_MANAGED_BY_DEPLOYMENT", plugin.connect)
        self.assertEqual(self.auth.reads, [])

    def test_account_host_conflict_returns_reset_action_without_waiting(self):
        plugin = self.plugin()
        host = {"id": "this-machine", "name": "original host", "managerRunning": True,
                "managed": True, "manager": "kit", "state": "needs-reset-id", "connected": False}
        self.client.offline = True
        with patch.object(plugin, "local_host", return_value=host), patch.object(plugin, "merge_config"):
            self.assert_code("NEEDS_RESET_ID", plugin.connect)
        self.assertEqual(self.clock.value, 0)
        self.assertFalse(any("reset-id" in path for _, path, _, _ in self.client.calls))

    def test_kit_is_reused_without_subprocess(self):
        plugin = self.plugin(allowManagedHost=True)
        with patch.object(plugin, "local_host", return_value={"managerRunning": True}), patch.object(adapter.subprocess, "Popen") as popen:
            self.assertEqual(plugin.ensure_host("https://server.example"), "kit")
        popen.assert_not_called()

    def test_verify_requires_actual_assistant_reply_and_stops_own_session(self):
        result = self.plugin(engine="codex", model="real-model").verify()
        self.assertTrue(result["ok"])
        self.assertEqual(result["reply"], adapter.SENTINEL)
        self.assertEqual(result["url"], "https://server.example/c/own-verification-session")
        create = next(payload for method, path, payload, _ in self.client.calls if path == "/v1/sessions" and method == "POST")
        self.assertEqual(create["model_override"], "real-model")
        self.assertEqual(create["harness_override"], "codex-native")
        self.assertNotIn("initial_items", create)
        messages = [payload for method, path, payload, _ in self.client.calls
                    if method == "POST" and path.endswith("/events") and payload.get("type") == "message"]
        self.assertEqual(messages, [{"type": "message", "data": {"role": "user", "content": [
            {"type": "input_text", "text": adapter.PROBE_PROMPT}]}}])
        stopped = [path for method, path, payload, _ in self.client.calls if method == "POST" and payload.get("type") == "stop_session"]
        self.assertEqual(stopped, ["/v1/sessions/own-verification-session/events"])
        self.assertEqual(self.client.cleanup_options, {"timeout_seconds": 15.0, "refresh_auth": False})

    def test_transient_stop_error_retries_with_refreshed_auth(self):
        self.client.stop_errors = [adapter.PluginError("server_unreachable", "temporary disconnect")]
        result = self.plugin(engine="codex", model="real-model").verify()
        self.assertTrue(result["ok"])
        self.assertEqual(result["cleanup"], "stopped")
        self.assertEqual(self.client.stop_attempts, [
            {"timeout_seconds": 15.0, "refresh_auth": False},
            {"timeout_seconds": 15.0, "refresh_auth": True},
        ])

    def test_persistent_stop_error_keeps_verification_incomplete(self):
        self.client.stop_errors = [adapter.PluginError("server_unreachable", "temporary disconnect"),
                                   adapter.PluginError("server_unreachable", "temporary disconnect")]
        result = self.plugin(engine="codex", model="real-model").verify()
        self.assertEqual(result["cleanup"], "stop_failed")
        self.assertEqual(len(self.client.stop_attempts), 2)

    def test_permanent_stop_error_is_not_retried(self):
        self.client.stop_errors = [adapter.PluginError("forbidden", "not allowed")]
        result = self.plugin(engine="codex", model="real-model").verify()
        self.assertEqual(result["cleanup"], "stop_failed")
        self.assertEqual(len(self.client.stop_attempts), 1)

    def test_provider_payment_error_is_reported_without_waiting_for_reply_timeout(self):
        self.client.items = []
        self.client.session_info = {"status": "failed", "last_task_error": {
            "code": "codex_turn_error",
            "message": "unexpected status 402 Payment Required: upstream billing failure secret-token"}}
        result = self.plugin(engine="codex").verify()
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "PROVIDER_PAYMENT_REQUIRED")
        self.assertEqual(result["cleanup"], "stopped")
        self.assertLess(self.clock.value, 120)
        self.assertNotIn("secret-token", json.dumps(result))

    def test_other_failed_session_task_returns_safe_error_code(self):
        self.client.items = []
        self.client.session_info = {"status": "failed", "last_task_error": {
            "code": "codex_turn_error", "message": "private upstream detail"}}
        result = self.plugin(engine="codex").verify()
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "SESSION_TASK_FAILED")
        self.assertNotIn("private upstream detail", json.dumps(result))

    def test_provider_failures_are_classified_on_both_native_error_paths(self):
        cases = [
            ({'code': 'native_error', 'message': 'API Error: 402 private-provider-secret'}, 'PROVIDER_PAYMENT_REQUIRED'),
            ({'code': 'native_error', 'message': "You've hit your usage limit. private-provider-secret"}, 'PROVIDER_USAGE_LIMIT_REACHED'),
            ({'code': 'RuntimeError', 'message': 'Pi model error: 429: usage limit reached private-provider-secret'}, 'PROVIDER_USAGE_LIMIT_REACHED'),
            ({'code': 'RuntimeError', 'message': 'HTTP 429 Too Many Requests private-provider-secret'}, 'PROVIDER_RATE_LIMITED'),
            ({'code': 'native_error', 'message': 'Upstream failure', 'details': {'error': {'code': 'insufficient_quota'}}}, 'PROVIDER_USAGE_LIMIT_REACHED'),
            ({'code': 'native_error', 'status_code': 402}, 'PROVIDER_PAYMENT_REQUIRED'),
            ({'code': 'native_error', 'status_code': 429}, 'PROVIDER_RATE_LIMITED'),
        ]
        for error, expected in cases:
            for event in [False, True]:
                with self.subTest(expected=expected, event=event):
                    self.client.items = [dict(error, type='error')] if event else []
                    self.client.session_info = {} if event else {'status': 'failed', 'last_task_error': error}
                    result = self.plugin(engine='pi').verify()
                    self.assertEqual(result['reason'], expected)
                    self.assertFalse(result['ok'])
                    self.assertEqual(result['cleanup'], 'stopped')
                    self.assertNotIn('private-provider-secret', json.dumps(result))

    def test_provider_classifier_does_not_treat_unrelated_numbers_as_http_status(self):
        for message in ['Request 402 failed', 'Turn 429 failed', 'billing setting exists', 'try again later', 'context limit reached']:
            with self.subTest(message=message):
                self.assertEqual(adapter.Plugin.session_failure_reason({'last_task_error': {'message': message}}), 'SESSION_TASK_FAILED')

    def test_verify_records_resolved_model_without_changing_default_selection(self):
        self.client.session_info = {'llm_model': 'omnigent/provider/actual-model'}
        result = self.plugin(engine='pi').verify()
        self.assertEqual(result['model'], 'omnigent/provider/actual-model')
        self.assertEqual(result['resolvedModel'], 'omnigent/provider/actual-model')
        create = next(payload for method, path, payload, _ in self.client.calls if path == '/v1/sessions' and method == 'POST')
        self.assertNotIn('model_override', create)

    def test_resolved_model_keeps_requested_alias_and_rejects_unsafe_values(self):
        self.client.session_info = {'llm_model': 'provider/actual-model'}
        result = self.plugin(engine='pi', model='real-model').verify()
        self.assertEqual(result['model'], 'real-model')
        self.assertEqual(result['resolvedModel'], 'provider/actual-model')
        self.client.session_info = {'llm_model': 'https://private.example/?token=private-provider-secret'}
        result = self.plugin(engine='pi').verify()
        self.assertIsNone(result['resolvedModel'])
        self.assertNotIn('private-provider-secret', json.dumps(result))

    def test_resolved_model_lookup_failure_does_not_skip_cleanup(self):
        request = self.client.request
        def flaky(method, path, *args, **kwargs):
            if method == 'GET' and path == '/v1/sessions/own-verification-session':
                raise adapter.PluginError('server_unreachable', 'private-provider-secret')
            return request(method, path, *args, **kwargs)
        with patch.object(self.client, 'request', side_effect=flaky):
            result = self.plugin(engine='pi').verify()
        self.assertTrue(result['ok'])
        self.assertIsNone(result['resolvedModel'])
        self.assertEqual(result['cleanup'], 'stopped')

    def test_user_echo_and_unrelated_text_do_not_pass_verification(self):
        self.client.items = [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": adapter.SENTINEL}]},
                             {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "private reply containing a secret"}]}]
        result = self.plugin(engine="pi", timeoutSeconds=1).verify()
        self.assertFalse(result["ok"])
        self.assertIsNone(result["reply"])
        self.assertNotIn("private reply", json.dumps(result))
        self.assertEqual(result["cleanup"], "stopped")

    def test_poll_failure_still_stops_verification_session(self):
        self.client.poll_error = adapter.PluginError("server_unreachable", "connection failed")
        result = self.plugin(engine="claude").verify()
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "SERVER_UNREACHABLE")
        self.assertEqual(result["cleanup"], "stopped")

    def test_invalid_model_never_creates_session(self):
        self.assert_code("INVALID_MODEL", lambda: self.plugin(engine="codex", model="invented-model").verify())
        self.assertFalse(any(method == "POST" for method, _, _, _ in self.client.calls))

    def test_catalog_delay_consumes_verify_budget_before_session_creation(self):
        plugin = self.plugin(engine="codex", timeoutSeconds=1)
        catalog = plugin.catalog

        def delayed_catalog(**kwargs):
            self.clock.sleep(2)
            return catalog(**kwargs)

        with patch.object(plugin, "catalog", side_effect=delayed_catalog):
            self.assert_code("VERIFY_TIMEOUT", plugin.verify)
        self.assertFalse(any(method == "POST" for method, _, _, _ in self.client.calls))

    def test_official_store_is_called_inside_sdk_token_lock(self):
        events = []

        @contextlib.contextmanager
        def lock():
            events.append("locked")
            yield
            events.append("unlocked")

        import omnigent.cli_auth
        with patch.object(omnigent.cli_auth, "_token_file_lock", lock), patch.object(omnigent.cli_auth, "store_token", side_effect=lambda *args, **kwargs: events.append(("stored", args, kwargs))):
            adapter.OfficialAuth.save("https://server.example", {"token": "token", "user": {"id": "user"}, "expires_in": 60, "refresh_token": "refresh"})
        self.assertEqual(events[0], "locked")
        self.assertEqual(events[1][0], "stored")
        self.assertEqual(events[1][2], {"refresh_token": "refresh"})
        self.assertEqual(events[-1], "unlocked")

    def test_official_clear_preserves_other_server_login_and_uses_lock(self):
        import omnigent.cli_auth

        events = []
        tokens = {"https://server.example": {"token": "remove"}, "https://other.example": {"token": "keep"}}
        path = self.config_home / "auth_tokens.json"
        path.write_text(json.dumps(tokens))

        @contextlib.contextmanager
        def lock():
            events.append("locked")
            yield
            events.append("unlocked")

        with patch.object(omnigent.cli_auth, "_token_file_lock", lock):
            adapter.OfficialAuth.clear("https://server.example")
        self.assertEqual(json.loads(path.read_text()), {"https://other.example": {"token": "keep"}})
        self.assertEqual(events, ["locked", "unlocked"])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_disconnect_refuses_a_process_record_for_another_server(self):
        plugin = self.plugin()
        plugin.state_dir.mkdir(parents=True)
        adapter.atomic_json(plugin.state_dir / "host-process.json", {"pid": os.getpid(), "server": "https://other.example"})
        with patch.object(plugin, "process_matches", return_value=True), patch.object(plugin, "local_host", return_value={"id": "this-machine", "managerRunning": False}):
            self.assert_code("HOST_PROCESS_MISMATCH", plugin.disconnect)
        self.assertEqual(self.auth.cleared, [])
        self.assertEqual(self.client.calls, [])

    def test_json_boundary_sanitizes_exception_and_uses_uppercase_codes(self):
        stdout = io.StringIO()
        with patch.object(adapter.sys, "stdin", io.StringIO('{"action":"status"}')), patch.object(adapter.sys, "stdout", stdout), patch.object(adapter, "dispatch", side_effect=RuntimeError("password=test-secret-token")):
            adapter.main()
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["error"]["code"], "INTERNAL_ERROR")
        self.assertNotIn("test-secret", stdout.getvalue())
        stdout = io.StringIO()
        with patch.object(adapter.sys, "stdin", io.StringIO("not json")), patch.object(adapter.sys, "stdout", stdout):
            adapter.main()
        self.assertEqual(json.loads(stdout.getvalue())["error"]["code"], "INVALID_JSON")


class ClientTests(unittest.TestCase):
    def test_one_http_client_reuses_transport_and_does_not_redirect_credentials(self):
        import httpx
        requests = []
        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"ok": True})
        client = adapter.Client("https://server.example", FakeAuth(), read_only=True,
                                transport=httpx.MockTransport(respond))
        try:
            self.assertEqual(client.auth_probe(), "header")
            client.request("GET", "/v1/hosts")
            client.request("GET", "/v1/agents")
            self.assertEqual(len(requests), 3)
            self.assertNotIn("authorization", requests[0].headers)
            self.assertEqual(requests[1].headers["authorization"], "Bearer existing-test-token")
            self.assertFalse(client._http.follow_redirects)
        finally:
            client.close()
        self.assertTrue(client._http.is_closed)

    def test_dispatch_closes_transport_on_failure(self):
        client = types.SimpleNamespace(close=lambda: setattr(client, "closed", True), closed=False)
        def fail(plugin):
            plugin.client_factory("https://server.example")
            raise adapter.PluginError("test_failure", "safe")
        with patch.object(adapter.Plugin, "status", fail):
            with self.assertRaises(adapter.PluginError):
                adapter.dispatch({"action": "status"}, client_factory=lambda *args: client)
        self.assertTrue(client.closed)

if __name__ == "__main__":
    unittest.main()
