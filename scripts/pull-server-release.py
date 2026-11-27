#!/usr/bin/env python3
"""Pull the latest stable public GitHub Hub release (Linux/systemd, stdlib only)."""

import argparse
import base64
import contextlib
from dataclasses import dataclass
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib


UNIT = 'dsh-bridge.service'
NODE = '/opt/node22/bin/node'
SYSTEMCTL = '/usr/bin/systemctl'
SELECTOR = Path('/etc/systemd/system') / (UNIT + '.d') / 'zzzz-release.conf'
RELEASES = Path('/opt/dsh-bridge-rollouts/releases')
STATE = Path('/var/lib/dsh-bridge-release')
CONFIG = Path('/etc/dsh-bridge/release.json')
ENV = Path('/etc/dsh-bridge/env')
ENTRY = 'apps/server/src/index.js'
REQUIRED = {'manifest.json', 'apps/server/package.json', ENTRY}
TAG = r'hub-v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})'
SOURCE = r'apps/server/src/[A-Za-z0-9._-]+\.js'
SHA256 = r'[a-f0-9]{64}'
API_LIMIT = 1024 * 1024
ARCHIVE_LIMIT = 8 * 1024 * 1024
TAR_LIMIT = 32 * 1024 * 1024
FILE_LIMIT = 4 * 1024 * 1024
MEMBER_LIMIT = 256
SMALL_LIMIT = 64 * 1024
CDN = {'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
TIMEOUT = 5
HEALTH_ATTEMPTS = 5


class PullError(Exception):
    pass


class Deadline(PullError):
    pass


def version(tag):
    match = re.fullmatch(TAG, tag) if isinstance(tag, str) else None
    if not match:
        raise PullError('expected a stable hub-vX.Y.Z tag')
    return tuple(map(int, match.groups()))


def parse_json(data, label):
    def unique(pairs):
        result = dict(pairs)
        if len(result) != len(pairs):
            raise ValueError('duplicate JSON keys')
        return result

    try:
        result = json.loads(data.decode('utf-8'), object_pairs_hook=unique)
    except (ValueError, RecursionError) as exc:
        raise PullError(f'invalid {label} JSON') from exc
    if not isinstance(result, dict):
        raise PullError(f'{label} must be a JSON object')
    return result


def bounded_read(stream, limit):
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise PullError('input exceeds size limit')
    return data


def read_file(path, limit=SMALL_LIMIT, *, owner=None, immutable=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise PullError(f'expected a single regular file: {path}')
        if owner is not None and (info.st_uid != owner or info.st_mode & 0o022):
            raise PullError(f'untrusted ownership or permissions: {path}')
        if immutable and stat.S_IMODE(info.st_mode) != 0o444:
            raise PullError(f'expected read-only release file: {path}')
        return bounded_read(stream, limit)


def optional_file(path, **kwargs):
    try:
        return read_file(path, **kwargs)
    except FileNotFoundError:
        return None


def trusted_dir(path, owner, *, immutable=False):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
        raise PullError(f'untrusted directory: {path}')
    if immutable and stat.S_IMODE(info.st_mode) != 0o555:
        raise PullError(f'expected read-only release directory: {path}')


def trusted_tree(path, owner, *, create=False, mode=0o755):
    if not path.is_absolute() or '..' in path.parts:
        raise PullError('expected an absolute path without parent traversal')
    for component in [*reversed(path.parents), path]:
        try:
            trusted_dir(component, owner)
        except FileNotFoundError:
            if not create:
                raise
            try:
                component.mkdir(mode=mode)
            except FileExistsError:
                pass
            trusted_dir(component, owner)
            sync_dir(component.parent)


@contextlib.contextmanager
def deadline(seconds):
    # A socket timeout alone does not limit DNS resolution or a trickling body.
    # This CLI does network I/O only on the main thread.
    def expired(_signum, _frame):
        raise Deadline('network deadline exceeded')

    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 3
    max_repeats = 1

    def __init__(self, asset):
        self.asset = asset

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if not self.asset or target.scheme != 'https' or target.netloc not in CDN or target.fragment:
            raise PullError('unexpected GitHub redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, limit, *, asset=False):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects(asset))
    headers = {'User-Agent': 'dsh-bridge-release-puller/1', 'Accept-Encoding': 'identity'}
    if not asset:
        headers.update({'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    req = urllib.request.Request(url, headers=headers)
    try:
        with deadline(30 if asset else 15), opener.open(req, timeout=TIMEOUT) as response:
            if response.status != 200:
                raise PullError(f'unexpected GitHub HTTP status {response.status}')
            return bounded_read(response, limit)
    except urllib.error.HTTPError as exc:
        exc.close()
        raise PullError(f'GitHub HTTP status {exc.code}') from None
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        # A CDN redirect URL may contain a signed query string; don't log it.
        raise PullError('GitHub request failed') from None


@dataclass(frozen=True)
class Asset:
    name: str
    url: str
    size: int
    digest: str | None


@dataclass(frozen=True)
class Release:
    tag: str
    archive: Asset
    checksum: Asset


def latest(repository):
    url = f'https://api.github.com/repos/{repository}/releases/latest'
    release = parse_json(fetch(url, API_LIMIT), 'GitHub release')
    tag = release.get('tag_name')
    version(tag)
    if release.get('draft') is not False or release.get('prerelease') is not False:
        raise PullError('latest release is a draft or pre-release')
    assets = release.get('assets')
    if not isinstance(assets, list) or any(not isinstance(item, dict) for item in assets):
        raise PullError('invalid GitHub assets list')

    def required(suffix, limit):
        name = f'dsh-hub-{tag}{suffix}'
        matches = [item for item in assets if item.get('name') == name]
        if len(matches) != 1:
            raise PullError(f'expected exactly one GitHub asset named {name}')
        item, = matches
        url = f'https://github.com/{repository}/releases/download/{tag}/{name}'
        size, digest = item.get('size'), item.get('digest')
        if item.get('browser_download_url') != url or item.get('state') != 'uploaded':
            raise PullError(f'asset {name} is not uploaded at its canonical URL')
        if type(size) is not int or not 0 < size <= limit:
            raise PullError(f'invalid size for {name}')
        if digest is not None and (not isinstance(digest, str) or not re.fullmatch('sha256:' + SHA256, digest)):
            raise PullError(f'invalid GitHub SHA-256 digest for {name}')
        return Asset(name, url, size, digest)

    return Release(tag, required('.tar.gz', ARCHIVE_LIMIT), required('.sha256', 512))


def download(asset):
    data = fetch(asset.url, asset.size, asset=True)
    if len(data) != asset.size:
        raise PullError(f'size mismatch for {asset.name}')
    if asset.digest is not None and 'sha256:' + hashlib.sha256(data).hexdigest() != asset.digest:
        raise PullError(f'GitHub SHA-256 digest mismatch for {asset.name}')
    return data


def release_files(repository, release):
    checksum = download(release.checksum)
    pattern = (SHA256 + r' [ *]' + re.escape(release.archive.name) + r'\n?').encode('ascii')
    if not re.fullmatch(pattern, checksum):
        raise PullError('checksum must be a single sha256sum record naming the archive')
    archive = download(release.archive)
    if hashlib.sha256(archive).hexdigest().encode('ascii') != checksum[:64]:
        raise PullError('release checksum mismatch')
    files = unpack(archive, release.tag)
    manifest = parse_json(files['manifest.json'], 'release manifest')
    commit_url = f'https://api.github.com/repos/{repository}/commits/{release.tag}'
    commit = parse_json(fetch(commit_url, API_LIMIT), 'GitHub release commit')
    if commit.get('sha') != manifest['commit']:
        raise PullError('manifest commit does not match the GitHub tag')
    return files


def unpack(archive, tag):
    # Read physical tar headers rather than transparently applying PAX/GNU
    # extensions. Extraction never applies archive owners, modes or paths.
    decoder = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        content = decoder.decompress(archive, TAR_LIMIT + 1)
    except zlib.error as exc:
        raise PullError('invalid gzip archive') from exc
    if len(content) > TAR_LIMIT or not decoder.eof or decoder.unused_data:
        raise PullError('oversize, truncated or concatenated gzip archive')
    files, offset = {}, 0
    while offset + 512 <= len(content):
        header = content[offset:offset + 512]
        if header == bytes(512):
            remainder = content[offset:]
            if len(remainder) < 1024 or len(remainder) % 512 or any(remainder):
                raise PullError('invalid tar end marker or trailing input')
            break
        try:
            entry = tarfile.TarInfo.frombuf(header, 'ascii', 'strict')
        except (tarfile.HeaderError, UnicodeError, ValueError) as exc:
            raise PullError('invalid tar header') from exc
        path = entry.name
        if (header[156:157] not in {b'0', b'\x00'} or entry.linkname or
                path not in REQUIRED and not re.fullmatch(SOURCE, path)):
            raise PullError('tar member violates the regular-file allowlist')
        if path in files or len(files) >= MEMBER_LIMIT or not 0 <= entry.size <= FILE_LIMIT:
            raise PullError('duplicate, oversize or excess tar member')
        start = offset + 512
        end = start + entry.size
        offset = start + ((entry.size + 511) // 512) * 512
        if offset > len(content) or any(content[end:offset]):
            raise PullError('invalid tar member bounds or padding')
        files[path] = content[start:end]
    else:
        raise PullError('missing tar end marker')
    if not REQUIRED.issubset(files):
        raise PullError('release is missing its manifest, package.json or index.js')
    manifest = parse_json(files['manifest.json'], 'release manifest')
    commit = manifest.get('commit')
    if (set(manifest) != {'version', 'tag', 'commit'} or type(manifest['version']) is not int or
            manifest['version'] != 1 or manifest['tag'] != tag or
            not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit)):
        raise PullError('manifest version, tag or commit is invalid')
    return files


@dataclass(frozen=True)
class Config:
    repository: str
    public_host: str
    public_port: int
    loopback_port: int
    portal_domain: str | None
    portal_port: int
    portal_public: bool


ENV_KEYS = {
    'BRIDGE_PORT', 'BRIDGE_PORTAL_ORIGIN', 'BRIDGE_PORTAL_DATA_DOMAIN',
    'BRIDGE_PORTAL_DATA_PORT',
}


def env_settings(data):
    result = {}
    for line in data.splitlines():
        key, sep, value = line.strip().partition(b'=')
        if not sep or key.decode('ascii', errors='replace') not in ENV_KEYS:
            continue
        value = value.strip()
        if len(value) > 1 and value[:1] in (b'"', b"'") and value[-1:] == value[:1]:
            value = value[1:-1]
        try:
            result[key.decode('ascii')] = value.decode('ascii')
        except UnicodeError as exc:
            raise PullError('non-ASCII value for a recognized hub env key') from exc
    return result


def host_name(value):
    return (isinstance(value, str) and 0 < len(value) <= 253 and
            all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                for label in value.split('.')))


def port_number(value):
    if isinstance(value, str) and re.fullmatch(r'[0-9]{1,5}', value):
        value = int(value)
    if type(value) is not int or not 0 < value <= 65535:
        raise PullError('invalid probe port')
    return value


def load_config(path, explicit, owner):
    def load(path, *, required):
        if owner is not None:
            try:
                trusted_tree(path.parent, owner)
            except FileNotFoundError:
                if not required:
                    return None
                raise
        return read_file(path, owner=owner) if required else optional_file(path, owner=owner)

    data = load(path, required=explicit)
    cfg = parse_json(data, 'configuration') if data is not None else {}
    if set(cfg) - {'repository', 'env_file', 'public_origin', 'loopback_port', 'portal_data_domain',
                   'portal_data_port', 'portal_data_public_probe'}:
        raise PullError('unknown release configuration key')
    repository = cfg.get('repository', '4dmoonlight/dsh-bridge')
    if (not isinstance(repository, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}', repository)
            or repository.split('/')[1] in {'.', '..'}):
        raise PullError('repository must be a GitHub owner/repo')
    env_setting = cfg.get('env_file', str(ENV))
    if not isinstance(env_setting, str) or not Path(env_setting).is_absolute():
        raise PullError('env_file must be an absolute path')
    env = env_settings(load(Path(env_setting), required='env_file' in cfg) or b'')
    public = cfg.get('public_origin', env.get('BRIDGE_PORTAL_ORIGIN'))
    if not isinstance(public, str) or not re.fullmatch(r'https://[a-z0-9.-]+(?::[0-9]{1,5})?/?', public):
        raise PullError('configure public_origin as an HTTPS origin (or set BRIDGE_PORTAL_ORIGIN)')
    origin = urllib.parse.urlsplit(public)
    if not host_name(origin.hostname):
        raise PullError('invalid public control hostname')
    try:
        public_port = origin.port if origin.port is not None else 443
    except ValueError as exc:
        raise PullError('invalid public control port') from exc
    domain = cfg.get('portal_data_domain', env.get('BRIDGE_PORTAL_DATA_DOMAIN'))
    if domain is not None and (not host_name(domain) or len(domain) > 220 or
                               origin.hostname == domain or origin.hostname.endswith('.' + domain)):
        raise PullError('invalid portal_data_domain; it must be separate from the control origin')
    portal_public = cfg.get('portal_data_public_probe', False)
    if type(portal_public) is not bool or (portal_public and domain is None):
        raise PullError('portal_data_public_probe requires a boolean and a data domain when true')
    return Config(repository, origin.hostname, port_number(public_port),
                  port_number(cfg.get('loopback_port', env.get('BRIDGE_PORT', 8787))), domain,
                  port_number(cfg.get('portal_data_port', env.get('BRIDGE_PORTAL_DATA_PORT', 8443))),
                  portal_public)


class LoopbackTLS(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection(('127.0.0.1', self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def http_probe(host, port, path, *, tls, loopback_tls=False, expected=200, shape=None):
    factory = LoopbackTLS if loopback_tls else http.client.HTTPSConnection if tls else http.client.HTTPConnection
    connection = factory(host, port, timeout=TIMEOUT)
    try:
        with deadline(TIMEOUT):
            # Cache busting for every request (including anonymous authorization checks).
            query = '?release_probe=' + secrets.token_hex(16)
            connection.request('GET', path + query, headers={
                'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache', 'Connection': 'close',
            })
            with connection.getresponse() as response:
                if response.status != expected:
                    raise PullError(f'expected HTTP {expected}, got {response.status}')
                if shape is not None:
                    data = parse_json(bounded_read(response, SMALL_LIMIT), 'probe response')
                    if not shape(data):
                        raise PullError('unexpected JSON response to probe')
    except (PullError, OSError, http.client.HTTPException) as exc:
        raise PullError(f'probe {host}:{port}{path} failed: {exc}') from exc
    finally:
        connection.close()


def command(*args):
    timeout = 30 if args[0] == 'restart' else 5 if args[0] in {'show', 'is-active'} else 10
    try:
        result = subprocess.run([SYSTEMCTL, *args], check=True, timeout=timeout, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except (subprocess.SubprocessError, OSError) as exc:
        raise PullError(f'systemctl {args[0]} failed (inspect systemd/journal on the host)') from exc
    return result.stdout.strip()


def verify_service_user():
    if command('show', '--property=User', '--value', UNIT) != 'hub':
        raise PullError('refusing to restart Hub unless systemd User is hub')


def verify_selected(entry):
    effective = command('show', '--property=ExecStart', '--value', UNIT)
    argv = f'path={NODE} ; argv[]={NODE} {entry} ;'
    if effective.count('{') != 1 or argv not in effective:
        raise PullError('effective systemd ExecStart is not the selected release')


def check_health(cfg, entry=None):
    def hub(data):
        return data.get('ok') is True and data.get('protocol') == 'bridge/1'

    def denied(data):
        error = data.get('error')
        return isinstance(error, dict) and error.get('code') == 'not_found'

    last = None
    retry_until = time.monotonic() + 30
    for attempt in range(HEALTH_ATTEMPTS):
        if attempt and time.monotonic() >= retry_until:
            break
        try:
            command('is-active', '--quiet', UNIT)
            if entry is not None:
                verify_selected(entry)
            http_probe('127.0.0.1', cfg.loopback_port, '/healthz', tls=False, shape=hub)
            http_probe(cfg.public_host, cfg.public_port, '/healthz', tls=True, shape=hub)
            if cfg.portal_domain is not None:
                http_probe(cfg.public_host, cfg.public_port, '/remote', tls=True)
                http_probe(cfg.public_host, cfg.public_port, '/remote/api/devices', tls=True, expected=401)
                data_host = secrets.token_hex(16) + '.' + cfg.portal_domain
                if cfg.portal_port == 8443:
                    http_probe(data_host, cfg.portal_port, '/healthz', tls=True, loopback_tls=True,
                               expected=404, shape=denied)
                if cfg.portal_public:
                    http_probe(data_host, cfg.portal_port, '/healthz', tls=True, expected=404, shape=denied)
            command('is-active', '--quiet', UNIT)
            return
        except PullError as exc:
            last = exc
            if attempt + 1 < HEALTH_ATTEMPTS:
                time.sleep(1)
    raise PullError(f'health verification failed: {last}')


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path, data, mode):
    fd, name = tempfile.mkstemp(prefix='.release-', dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        os.replace(temp, path)
        sync_dir(path.parent)
    finally:
        temp.unlink(missing_ok=True)


def discard(path):
    path.unlink(missing_ok=True)
    sync_dir(path.parent)


class Updater:
    def __init__(self, config, *, releases=RELEASES, state=STATE, selector=SELECTOR, owner=0):
        self.cfg = config
        self.releases = releases
        self.state = state
        self.selector = selector
        self.owner = owner
        self.pending = state / 'pending.json'

    @contextlib.contextmanager
    def lock(self):
        fd = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise PullError('another release pull is running') from exc
            yield
        finally:
            os.close(fd)

    def entry(self, tag):
        version(tag)
        return self.releases / tag / ENTRY

    def selector_bytes(self, tag):
        return f'[Service]\nExecStart=\nExecStart={NODE} {self.entry(tag)}\n'.encode('ascii')

    def selector_tag(self, data):
        if data is None:
            return None
        try:
            lines = data.decode('ascii').splitlines()
        except UnicodeError as exc:
            raise PullError('unrecognized release selector; refusing to overwrite') from exc
        lines = [line.strip() for line in lines if line.strip() and not line.lstrip().startswith(('#', ';'))]
        prefix = f'ExecStart={NODE} {self.releases}/'
        if (len(lines) == 3 and lines[:2] == ['[Service]', 'ExecStart='] and
                lines[2].startswith(prefix) and lines[2].endswith('/' + ENTRY)):
            tag = lines[2][len(prefix):-len(ENTRY)-1]
            version(tag)
            return tag
        raise PullError('unrecognized release selector; refusing to overwrite')

    def failed_path(self, tag):
        version(tag)
        return self.state / ('failed-' + tag)

    def stage(self, tag, files):
        destination = self.releases / tag
        try:
            trusted_dir(destination, self.owner, immutable=True)
        except FileNotFoundError:
            pass
        else:
            # Never replace or mutate an existing tag directory. Only resume
            # with byte-identical data and the exact existing directory layout.
            self.verify_tree(destination, files)
            return
        temporary = Path(tempfile.mkdtemp(prefix='.staging-', dir=self.releases))
        try:
            for name, data in files.items():
                target = temporary / name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fchmod(stream.fileno(), 0o444)
                    os.fsync(stream.fileno())
            for current, _, _ in os.walk(temporary, topdown=False):
                path = Path(current)
                path.chmod(0o555)
                sync_dir(path)
            os.rename(temporary, destination)
            sync_dir(self.releases)
        finally:
            if temporary.exists():
                for current, _, _ in os.walk(temporary):
                    Path(current).chmod(0o700)
                shutil.rmtree(temporary)

    def verify_tree(self, destination, files):
        expected_dirs = {
            str(parent) for name in files for parent in Path(name).parents if str(parent) != '.'
        }
        actual_files, actual_dirs = set(), set()
        for current, dirs, names in os.walk(destination, followlinks=False):
            directory = Path(current)
            for name in dirs:
                path = directory / name
                trusted_dir(path, self.owner, immutable=True)
                actual_dirs.add(str(path.relative_to(destination)))
            for name in names:
                path = directory / name
                relative = str(path.relative_to(destination))
                if relative not in files or read_file(path, FILE_LIMIT, owner=self.owner, immutable=True) != files[relative]:
                    raise PullError('existing immutable release differs from the downloaded archive')
                actual_files.add(relative)
        if actual_files != set(files) or actual_dirs != expected_dirs:
            raise PullError('existing immutable release layout differs from the downloaded archive')

    def selector_snapshot(self):
        return optional_file(self.selector, owner=self.owner)

    def finish_rollback(self, tag, previous):
        # Keep the journal until rollback health is verified, including the
        # case where restart and verification happen in the next invocation.
        current = self.selector_snapshot()
        if current != previous and current != self.selector_bytes(tag):
            raise PullError('release selector changed during transaction; manual recovery required')
        atomic_write(self.failed_path(tag), b'activation failed\n', 0o600)
        if current != previous:
            if previous is None:
                discard(self.selector)
            else:
                atomic_write(self.selector, previous, 0o644)
        command('daemon-reload')
        verify_service_user()
        command('reset-failed', UNIT)
        command('restart', UNIT)
        previous_tag = self.selector_tag(previous)
        check_health(self.cfg, self.entry(previous_tag) if previous_tag is not None else None)
        discard(self.pending)
        print(f'{tag}: previous selector and service health restored', file=sys.stderr)

    def recover(self, journal):
        record = parse_json(journal, 'pending release')
        tag = record.get('tag')
        version(tag)
        if set(record) != {'tag', 'previous'}:
            raise PullError('invalid pending release journal; manual recovery required')
        previous = record['previous']
        if previous is not None:
            try:
                previous = base64.b64decode(previous, validate=True)
            except (TypeError, ValueError) as exc:
                raise PullError('invalid pending release selector') from exc
            self.selector_tag(previous)
        self.finish_rollback(tag, previous)

    def activate(self, tag, previous):
        verify_service_user()
        if self.selector_snapshot() != previous:
            raise PullError('release selector changed before activation')
        record = {'tag': tag, 'previous': None if previous is None else base64.b64encode(previous).decode('ascii')}
        atomic_write(self.pending, json.dumps(record).encode('ascii'), 0o600)
        try:
            atomic_write(self.selector, self.selector_bytes(tag), 0o644)
            command('daemon-reload')
            verify_service_user()
            verify_selected(self.entry(tag))
            command('restart', UNIT)
            check_health(self.cfg, self.entry(tag))
        except (PullError, OSError, KeyboardInterrupt) as exc:
            try:
                self.finish_rollback(tag, previous)
            except (PullError, OSError, KeyboardInterrupt) as rollback_error:
                raise PullError(f'{tag} activation failed: {exc}; rollback not verified: {rollback_error}') from rollback_error
            raise PullError(f'{tag} activation failed and was rolled back: {exc}') from exc
        # Remove a manual retry marker only after verification. If interrupted
        # before committing the journal, the next run conservatively rolls back.
        discard(self.failed_path(tag))
        discard(self.pending)
        print(f'{tag}: activated and verified')

    def run(self, *, check=False, retry_failed=False):
        journal = optional_file(self.pending, limit=2 * SMALL_LIMIT, owner=self.owner)
        if journal is not None:
            if check:
                raise PullError('incomplete activation requires rollback; --check made no changes')
            self.recover(journal)
            raise PullError('recovered an incomplete activation; no new release attempted')
        previous = self.selector_snapshot()
        active = self.selector_tag(previous)
        release = latest(self.cfg.repository)
        if active is not None:
            if release.tag == active:
                print(f'{active}: already selected')
                return
            if version(release.tag) < version(active):
                raise PullError(f'refusing downgrade from {active} to {release.tag}')
        if optional_file(self.failed_path(release.tag), owner=self.owner) is not None and not retry_failed:
            raise PullError(f'{release.tag} previously failed; skipped (manual --retry-failed to override)')
        files = release_files(self.cfg.repository, release)
        if check:
            print(f'{release.tag}: verified release available (current: {active or "base unit"}); no changes made')
            return
        self.stage(release.tag, files)
        self.activate(release.tag, previous)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, help=f'operator JSON configuration (default {CONFIG} when present)')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='verify availability/artifacts without writes or service actions')
    mode.add_argument('--retry-failed', action='store_true', help='manually retry a failed latest release; never downgrade')
    args = parser.parse_args(argv)

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        if not args.check and os.geteuid() != 0:
            raise PullError('root is required to activate a release')
        path = args.config or CONFIG
        cfg = load_config(path, args.config is not None, None if args.check else 0)
        updater = Updater(cfg)
        if args.check:
            updater.run(check=True)
        else:
            trusted_tree(updater.state, 0, create=True, mode=0o700)
            with updater.lock():
                trusted_tree(updater.releases, 0, create=True)
                trusted_tree(updater.selector.parent, 0, create=True)
                updater.run(retry_failed=args.retry_failed)
        return 0
    except (PullError, OSError, KeyboardInterrupt) as exc:
        print(f'release pull: {exc or "interrupted"}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
