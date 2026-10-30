"""Release packaging checks without network: a throw-away git repository stands in for the tag."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('publish_release_package', ROOT / '.github' / 'scripts' / 'publish-release-package.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

NAME = release.PACKAGE_NAME
REPOSITORY = release.REPOSITORY


def sha(data):
    return hashlib.sha256(data).hexdigest()


def make_repo(directory, version='1.2.3'):
    """A committed package shaped like this one; returns (root, commit)."""
    root = Path(directory) / 'repo'
    patches = {'integrations/pi-web/combined.adapter.patch': b'combined patch\n', 'integrations/pi-web/adapter.patch': b'adapter patch\n'}
    files = {
        'package.json': json.dumps({
            'name': NAME, 'version': version, 'bin': {'pi-omnigent': './bin/cli.mjs'},
            'pi': {'extensions': ['./extensions/index.ts']},
            'files': ['bin/cli.mjs', 'src/*.py', 'extensions/*.ts', 'README.md', 'LICENSE', 'integrations/pi-web/']}).encode(),
        'package-lock.json': json.dumps({'name': NAME, 'version': version, 'packages': {'': {'name': NAME, 'version': version}}}).encode(),
        'integrations/pi-web/combined.adapter-meta.json': json.dumps({
            'patchSha256': sha(patches['integrations/pi-web/combined.adapter.patch']),
            'omnigent': {'packageName': NAME, 'packageVersion': version,
                         'adapterPatchSha256': sha(patches['integrations/pi-web/adapter.patch'])}}).encode(),
        'bin/cli.mjs': b'#!/usr/bin/env node\n', 'src/omnigent.py': b'print("adapter")\n', 'extensions/index.ts': b'export {}\n',
        'README.md': b'# readme\n', 'LICENSE': b'MIT\n', **patches,
    }
    for relative, data in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    git = ['git', '-C', str(root), '-c', 'user.name=test', '-c', 'user.email=test@example.invalid']
    subprocess.run(['git', 'init', '-q', str(root)], check=True)
    subprocess.run([*git, 'add', '-A'], check=True)
    subprocess.run([*git, 'commit', '-q', '-m', 'release'], check=True)
    commit = subprocess.check_output([*git, 'rev-parse', 'HEAD'], text=True).strip()
    return root, commit


def make_archive(files, *, extra=()):
    """An npm-shaped archive of {path: bytes}; extra is a list of ready TarInfo, data pairs."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        for relative, data in files.items():
            info = tarfile.TarInfo(f'package/{relative}')
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for info, data in extra:
            tar.addfile(info, io.BytesIO(data) if data is not None else None)
    return buffer.getvalue()


def tracked(root):
    """What `npm pack` would ship for the fixture package: every tracked file but the lockfile."""
    names = subprocess.check_output(['git', '-C', str(root), 'ls-files'], text=True).split()
    return {name: (root / name).read_bytes() for name in names if name != 'package-lock.json'}


def pack_fixture(root, version, directory):
    return make_archive(tracked(root))


class FakeGitHub:
    repository = REPOSITORY

    def __init__(self, commit, assets=None, *, draft=False, prerelease=False):
        self.commit, self.draft, self.prerelease = commit, draft, prerelease
        self.blobs = {}
        self.uploads = []
        self.digests = {}
        self.tamper_public = {}
        for name, body in (assets or {}).items():
            self.store(name, body)

    def url(self, tag, name):
        return f'https://github.com/{self.repository}/releases/download/{tag}/{name}'

    def store(self, name, body):
        self.blobs[name] = body
        self.digests[name] = f'sha256:{sha(body)}'

    def commit_of_tag(self, tag):
        return self.commit

    def release(self, tag):
        return {'draft': self.draft, 'prerelease': self.prerelease, 'tag_name': tag,
                'upload_url': 'https://uploads.example.invalid/assets{?name,label}',
                'assets': [{'name': name, 'state': 'uploaded', 'digest': self.digests.get(name),
                            'browser_download_url': self.url(tag, name)} for name in self.blobs]}

    def download(self, url):
        name = url.rsplit('/', 1)[1]
        return self.tamper_public.get(name, self.blobs[name])

    def upload(self, release_, name, body):
        self.uploads.append(name)
        self.store(name, body)
        return {'size': len(body), 'state': 'uploaded'}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root, self.commit = make_repo(self.tmp.name)
        self.archive = pack_fixture(self.root, '1.2.3', None)
        self.archive_name = release.ARCHIVE_NAME.format(version='1.2.3')
        self.sums = release.checksum_file(self.archive_name, sha(self.archive))

    def edit_json(self, relative, change):
        path = self.root / relative
        document = json.loads(path.read_text())
        change(document)
        path.write_text(json.dumps(document))

    def publish(self, github, **options):
        return release.publish(self.root, 'v1.2.3', github, pack=pack_fixture, sleep=lambda _: None, **options)


class TagAndVersionTests(Base):
    def test_only_stable_semantic_tags_are_accepted(self):
        for tag in ('v0.3.29', 'v1.0.0', 'v10.20.30'):
            release.check_tag(tag)
        for tag in ('0.3.29', 'v0.3', 'v0.3.29-rc.1', 'v01.2.3', 'v1.2.3 ', 'v1.2.3\n', 'refs/tags/v1.2.3', ''):
            with self.assertRaises(release.ReleaseError, msg=repr(tag)):
                release.check_tag(tag)

    def test_consistent_versions_pass(self):
        package, meta = release.check_versions(self.root, 'v1.2.3')
        self.assertEqual(package['version'], '1.2.3')
        self.assertEqual(meta['omnigent']['packageVersion'], '1.2.3')

    def test_every_disagreeing_version_is_named(self):
        cases = [
            ('the tag', lambda: None, 'v1.2.4', 'package.json version'),
            ('package.json', lambda: self.edit_json('package.json', lambda d: d.update(version='1.2.4')), 'v1.2.3', 'package.json version'),
            ('lock', lambda: self.edit_json('package-lock.json', lambda d: d.update(version='1.2.4')), 'v1.2.3', 'package-lock.json version'),
            ('lock root package', lambda: self.edit_json('package-lock.json', lambda d: d['packages'][''].update(version='1.2.4')), 'v1.2.3', 'package-lock.json root package version'),
            ('meta', lambda: self.edit_json('integrations/pi-web/combined.adapter-meta.json', lambda d: d['omnigent'].update(packageVersion='1.2.4')), 'v1.2.3', 'omnigent.packageVersion'),
        ]
        for label, change, tag, expected in cases:
            with self.subTest(label):
                change()
                with self.assertRaises(release.ReleaseError) as context:
                    release.check_versions(self.root, tag)
                self.assertIn(expected, str(context.exception))
                subprocess.run(['git', '-C', str(self.root), 'checkout', '-q', '--', '.'], check=True)

    def test_another_package_is_refused(self):
        self.edit_json('package.json', lambda d: d.update(name='@someone/else'))
        with self.assertRaisesRegex(release.ReleaseError, 'package.json names'):
            release.check_versions(self.root, 'v1.2.3')

    def test_meta_must_record_the_shipped_patch_hashes(self):
        for relative in ('integrations/pi-web/combined.adapter.patch', 'integrations/pi-web/adapter.patch'):
            with self.subTest(relative):
                (self.root / relative).write_bytes(b'changed after the meta was written\n')
                with self.assertRaisesRegex(release.ReleaseError, 'does not record the sha256'):
                    release.check_versions(self.root, 'v1.2.3')
                subprocess.run(['git', '-C', str(self.root), 'checkout', '-q', '--', '.'], check=True)

    def test_a_tag_without_the_meta_file_stops_with_a_message(self):
        (self.root / 'integrations/pi-web/combined.adapter-meta.json').unlink()
        with self.assertRaisesRegex(release.ReleaseError, 'cannot be read'):
            release.check_versions(self.root, 'v1.2.3')


class ArchiveTests(Base):
    def test_archive_equal_to_the_tag_passes(self):
        files = release.archive_files(self.archive)
        release.check_matches_commit(files, self.root, self.commit)
        release.check_complete(json.loads((self.root / 'package.json').read_text()), files)

    def test_a_changed_file_is_named(self):
        files = tracked(self.root)
        files['src/omnigent.py'] = b'print("something else")\n'
        with self.assertRaisesRegex(release.ReleaseError, 'src/omnigent.py differs'):
            release.check_matches_commit(release.archive_files(make_archive(files)), self.root, self.commit)

    def test_a_file_that_is_not_at_the_tag_is_named(self):
        files = tracked(self.root) | {'extra/new.sh': b'#!/bin/sh\n'}
        with self.assertRaisesRegex(release.ReleaseError, 'extra/new.sh is not in the tagged tree'):
            release.check_matches_commit(release.archive_files(make_archive(files)), self.root, self.commit)

    def test_unsafe_or_unexpected_members_are_refused(self):
        def info(name, **fields):
            member = tarfile.TarInfo(name)
            for key, value in fields.items():
                setattr(member, key, value)
            return member
        cases = {
            'parent traversal': (info('package/../escape'), b''),
            'absolute path': (info('/etc/passwd'), b''),
            'another top directory': (info('other/file'), b''),
            'symbolic link': (info('package/link', type=tarfile.SYMTYPE, linkname='/etc/passwd'), None),
            'hard link': (info('package/hard', type=tarfile.LNKTYPE, linkname='package/bin/cli.mjs'), None),
            'device': (info('package/dev', type=tarfile.CHRTYPE), None),
        }
        for label, (member, data) in cases.items():
            with self.subTest(label):
                if data is not None:
                    member.size = len(data)
                with self.assertRaises(release.ReleaseError):
                    release.archive_files(make_archive({}, extra=[(member, data)]))

    def test_an_incomplete_archive_names_what_is_missing(self):
        package = json.loads((self.root / 'package.json').read_text())
        for gone, expected in (('bin/cli.mjs', 'bin/cli.mjs'), ('extensions/index.ts', 'extensions/index.ts'),
                               ('src/omnigent.py', 'src/*.py'), ('README.md', 'README.md')):
            with self.subTest(gone):
                files = tracked(self.root)
                del files[gone]
                with self.assertRaisesRegex(release.ReleaseError, expected.replace('*', r'\*')):
                    release.check_complete(package, release.archive_files(make_archive(files)))
        files = {name: data for name, data in tracked(self.root).items() if not name.startswith('integrations/')}
        with self.assertRaisesRegex(release.ReleaseError, 'integrations/pi-web/'):
            release.check_complete(package, release.archive_files(make_archive(files)))


class ChecksumAndAssetTests(Base):
    def test_checksum_file_is_what_sha256sum_prints(self):
        self.assertEqual(self.sums, f'{sha(self.archive)}  {self.archive_name}\n'.encode())
        self.assertEqual(release.read_checksums(self.sums), {self.archive_name: sha(self.archive)})

    def test_malformed_or_repeated_checksum_lines_are_errors(self):
        good = f'{"a" * 64}  file.tgz'
        for body in (f'{"A" * 64}  file.tgz\n', f'{"a" * 63}  file.tgz\n', f'{"a" * 64} file.tgz\n', f'{good}\n{good}\n',
                     f'{good} \n', f'{good}\n\n'):
            with self.subTest(body=body):
                with self.assertRaises(release.ReleaseError):
                    release.read_checksums(body.encode())

    def wanted(self):
        return {self.archive_name: self.archive, 'SHA256SUMS': self.sums}

    def test_nothing_exists_everything_is_missing(self):
        github = FakeGitHub(self.commit)
        self.assertEqual(release.missing_assets(github.release('v1.2.3'), self.wanted(), github.download), [self.archive_name, 'SHA256SUMS'])

    def test_identical_assets_are_left_alone_and_a_missing_one_is_reported(self):
        github = FakeGitHub(self.commit, {self.archive_name: self.archive})
        self.assertEqual(release.missing_assets(github.release('v1.2.3'), self.wanted(), github.download), ['SHA256SUMS'])
        github.store('SHA256SUMS', self.sums)
        self.assertEqual(release.missing_assets(github.release('v1.2.3'), self.wanted(), github.download), [])

    def test_a_different_existing_asset_is_never_accepted(self):
        for name in (self.archive_name, 'SHA256SUMS'):
            with self.subTest(name):
                github = FakeGitHub(self.commit, {self.archive_name: self.archive, 'SHA256SUMS': self.sums})
                github.store(name, b'someone else built this')
                with self.assertRaisesRegex(release.ReleaseError, f'differs from this build: {name}'):
                    release.missing_assets(github.release('v1.2.3'), self.wanted(), github.download)

    def test_an_unfinished_upload_is_reported_not_replaced(self):
        github = FakeGitHub(self.commit, {self.archive_name: self.archive})
        listing = github.release('v1.2.3')
        listing['assets'][0]['state'] = 'starter'
        with self.assertRaisesRegex(release.ReleaseError, 'not uploaded'):
            release.missing_assets(listing, self.wanted(), github.download)


class PublishTests(Base):
    def test_a_release_without_assets_gets_both_and_is_verified(self):
        github = FakeGitHub(self.commit)
        result = self.publish(github)
        self.assertEqual(github.uploads, [self.archive_name, 'SHA256SUMS'])
        self.assertTrue(result['publicDownloadsVerified'])
        self.assertEqual(result['missingAssets'], [self.archive_name, 'SHA256SUMS'])
        self.assertEqual(result['sha256'], sha(self.archive))
        self.assertEqual(result['uiPatchSha256'], sha(b'combined patch\n'))
        self.assertEqual(github.blobs['SHA256SUMS'], self.sums)

    def test_a_rerun_changes_nothing(self):
        github = FakeGitHub(self.commit, {self.archive_name: self.archive, 'SHA256SUMS': self.sums})
        result = self.publish(github)
        self.assertEqual(github.uploads, [])
        self.assertEqual(result['missingAssets'], [])
        self.assertTrue(result['publicDownloadsVerified'])

    def test_only_the_missing_asset_is_uploaded(self):
        github = FakeGitHub(self.commit, {self.archive_name: self.archive})
        self.publish(github)
        self.assertEqual(github.uploads, ['SHA256SUMS'])

    def test_a_conflicting_asset_stops_everything_before_any_upload(self):
        github = FakeGitHub(self.commit, {'SHA256SUMS': f'{"0" * 64}  {self.archive_name}\n'.encode()})
        with self.assertRaisesRegex(release.ReleaseError, 'differs from this build: SHA256SUMS'):
            self.publish(github)
        self.assertEqual(github.uploads, [])

    def test_a_draft_or_prerelease_is_refused_before_anything_is_built(self):
        for options in ({'draft': True}, {'prerelease': True}):
            with self.subTest(options):
                github = FakeGitHub(self.commit, **options)
                with self.assertRaisesRegex(release.ReleaseError, 'published stable release'):
                    self.publish(github)
                self.assertEqual(github.uploads, [])

    def test_a_checkout_that_is_not_the_tagged_commit_is_refused(self):
        github = FakeGitHub('0' * 40)
        with self.assertRaisesRegex(release.ReleaseError, 'does not match the published tag'):
            self.publish(github)
        self.assertEqual(github.uploads, [])

    def test_versions_that_disagree_stop_the_run(self):
        self.edit_json('package.json', lambda d: d.update(version='1.2.4'))
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
                        'commit', '-qam', 'bump only package.json'], check=True)
        github = FakeGitHub(subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip())
        with self.assertRaisesRegex(release.ReleaseError, 'package.json version'):
            self.publish(github)
        self.assertEqual(github.uploads, [])

    def test_an_archive_that_differs_from_the_tag_is_never_uploaded(self):
        def polluted(root, version, directory):
            return make_archive(tracked(root) | {'src/omnigent.py': b'print("built from somewhere else")\n'})
        github = FakeGitHub(self.commit)
        with self.assertRaisesRegex(release.ReleaseError, 'src/omnigent.py differs'):
            release.publish(self.root, 'v1.2.3', github, pack=polluted, sleep=lambda _: None)
        self.assertEqual(github.uploads, [])

    def test_a_wrong_api_digest_fails_the_verification(self):
        github = FakeGitHub(self.commit, {self.archive_name: self.archive, 'SHA256SUMS': self.sums})
        github.digests[self.archive_name] = 'sha256:' + '0' * 64
        with self.assertRaisesRegex(release.ReleaseError, 'API digest'):
            self.publish(github)

    def test_a_missing_api_digest_fails_after_waiting(self):
        github = FakeGitHub(self.commit, {self.archive_name: self.archive, 'SHA256SUMS': self.sums})
        github.digests[self.archive_name] = None
        sleeps = []
        with self.assertRaisesRegex(release.ReleaseError, 'API digest'):
            release.publish(self.root, 'v1.2.3', github, pack=pack_fixture, sleep=sleeps.append)
        self.assertEqual(len(sleeps), 6)

    def test_a_public_download_that_differs_fails_the_verification(self):
        github = FakeGitHub(self.commit, {self.archive_name: self.archive, 'SHA256SUMS': self.sums})
        github.tamper_public['SHA256SUMS'] = b'changed on the way'
        # The listing's own download URL is the public one in the fake, so tamper only after the plan succeeded.
        with patch.object(release, 'missing_assets', return_value=[]):
            with self.assertRaisesRegex(release.ReleaseError, 'Public download differs: SHA256SUMS'):
                self.publish(github)

    def test_a_dry_run_uploads_nothing_and_says_what_it_would_upload(self):
        github = FakeGitHub(self.commit)
        result = self.publish(github, dry_run=True)
        self.assertEqual(github.uploads, [])
        self.assertEqual(result['missingAssets'], [self.archive_name, 'SHA256SUMS'])
        self.assertFalse(result['publicDownloadsVerified'])


class GitHubClientTests(unittest.TestCase):
    def test_an_annotated_tag_is_followed_to_its_commit(self):
        answers = {'/git/ref/tags/v1.2.3': {'object': {'type': 'tag', 'sha': 'a' * 40}},
                   f'/git/tags/{"a" * 40}': {'object': {'type': 'commit', 'sha': 'b' * 40}}}
        client = release.GitHub(REPOSITORY, 'token')
        with patch.object(client, 'api', side_effect=lambda path: answers[path]):
            self.assertEqual(client.commit_of_tag('v1.2.3'), 'b' * 40)

    def test_a_tag_that_is_not_a_commit_is_refused(self):
        client = release.GitHub(REPOSITORY, 'token')
        with patch.object(client, 'api', return_value={'object': {'type': 'tree', 'sha': 'c' * 40}}):
            with self.assertRaises(release.ReleaseError):
                client.commit_of_tag('v1.2.3')

    def capture(self):
        seen = []

        class Reply(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def opener(request, timeout):
            seen.append(request)
            return Reply(b'{}')
        return seen, opener

    def test_downloads_are_anonymous_and_api_calls_carry_the_token(self):
        seen, opener = self.capture()
        client = release.GitHub(REPOSITORY, 'secret-token')
        with patch.object(release.urllib.request, 'urlopen', opener):
            client.download('https://github.com/x/y/releases/download/v1/a.tgz')
            client.api('/releases/tags/v1')
        download, api = seen
        self.assertNotIn('Authorization', {key.title() for key in download.headers})
        self.assertEqual(api.get_header('Authorization'), 'Bearer secret-token')

    def test_uploads_need_a_token_and_are_never_retried(self):
        with self.assertRaisesRegex(release.ReleaseError, 'GITHUB_TOKEN'):
            release.GitHub(REPOSITORY).upload({'upload_url': 'https://u.example.invalid/a{?name}'}, 'a', b'x')
        calls = []

        def failing(request, timeout):
            calls.append(request.get_method())
            raise urllib.error.HTTPError(request.full_url, 502, 'bad gateway', {}, None)
        client = release.GitHub(REPOSITORY, 'token')
        with patch.object(release.urllib.request, 'urlopen', failing), patch.object(release.time, 'sleep'):
            with self.assertRaises(release.ReleaseError):
                client.upload({'upload_url': 'https://u.example.invalid/a{?name}'}, 'a', b'x')
            self.assertEqual(calls, ['POST'])
            calls.clear()
            with self.assertRaises(release.ReleaseError):
                client.api('/releases/tags/v1')
            self.assertEqual(calls, ['GET', 'GET', 'GET'])


@unittest.skipUnless(shutil.which('npm'), 'npm is needed to list what the real package would ship')
class RealPackageTests(unittest.TestCase):
    """This repository's own package, so a change to `files` or a half-done version bump fails in the pull request."""

    def test_the_package_would_ship_everything_package_json_promises(self):
        with tempfile.TemporaryDirectory() as cache:
            env = {**os.environ, 'npm_config_cache': cache, 'npm_config_update_notifier': 'false', 'npm_config_fund': 'false'}
            done = subprocess.run(['npm', 'pack', '--dry-run', '--json', '--ignore-scripts'], cwd=ROOT, env=env,
                                  capture_output=True, text=True, check=True)
        paths = [entry['path'] for entry in json.loads(done.stdout)[0]['files']]
        package = json.loads((ROOT / 'package.json').read_text())
        release.check_complete(package, paths)
        self.assertIn('src/omnigent.py', paths)
        self.assertIn('integrations/pi-web/combined.adapter-meta.json', paths)

    def test_package_lock_and_adapter_meta_carry_the_package_version(self):
        version = json.loads((ROOT / 'package.json').read_text())['version']
        release.check_versions(ROOT, f'v{version}')


if __name__ == '__main__':
    unittest.main()
