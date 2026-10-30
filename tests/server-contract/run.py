#!/usr/bin/env python3
"""Server contract: the plugin's own Python adapter against a real, local Omnigent server.

tests/test_omnigent.py answers every server call with a fake. This script starts an actual
`omnigent server` (accounts auth, sqlite, loopback only) and drives src/omnigent.py through the same
JSON boundary the Node runtime uses: connect, host online, resume (running, and after the host process
died), identity mismatch, disconnect, reconnect.

No model, engine or external service is involved. Every process runs in a scrubbed environment (nothing
is inherited from the caller, so a local OMNIGENT_* setting cannot leak in or be written to), telemetry and
update checks are off, all passwords are generated for this run, and an egress tripwire fails the run if a
process tries to leave the machine.

Run it with the Python that has the pinned SDK installed:

    python tests/server-contract/run.py [--server-omnigent PATH] [--expect-server-version X] [--expect-sdk-version Y]

--server-omnigent starts the server from another installation (for example a newer release), while the
adapter and the managed host keep using the SDK of the interpreter that runs this script.

--server-url URL drives an existing server instead (for example a candidate server image deployed in a
sandbox before it replaces a production one). The admin account comes from CONTRACT_ADMIN_USERNAME and
CONTRACT_ADMIN_PASSWORD, never from argv. Account and host names get a per-run suffix, and the managed host
may hold a connection to that server and nowhere else. --expect-host-delete adds the owner host delete
(DELETE /v1/hosts/{id}: refused while online, removed once offline) of servers that carry it.
"""
from __future__ import annotations

import argparse
import contextlib
import http.server
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / 'src' / 'omnigent.py'
ADMIN, OTHER, HOST_NAME = 'contract-admin', 'contract-other', 'contract-host'
READINESS = (True, False, 'binary-missing', 'needs-auth', 'version-too-low', None)
NO_ENGINES = {name: {'installed': False} for name in ('claude', 'codex', 'pi')}


class ContractError(AssertionError):
    pass


def require(condition, message):
    if not condition:
        raise ContractError(message)


# --- processes (Linux /proc; the adapter itself identifies hosts the same way) ----------------------------

def proc_state(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
    except OSError:
        return None
    return raw[raw.rfind(')') + 2:].split()


def alive(pid):
    state = proc_state(pid)
    return bool(state) and state[0] not in ('Z', 'X')


def gone(pid):
    # A dead process stays visible as a zombie until its parent reaps it; the adapter reads that as a
    # host it cannot identify (HOST_PROCESS_MISMATCH), so steps that restart a host wait for this.
    return not Path(f'/proc/{pid}').exists()


def all_pids():
    return [int(entry.name) for entry in Path('/proc').iterdir() if entry.name.isdigit()]


def descendants(pid):
    parents = {}
    for other in all_pids():
        state = proc_state(other)
        if state:
            parents.setdefault(int(state[1]), []).append(other)
    found, queue = [], [pid]
    while queue:
        for child in parents.get(queue.pop(), []):
            if child not in found:
                found.append(child)
                queue.append(child)
    return found


def stop_tree(pid, grace=8.0):
    members = [pid, *descendants(pid)]
    for signum, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 3.0)):
        for member in members:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(member, signum)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline and any(alive(member) for member in members):
            time.sleep(0.1)
        if not any(alive(member) for member in members):
            return


def marked_pids(marker):
    """Live processes of this user whose environment names the run's private directory."""
    needle, found = marker.encode(), []
    for pid in all_pids():
        if pid == os.getpid():
            continue
        with contextlib.suppress(OSError):
            if needle in Path(f'/proc/{pid}/environ').read_bytes() and alive(pid):
                found.append(pid)
    return found


def host_processes(config_home):
    """Live `omnigent host` processes started for one OMNIGENT_CONFIG_HOME."""
    needle, found = f'OMNIGENT_CONFIG_HOME={config_home}\0'.encode(), []
    for pid in all_pids():
        try:
            argv = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            if b'host' not in argv or not any(b'omnigent' in part for part in argv[:argv.index(b'host')]):
                continue
            if needle in Path(f'/proc/{pid}/environ').read_bytes() and alive(pid):
                found.append(pid)
        except OSError:
            continue
    return found


def loopback(address_hex):
    raw = bytes.fromhex(address_hex)
    # /proc/net prints every 32-bit word byte-reversed.
    raw = b''.join(raw[i:i + 4][::-1] for i in range(0, len(raw), 4))
    if len(raw) == 4:
        return raw[0] == 127 or raw == bytes(4)
    return raw in (bytes(15) + b'\x01', bytes(16)) or (raw[:12] == bytes(10) + b'\xff\xff' and raw[12] == 127)


def peer_address(field):
    """(ip, port) of a /proc/net address field such as 0100007F:1F40."""
    address_hex, port_hex = field.split(':')
    raw = bytes.fromhex(address_hex)
    raw = b''.join(raw[i:i + 4][::-1] for i in range(0, len(raw), 4))
    address = ipaddress.ip_address(raw)
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    return str(address), int(port_hex, 16)


def external_sockets(pids, allowed=frozenset()):
    """Sockets held by these processes whose peer is not on this machine (nor one of the allowed (ip, port))."""
    inodes = set()
    for pid in pids:
        with contextlib.suppress(OSError):
            for fd in Path(f'/proc/{pid}/fd').iterdir():
                with contextlib.suppress(OSError):
                    target = os.readlink(fd)
                    if target.startswith('socket:['):
                        inodes.add(target[8:-1])
    found = []
    for table in ('tcp', 'tcp6', 'udp', 'udp6'):
        with contextlib.suppress(OSError):
            for line in Path(f'/proc/net/{table}').read_text().splitlines()[1:]:
                fields = line.split()
                if fields[9] in inodes and not loopback(fields[2].split(':')[0]) and peer_address(fields[2]) not in allowed:
                    found.append(f'{table} peer {fields[2]}')
    return found


# --- egress tripwire -------------------------------------------------------------------------------------

class Tripwire:
    """A local HTTP proxy that refuses everything and remembers what was asked for."""

    def __init__(self):
        attempts = self.attempts = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def refuse(self):
                attempts.append(f'{self.command} {self.path}'.split('?')[0][:160])
                self.send_response(403)
                self.send_header('Content-Length', '0')
                self.end_headers()

            do_GET = do_POST = do_PUT = do_HEAD = do_DELETE = do_PATCH = do_OPTIONS = do_CONNECT = refuse

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


# --- the run ---------------------------------------------------------------------------------------------

class Account:
    """One client installation: its own HOME, Omnigent config, plugin state and workspace."""

    def __init__(self, root, name):
        self.name = name
        self.home, self.config_home = root / name / 'home', root / name / 'omnigent'
        self.state_dir, self.workspace = root / name / 'plugin-state', root / name / 'workspace'
        for path in (self.home / 'tmp', self.config_home, self.state_dir, self.workspace):
            path.mkdir(parents=True, exist_ok=True)

    @property
    def config_file(self):
        return self.config_home / 'config.yaml'

    @property
    def tokens_file(self):
        return self.config_home / 'auth_tokens.json'

    def host_id(self):
        match = re.search(r'^\s*host_id:\s*(\S+)\s*$', self.config_file.read_text(), re.MULTILINE)
        require(match, f'{self.name}: config.yaml has no host id')
        return match.group(1)

    def host_pid(self):
        return json.loads((self.state_dir / 'host-process.json').read_text())['pid']


class Contract:
    def __init__(self, args, tmp):
        self.args, self.tmp = args, tmp
        self.client_python = Path(sys.executable)
        self.client_bin = self.client_python.parent / 'omnigent'
        self.server_bin = Path(args.server_omnigent) if args.server_omnigent else self.client_bin
        for binary in (self.client_bin,) if args.server_url else (self.client_bin, self.server_bin):
            require(binary.is_file(), f'{binary} not found; run this with the Python that has omnigent installed')
        self.other_password = secrets.token_urlsafe(24)
        self.admin_user, self.other_user, self.host_name = ADMIN, OTHER, HOST_NAME
        self.allowed_peers = frozenset()
        if args.server_url:
            self.admin_user = os.environ.get('CONTRACT_ADMIN_USERNAME', '')
            self.admin_password = os.environ.get('CONTRACT_ADMIN_PASSWORD', '')
            require(self.admin_user and self.admin_password, '--server-url needs CONTRACT_ADMIN_USERNAME and CONTRACT_ADMIN_PASSWORD')
            # The server outlives this run and may already know earlier runs' accounts and hosts.
            run = secrets.token_hex(3)
            self.other_user, self.host_name = f'{OTHER}-{run}', f'{HOST_NAME}-{run}'
            parts = urlsplit(args.server_url)
            require(parts.scheme in ('http', 'https') and parts.hostname, f'--server-url is not an http(s) URL: {args.server_url}')
            self.server_host = parts.hostname
            port = parts.port or (443 if parts.scheme == 'https' else 80)
            self.allowed_peers = frozenset((info[4][0], port) for info in socket.getaddrinfo(parts.hostname, port, proto=socket.IPPROTO_TCP))
        else:
            self.admin_password = secrets.token_urlsafe(24)
            self.server_host = None
        self.sensitive = {self.admin_password, self.other_password}
        self.tripwire = Tripwire()
        self.engines = self.write_engine_stand_ins(tmp / 'engines')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.server_data = tmp / 'server' / 'data'
        self.server_data.mkdir(parents=True)
        (tmp / 'server' / 'home' / 'tmp').mkdir(parents=True)
        self.server = None
        self.base = None
        self.accounts = []
        self.results = []
        self.versions = {}

    # environment --------------------------------------------------------------------------------------

    @staticmethod
    def write_engine_stand_ins(directory):
        # The SDK looks for the engine CLIs on PATH and then in fixed directories (/usr/local/bin, ~/.local/bin,
        # ...), and a host probes whatever it finds at boot: a real Codex would open connections to github.com
        # and chatgpt.com. First on PATH, these answer --version and refuse everything else, so the run
        # looks the same on a machine with real engines and on one without.
        directory.mkdir(parents=True)
        for name, version in (('codex', 'codex-cli 0.0.0'), ('claude', '0.0.0 (Claude Code)'), ('pi', '0.0.0')):
            script = directory / name
            script.write_text(f'#!/bin/sh\ncase "$1" in --version) echo "{version}"; exit 0;; esac\nexit 1\n')
            script.chmod(0o755)
        return directory

    @property
    def no_proxy(self):
        return ','.join(['127.0.0.1', 'localhost', '::1'] + ([self.server_host] if self.server_host else []))

    def environment(self, bin_dir, home, **extra):
        proxy = self.tripwire.url
        env = {'PATH': f'{self.engines}:{bin_dir}:/usr/bin:/bin', 'HOME': str(home), 'TMPDIR': str(home / 'tmp'),
               'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'NO_COLOR': '1',
               'OMNIGENT_ANALYTICS': '0', 'OMNIGENT_NO_UPDATE_CHECK': '1',
               'NO_PROXY': self.no_proxy, 'no_proxy': self.no_proxy}
        for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
            env[name] = proxy
        env.update(extra)
        return env

    def scrub(self, text):
        for secret in self.sensitive:
            text = text.replace(secret, '[redacted]')
        return text

    # server ---------------------------------------------------------------------------------------------

    def start_server(self):
        if self.args.server_url:
            self.base = self.args.server_url.rstrip('/')
            deadline = time.monotonic() + self.args.startup_timeout
            while time.monotonic() < deadline:
                if self.request('GET', '/health')[0] == 200:
                    return
                time.sleep(0.5)
            raise ContractError(f'{self.base} never answered /health')
        home = self.tmp / 'server' / 'home'
        env = self.environment(
            self.server_bin.parent, home, OMNIGENT_AUTH_ENABLED='1', OMNIGENT_AUTH_PROVIDER='accounts',
            OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME=ADMIN, OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD=self.admin_password,
            OMNIGENT_ACCOUNTS_COOKIE_SECRET=secrets.token_hex(32),
            OMNIGENT_CONFIG_HOME=str(self.server_data), OMNIGENT_DATA_DIR=str(self.server_data))
        for attempt in range(3):
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            self.base = f'http://127.0.0.1:{port}'
            log = open(self.tmp / 'server.log', 'ab')
            self.server = subprocess.Popen(
                [str(self.server_bin), 'server', '--host', '127.0.0.1', '--port', str(port), '--no-open',
                 '--database-uri', f'sqlite:///{self.server_data}/chat.db',
                 '--artifact-location', str(self.server_data / 'artifacts')],
                env=env, cwd=home, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            log.close()
            deadline = time.monotonic() + self.args.startup_timeout
            while time.monotonic() < deadline and self.server.poll() is None:
                if self.request('GET', '/health')[0] == 200:
                    return
                time.sleep(0.5)
            if self.server.poll() is None:
                stop_tree(self.server.pid)
            print(f'server did not become healthy (attempt {attempt + 1})', file=sys.stderr)
        raise ContractError('the server never answered /health')

    # the server as seen by a plain HTTP client (independent of the adapter) -------------------------------

    def request(self, method, path, body=None, token=None):
        headers = {'Accept': 'application/json'}
        data = None
        if body is not None:
            data, headers['Content-Type'] = json.dumps(body).encode(), 'application/json'
        if token:
            headers['Authorization'] = f'Bearer {token}'
        try:
            with self.opener.open(urllib.request.Request(self.base + path, data=data, headers=headers, method=method), timeout=10) as reply:
                status, raw = reply.status, reply.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
        except OSError:
            return 0, None
        try:
            return status, json.loads(raw or b'null')
        except ValueError:
            return status, None

    def login(self, username, password):
        status, body = self.request('POST', '/auth/login', {'username': username, 'password': password})
        require(status == 200 and isinstance(body, dict) and body.get('token'), f'/auth/login answered {status} for {username}')
        self.sensitive.add(body['token'])
        return body['token']

    def hosts_of(self, token):
        status, body = self.request('GET', '/v1/hosts', token=token)
        require(status == 200 and isinstance(body.get('hosts'), list), f'/v1/hosts answered {status}')
        return body['hosts']

    def wait_for(self, what, predicate, timeout=30.0):
        deadline = time.monotonic() + timeout
        while True:
            value = predicate()
            if value:
                return value
            require(time.monotonic() < deadline, f'timed out waiting for {what}')
            time.sleep(0.5)

    # the adapter, through its stdin/stdout JSON boundary -------------------------------------------------

    def account(self, name):
        account = Account(self.tmp, name)
        self.accounts.append(account)
        return account

    def adapter(self, account, action, **fields):
        request = {'action': action, 'configHome': str(account.config_home), 'dataDir': str(account.config_home),
                   'stateDir': str(account.state_dir), 'workspace': str(account.workspace),
                   'omnigentBin': str(self.client_bin), 'timeoutSeconds': 90, 'engineInventory': NO_ENGINES,
                   'server': self.base, **fields}
        env = self.environment(self.client_python.parent, account.home,
                               OMNIGENT_CONFIG_HOME=str(account.config_home), OMNIGENT_DATA_DIR=str(account.config_home))
        done = subprocess.run([str(self.client_python), str(ADAPTER)], input=json.dumps(request), env=env,
                              cwd=account.workspace, capture_output=True, text=True, timeout=180)
        lines = done.stdout.strip().splitlines()
        require(done.returncode == 0 and len(lines) == 1, f'adapter {action}: exit {done.returncode}, {len(lines)} output lines')
        reply = json.loads(lines[0])
        require(isinstance(reply, dict) and isinstance(reply.get('ok'), bool), f'adapter {action}: unexpected reply shape')
        text = done.stdout + done.stderr
        require(not any(secret in text for secret in self.sensitive), f'adapter {action}: a secret reached its output')
        return reply

    def adapter_ok(self, account, action, **fields):
        reply = self.adapter(account, action, **fields)
        require(reply['ok'], f'adapter {action} failed: {json.dumps(reply.get("error"), ensure_ascii=False)}')
        return reply['data']

    def adapter_refused(self, account, action, codes, **fields):
        reply = self.adapter(account, action, **fields)
        code = (reply.get('error') or {}).get('code')
        require(reply['ok'] is False and code in codes, f'adapter {action}: expected {sorted(codes)}, got {reply}')
        return code

    # checks reused by several steps -----------------------------------------------------------------------

    def check_host_online(self, token, account, host_id):
        mine = [row for row in self.hosts_of(token) if row.get('host_id') == host_id]
        require(len(mine) == 1, f'the server lists {len(mine)} rows for the {account.name} host')
        require(mine[0].get('owner') == self.admin_user and mine[0].get('status') == 'online', f'host row: {mine[0]}')
        return mine[0]

    def check_no_egress_sockets(self):
        trees = [self.server.pid] if self.server else []
        trees += [account.host_pid() for account in self.accounts if (account.state_dir / 'host-process.json').exists()]
        pids = {member for root in trees if alive(root) for member in (root, *descendants(root))}
        found = external_sockets(pids, self.allowed_peers)
        require(not found, f'a process holds a connection to another machine: {found}')

    def check_no_secret_on_disk(self, account):
        files = [path for path in (account.home, account.config_home, account.state_dir, account.workspace)
                 for path in path.rglob('*') if path.is_file() and not path.is_symlink()]
        needles = [self.admin_password.encode(), self.other_password.encode()]
        leaked = [str(path.relative_to(self.tmp)) for path in files if any(n in path.read_bytes() for n in needles)]
        require(not leaked, f'a password was written to disk: {leaked}')

    # steps ----------------------------------------------------------------------------------------------

    def step_server(self):
        status, body = self.request('GET', '/v1/me')
        # Adapter.auth_probe decides between password and browser login from exactly this answer.
        require(status == 401 and isinstance(body, dict) and body.get('login_url') == '/login',
                f'anonymous /v1/me must answer 401 with login_url=/login, got {status} {body}')
        status, info = self.request('GET', '/v1/info')
        require(status == 200 and info.get('accounts_enabled') is True, f'/v1/info: {status} {info}')
        self.versions['server'] = info.get('server_version')
        expected = self.args.expect_server_version
        require(not expected or self.versions['server'] == expected, f'server is {self.versions["server"]}, expected {expected}')
        self.admin_token = self.login(self.admin_user, self.admin_password)

    def step_connect(self):
        self.a = self.account('client')
        data = self.adapter_ok(self.a, 'connect', username=self.admin_user, password=self.admin_password,
                               allowManagedHost=True, hostName=self.host_name)
        host = data['host']
        require(data['server'] == self.base, 'connect answered for another server')
        require(host['connected'] is True and host['manager'] == 'plugin' and host['name'] == self.host_name, f'host: {host}')
        require(isinstance(host['id'], str) and host['id'], 'connect returned no host id')
        self.host_id = host['id']
        require(set(data['engines']) == {'claude', 'codex', 'pi'}, f'engines: {sorted(data["engines"])}')
        for key, engine in data['engines'].items():
            require(engine['configured'] in READINESS, f'{key}: unknown readiness {engine["configured"]!r}')
            require(isinstance(engine['agentId'], str) and engine['agentId'], f'{key}: the server has no built-in agent for it')
        require(data['modules'] and all(isinstance(m.get('key'), str) and isinstance(m.get('name'), str) for m in data['modules']),
                'harness catalog has an unexpected shape')
        # What the server says, asked directly and not through the adapter.
        self.check_host_online(self.admin_token, self.a, self.host_id)
        # What the adapter left behind.
        require(self.a.host_id() == self.host_id and self.base in self.a.config_file.read_text(), 'config.yaml does not name the host and server')
        require(stat.S_IMODE(self.a.tokens_file.stat().st_mode) == 0o600, 'auth_tokens.json is not private')
        require(self.base in json.loads(self.a.tokens_file.read_text()), 'no login stored for the server')
        self.pid = self.a.host_pid()
        require(host_processes(self.a.config_home) == [self.pid], f'expected exactly one host process, found {host_processes(self.a.config_home)}')
        self.check_no_secret_on_disk(self.a)
        self.check_no_egress_sockets()

    def step_status_catalog(self):
        status = self.adapter_ok(self.a, 'status')
        require(status['host']['id'] == self.host_id and status['host']['connected'] is True, f'status host: {status["host"]}')
        require(status['connectivityError'] is None, f'status: {status["connectivityError"]}')
        require(status['installed'] is True, 'status does not see the SDK')
        self.versions['sdk'] = status['version']
        expected = self.args.expect_sdk_version
        require(not expected or status['version'] == expected, f'SDK is {status["version"]}, expected {expected}')
        catalog = self.adapter_ok(self.a, 'catalog')
        require(catalog['host']['id'] == self.host_id and catalog['host']['connected'] is True, f'catalog host: {catalog["host"]}')
        require(all(catalog['engines'][key]['agentId'] for key in ('claude', 'codex', 'pi')), 'catalog lost a built-in agent')

    def step_resume_running(self):
        before = self.a.config_file.read_bytes()
        data = self.adapter_ok(self.a, 'resume', resumeHostId=self.host_id, allowManagedHost=True)
        require(data['host'] == {'id': self.host_id, 'connected': True, 'manager': 'plugin'}, f'resume host: {data["host"]}')
        require(self.a.host_pid() == self.pid and host_processes(self.a.config_home) == [self.pid], 'resume started a second host')
        require(self.a.config_file.read_bytes() == before, 'resume rewrote config.yaml')

    def step_resume_after_restart(self):
        stop_tree(self.pid)
        self.wait_for('the old host process to be reaped', lambda: gone(self.pid))
        self.wait_for('the server to see the host go offline',
                      lambda: any(row['host_id'] == self.host_id and row['status'] == 'offline' for row in self.hosts_of(self.admin_token)))
        data = self.adapter_ok(self.a, 'resume', resumeHostId=self.host_id, allowManagedHost=True)
        require(data['host']['id'] == self.host_id and data['host']['connected'] is True, f'resume host: {data["host"]}')
        fresh = self.a.host_pid()
        require(fresh != self.pid and host_processes(self.a.config_home) == [fresh], 'resume did not start exactly one new host')
        self.pid = fresh
        self.wait_for('the server to see the host online again',
                      lambda: any(row['host_id'] == self.host_id and row['status'] == 'online' for row in self.hosts_of(self.admin_token)))
        self.check_no_egress_sockets()

    def step_mismatch_local(self):
        before = self.a.config_file.read_bytes()
        for label, fields in (('another host id', {'resumeHostId': 'not-this-host'}),
                              ('another server', {'resumeHostId': self.host_id, 'server': 'http://127.0.0.1:9'})):
            self.adapter_refused(self.a, 'resume', {'CONNECTION_IDENTITY_MISMATCH'}, allowManagedHost=True, **fields)
            require(self.a.config_file.read_bytes() == before, f'{label}: config.yaml changed')
            require(self.a.host_pid() == self.pid and host_processes(self.a.config_home) == [self.pid], f'{label}: the running host was touched')

    def step_mismatch_foreign(self):
        # A second account on the same server. Its own connection works; then its config is pointed at the
        # first account's host id, the way a wrong host id ended up in a tenant's config. The server answers
        # 403 for a host the caller does not own, and the adapter must neither start a host nor write anything.
        status, invite = self.request('POST', '/auth/invite', {'is_admin': False}, token=self.admin_token)
        require(status == 200 and invite.get('token'), f'/auth/invite answered {status}')
        status, _ = self.request('POST', '/auth/register', {'invite': invite['token'], 'username': self.other_user, 'password': self.other_password})
        require(status == 200, f'/auth/register answered {status}')
        b = self.account('other')
        own = self.adapter_ok(b, 'connect', username=self.other_user, password=self.other_password, allowManagedHost=True,
                              hostName=f'other-{self.host_name}')
        self.other_host_id = own['host']['id']
        require(own['host']['connected'] is True and own['host']['id'] != self.host_id, 'the second account did not get its own host')
        other_pid = b.host_pid()
        stop_tree(other_pid)
        self.wait_for('the second host to be reaped', lambda: gone(other_pid))
        b.config_file.write_text(b.config_file.read_text().replace(own['host']['id'], self.host_id))
        before = {path: path.read_bytes() for path in (b.config_file, b.state_dir / 'host-process.json')}
        self.adapter_refused(b, 'resume', {'FORBIDDEN', 'CONNECTION_IDENTITY_MISMATCH'}, resumeHostId=self.host_id, allowManagedHost=True)
        require(all(path.read_bytes() == data for path, data in before.items()), 'the refused resume wrote to the second account')
        require(not host_processes(b.config_home), 'the refused resume started a host')
        require(self.a.host_pid() == self.pid and host_processes(self.a.config_home) == [self.pid], 'the owner host was disturbed')
        self.check_host_online(self.admin_token, self.a, self.host_id)
        self.check_no_secret_on_disk(b)

    def step_disconnect(self):
        data = self.adapter_ok(self.a, 'disconnect')
        require(data['credentialsCleared'] is True and data['registrationRetained'] is True, f'disconnect: {data}')
        require(data['host']['id'] == self.host_id and data['host']['connected'] is False, f'disconnect host: {data["host"]}')
        self.wait_for('the stopped host to be reaped', lambda: gone(self.pid))
        require(not host_processes(self.a.config_home), 'disconnect left the host running')
        require(self.base not in json.loads(self.a.tokens_file.read_text()), 'the login is still stored')
        require(self.a.host_id() == self.host_id, 'disconnect forgot the host identity')
        rows = [row for row in self.hosts_of(self.admin_token) if row['host_id'] == self.host_id]
        require(len(rows) == 1 and rows[0]['status'] == 'offline', f'the server should keep the host, offline: {rows}')

    def step_resume_after_disconnect(self):
        self.adapter_refused(self.a, 'resume', {'NEEDS_LOGIN'}, resumeHostId=self.host_id, allowManagedHost=True)
        require(not host_processes(self.a.config_home), 'a refused resume started a host')

    def step_reconnect(self):
        data = self.adapter_ok(self.a, 'connect', username=self.admin_user, password=self.admin_password,
                               allowManagedHost=True, hostName=self.host_name)
        require(data['host']['id'] == self.host_id and data['host']['connected'] is True, f'reconnect host: {data["host"]}')
        self.pid = self.a.host_pid()
        require(host_processes(self.a.config_home) == [self.pid], 'reconnect did not leave exactly one host')
        self.check_host_online(self.admin_token, self.a, self.host_id)
        rows = self.hosts_of(self.admin_token)
        if self.args.server_url:
            # A server that outlives the run may list earlier runs' hosts too: count this run's only.
            rows = [row for row in rows if row.get('name') == self.host_name or row.get('host_id') == self.host_id]
        require(len(rows) == 1, f'reconnect registered another host: {len(rows)} rows')
        self.check_no_secret_on_disk(self.a)
        self.check_no_egress_sockets()

    def step_host_delete(self):
        status, _ = self.request('DELETE', f'/v1/hosts/{self.host_id}', token=self.admin_token)
        require(status == 409, f'deleting an online host must answer 409, got {status}')
        self.check_host_online(self.admin_token, self.a, self.host_id)
        self.adapter_ok(self.a, 'disconnect')
        self.wait_for('the stopped host to be reaped', lambda: gone(self.pid))
        self.wait_for('the server to see the host go offline',
                      lambda: any(row['host_id'] == self.host_id and row['status'] == 'offline' for row in self.hosts_of(self.admin_token)))
        status, _ = self.request('DELETE', f'/v1/hosts/{self.host_id}', token=self.admin_token)
        require(status in (200, 204), f'deleting the offline host answered {status}')
        require(not any(row['host_id'] == self.host_id for row in self.hosts_of(self.admin_token)), 'the deleted host is still listed')
        other_token = self.login(self.other_user, self.other_password)
        status, _ = self.request('DELETE', f'/v1/hosts/{self.other_host_id}', token=other_token)
        require(status in (200, 204), f'the second account deleting its own offline host answered {status}')

    def step_no_egress(self):
        require(not self.tripwire.attempts, f'a process tried to reach {sorted(set(self.tripwire.attempts))}')

    def steps(self):
        return [
            ('server answers the anonymous probes the adapter relies on', self.step_server),
            ('connect: fresh login, managed host online', self.step_connect),
            ('status and catalog agree with the server', self.step_status_catalog),
            ('resume while the host runs reuses it', self.step_resume_running),
            ('resume after the host process died starts the same host again', self.step_resume_after_restart),
            ('identity mismatch: another host id or server is refused', self.step_mismatch_local),
            ('identity mismatch: another account cannot take this host', self.step_mismatch_foreign),
            ('disconnect: login cleared, host stopped, registration kept', self.step_disconnect),
            ('resume after disconnect asks for a login', self.step_resume_after_disconnect),
            ('connect again keeps the host identity', self.step_reconnect),
            *([('owner host delete: refused online, removed offline', self.step_host_delete)]
              if self.args.expect_host_delete else []),
            ('nothing tried to leave the machine', self.step_no_egress),
        ]

    def run(self):
        failed = None
        try:
            self.start_server()
            print(f'server up on {self.base}')
            for name, step in self.steps():
                started = time.monotonic()
                try:
                    step()
                except (AssertionError, subprocess.SubprocessError, OSError, ValueError, KeyError, TypeError) as error:
                    failed = (name, self.scrub(f'{type(error).__name__}: {error}'))
                    self.results.append({'step': name, 'ok': False, 'seconds': round(time.monotonic() - started, 1)})
                    print(f'FAIL {name}\n     {failed[1]}')
                    break
                self.results.append({'step': name, 'ok': True, 'seconds': round(time.monotonic() - started, 1)})
                print(f'ok   {name} ({self.results[-1]["seconds"]}s)')
        finally:
            self.shutdown()
        if failed:
            self.print_logs()
        print(json.dumps({'ok': failed is None, 'server': self.versions.get('server'), 'sdk': self.versions.get('sdk'),
                          'steps': self.results}))
        return 0 if failed is None else 1

    def print_logs(self):
        for name, path in [('server.log', self.tmp / 'server.log')] + [
                (f'{a.name} host.log', a.state_dir / 'host.log') for a in self.accounts]:
            if path.exists():
                tail = self.scrub(path.read_text(errors='replace')).splitlines()[-25:]
                print(f'--- {name} (last {len(tail)} lines)', file=sys.stderr)
                print('\n'.join(tail), file=sys.stderr)

    def shutdown(self):
        for account in self.accounts:
            for pid in host_processes(account.config_home):
                stop_tree(pid)
        if self.server is not None and self.server.poll() is None:
            stop_tree(self.server.pid)
        for pid in marked_pids(str(self.tmp)):
            stop_tree(pid)
        self.tripwire.close()
        if self.args.logs:
            target = Path(self.args.logs)
            target.mkdir(parents=True, exist_ok=True)
            for name, path in [('server.log', self.tmp / 'server.log')] + [
                    (f'{a.name}-host.log', a.state_dir / 'host.log') for a in self.accounts]:
                if path.exists():
                    (target / name).write_text(self.scrub(path.read_text(errors='replace')))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--server-omnigent', help='omnigent executable that runs the server (default: the SDK of this interpreter)')
    parser.add_argument('--expect-server-version', help='fail unless the server reports this version')
    parser.add_argument('--expect-sdk-version', help='fail unless the adapter sees this SDK version')
    parser.add_argument('--server-url', help='drive this existing server instead of starting one (admin from CONTRACT_ADMIN_USERNAME/_PASSWORD)')
    parser.add_argument('--expect-host-delete', action='store_true', help='also check DELETE /v1/hosts/{id} (servers that carry it)')
    parser.add_argument('--startup-timeout', type=float, default=90.0, help='seconds to wait for the server (default 90)')
    parser.add_argument('--logs', help='copy the server and host logs (secrets removed) into this directory')
    parser.add_argument('--keep', action='store_true', help='keep the private working directory')
    args = parser.parse_args(argv)
    if not sys.platform.startswith('linux'):
        print('server-contract needs Linux (/proc)', file=sys.stderr)
        return 2
    tmp = Path(tempfile.mkdtemp(prefix='pi-omnigent-contract-')).resolve()
    try:
        return Contract(args, tmp).run()
    except ContractError as error:
        print(f'setup failed: {error}', file=sys.stderr)
        return 2
    finally:
        if args.keep:
            print(f'kept {tmp}', file=sys.stderr)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
