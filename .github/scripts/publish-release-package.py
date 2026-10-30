"""Publish immutable npm assets for an existing public release, built from its exact tag.

Run by .github/workflows/release-package.yml after a release is published, or by hand for an existing tag.
Standard library only. In order:

1. The tag, package.json, package-lock.json and the combined adapter meta name one version, and the meta's
   patch hashes match the patch files.
2. The tag resolves to the commit that is checked out, and its release is published and stable.
3. `npm pack --ignore-scripts` builds the archive. It holds every file package.json promises, and every file in
   it is byte-identical to the file at the tag.
4. SHA256SUMS is generated. An asset that already exists must be identical to what was built; a different one
   stops the run (nothing is ever deleted or replaced). Only missing assets are uploaded, and only after every
   check above passed.
5. Both assets are downloaded again without credentials: sha256 of the archive = the SHA256SUMS line = the digest
   the GitHub API reports, and the downloaded archive is compared with the tag once more.

PUBLISH_DRY_RUN=1 stops before any upload. Without GITHUB_TOKEN only read-only runs are possible.
"""
import fnmatch
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPOSITORY = 'WOOWTECH/pi-omnigent-plugin'
PACKAGE_NAME = '@woowtech/pi-omnigent-plugin'
ARCHIVE_NAME = 'woowtech-pi-omnigent-plugin-{version}.tgz'
SUMS_NAME = 'SHA256SUMS'
META_PATH = 'integrations/pi-web/combined.adapter-meta.json'
TAG_PATTERN = re.compile(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
CHECKSUM_LINE = re.compile(r'([0-9a-f]{64})  (\S+)')


class ReleaseError(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_bytes(path):
    try:
        return Path(path).read_bytes()
    except OSError:
        raise ReleaseError(f'{path} cannot be read at this tag') from None


def read_json(path):
    try:
        return json.loads(read_bytes(path))
    except ValueError:
        raise ReleaseError(f'{path} is not valid JSON') from None


def check_tag(tag):
    if not TAG_PATTERN.fullmatch(tag):
        raise ReleaseError('A stable semantic version tag such as v1.2.3 is required')


def check_versions(root, tag):
    """The tag is the one version everything else must agree with; returns package.json and the meta."""
    package = read_json(root / 'package.json')
    lock = read_json(root / 'package-lock.json')
    meta = read_json(root / META_PATH)
    if package.get('name') != PACKAGE_NAME:
        raise ReleaseError(f'package.json names {package.get("name")!r}, expected {PACKAGE_NAME}')
    expected = tag[1:]
    found = {
        'package.json version': package.get('version'),
        'package-lock.json version': lock.get('version'),
        'package-lock.json root package version': lock.get('packages', {}).get('', {}).get('version'),
        f'{META_PATH} omnigent.packageVersion': meta.get('omnigent', {}).get('packageVersion'),
    }
    wrong = [f'{where} is {value!r}' for where, value in found.items() if value != expected]
    if wrong:
        raise ReleaseError(f'The tag is {tag} but ' + ', '.join(wrong))
    # The meta is what installers and downstream pins read: it must describe the patches that are shipped.
    for relative, claimed in (('integrations/pi-web/combined.adapter.patch', meta.get('patchSha256')),
                              ('integrations/pi-web/adapter.patch', meta.get('omnigent', {}).get('adapterPatchSha256'))):
        if sha256(read_bytes(root / relative)) != claimed:
            raise ReleaseError(f'{META_PATH} does not record the sha256 of {relative}')
    return package, meta


def build_archive(root, version, directory):
    # No lifecycle script runs (--ignore-scripts), and the token is not handed to npm in any case.
    env = {key: value for key, value in os.environ.items() if key != 'GITHUB_TOKEN'}
    done = subprocess.run(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(directory)],
                          cwd=root, env=env, check=True, capture_output=True, text=True)
    name = ARCHIVE_NAME.format(version=version)
    if json.loads(done.stdout)[0]['filename'] != name:
        raise ReleaseError('Unexpected package archive name')
    return (Path(directory) / name).read_bytes()


def archive_files(archive):
    """Regular files of an npm archive as {path inside the package: bytes}; anything else is refused."""
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for member in tar:
            parts = member.name.split('/')
            if member.name.startswith('/') or '..' in parts or parts[0] != 'package':
                raise ReleaseError(f'Unsafe or unexpected archive path: {member.name!r}')
            if member.isdir():
                continue
            if not member.isfile():
                raise ReleaseError(f'Archive member {member.name!r} is not a regular file')
            files['/'.join(parts[1:])] = tar.extractfile(member).read()
    return files


def check_matches_commit(files, root, commit):
    """Every file in the archive is byte-identical to the file in the commit's tree."""
    problems = []
    for relative, data in files.items():
        shown = subprocess.run(['git', '-C', str(root), 'show', f'{commit}:{relative}'], capture_output=True)
        if shown.returncode != 0:
            problems.append(f'{relative} is not in the tagged tree')
        elif shown.stdout != data:
            problems.append(f'{relative} differs from the tagged tree')
    if problems:
        raise ReleaseError('The archive does not match the tag: ' + '; '.join(problems[:10]))


def check_complete(package, paths):
    """The archive holds what package.json promises: files entries, bin and pi extension targets."""
    wanted = {'package.json'}
    wanted.update(re.sub(r'^\./', '', target) for target in (
        [package['bin']] if isinstance(package.get('bin'), str) else list(package.get('bin', {}).values())))
    wanted.update(re.sub(r'^\./', '', target) for target in package.get('pi', {}).get('extensions', []))
    wanted.update(re.sub(r'^\./', '', entry) for entry in package.get('files', []))
    missing = []
    for entry in sorted(wanted):
        if any(char in entry for char in '*?['):
            found = any(fnmatch.fnmatchcase(path, entry) for path in paths)
        else:
            directory = entry.rstrip('/') + '/'
            found = entry in paths or any(path.startswith(directory) for path in paths)
        if not found:
            missing.append(entry)
    if missing:
        raise ReleaseError('The archive lacks files package.json promises: ' + ', '.join(missing))


def checksum_file(name, digest):
    return f'{digest}  {name}\n'.encode()


def read_checksums(data):
    """{file name: sha256} from a SHA256SUMS body; a malformed or duplicated line is an error."""
    sums = {}
    for line in data.decode('utf-8').splitlines():
        match = CHECKSUM_LINE.fullmatch(line)
        if not match or match.group(2) in sums:
            raise ReleaseError(f'Malformed or repeated {SUMS_NAME} line: {line!r}')
        sums[match.group(2)] = match.group(1)
    return sums


def missing_assets(release, wanted, download):
    """Names still to upload. An existing asset must be identical to what was built; otherwise stop."""
    existing = {asset['name']: asset for asset in release.get('assets', [])}
    missing = []
    for name, body in wanted.items():
        asset = existing.get(name)
        if asset is None:
            missing.append(name)
        elif asset.get('state') != 'uploaded':
            raise ReleaseError(f'Release asset {name} is {asset.get("state")!r}, not uploaded; remove it by hand first')
        elif download(asset['browser_download_url']) != body:
            raise ReleaseError(f'Existing release asset differs from this build: {name}')
    return missing


def verify_published(github, tag, release, wanted, package, root, commit, digest):
    """Download the assets anonymously and prove archive, SHA256SUMS and API digest agree with each other and the tag."""
    name = ARCHIVE_NAME.format(version=tag[1:])
    assets = {asset['name']: asset for asset in release['assets']}
    downloaded = {}
    for asset_name, body in wanted.items():
        url = f'https://github.com/{github.repository}/releases/download/{tag}/{urllib.parse.quote(asset_name)}'
        downloaded[asset_name] = github.download(url)
        if downloaded[asset_name] != body:
            raise ReleaseError(f'Public download differs: {asset_name}')
        if asset_name not in assets:
            raise ReleaseError(f'Release asset {asset_name} is not listed after the upload')
        reported = assets[asset_name].get('digest')
        if reported != f'sha256:{sha256(body)}':
            raise ReleaseError(f'The API digest of {asset_name} is {reported!r}, expected sha256:{sha256(body)}')
    if read_checksums(downloaded[SUMS_NAME]) != {name: digest}:
        raise ReleaseError(f'{SUMS_NAME} does not list exactly {name} with sha256 {digest}')
    files = archive_files(downloaded[name])
    check_matches_commit(files, root, commit)
    check_complete(package, files)


def publish(root, tag, github, *, dry_run=False, pack=build_archive, sleep=time.sleep):
    """Build, check, upload what is missing and verify; returns what was done."""
    check_tag(tag)
    package, meta = check_versions(root, tag)
    commit = github.commit_of_tag(tag)
    checked_out = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    if checked_out != commit:
        raise ReleaseError('Checkout does not match the published tag')
    release = github.release(tag)
    if release['draft'] or release['prerelease'] or release['tag_name'] != tag:
        raise ReleaseError('A published stable release is required')

    name = ARCHIVE_NAME.format(version=tag[1:])
    with tempfile.TemporaryDirectory(prefix='omnigent-release-') as directory:
        archive = pack(root, tag[1:], Path(directory))
    files = archive_files(archive)
    check_matches_commit(files, root, commit)
    check_complete(package, files)
    digest = sha256(archive)
    wanted = {name: archive, SUMS_NAME: checksum_file(name, digest)}

    # Every existing asset is validated before anything is uploaded.
    missing = missing_assets(release, wanted, github.download)
    result = {'tag': tag, 'sourceCommit': commit, 'archive': name, 'bytes': len(archive), 'sha256': digest,
              'files': len(files), 'uiPatchSha256': meta['patchSha256'], 'missingAssets': missing, 'dryRun': dry_run,
              'publicDownloadsVerified': False}
    if dry_run:
        return result
    for asset_name in missing:
        uploaded = github.upload(release, asset_name, wanted[asset_name])
        if uploaded.get('size') != len(wanted[asset_name]) or uploaded.get('state') != 'uploaded':
            raise ReleaseError(f'Upload of {asset_name} did not complete')
    # The API fills the digest in a moment after the upload.
    for _ in range(6):
        release = github.release(tag)
        if all(asset.get('digest') for asset in release['assets'] if asset['name'] in wanted):
            break
        sleep(5)
    verify_published(github, tag, release, wanted, package, root, commit, digest)
    result['publicDownloadsVerified'] = True
    return result


class GitHub:
    """The few GitHub calls the release needs. Downloads never carry the token."""

    def __init__(self, repository, token=None):
        self.repository = repository
        self.token = token

    def request(self, url, headers, *, data=None, method=None):
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        where = f'{method or "GET"} {urllib.parse.urlsplit(url).path}'
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    return response.read()
            except urllib.error.HTTPError as error:
                # Reads are retried on a server error; a write is not, so a half-done upload is never repeated.
                if method == 'POST' or error.code < 500 or attempt == 2:
                    raise ReleaseError(f'{where} answered HTTP {error.code}') from None
            except urllib.error.URLError as error:
                if method == 'POST' or attempt == 2:
                    raise ReleaseError(f'{where} failed: {error.reason}') from None
            time.sleep(2 * (attempt + 1))

    def authorization(self):
        return {'Authorization': 'Bearer ' + self.token} if self.token else {}

    def api(self, path):
        headers = {'Accept': 'application/vnd.github+json', **self.authorization()}
        return json.loads(self.request(f'https://api.github.com/repos/{self.repository}{path}', headers))

    def commit_of_tag(self, tag):
        """The commit a tag points at, whether the tag is lightweight or annotated."""
        target = self.api(f'/git/ref/tags/{urllib.parse.quote(tag)}')['object']
        while target['type'] == 'tag':
            target = self.api(f'/git/tags/{target["sha"]}')['object']
        if target['type'] != 'commit':
            raise ReleaseError('The tag does not point at a commit')
        return target['sha']

    def release(self, tag):
        return self.api(f'/releases/tags/{urllib.parse.quote(tag)}')

    def download(self, url):
        return self.request(url, {'Accept': 'application/octet-stream'})

    def upload(self, release, name, body):
        if not self.token:
            raise ReleaseError('GITHUB_TOKEN is required to upload release assets')
        url = release['upload_url'].split('{')[0] + '?name=' + urllib.parse.quote(name)
        headers = {'Accept': 'application/vnd.github+json', 'Content-Type': 'application/octet-stream',
                   **self.authorization()}
        return json.loads(self.request(url, headers, data=body, method='POST'))


def main():
    tag = os.environ['RELEASE_TAG']
    repository = os.environ['GITHUB_REPOSITORY']
    root = Path(os.environ['RELEASE_SOURCE']).resolve()
    try:
        if repository != REPOSITORY:
            raise ReleaseError('Unexpected release repository')
        result = publish(root, tag, GitHub(repository, os.environ.get('GITHUB_TOKEN') or None),
                         dry_run=os.environ.get('PUBLISH_DRY_RUN') == '1')
    except ReleaseError as error:
        print(f'::error title=Release package::{error}')
        raise SystemExit(1) from None
    print(json.dumps(result))
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        pins = (f'PI_OMNIGENT_VERSION={tag[1:]}\nPI_OMNIGENT_SHA256={result["sha256"]}\n'
                f'PI_OMNIGENT_UI_SHA256={result["uiPatchSha256"]}\n')
        with open(summary, 'a', encoding='utf-8') as handle:
            handle.write(f'### {tag}\n\nUploaded: {", ".join(result["missingAssets"]) or "nothing (all assets already matched)"}\n\n'
                         f'Downstream pins:\n\n```\n{pins}```\n')


if __name__ == '__main__':
    main()
