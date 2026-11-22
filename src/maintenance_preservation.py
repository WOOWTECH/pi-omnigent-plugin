#!/usr/bin/env python3
"""Stdlib-only exact-source guard; run with the selected SDK's own Python -I -B.

Locates only sysconfig purelib. Does not import Omnigent, execute its source,
start a host, read native homes or inspect credentials.
"""
from __future__ import annotations

import argparse
import base64
import configparser
import csv
from email.parser import BytesHeaderParser
import io
import hashlib
import importlib.util
import json
import marshal
import os
from pathlib import Path
import stat
import sys
import sysconfig
import types
import time

HERE = Path(__file__).resolve().parent
BUNDLE = HERE / "native-maintenance"
TARGET = "omnigent/native/native_bridge_common.py"
BEFORE = "2a80d492f6f844a8da0e7dbb3e8aaec396a2bbd525f6d042ddc3cf2eed6bccc6"
AFTER = "68f4c2a3c0a3aa75436a15828e325bd279995435d83931d93b12516cca303962"
PINS = {
    "apply_maintenance_patch.py": "98355f8dd825b1642d5bb8d4b613954de838754c3b56fa401c7ce03c0f9b24ac",
    "source-lock.json": "3a3a30222dec807e18f785f34b1fc4201251d4ba43e005c7c8e510edb62133ab",
    "overlay/" + TARGET: AFTER,
    "console-entry.body.py": "f2356b7e212bcff63f614285750e50422de13a325ca1491e712637c998325f5b",
}


class PreservationRequired(RuntimeError):
    pass


def require(value, reason):
    if not value:
        raise PreservationRequired(reason)


def read_plain(path, limit=128 * 1024, budget=None):
    """Bounded stable regular-file read without following any symlink ancestor."""
    if budget is not None:
        budget.tick()
    require(path.is_absolute() and ".." not in path.parts, "absolute-path-required")
    for directory in (path.parent, *path.parent.parents):
        require(stat.S_ISDIR(directory.lstat().st_mode), "unsafe-source-directory")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        first = os.fstat(fd)
        require(stat.S_ISREG(first.st_mode) and first.st_nlink == 1 and first.st_size <= limit,
                "unsafe-source-file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        fingerprint = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                                    info.st_uid, info.st_gid, info.st_size,
                                    info.st_mtime_ns, info.st_ctime_ns)
        require(len(raw) == first.st_size and fingerprint(first) == fingerprint(os.fstat(fd))
                == fingerprint(path.lstat()), "source-changed-during-read")
        if budget is not None:
            budget.tick(size=len(raw))
        return raw
    finally:
        os.close(fd)


def reviewed_applicator():
    sources = {}
    for relative, expected in PINS.items():
        raw = read_plain(BUNDLE / relative)
        require(hashlib.sha256(raw).hexdigest() == expected, "packaged-review-pin-mismatch")
        sources[relative] = raw
    module = types.ModuleType("reviewed_native_maintenance_applicator")
    module.__file__ = str(BUNDLE / "apply_maintenance_patch.py")
    # Execute only the exact reviewed stdlib applicator, never the SDK payload.
    exec(compile(sources["apply_maintenance_patch.py"], module.__file__, "exec"), module.__dict__)
    lock = json.loads(sources["source-lock.json"])
    require(lock["capturedCoreVersion"] == "0.16.0", "unsupported-core-version-lock")
    return module, lock


def check_bytecode(target, source):
    """A stale unchecked cache must not bypass verification of the source bytes."""
    cache = target.parent / "__pycache__"
    if cache.exists() or cache.is_symlink():
        require(stat.S_ISDIR(cache.lstat().st_mode), "unsafe-bytecode-directory")
    for optimization in ("", "1", "2"):
        compiled = Path(importlib.util.cache_from_source(str(target), optimization=optimization))
        if compiled.exists() or compiled.is_symlink():
            raw = read_plain(compiled)
            require(len(raw) >= 16 and raw[:4] == importlib.util.MAGIC_NUMBER
                    and int.from_bytes(raw[4:8], "little") == 3
                    and raw[8:16] == importlib.util.source_hash(source),
                    "unverified-or-stale-bytecode")
            expected = compile(source, str(target), "exec", dont_inherit=True,
                               optimize=0 if optimization == "" else int(optimization))
            require(marshal.loads(raw[16:]) == expected, "bytecode-payload-differs-from-source")


class IdentityBudget:
    """One global count/deadline/byte budget across both identity preflights."""
    def __init__(self):
        self.deadline = time.monotonic() + 10
        self.names = self.distributions = self.bytes = 0

    def tick(self, *, names=0, distributions=0, size=0):
        self.names += names
        self.distributions += distributions
        self.bytes += size
        require(time.monotonic() <= self.deadline and self.names <= 8192
                and self.distributions <= 1024 and self.bytes <= 32 * 1024 * 1024,
                "sdk-identity-budget")


def distribution_identity(purelib, version, budget):
    # Inspect only this interpreter's purelib, without importlib.metadata's
    # sys.path search, arbitrary distribution selection or any SDK import.
    fd = os.open(purelib, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    candidates = []
    try:
        with os.scandir(fd) as stream:
            for item in stream:
                budget.tick(names=1)
                if not item.name.endswith((".dist-info", ".egg-info")):
                    continue
                budget.tick(distributions=1)
                directory = purelib / item.name
                is_dist = item.name.endswith(".dist-info")
                if is_dist:
                    require(stat.S_ISDIR(item.stat(follow_symlinks=False).st_mode), "unsafe-metadata-directory")
                    metadata = directory / "METADATA"
                else:
                    # Do not hide a duplicate core distribution in legacy egg
                    # metadata; that format is not supported for core admission.
                    metadata = directory / "PKG-INFO" if item.is_dir(follow_symlinks=False) else directory
                raw = read_plain(metadata, 512 * 1024, budget)
                headers = BytesHeaderParser().parsebytes(raw)
                names = headers.get_all("Name", [])
                versions = headers.get_all("Version", [])
                require(len(names) == 1 and len(versions) == 1 and not headers.defects,
                        "invalid-distribution-identity")
                if str(names[0]).strip().lower().replace("_", "-") != "omnigent":
                    continue
                require(is_dist and item.name == "omnigent-" + version + ".dist-info"
                        and str(names[0]) == "omnigent" and str(versions[0]) == version,
                        "wrong-core-distribution-version-or-path")
                candidates.append((directory, raw))
                require(len(candidates) == 1, "ambiguous-core-distribution")
    finally:
        os.close(fd)
    budget.tick()
    require(len(candidates) == 1, "missing-core-distribution")
    return candidates[0]


def record_digest(raw):
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")


def validate_sdk_identity(purelib, binary, version, budget):
    scripts = Path(sysconfig.get_path("scripts"))
    prefix = Path(sys.prefix)
    require(scripts.is_absolute() and purelib.is_relative_to(prefix)
            and scripts.is_relative_to(prefix) and binary == scripts / "omnigent"
            and Path(sys.executable).absolute().parent == scripts,
            "foreign-sdk-scripts-or-package-root")
    for directory in (purelib, scripts):
        for ancestor in (directory, *directory.parents):
            require(stat.S_ISDIR(ancestor.lstat().st_mode), "unsafe-sdk-root")
    distribution, metadata = distribution_identity(purelib, version, budget)
    entry_metadata = read_plain(distribution / "entry_points.txt", 16 * 1024, budget)
    config = configparser.ConfigParser(interpolation=None, strict=True)
    config.read_string(entry_metadata.decode("utf-8"))
    require(not config.defaults(), "unsupported-console-defaults")
    require(config.get("console_scripts", "omnigent", fallback=None) == "omnigent.cli:main",
            "unsupported-console-entry-point")
    script = read_plain(binary, 4096, budget)
    body = read_plain(BUNDLE / "console-entry.body.py", 4096, budget)
    require(hashlib.sha256(body).hexdigest() == PINS["console-entry.body.py"]
            and script == b"#!" + os.fsencode(sys.executable) + b"\n" + body,
            "unsupported-python-console-script")
    # Bind the declared core distribution to the exact selected entry and
    # package roots. Original RECORD common bytes remain BEFORE after applying
    # the reviewed overlay; the applicator intentionally does not rewrite it.
    record = read_plain(distribution / "RECORD", 2 * 1024 * 1024, budget)
    rows = {}
    for number, row in enumerate(csv.reader(io.StringIO(record.decode("utf-8"))), 1):
        budget.tick()
        require(number <= 16384 and len(row) == 3 and row[0] not in rows,
                "invalid-or-ambiguous-distribution-record")
        rows[row[0]] = row[1:]
    required = {
        distribution.name + "/METADATA": metadata,
        distribution.name + "/entry_points.txt": entry_metadata,
        os.path.relpath(binary, purelib).replace(os.sep, "/"): script,
        "omnigent/__init__.py": read_plain(purelib / "omnigent/__init__.py", 1024 * 1024, budget),
        "omnigent/cli.py": read_plain(purelib / "omnigent/cli.py", 1024 * 1024, budget),
    }
    for name, raw in required.items():
        require(rows.get(name) == [record_digest(raw), str(len(raw))], "record-owner-or-bytes-mismatch")
    before_digest = "sha256=" + base64.urlsafe_b64encode(bytes.fromhex(BEFORE)).decode().rstrip("=")
    require(rows.get(TARGET) == [before_digest, "8754"], "record-common-source-not-captured-core")
    return {"distribution": "omnigent", "coreVersion": version,
            "distributionRoot": str(distribution), "pythonExecutable": sys.executable,
            "consoleScript": str(binary), "consoleScriptSha256": hashlib.sha256(script).hexdigest(),
            "consoleEntryPoint": "omnigent.cli:main", "consoleScriptValidated": True,
            "metadataSha256": hashlib.sha256(metadata).hexdigest(),
            "recordSha256": hashlib.sha256(record).hexdigest()}


def enforce(omnigent_bin: Path, state_dir: Path):
    applicator, lock = reviewed_applicator()
    require(omnigent_bin.is_absolute() and state_dir.is_absolute()
            and ".." not in omnigent_bin.parts and ".." not in state_dir.parts,
            "absolute-selected-paths-required")
    binary = omnigent_bin.resolve(strict=True)
    require(binary.is_file() and os.access(binary, os.X_OK), "selected-cli-unavailable")
    # Discovery selected the Python adjacent to this exact resolved CLI. Never
    # substitute the system Python or a different environment's site-packages.
    require(binary.parent == Path(sys.executable).absolute().parent,
            "selected-cli-python-mismatch")
    purelib = Path(sysconfig.get_path("purelib"))
    require(purelib.is_absolute() and ".." not in purelib.parts, "purelib-unavailable")
    budget = IdentityBudget()
    identity = validate_sdk_identity(purelib, binary, lock["capturedCoreVersion"], budget)
    target = purelib / TARGET
    current = hashlib.sha256(read_plain(target)).hexdigest()
    require(current in (BEFORE, AFTER), "unknown-installed-source")
    state = "verified"
    if current == BEFORE:
        tool = state_dir / "uv" / "tools" / "omnigent"
        # A managed launcher symlink alone is insufficient authority to patch
        # a bundled/global SDK. The selected venv and resolved CLI must both be
        # this plugin's exact uv tool, with non-symlink directory ancestry.
        applicator.plain_directory(tool)
        require(Path(sys.prefix) == tool and binary == tool / "bin" / "omnigent"
                and purelib.is_relative_to(tool), "unpatched-sdk-not-plugin-managed")
        require(bool(target.parent.stat().st_mode & 0o222) and os.access(target.parent, os.W_OK),
                "managed-sdk-not-writable")
        applicator.apply(purelib)
        state = "applied"
    # check_only in the reviewed applicator also accepts BEFORE. The outer
    # guard must require exact AFTER explicitly; never equate 'checked' to safe.
    applicator.apply(purelib, check_only=True)
    raw = read_plain(target)
    require(hashlib.sha256(raw).hexdigest() == AFTER and len(raw) == 13872,
            "installed-after-verification-failed")
    check_bytecode(target, raw)
    require(validate_sdk_identity(purelib, binary, lock["capturedCoreVersion"], budget) == identity,
            "sdk-identity-changed-during-guard")
    return {**identity, "schema": "plugin-native-maintenance-preservation/v2", "ok": True,
            "state": state, "sourceSha256": AFTER, "purelib": str(purelib),
            "sdkImported": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omnigent-bin", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(enforce(args.omnigent_bin, args.state_dir), sort_keys=True))
        return 0
    except Exception:
        # Do not leak raw filesystem errors or SDK output through status/UI.
        print(json.dumps({"ok": False, "code": "MAINTENANCE_PRESERVATION_REQUIRED"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
