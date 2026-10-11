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
        self.stop_error = None
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
        if "/items?" in path:
            if self.poll_error:
                raise self.poll_error
            return {"data": self.items}
        if path.endswith("/events"):
            self.cleanup_options = {"timeout_seconds": timeout_seconds, "refresh_auth": refresh_auth}
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
                                                   "OMNIGENT_DATA_DIR": str(self.config_home), "OG_HOST_ENABLED": "0",
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


if __name__ == "__main__":
    unittest.main()
