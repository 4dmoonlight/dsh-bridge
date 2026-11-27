"""Local-only tests: network requests and systemctl calls are mocked."""

import base64
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.request


SPEC = importlib.util.spec_from_file_location('pull_server_release', Path(__file__).with_name('pull-server-release.py'))
pull = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = pull
SPEC.loader.exec_module(pull)
REPO = '4dmoonlight/dsh-bridge'
TAG = 'hub-v1.12.3'
PRIOR = 'hub-v1.9.0'


def package(tag=TAG):
    return {
        'manifest.json': json.dumps({'version': 1, 'tag': tag, 'commit': 'a' * 40}).encode(),
        'apps/server/package.json': b'{"type":"module"}',
        pull.ENTRY: b'console.log("hello")\n',
        'apps/server/src/sub-module.js': b'export const ok = true\n',
    }


def archive(files, extra=None):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as output:
        for path, data in files.items():
            header = tarfile.TarInfo(path)
            header.size = len(data)
            header.mode = 0o777  # Archive permissions are never applied.
            output.addfile(header, io.BytesIO(data))
        if extra is not None:
            output.addfile(tarfile.TarInfo.frombuf(extra.tobuf(), 'ascii', 'strict'), io.BytesIO(b'x'))
    return gzip.compress(raw.getvalue())


class GitHubFixture:
    def __init__(self, tag=TAG):
        self.tag = tag
        self.archive_name = f'dsh-hub-{tag}.tar.gz'
        self.metadata = {'tag_name': tag, 'draft': False, 'prerelease': False, 'assets': []}
        self.content = {}
        data = archive(package(tag))
        checksum = f'{hashlib.sha256(data).hexdigest()}  {self.archive_name}\n'.encode()
        self.asset(self.archive_name, data)
        self.asset(f'dsh-hub-{tag}.sha256', checksum)
        self.api = f'https://api.github.com/repos/{REPO}/releases/latest'
        self.commit_api = f'https://api.github.com/repos/{REPO}/commits/{tag}'
        self.commit = 'a' * 40

    def asset(self, name, data):
        url = f'https://github.com/{REPO}/releases/download/{self.tag}/{name}'
        self.metadata['assets'].append({'name': name, 'browser_download_url': url, 'state': 'uploaded',
                                        'digest': 'sha256:' + hashlib.sha256(data).hexdigest(), 'size': len(data)})
        self.content[url] = data

    def fetch(self, url, limit, *, asset=False):
        if not asset:
            assert url in {self.api, self.commit_api}
            data = json.dumps(self.metadata if url == self.api else {'sha': self.commit}).encode()
        else:
            data = self.content[url]
        assert len(data) <= limit
        return data


class ArtifactsTest(unittest.TestCase):
    def test_expected_downloads_and_both_digests(self):
        github = GitHubFixture()
        with patch.object(pull, 'fetch', side_effect=github.fetch) as fetch:
            release = pull.latest(REPO)
            self.assertEqual(pull.release_files(REPO, release), package())
            self.assertEqual([call.args[0] for call in fetch.call_args_list],
                             [github.api, release.checksum.url, release.archive.url, github.commit_api])

    def test_manifest_commit_must_match_tag(self):
        github = GitHubFixture()
        github.commit = 'b' * 40
        with patch.object(pull, 'fetch', side_effect=github.fetch):
            with self.assertRaisesRegex(pull.PullError, 'manifest commit does not match'):
                pull.release_files(REPO, pull.latest(REPO))

    def test_reject_nonstable_tag_and_wrong_asset_url(self):
        for tag in ('hub-v1.2.3-rc.1', 'hub-v01.2.3', 'v1.2.3', 'hub-v1x2x3'):
            with self.subTest(tag=tag), self.assertRaises(pull.PullError):
                pull.version(tag)
        github = GitHubFixture()
        github.metadata['assets'][0]['browser_download_url'] += '?other=1'
        with patch.object(pull, 'fetch', side_effect=github.fetch), self.assertRaisesRegex(pull.PullError, 'canonical'):
            pull.latest(REPO)

    def test_github_digest_mismatch_and_required_checksum_even_without_digest(self):
        github = GitHubFixture()
        check = github.metadata['assets'][1]
        github.content[check['browser_download_url']] = b'0' * 64 + github.content[check['browser_download_url']][64:]
        with patch.object(pull, 'fetch', side_effect=github.fetch):
            with self.assertRaisesRegex(pull.PullError, 'GitHub SHA-256 digest mismatch'):
                pull.release_files(REPO, pull.latest(REPO))
            for asset in github.metadata['assets']:
                asset['digest'] = None
            with self.assertRaisesRegex(pull.PullError, 'release checksum mismatch'):
                pull.release_files(REPO, pull.latest(REPO))

    def test_asset_redirect_policy(self):
        request = urllib.request.Request('https://github.com/example/repo/releases/download/tag/file')
        asset = pull.Redirects(True)
        cdn = 'https://release-assets.githubusercontent.com/file?signature=opaque'
        self.assertEqual(asset.redirect_request(request, None, 302, '', {}, cdn).full_url, cdn)
        for handler, url in ((asset, 'http://release-assets.githubusercontent.com/file'),
                             (asset, 'https://github.com.evil.test/file'),
                             (pull.Redirects(False), cdn)):
            with self.subTest(url=url), self.assertRaisesRegex(pull.PullError, 'unexpected GitHub redirect'):
                handler.redirect_request(request, None, 302, '', {}, url)

    def test_unsafe_members_and_invalid_manifest_rejected(self):
        for kind, name in ((tarfile.SYMTYPE, 'apps/server/src/link.js'),
                           (tarfile.LNKTYPE, 'apps/server/src/link.js'),
                           (tarfile.DIRTYPE, 'apps'),
                           (tarfile.XHDTYPE, 'apps/server/src/extra.js'),
                           (tarfile.REGTYPE, '/apps/server/src/absolute.js'),
                           (tarfile.REGTYPE, 'apps/server/src/../outside.js'),
                           (tarfile.REGTYPE, pull.ENTRY),
                           (tarfile.REGTYPE, 'apps/server/src/nested/app.js')):
            with self.subTest(kind=kind, member=name):
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = 1 if kind == tarfile.REGTYPE else 0
                with self.assertRaises(pull.PullError):
                    pull.unpack(archive(package(), member), TAG)
        with self.assertRaisesRegex(pull.PullError, 'manifest'):
            pull.unpack(archive(package(PRIOR)), TAG)
        with self.assertRaisesRegex(pull.PullError, 'concatenated'):
            pull.unpack(archive(package()) + gzip.compress(b'junk'), TAG)
        with patch.object(pull, 'TAR_LIMIT', 512), self.assertRaisesRegex(pull.PullError, 'oversize'):
            pull.unpack(archive(package()), TAG)


class ProbeRequestTest(unittest.TestCase):
    def test_cache_buster_applies_to_health_only(self):
        for path, status in (('/healthz', 200), ('/remote', 200), ('/remote/api/devices', 401)):
            with self.subTest(path=path), patch.object(pull.http.client, 'HTTPSConnection') as factory:
                conn = factory.return_value
                conn.getresponse.return_value.__enter__.return_value.status = status
                pull.http_probe('hub.example.test', 443, path, tls=True, expected=status)
                method, target = conn.request.call_args.args
                self.assertEqual(method, 'GET')
                if path == '/healthz':
                    self.assertRegex(target, r'^/healthz[?]release_probe=[a-f0-9]{32}$')
                else:
                    self.assertEqual(target, path)
                self.assertEqual(conn.request.call_args.kwargs['headers']['Cache-Control'], 'no-cache, no-store')
                conn.close.assert_called_once_with()


class RolloutTest(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        self.addCleanup(self.remove_tree)
        self.github = GitHubFixture()
        self.config = pull.Config(REPO, 'hub.example.test', 443, 8787, 'views.example.test', 8443, True)
        self.releases = self.work / 'releases'
        self.state = self.work / 'state'
        self.dropin = self.work / 'dsh-bridge.service.d'
        for directory in (self.releases, self.state, self.dropin):
            directory.mkdir()
        self.original = self.dropin / 'zz-browser-portal.conf'
        self.original.write_bytes(b'original drop-in (untouched)\n')
        self.selector = self.dropin / 'zzzz-release.conf'
        self.updater = pull.Updater(self.config, releases=self.releases, state=self.state,
                                    selector=self.selector, owner=os.geteuid())
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.fetch = stack.enter_context(patch.object(pull, 'fetch', side_effect=lambda *a, **kw: self.github.fetch(*a, **kw)))
        self.command = stack.enter_context(patch.object(pull, 'command', side_effect=self.mock_command))
        self.http_probe = stack.enter_context(patch.object(pull, 'http_probe'))
        stack.enter_context(patch.object(pull, 'HEALTH_ATTEMPTS', 1))
        self.fail_restart = False

    def remove_tree(self):
        for current, _, _ in os.walk(self.work):
            Path(current).chmod(0o700)
        shutil.rmtree(self.work)

    def mock_command(self, *args):
        if args[:2] == ('show', '--property=User'):
            return 'hub'
        if args[0] == 'show':
            tag = self.updater.selector_tag(self.updater.selector_snapshot())
            entry = self.updater.entry(tag)
            return f'{{ path={pull.NODE} ; argv[]={pull.NODE} {entry} ; ... }}'
        if args[0] == 'restart' and self.fail_restart and self.selector.exists():
            raise pull.PullError('test restart failure')
        return ''

    def run_locked(self, **kwargs):
        with self.updater.lock():
            self.updater.run(**kwargs)

    def test_check_validates_artifacts_without_mutating_paths(self):
        self.updater.run(check=True)
        self.assertEqual(self.fetch.call_count, 4)
        self.assertFalse(self.selector.exists())
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertEqual(list(self.releases.iterdir()), [])
        self.command.assert_not_called()
        self.http_probe.assert_not_called()

    def test_activate_exact_selector_immutable_files_and_noop_same_version(self):
        self.run_locked()
        expected = f'[Service]\nExecStart=\nExecStart={pull.NODE} {self.releases}/{TAG}/{pull.ENTRY}\n'
        self.assertEqual(self.selector.read_text(), expected)
        self.assertEqual(self.original.read_bytes(), b'original drop-in (untouched)\n')
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertEqual((self.releases / TAG).stat().st_mode & 0o777, 0o555)
        self.assertEqual(self.updater.entry(TAG).stat().st_mode & 0o777, 0o444)
        self.assertEqual(self.updater.entry(TAG).stat().st_uid, os.geteuid())
        probes = self.http_probe.call_args_list
        self.assertEqual([call.args[2] for call in probes],
                         ['/healthz', '/healthz', '/remote', '/remote/api/devices', '/healthz', '/healthz'])
        self.assertRegex(probes[-1].args[0], r'^[0-9a-f]{32}\.views\.example\.test$')
        self.assertTrue(probes[-2].kwargs['loopback_tls'])
        self.assertNotIn('loopback_tls', probes[-1].kwargs)
        self.fetch.reset_mock()
        self.command.reset_mock()
        self.run_locked()
        self.fetch.assert_called_once()
        self.command.assert_not_called()

    def test_unprivileged_hub_user_required(self):
        self.command.side_effect = lambda *args: 'root'
        with self.assertRaisesRegex(pull.PullError, 'unless systemd User is hub'):
            self.run_locked()
        self.assertFalse(self.selector.exists())
        self.assertFalse(self.updater.pending.exists())
        self.command.assert_called_once_with('show', '--property=User', '--value', pull.UNIT)

    def test_restart_failure_removes_new_selector_and_suppresses_retry(self):
        self.fail_restart = True
        with self.assertRaisesRegex(pull.PullError, 'rolled back'):
            self.run_locked()
        self.assertFalse(self.selector.exists())
        self.assertTrue(self.updater.failed_path(TAG).is_file())
        self.assertFalse(self.updater.pending.exists())
        self.assertEqual([call.args[0] for call in self.command.call_args_list].count('restart'), 2)
        self.fetch.reset_mock()
        self.command.reset_mock()
        with self.assertRaisesRegex(pull.PullError, 'previously failed; skipped'):
            self.run_locked()
        self.fetch.assert_called_once()
        self.command.assert_not_called()
        self.fail_restart = False
        self.run_locked(retry_failed=True)
        self.assertFalse(self.updater.failed_path(TAG).exists())

    def test_health_failure_restores_previous_selector_byte_for_byte(self):
        original = b'# managed release\n\n' + self.updater.selector_bytes(PRIOR) + b'\n'
        self.selector.write_bytes(original)

        def probe(*args, **kwargs):
            if self.updater.selector_tag(self.selector.read_bytes()) == TAG and args[0] == 'hub.example.test':
                raise pull.PullError('failed public probe')

        self.http_probe.side_effect = probe
        with self.assertRaisesRegex(pull.PullError, 'rolled back:.*public probe'):
            self.run_locked()
        self.assertEqual(self.selector.read_bytes(), original)
        self.assertTrue(self.updater.failed_path(TAG).exists())
        self.assertFalse(self.updater.pending.exists())

    def test_failed_rollback_is_recovered_before_network_contacts(self):
        previous = self.updater.selector_bytes(PRIOR)
        self.selector.write_bytes(previous)
        self.http_probe.side_effect = pull.PullError('host unavailable')
        with self.assertRaisesRegex(pull.PullError, 'rollback not verified'):
            self.run_locked()
        self.assertEqual(self.selector.read_bytes(), previous)
        self.assertTrue(self.updater.pending.exists())
        self.fetch.reset_mock()
        self.http_probe.side_effect = None
        with self.assertRaisesRegex(pull.PullError, 'recovered an incomplete activation'):
            self.run_locked()
        self.assertFalse(self.updater.pending.exists())
        self.fetch.assert_not_called()

    def test_interrupted_selector_is_not_recovered_by_check(self):
        previous = self.updater.selector_bytes(PRIOR)
        self.selector.write_bytes(self.updater.selector_bytes(TAG))
        self.updater.pending.write_text(json.dumps({'tag': TAG, 'previous': base64.b64encode(previous).decode()}))
        with self.assertRaisesRegex(pull.PullError, '--check made no changes'):
            self.updater.run(check=True)
        self.assertEqual(self.selector.read_bytes(), self.updater.selector_bytes(TAG))
        self.command.assert_not_called()
        with self.assertRaisesRegex(pull.PullError, 'recovered an incomplete activation'):
            self.run_locked()
        self.assertEqual(self.selector.read_bytes(), previous)
        self.fetch.assert_not_called()

    def test_downgrade_and_concurrent_pull_refused(self):
        self.selector.write_bytes(self.updater.selector_bytes(TAG))
        self.github = GitHubFixture(PRIOR)
        with self.assertRaisesRegex(pull.PullError, 'refusing downgrade'):
            self.run_locked(retry_failed=True)
        with self.updater.lock(), self.assertRaisesRegex(pull.PullError, 'another release pull'):
            self.run_locked()
        self.fetch.assert_called_once()
        self.command.assert_not_called()


class ConfigurationTest(unittest.TestCase):
    def test_explicit_values_override_env_and_secrets_are_not_sourced(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            env = path / 'env'
            env.write_text('BRIDGE_TOKEN=$(exit 3)\nBRIDGE_PORT=10000\nBRIDGE_PORTAL_ORIGIN="https://hub.example.test"\n')
            config = path / 'config.json'
            config.write_text(json.dumps({'env_file': str(env), 'loopback_port': 8787}))
            loaded = pull.load_config(config, True, None)
            self.assertEqual(loaded.loopback_port, 8787)
            self.assertEqual(loaded.public_host, 'hub.example.test')
            self.assertIsNone(loaded.portal_domain)


if __name__ == '__main__':
    unittest.main()
