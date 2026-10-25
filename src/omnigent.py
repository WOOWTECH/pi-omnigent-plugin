#!/usr/bin/env python3
"""Small JSON boundary around the installed Omnigent client.

Passwords enter over stdin and are never persisted by this plugin. Omnigent
owns token storage and refresh. Only this machine's host and this invocation's
verification session are used; no other host, agent, or conversation is edited.
"""

from __future__ import annotations

import contextlib
import copy
import fcntl
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote, urlsplit, urlunsplit

# The helper's filename matches the SDK package. Running it directly must not
# let its own directory shadow the installed ``omnigent`` package.
_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path[:] = [entry for entry in sys.path if not entry or Path(entry).resolve() != _SCRIPT_DIR]

ENGINES = {
    "claude": {"harness": "claude-native", "agent": "claude-native-ui", "family": "anthropic"},
    "codex": {"harness": "codex-native", "agent": "codex-native-ui", "family": "openai"},
    "pi": {"harness": "pi-native", "agent": "pi-native-ui", "family": "pi"},
}
SENTINEL = "OMNIGENT_CONNECTION_OK"
PROBE_PROMPT = f"Reply exactly {SENTINEL}. Do not use tools or modify any files."


class PluginError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code.upper()
        self.message = message


def normalize_server(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PluginError("needs_server", "請提供 Omnigent server 網址。")
    value = value.strip()
    if any(ord(c) < 33 for c in value) or "\\" in value:
        raise PluginError("invalid_server", "Server 網址包含不支援的字元。")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise PluginError("invalid_server", "Server 網址格式不正確。") from None
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
        raise PluginError("invalid_server", "請使用沒有帳號密碼的 HTTP 或 HTTPS server 網址。")
    if parsed.query or parsed.fragment:
        raise PluginError("invalid_server", "Server 網址不可包含查詢參數或片段。")
    if parsed.scheme == "http" and parsed.hostname.lower() not in ("localhost", "127.0.0.1", "::1"):
        raise PluginError("invalid_server", "遠端 Omnigent server 必須使用 HTTPS。")
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    if port:
        host += f":{port}"
    return urlunsplit((parsed.scheme.lower(), host, parsed.path.rstrip("/"), "", ""))


def safe_text(value: object, limit: int = 256) -> str | None:
    if not isinstance(value, str):
        return None
    return "".join(c for c in value if ord(c) >= 32 and ord(c) != 127)[:limit]


def read_json(path: Path) -> dict:
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as handle:
        temporary = Path(handle.name)
        try:
            os.chmod(temporary, 0o600)
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


class OfficialAuth:
    """Use Omnigent's stored credential shape, locks, and refresh implementation."""

    @staticmethod
    def token(server: str, *, refresh: bool = True) -> str | None:
        from omnigent.cli_auth import load_token, refresh_stored_token

        token = load_token(server, min_remaining_seconds=90.0)
        if not token and refresh:
            token = refresh_stored_token(server)
        return token or load_token(server)

    @staticmethod
    def save(server: str, payload: dict) -> None:
        from omnigent.cli_auth import _token_file_lock, store_token

        token = payload.get("token")
        user = payload.get("user")
        user_id = user.get("id") if isinstance(user, dict) else None
        if not isinstance(token, str) or not token or not isinstance(user_id, str) or not user_id:
            raise PluginError("invalid_login_response", "Server 登入回應不符合 Omnigent 合約。")
        expires = payload.get("expires_in", 8 * 3600)
        if isinstance(expires, bool) or not isinstance(expires, (int, float)) or not math.isfinite(expires) or expires <= 0:
            raise PluginError("invalid_login_response", "Server 登入憑證的有效時間不正確。")
        refresh_token = payload.get("refresh_token")
        if refresh_token is not None and not isinstance(refresh_token, str):
            raise PluginError("invalid_login_response", "Server 更新憑證回應不正確。")
        with _token_file_lock():
            store_token(server, token, user_id, time.time() + expires, refresh_token=refresh_token)

    @staticmethod
    def clear(server: str) -> None:
        from omnigent.cli_auth import _token_file_lock, clear_token

        with _token_file_lock():
            clear_token(server)


class Client:
    def __init__(self, server: str, auth: OfficialAuth, *, read_only: bool = False, transport=None):
        import httpx
        self.server = server
        self.auth = auth
        self.read_only = read_only
        self._held_token = None
        self._http = httpx.Client(follow_redirects=False, transport=transport)

    def close(self) -> None:
        self._http.close()

    def hold_token(self, token: str) -> None:
        # A logout check needs an in-memory bearer after the local entry is
        # removed. Never refresh or write it back to the credential store.
        self._held_token = token

    def request(self, method: str, path: str, payload: dict | None = None, *, authenticated: bool = True,
                timeout_seconds: float = 15.0, refresh_auth: bool | None = None) -> dict:
        import httpx

        headers = {"Accept": "application/json"}
        if authenticated:
            token = self._held_token or self.auth.token(self.server, refresh=not self.read_only if refresh_auth is None else refresh_auth)
            if token:
                headers["Authorization"] = f"Bearer {token}"
        try:
            # Redirects never forward the entered password or a stored bearer
            # to an unexpected origin. A proxy/TLS error is reported generically.
            response = self._http.request(method, f"{self.server}{path}", json=payload, headers=headers,
                                     timeout=timeout_seconds, follow_redirects=False)
        except httpx.HTTPError:
            raise PluginError("server_unreachable", "無法連線 Omnigent server，請檢查網址、網路與 TLS。") from None
        if response.status_code == 401:
            raise PluginError("needs_login", "請登入此 Omnigent server；原有登入可能已到期。")
        if response.status_code == 403:
            raise PluginError("forbidden", "目前帳號沒有此 Omnigent 資源的權限。")
        if not 200 <= response.status_code < 300:
            raise PluginError(f"http_{response.status_code}", f"Omnigent server 回傳 HTTP {response.status_code}。")
        try:
            body = response.json()
        except ValueError:
            raise PluginError("invalid_response", "Server 回應並非有效的 Omnigent JSON。") from None
        if not isinstance(body, dict):
            raise PluginError("invalid_response", "Server 回應格式不符合 Omnigent 合約。")
        return body

    def auth_probe(self) -> str:
        import httpx

        try:
            response = self._http.get(f"{self.server}/v1/me", timeout=15.0, follow_redirects=False)
        except httpx.HTTPError:
            raise PluginError("server_unreachable", "無法連線 Omnigent server，請檢查網址、網路與 TLS。") from None
        if response.status_code == 200:
            return "header"
        if response.status_code != 401:
            raise PluginError("unsupported_auth", "Server 沒有回傳 Omnigent 登入模式，請確認 API 網址。")
        try:
            body = response.json()
        except ValueError:
            raise PluginError("unsupported_auth", "Server 沒有回傳 Omnigent 登入模式。") from None
        return "accounts" if isinstance(body, dict) and body.get("login_url") == "/login" else "oidc"


class Plugin:
    def __init__(self, request: dict, *, auth=None, client_factory=None, sleeper=time.sleep, clock=time.monotonic, probe_submit=None):
        self.request = request
        self.home = Path(os.environ.get("HOME", str(Path.home())))
        self.config_home = Path(request.get("configHome") or os.environ.get("OMNIGENT_CONFIG_HOME") or self.home / ".omnigent")
        self.data_dir = Path(request.get("dataDir") or os.environ.get("OMNIGENT_DATA_DIR") or self.config_home)
        self.state_dir = Path(request.get("stateDir") or self.data_dir / "pi-web-plugin")
        self.workspace = Path(request.get("workspace") or self.home)
        for path in (self.config_home, self.data_dir, self.state_dir, self.workspace):
            if not path.is_absolute():
                raise PluginError("invalid_path", "Omnigent 設定與工作區必須使用絕對路徑。")
        # The official modules resolve these at call time, so every invocation
        # shares the resident host's token store and configuration.
        os.environ["OMNIGENT_CONFIG_HOME"] = str(self.config_home)
        os.environ["OMNIGENT_DATA_DIR"] = str(self.data_dir)
        self.auth = auth or OfficialAuth()
        factory = client_factory or (lambda server, readonly=False: Client(server, self.auth, read_only=readonly))
        self._clients = []
        def tracked_client(server, readonly=False):
            client = factory(server, readonly)
            self._clients.append(client)
            return client
        self.client_factory = tracked_client
        self.sleep = sleeper
        self.clock = clock
        self.probe_submit = probe_submit or self.submit_owned_probe_draft

    def close(self) -> None:
        for client in self._clients:
            close = getattr(client, "close", None)
            if close:
                close()

    def config(self) -> dict:
        import yaml

        path = self.config_home / "config.yaml"
        if not path.exists():
            return {}
        try:
            config = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            raise PluginError("invalid_config", "現有 Omnigent config.yaml 無法讀取，請先修正設定。") from None
        if config is None:
            return {}
        if not isinstance(config, dict):
            raise PluginError("invalid_config", "現有 Omnigent config.yaml 必須是 YAML mapping。")
        return config

    def server(self) -> str:
        return normalize_server(self.request.get("server") or self.config().get("server"))

    def timeout(self, default=120, maximum=180) -> float:
        raw = self.request.get("timeoutSeconds", default)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
            raise PluginError("invalid_timeout", "等待時間格式不正確。")
        return max(1.0, min(float(raw), maximum))

    def local_host(self) -> dict:
        host = self.config().get("host")
        host = host if isinstance(host, dict) else {}
        status_path = Path(os.environ.get("OG_STATUS_FILE") or self.data_dir / "omnigent-host" / "status.json")
        status = read_json(status_path)
        supervisor_pid = status.get("supervisor_pid")
        kit_running = self.process_matches(supervisor_pid, "supervisor.sh")
        if not kit_running:
            try:
                with (status_path.parent / "supervisor.lock").open("r") as lock:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        fcntl.flock(lock, fcntl.LOCK_UN)
                    except BlockingIOError:
                        kit_running = True
            except OSError:
                pass
        # A local status file says the process is running; only catalog() can
        # claim that the server actually sees it online.
        return {"id": safe_text(host.get("host_id")), "name": safe_text(host.get("name")),
                "manager": "kit" if kit_running else "plugin", "managerRunning": kit_running,
                "managed": kit_running or self.process_matches(read_json(self.state_dir / "host-process.json").get("pid"), "omnigent"),
                "state": safe_text(status.get("state")) or "unknown", "connected": False}

    @staticmethod
    def process_matches(pid, marker: str) -> bool:
        try:
            pid = int(pid)
            if pid <= 1:
                return False
            command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ")
            return marker.encode() in command
        except (TypeError, ValueError, OSError):
            return False

    def status(self) -> dict:
        try:
            version = importlib.metadata.version("omnigent")
        except importlib.metadata.PackageNotFoundError:
            version = None
        host = self.local_host()
        engines = {}
        for key, spec in ENGINES.items():
            inventory = self.request.get("engineInventory", {})
            entry = inventory.get(key) if isinstance(inventory, dict) else None
            if isinstance(entry, dict) and isinstance(entry.get("installed"), bool):
                engines[key] = {"key": key, "harness": spec["harness"], "installed": entry["installed"],
                                "version": safe_text(entry.get("version")), "configured": None, "ready": False}
                continue
            binary = shutil.which(key)
            version_text = None
            if binary:
                try:
                    probe = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=5)
                    match = re.search(r"\d+\.\d+\.\d+(?:[-.][\w]+)*", probe.stdout)
                    if probe.returncode == 0 and match:
                        version_text = match.group(0)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            engines[key] = {"key": key, "harness": spec["harness"], "installed": bool(binary),
                            "version": version_text, "configured": None, "ready": False}
        try:
            server = self.server()
        except PluginError as error:
            if error.code != "NEEDS_SERVER":
                raise
            server = None
        connectivity_error = None
        if server and host["id"]:
            try:
                hosts = self.client_factory(server, True).request("GET", "/v1/hosts").get("hosts", [])
                matching = next((row for row in hosts if isinstance(row, dict) and row.get("host_id") == host["id"]), None)
                host["connected"] = bool(matching and matching.get("status") == "online")
                readiness = matching.get("configured_harnesses", {}) if matching else {}
                for key, spec in ENGINES.items():
                    available = readiness.get(spec["harness"], readiness.get(key)) if isinstance(readiness, dict) else None
                    if available not in (True, False, "binary-missing", "needs-auth", "version-too-low", None):
                        available = None
                    engines[key]["configured"] = available
                    engines[key]["ready"] = host["connected"] and available is True
            except PluginError as error:
                connectivity_error = error.code
        return {"server": server, "version": version, "installed": bool(version), "host": host,
                "engines": engines, "workspace": str(self.workspace), "connectivityError": connectivity_error}

    def all_agents(self, client) -> list[dict]:
        agents = []
        after = None
        for _ in range(10):
            path = "/v1/agents?limit=100&order=asc"
            if after:
                path += "&after=" + quote(after, safe="")
            page = client.request("GET", path)
            rows = page.get("data")
            if not isinstance(rows, list):
                raise PluginError("invalid_response", "Omnigent agents 清單格式不正確。")
            agents.extend(row for row in rows if isinstance(row, dict))
            if not page.get("has_more"):
                return agents
            after = page.get("last_id")
            if not isinstance(after, str) or not after:
                break
        raise PluginError("agent_catalog_too_large", "Omnigent agents 清單過大或分頁格式不正確。")

    def catalog(self, *, client=None, read_only=True, engine_key=None) -> dict:
        server = self.server()
        client = client or self.client_factory(server, read_only)
        host = self.local_host()
        hosts = client.request("GET", "/v1/hosts").get("hosts")
        if not isinstance(hosts, list):
            raise PluginError("invalid_response", "Omnigent hosts 清單格式不正確。")
        matching = next((row for row in hosts if isinstance(row, dict) and host["id"] and row.get("host_id") == host["id"]), None)
        host["connected"] = bool(matching and matching.get("status") == "online")
        if matching:
            host["name"] = safe_text(matching.get("name")) or host["name"]
        readiness = matching.get("configured_harnesses") if matching else {}
        readiness = readiness if isinstance(readiness, dict) else {}
        harness_catalog = client.request("GET", "/v1/harnesses").get("data") if engine_key is None else []
        agents = self.all_agents(client)
        engines = {}
        for key, spec in ENGINES.items():
            if engine_key is not None and key != engine_key:
                continue
            agent = next((row for row in agents if row.get("name") == spec["agent"]), None)
            if not agent:
                agent = next((row for row in agents if row.get("harness") == spec["harness"]), None)
            available = readiness.get(spec["harness"], readiness.get(key))
            if available not in (True, False, "binary-missing", "needs-auth", "version-too-low", None):
                available = None
            models = []
            model_error = None
            if host["connected"] and available is True:
                try:
                    result = client.request("GET", f"/v1/hosts/{quote(host['id'], safe='')}/harnesses/{spec['harness']}/model-options")
                    for row in result.get("models", []):
                        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                            continue
                        models.append({"id": safe_text(row["id"]), "model": safe_text(row.get("model") or row["id"]),
                                       "displayName": safe_text(row.get("displayName") or row["id"]),
                                       "isDefault": row.get("isDefault") is True})
                except PluginError as error:
                    model_error = error.code
            engines[key] = {"key": key, "harness": spec["harness"], "configured": available,
                            "installed": available not in (None, False, "binary-missing"),
                            "ready": host["connected"] and available is True and bool(models) and bool(agent),
                            "agentId": safe_text(agent.get("id")) if agent else None,
                            "models": models, "modelError": model_error}
        # Expose only the names of supported picker modules, never the raw
        # server catalog (which can grow new credential-bearing fields).
        modules = []
        rows = harness_catalog.values() if isinstance(harness_catalog, dict) else harness_catalog if isinstance(harness_catalog, list) else []
        for row in rows:
            if isinstance(row, dict):
                key = safe_text(row.get("key") or row.get("id"))
                if key:
                    modules.append({"key": key, "name": safe_text(row.get("label") or row.get("display_name") or row.get("displayName") or row.get("name") or key)})
        return {"server": server, "host": host, "engines": engines, "modules": modules,
                "workspace": str(self.workspace)}

    def merge_config(self, server: str) -> None:
        import yaml
        from omnigent.onboarding.provider_config import get_default_provider, load_providers

        self.config_home.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_path = self.config_home / ".pi-web-plugin-config.lock"
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(descriptor, "r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            config = self.config()
            original = copy.deepcopy(config)
            providers = config.setdefault("providers", {})
            if not isinstance(providers, dict):
                raise PluginError("invalid_config", "現有 providers 設定必須是 YAML mapping。")
            try:
                parsed = load_providers(config)
                for key, spec in ENGINES.items():
                    if not shutil.which(key):
                        continue
                    if any(entry.kind == "subscription" and entry.cli == key for entry in parsed.values()):
                        continue
                    name = f"{key}-subscription"
                    if name in providers:
                        continue
                    default = get_default_provider(config, spec["family"])
                    entry = {"kind": "subscription", "cli": key}
                    if default is None:
                        entry["default"] = spec["family"]
                    providers[name] = entry
                    parsed = load_providers(config)
            except Exception:
                raise PluginError("invalid_providers", "現有 Omnigent providers 設定無法安全合併。") from None
            # CLI installers can relocate a standard executable. Repair only
            # a dead absolute path whose basename is the engine's normal name;
            # live commands and custom wrappers remain user-owned.
            harnesses = config.get("harness", {})
            if isinstance(harnesses, dict):
                for key, spec in ENGINES.items():
                    entry = harnesses.get(spec["harness"])
                    command = entry.get("command") if isinstance(entry, dict) else None
                    if not isinstance(command, str) or not Path(command).is_absolute() or Path(command).name != key:
                        continue
                    if Path(command).is_file() and os.access(command, os.X_OK):
                        continue
                    replacement = shutil.which(key)
                    if replacement and Path(replacement).is_file() and os.access(replacement, os.X_OK):
                        entry["command"] = replacement
            config["server"] = server
            name = self.request.get("hostName")
            if name is not None:
                if not isinstance(name, str) or not name.strip() or len(name) > 128:
                    raise PluginError("invalid_host_name", "Host 名稱必須是 1 至 128 個字元。")
                host = config.setdefault("host", {})
                if not isinstance(host, dict):
                    raise PluginError("invalid_config", "現有 host 設定必須是 YAML mapping。")
                host["name"] = name.strip()
            if config == original:
                return
            path = self.config_home / "config.yaml"
            if path.exists():
                # The original may contain credentials managed by Omnigent, so
                # backups are private and their content/path never enters logs.
                backup = self.config_home / f".pi-web-plugin-backup-{time.time_ns()}.yaml"
                descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(path.read_bytes())
                    handle.flush()
                    os.fsync(handle.fileno())
            with tempfile.NamedTemporaryFile("w", dir=self.config_home, delete=False, encoding="utf-8") as handle:
                temporary = Path(handle.name)
                try:
                    os.chmod(temporary, 0o600)
                    yaml.safe_dump(config, handle, allow_unicode=True, sort_keys=False)
                    handle.flush()
                    os.fsync(handle.fileno())
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)

    def require_compatible_kit_server(self, server: str) -> None:
        if not self.local_host()["managerRunning"]:
            return
        runtime = os.environ.get("OG_SERVER_URL")
        runtime_path = os.environ.get("OG_SERVER_URL_FILE")
        if not runtime and runtime_path:
            try:
                runtime = Path(runtime_path).read_text(encoding="utf-8").strip()
            except OSError:
                pass
        status_path = Path(os.environ.get("OG_STATUS_FILE") or self.data_dir / "omnigent-host" / "status.json")
        status_server = read_json(status_path).get("server")
        candidates = [runtime, status_server]
        for candidate in candidates:
            if not candidate:
                continue
            try:
                managed = normalize_server(candidate)
            except PluginError:
                continue
            if managed != server:
                raise PluginError("server_managed_by_deployment", "此容器的 host 由部署連接至另一個 server；請先調整部署設定，或沿用目前 server。")

    def ensure_host(self, server: str) -> str:
        host = self.local_host()
        if host["managerRunning"]:
            return "kit"
        if os.environ.get("OG_HOST_ENABLED") in ("1", "true") and Path(os.environ.get("OG_KIT_DIR", "/etc/omnigent-host"), "supervisor.sh").exists():
            raise PluginError("kit_not_running", "容器已配置 Omnigent host supervisor，請先恢復該服務。")
        if self.request.get("allowManagedHost") is not True:
            raise PluginError("host_not_managed", "尚無 host supervisor；初始化時需啟用插件的 host 管理。")
        if not self.workspace.is_dir():
            raise PluginError("invalid_workspace", "指定工作區不存在。")
        binary = self.request.get("omnigentBin") or shutil.which("omnigent")
        if not isinstance(binary, str) or not Path(binary).is_file() or not os.access(binary, os.X_OK):
            raise PluginError("missing_omnigent", "尚未安裝可執行的 Omnigent CLI。")
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(self.state_dir / "host-launch.lock", os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(descriptor, "r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            existing = read_json(self.state_dir / "host-process.json")
            if self.process_matches(existing.get("pid"), "omnigent"):
                if existing.get("server") != server:
                    raise PluginError("host_server_mismatch", "插件管理的 host 正連接另一個 server，請先停止該 host。")
                return "plugin"
            descriptor = os.open(self.state_dir / "host.log", os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
            with os.fdopen(descriptor, "ab") as log:
                environment = dict(os.environ)
                environment["OMNIGENT_HOST_NO_OPEN"] = "1"
                for key in ("OMNIGENT_HOST_ID", "OMNIGENT_HOST_NAME", "RUNNER_SERVER_URL", "RUNNER_AUTH_TOKEN", "OMNIGENT_RUNNER_AUTH_TOKEN", "OMNIGENT_HOST_BINDING_TOKEN"):
                    environment.pop(key, None)
                process = subprocess.Popen([binary, "host", "--server", server, "--non-interactive", "--no-open"],
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=self.workspace,
                                           env=environment, start_new_session=True)
            atomic_json(self.state_dir / "host-process.json", {"pid": process.pid, "server": server})
        return "plugin"

    def connect(self) -> dict:
        server = self.server()
        self.require_compatible_kit_server(server)
        client = self.client_factory(server, False)
        username, password = self.request.get("username"), self.request.get("password")
        if username is not None or password is not None:
            if not isinstance(username, str) or not username.strip() or not isinstance(password, str) or not password:
                raise PluginError("needs_login", "請同時輸入 Omnigent 帳號及密碼。")
            if client.auth_probe() != "accounts":
                raise PluginError("needs_browser_auth", "此 server 使用瀏覽器登入；請在終端執行 omnigent login 並完成登入。")
            body = client.request("POST", "/auth/login", {"username": username.strip(), "password": password, "issue_refresh": True}, authenticated=False)
            self.auth.save(server, body)
        else:
            # Reuse only a credential for this exact normalized server. Header
            # auth servers can establish identity without a locally stored token.
            if not self.auth.token(server):
                if client.auth_probe() != "header":
                    raise PluginError("needs_login", "請輸入 Omnigent 帳號密碼，或先完成 omnigent login。")
        client.request("GET", "/v1/me")
        self.merge_config(server)
        manager = self.ensure_host(server)
        deadline = self.clock() + self.timeout(default=90)
        while True:
            result = self.catalog(client=client, read_only=False)
            if result["host"]["connected"]:
                result["host"]["manager"] = manager
                return result
            if self.local_host()["state"] == "needs-reset-id":
                raise PluginError("needs_reset_id", "此 host ID 屬於另一個 Omnigent 帳號；請改用原帳號，或在終端執行 omnigent host reset-id --yes 建立新的 host 身分。")
            if self.clock() >= deadline:
                raise PluginError("host_connect_timeout", "登入已完成，host 尚未在線；請查看插件狀態與 host supervisor。")
            self.sleep(2)

    def managed_host_pid(self, server: str) -> int | None:
        record = read_json(self.state_dir / "host-process.json")
        pid = record.get("pid")
        if not self.process_matches(pid, "omnigent"):
            return None
        try:
            pid = int(pid)
            process = Path(f"/proc/{pid}")
            argv = (process / "cmdline").read_bytes().decode().split("\0")
            environ = dict(entry.split("=", 1) for entry in (process / "environ").read_bytes().decode().split("\0") if "=" in entry)
            start = argv.index("host")
            valid = argv[start + 1:start + 3] == ["--server", server]
            valid = valid and record.get("server") == server and process.stat().st_uid == os.getuid()
            valid = valid and environ.get("OMNIGENT_CONFIG_HOME") == str(self.config_home)
            valid = valid and environ.get("OMNIGENT_DATA_DIR") == str(self.data_dir)
        except (OSError, ValueError, UnicodeError):
            valid = False
        if not valid:
            raise PluginError("host_process_mismatch", "無法確認插件管理的 host 程序；取消連結前請先檢查主機狀態。")
        return pid

    def disconnect(self) -> dict:
        server = self.server()
        self.require_compatible_kit_server(server)
        host = self.local_host()
        if not host["id"]:
            raise PluginError("missing_host_id", "目前沒有可取消連結的本機 host ID。")
        pid = None if host["managerRunning"] else self.managed_host_pid(server)
        token = self.auth.token(server, refresh=False)
        if not token:
            raise PluginError("needs_login", "無法以目前登入查核主機離線狀態；請先檢查登入。")
        client = self.client_factory(server, True)
        client.hold_token(token)
        # Validate access before removing anything. The list and all polling
        # are GETs; only this host's exact identity is considered.
        hosts = client.request("GET", "/v1/hosts").get("hosts")
        if not isinstance(hosts, list):
            raise PluginError("invalid_response", "Omnigent hosts 清單格式不正確。")
        self.auth.clear(server)
        if pid is not None:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        # The deployment supervisor notices the missing credential and stops
        # its host. It stays alive to accept a fresh login from setup.
        deadline = self.clock() + self.timeout(default=90)
        while True:
            rows = client.request("GET", "/v1/hosts").get("hosts")
            if not isinstance(rows, list):
                raise PluginError("invalid_response", "Omnigent hosts 清單格式不正確。")
            matching = next((row for row in rows if isinstance(row, dict) and row.get("host_id") == host["id"]), None)
            if not matching or matching.get("status") == "offline":
                return {"server": server, "host": {"id": host["id"], "name": host["name"], "connected": False},
                        "credentialsCleared": True, "registrationRetained": True}
            if self.clock() >= deadline:
                raise PluginError("host_disconnect_timeout", "本機登入已清除，但 server 尚未確認此 host 離線；請檢查 supervisor。")
            self.sleep(2)

    @staticmethod
    def assistant_sentinel(items: object) -> bool:
        if not isinstance(items, list):
            return False
        for item in items:
            if not isinstance(item, dict) or item.get("role") != "assistant" or item.get("type") != "message":
                continue
            content = item.get("content")
            if isinstance(content, list):
                text = "".join(block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") in ("output_text", "text") and isinstance(block.get("text"), str))
                if text.strip() == SENTINEL:
                    return True
        return False

    @staticmethod
    def exact_probe_draft(pane: str) -> bool:
        """Match the entire fixed probe in the last framed chat composer.

        Claude can wrap a pasted draft below a blank glyph row. Omnigent
        0.16's draft check only examines the glyph row, missing that case.
        History, menus, partial text and extra draft content never qualify.
        """
        lines = pane.splitlines()
        def rule(line):
            text = line.strip().strip('│┃┌┐└┘├┤╭╮╰╯')
            return len(text) >= 8 and set(text) <= set('─━═╌-')
        boundaries = [i for i, line in enumerate(lines) if rule(line)]
        if len(boundaries) < 2:
            return False
        region = lines[boundaries[-2] + 1:boundaries[-1]]
        if not region or not region[0].strip().startswith('❯'):
            return False
        text = region[0].strip()[1:] + '\n' + '\n'.join(region[1:])
        return ' '.join(text.split()) == PROBE_PROMPT

    def submit_owned_probe_draft(self, session_id: str) -> bool:
        """Recover one unsent health-check draft, never send/approve a dialog."""
        try:
            from omnigent.harnesses.claude_native import bridge
            root = Path(bridge._BRIDGE_ROOT)
            for file in root.glob('*/tmux.json'):
                directory = file.parent
                if directory.is_symlink() or directory.stat().st_uid != os.getuid():
                    continue
                if bridge.read_active_session_id(directory) != session_id:
                    continue
                info = read_json(file)
                socket, target = info.get('socket_path'), info.get('tmux_target')
                if not isinstance(socket, str) or not isinstance(target, str):
                    continue
                # Two stable captures plus a final read keep torn repaints and
                # a just-delivered prompt from spending Enter on another UI.
                for capture in range(3):
                    if bridge.read_active_session_id(directory) != session_id or bridge.has_pending_user_prompt(directory):
                        return False
                    pane = subprocess.run(['tmux', '-S', socket, 'capture-pane', '-p', '-t', target],
                                          capture_output=True, text=True, timeout=2)
                    text = pane.stdout
                    if pane.returncode or not self.exact_probe_draft(text) or bridge._terminal_dialog_headline(text) \
                            or bridge.auto_mode_billing_notice_visible(text) or bridge._history_search_footer_shown(text):
                        return False
                    if capture < 2:
                        time.sleep(0.15)
                if bridge.read_active_session_id(directory) != session_id or bridge.has_pending_user_prompt(directory):
                    return False
                command = subprocess.run(['tmux', '-S', socket, 'send-keys', '-t', target, 'Enter'],
                                         capture_output=True, timeout=2)
                return command.returncode == 0
        except (ImportError, AttributeError, OSError, subprocess.TimeoutExpired):
            pass
        return False

    def verify(self) -> dict:
        deadline = self.clock() + self.timeout()
        key = self.request.get("engine")
        if key not in ENGINES:
            raise PluginError("invalid_engine", "驗證引擎必須是 claude、codex 或 pi。")
        server = self.server()
        client = self.client_factory(server, False)
        catalog = self.catalog(client=client, read_only=False, engine_key=key)
        engine = catalog["engines"][key]
        if not catalog["host"]["connected"]:
            raise PluginError("host_offline", "此容器的 Omnigent host 尚未在線。")
        if not engine["agentId"]:
            raise PluginError("missing_agent", "Server 尚未提供此引擎的原生 agent 模組。")
        if engine["configured"] is not True:
            raise PluginError("engine_not_ready", "此引擎尚未完成安裝或供應商登入。")
        selected = self.request.get("model")
        if selected is None and not engine['models']:
            raise PluginError('models_unavailable', '此引擎尚未提供可驗證的模型。')
        if selected is not None and selected not in {row["id"] for row in engine["models"]}:
            raise PluginError("invalid_model", "選取的模型不在此 host 的實際模型清單內。")
        if self.clock() >= deadline:
            raise PluginError("verify_timeout", "取得 host 與模型清單已超過驗證等待時間，尚未建立測試對話。")
        body = {"agent_id": engine["agentId"], "host_id": catalog["host"]["id"], "workspace": str(self.workspace),
                "title": f"Pi Web connection check · {key}", "harness_override": ENGINES[key]["harness"]}
        if selected:
            body["model_override"] = selected
        if key == "claude":
            # The no-tools health probe uses this session's ordinary attended
            # mode. Auto mode can present a first-run dialog that consumes the
            # native bridge's submit key; do not drive or approve that dialog.
            body["terminal_launch_args"] = ["--permission-mode", "default"]
        created = client.request("POST", "/v1/sessions", body)
        session_id = created.get("id") or created.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise PluginError("invalid_session_response", "Server 沒有回傳已建立的驗證對話 ID。")
        result = {"engine": key, "ok": False, "reply": None, "sessionId": session_id,
                  "url": f"{server}/c/{quote(session_id, safe='')}", "model": selected, "reason": "REPLY_TIMEOUT"}
        try:
            # Claude 2.1 can mount its initial Auto mode dialog after the first
            # composer paint. In live tests an immediate first event left the
            # probe in the draft after that dialog consumed Enter. Allow the
            # newly created TUI to settle before sending the one test message.
            # This is bounded by the same deadline and never answers a dialog,
            # retries a prompt, or changes the user's permission policy.
            if key == "claude":
                self.sleep(min(3.0, max(0.0, deadline - self.clock())))
                if self.clock() >= deadline:
                    result["reason"] = "NATIVE_START_TIMEOUT"
                    return result
            # Follow the web composer: native TUI harnesses may never consume
            # initial_items passed on creation, so deliver one explicit event.
            client.request("POST", f"/v1/sessions/{quote(session_id, safe='')}/events", {
                "type": "message", "data": {"role": "user", "content": [
                    {"type": "input_text", "text": PROBE_PROMPT}]}})
            recover_after = self.clock() + 8.0
            while True:
                page = client.request("GET", f"/v1/sessions/{quote(session_id, safe='')}/items?limit=100&order=desc")
                if self.assistant_sentinel(page.get("data")):
                    result.update(ok=True, reply=SENTINEL, reason=None)
                    break
                failure = next((item.get("code") for item in page.get("data", [])
                                if isinstance(item, dict) and item.get("type") == "error"
                                and isinstance(item.get("code"), str)
                                and re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]{0,63}", item["code"])), None)
                if failure:
                    result["reason"] = failure.upper()
                    break
                if self.clock() >= deadline:
                    break
                if key == 'claude' and self.clock() >= recover_after and deadline - self.clock() > 10 \
                        and not result.get('nativeSubmitRecovered'):
                    if self.probe_submit(session_id):
                        result['nativeSubmitRecovered'] = True
                self.sleep(2)
        except PluginError as error:
            result["reason"] = error.code
        finally:
            stop_path = f"/v1/sessions/{quote(session_id, safe='')}/events"
            stop_event = {"type": "stop_session", "data": {}}
            retryable = {"SERVER_UNREACHABLE", "NEEDS_LOGIN", "HTTP_408", "HTTP_409",
                         "HTTP_425", "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504"}
            for attempt in range(2):
                try:
                    client.request("POST", stop_path, stop_event,
                                   timeout_seconds=15.0, refresh_auth=attempt > 0)
                    result["cleanup"] = "stopped"
                    break
                except PluginError as error:
                    result["cleanup"] = "stop_failed"
                    if attempt == 0 and error.code in retryable:
                        self.sleep(0.5)
                        continue
                    break
        return result


def dispatch(request: dict, **dependencies) -> dict:
    if not isinstance(request, dict):
        raise PluginError("invalid_request", "請提供 JSON object。")
    action = request.get("action")
    if action not in ("status", "catalog", "connect", "verify", "disconnect"):
        raise PluginError("invalid_action", "不支援此 Omnigent 操作。")
    plugin = Plugin(request, **dependencies)
    try:
        return getattr(plugin, action)()
    finally:
        plugin.close()


def main() -> None:
    # Third-party imports and credential refresh diagnostics stay off the JSON
    # wire. The public error envelope never includes raw exception/HTTP bodies.
    try:
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise PluginError("request_too_large", "初始化請求過大。")
        request = json.loads(raw)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            data = dispatch(request)
        result = {"ok": True, "data": data}
    except PluginError as error:
        result = {"ok": False, "error": {"code": error.code, "message": error.message}}
    except (json.JSONDecodeError, UnicodeError):
        result = {"ok": False, "error": {"code": "INVALID_JSON", "message": "初始化請求不是有效 JSON。"}}
    except (ImportError, ModuleNotFoundError):
        result = {"ok": False, "error": {"code": "MISSING_DEPENDENCY", "message": "Omnigent 套件尚未安裝完整。"}}
    except Exception:
        result = {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": "Omnigent 操作失敗；請重新檢查插件設定。"}}
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
