#!/usr/bin/env python3
# ruff: noqa
"""DSH remote helper daemon.

One long-lived process on the SSH target. It speaks newline-delimited JSON on
stdin/stdout and owns everything the SSH protocol itself cannot express:

  * real process identity (pid AND pgid) for spawned children
  * whole-tree liveness, so `waitForExit` can observe descendants
  * tree-scoped signal delivery (`killpg`) after the spawning channel is gone
  * atomic file publication (`os.replace` / `os.link`) and `realpath -m`
  * a freshness token with inode + nanosecond fidelity

Design constraints, in order of priority:

  1. **No third-party imports.** Only the Python 3 standard library, so any
     distro image works with no provisioning beyond `python3` itself.
  2. **Python 3.6+.** No walrus, no dataclasses, no `subprocess` niceties added
     after 3.6. Long-lived servers run old interpreters.
  3. **One frame per line.** Payload bytes travel base64-encoded inside the JSON
     frame; nothing is length-prefixed, so a partial write can never desync the
     stream. Every payload is chunked to CHUNK so no single transfer starves an
     interactive terminal sharing the channel.
  4. **stderr is diagnostics only.** The client treats helper stderr as log text
     and never parses it. Protocol traffic is stdout exclusively.

Protocol: see `../src/protocol.ts` for the authoritative type definitions.
Requests carry an `id`; every request produces exactly one terminal reply
(`{"id":N,"ok":true,...}` or `{"id":N,"ok":false,"error":{...}}`). Unsolicited
frames carry `ev` instead of `id`.
"""

import base64
import errno
import hashlib
import json
import os
import signal
import stat as statmod
import subprocess
import sys
import threading
import traceback
import uuid

PROTOCOL_VERSION = 1
CHUNK = 64 * 1024

_out_lock = threading.Lock()
_children = {}
_children_lock = threading.Lock()


def _send(frame):
    """Write one JSON frame followed by a newline, atomically against peers."""
    line = json.dumps(frame, separators=(',', ':'), ensure_ascii=True)
    with _out_lock:
        sys.stdout.write(line)
        sys.stdout.write('\n')
        sys.stdout.flush()


def _log(level, message):
    _send({'ev': 'log', 'level': level, 'message': message})


def _b64(data):
    return base64.b64encode(data).decode('ascii')


def _unb64(text):
    return base64.b64decode(text.encode('ascii'))


class HelperError(Exception):
    """An error with a stable machine-readable code."""

    def __init__(self, code, message, errno_value=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.errno = errno_value


def _os_error(error, path):
    """Translate an OSError into a coded HelperError."""
    code = errno.errorcode.get(error.errno, 'EIO')
    return HelperError(code, '%s: %s' % (code, path), error.errno)


# ---------------------------------------------------------------------------
# filesystem
# ---------------------------------------------------------------------------

def _version_token(st):
    """Freshness token with inode and nanosecond fidelity.

    SFTP v3 attributes could not produce this: no inode, no ctime, second-only
    mtime. A sub-second same-size overwrite must still change the token.

    Deliberately EXCLUDES ctime: on Linux, reading a file updates its atime, and
    an atime update bumps ctime. A token containing ctime therefore changes when
    a file is merely READ, which makes the "stat -> read -> compare-and-swap
    write" sequence of an edit misreport ESTALE — the file changed between the
    caller's read and its publish only in the sense that the caller read it.
    Content freshness is inode (a replace is a new inode) plus mtime (an in-place
    edit rewrites it) plus size and mode.
    """
    raw = '%d:%d:%d:%d:%d' % (
        st.st_dev, st.st_ino, st.st_size, st.st_mode,
        getattr(st, 'st_mtime_ns', int(st.st_mtime * 1e9)),
    )
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _kind(mode, follow_result=None):
    if statmod.S_ISDIR(mode):
        return 'directory'
    if statmod.S_ISREG(mode):
        return 'file'
    if statmod.S_ISLNK(mode):
        return 'symlink'
    return 'other'


def _stat_info(st, allow_symlink):
    kind = _kind(st.st_mode)
    if kind == 'symlink' and not allow_symlink:
        kind = 'other'
    info = {'type': kind, 'version': _version_token(st), 'mode': statmod.S_IMODE(st.st_mode)}
    if kind == 'file':
        info['size'] = st.st_size
    return info


def op_stat(req):
    path = req['path']
    try:
        st = os.stat(path)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR):
            return {'present': False}
        raise _os_error(error, path)
    return {'present': True, 'info': _stat_info(st, allow_symlink=False)}


def op_lstat(req):
    path = req['path']
    try:
        st = os.lstat(path)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR):
            return {'present': False}
        raise _os_error(error, path)
    return {'present': True, 'info': _stat_info(st, allow_symlink=True)}


def op_realpath(req):
    """`realpath -m` semantics: canonicalize the deepest existing ancestor.

    A create needs a stable identity for a path whose final component does not
    exist yet, so a strict realpath is unusable here.
    """
    path = req['path']
    cwd = req.get('cwd')
    if not os.path.isabs(path):
        if not cwd:
            raise HelperError('EINVAL', 'relative path with no cwd: %s' % path)
        path = os.path.join(cwd, path)
    path = os.path.normpath(path)
    tail = []
    head = path
    while True:
        if os.path.lexists(head):
            break
        parent = os.path.dirname(head)
        if parent == head:
            break
        tail.append(os.path.basename(head))
        head = parent
    try:
        resolved = os.path.realpath(head)
    except OSError as error:
        raise _os_error(error, head)
    for name in reversed(tail):
        resolved = os.path.join(resolved, name)
    return {'path': resolved}


def op_listdir(req):
    path = req['path']
    try:
        names = os.listdir(path)
    except OSError as error:
        raise _os_error(error, path)
    entries = []
    for name in sorted(names):
        child = os.path.join(path, name)
        entry = {'name': name}
        try:
            lst = os.lstat(child)
        except OSError:
            # Vanished between listdir and lstat; report it as unusable rather
            # than dropping it, so the client can still show the name.
            entry['type'] = 'other'
            entries.append(entry)
            continue
        if statmod.S_ISLNK(lst.st_mode):
            # A followed symlink needs the target's identity; an unresolvable
            # one degrades to 'other' with no version, which the fs contract
            # explicitly permits as a cheap-metadata decline.
            try:
                st = os.stat(child)
                entry.update(_stat_info(st, allow_symlink=False))
                entry['target'] = os.path.realpath(child)
                entry['symlink'] = True
            except OSError:
                entry['type'] = 'other'
                entry['symlink'] = True
        else:
            entry.update(_stat_info(lst, allow_symlink=False))
        entries.append(entry)
    return {'entries': entries}


def op_read(req):
    """Stream a regular file as base64 data events, then reply with the total.

    `maxBytes`, when present, is an inclusive cap: exceeding it aborts with
    E2BIG rather than truncating, because a truncated read would be
    indistinguishable from a short file.
    """
    path = req['path']
    request_id = req['id']
    max_bytes = req.get('maxBytes')
    try:
        st = os.stat(path)
    except OSError as error:
        raise _os_error(error, path)
    if not statmod.S_ISREG(st.st_mode):
        raise HelperError('EISDIR' if statmod.S_ISDIR(st.st_mode) else 'EINVAL',
                          'not a regular file: %s' % path)
    if max_bytes is not None and st.st_size > max_bytes:
        raise HelperError('E2BIG', 'file exceeds %d bytes: %s' % (max_bytes, path))
    total = 0
    try:
        handle = open(path, 'rb')
    except OSError as error:
        raise _os_error(error, path)
    try:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if max_bytes is not None and total > max_bytes:
                # A file that grew after the stat preflight.
                raise HelperError('E2BIG', 'file exceeds %d bytes: %s' % (max_bytes, path))
            _send({'ev': 'data', 'id': request_id, 'b64': _b64(chunk)})
    finally:
        handle.close()
    return {'bytes': total, 'version': _version_token(st)}


def _staging_name(target):
    return os.path.join(os.path.dirname(target), '.dsh-%s.tmp' % uuid.uuid4().hex)


def op_write(req):
    """Publish file content atomically.

    Three publication modes, all impossible over plain SFTP v3:
      * overwrite  -> `os.replace` (rename that is specified to overwrite)
      * exclusive  -> `os.link`    (fails when the target exists; the guarded
                                    create the fs contract needs)
      * ifVersion  -> compare-and-swap: the target's version token is re-checked
                      immediately before publication, so a concurrent writer that
                      lands between the client's read and its write is detected.
                      A client-side check alone cannot close that window, because
                      the window is on this machine.
    """
    path = req['path']
    data = _unb64(req['dataB64'])
    exclusive = bool(req.get('exclusive'))
    if_version = req.get('ifVersion')
    mode = req.get('mode')
    if mode is None:
        try:
            mode = statmod.S_IMODE(os.lstat(path).st_mode)
        except OSError:
            mode = 0o600
    temp = _staging_name(path)
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(temp, flags, mode)
        try:
            os.write(fd, data)
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as error:
        raise _os_error(error, temp)
    try:
        if if_version is not None:
            # Checked as late as possible: the shorter the interval between the
            # check and the rename, the smaller the residual race. It cannot be
            # eliminated without a lock the fs contract does not provide, and a
            # narrow window that reports honestly beats a wide silent one.
            try:
                pre = os.stat(path)
                current = _version_token(pre)
            except OSError as error:
                if error.errno == errno.ENOENT:
                    raise HelperError('ESTALE', 'target vanished before publication: %s' % path)
                raise _os_error(error, path)
            if current != if_version:
                _send({'ev': 'log', 'level': 'warn', 'message':
                       'CAS mismatch %s: expected %s got %s (ino=%d mtime_ns=%d size=%d mode=%o)' % (
                           path, if_version[:12], current[:12], pre.st_ino,
                           getattr(pre, 'st_mtime_ns', int(pre.st_mtime * 1e9)),
                           pre.st_size, statmod.S_IMODE(pre.st_mode))})
                raise HelperError('ESTALE', 'target changed before publication: %s' % path)
        if exclusive:
            try:
                os.link(temp, path)
            except OSError as error:
                if error.errno == errno.EEXIST:
                    raise HelperError('EEXIST', 'target already exists: %s' % path, errno.EEXIST)
                raise _os_error(error, path)
        else:
            os.replace(temp, path)
    finally:
        try:
            os.unlink(temp)
        except OSError:
            pass
    try:
        st = os.stat(path)
    except OSError as error:
        raise _os_error(error, path)
    return {'version': _version_token(st), 'size': st.st_size}


def op_mkdir(req):
    path = req['path']
    try:
        if req.get('parents'):
            os.makedirs(path)
        else:
            os.mkdir(path)
    except OSError as error:
        if error.errno == errno.EEXIST and req.get('okIfExists'):
            return {'created': False}
        raise _os_error(error, path)
    return {'created': True}


def op_remove(req):
    path = req['path']
    try:
        if req.get('dir'):
            os.rmdir(path)
        else:
            os.unlink(path)
    except OSError as error:
        if error.errno == errno.ENOENT:
            return {'removed': False}
        raise _os_error(error, path)
    return {'removed': True}


# ---------------------------------------------------------------------------
# environment and executable resolution
# ---------------------------------------------------------------------------

def op_env(req):
    """Report the remote environment base the client will scrub.

    `login` runs the account's login shell so PAM, /etc/profile and rc files are
    represented; the plain form reports this daemon's own environment, which an
    sshd non-interactive session leaves comparatively bare.
    """
    if not req.get('login'):
        return {'env': dict(os.environ), 'home': os.path.expanduser('~')}
    shell = os.environ.get('SHELL') or '/bin/sh'
    try:
        raw = subprocess.check_output([shell, '-l', '-c', 'env -0'], stderr=subprocess.DEVNULL)
    except Exception as error:  # noqa: BLE001 - a login shell may not exist
        _log('warn', 'login env probe failed: %s' % error)
        return {'env': dict(os.environ), 'home': os.path.expanduser('~'), 'login': False}
    env = {}
    for item in raw.split(b'\0'):
        if not item:
            continue
        name, _, value = item.partition(b'=')
        try:
            env[name.decode('utf-8')] = value.decode('utf-8')
        except UnicodeDecodeError:
            continue
    return {'env': env, 'home': os.path.expanduser('~'), 'login': True}


def op_which(req):
    """Resolve one executable exactly as the subprocess contract requires.

    Absolute paths are verified. Bare names search the supplied PATH. A relative
    path containing a separator is rejected: its resolution base is undefined,
    so guessing would be worse than failing.
    """
    name = req['name']
    path_env = req.get('path') or os.environ.get('PATH') or os.defpath
    if os.path.isabs(name):
        if os.path.isfile(name) and os.access(name, os.X_OK):
            return {'path': name}
        raise HelperError('ENOENT', 'not an executable file: %s' % name)
    if os.sep in name or (os.altsep and os.altsep in name):
        raise HelperError('EINVAL', 'relative path with separators is not resolvable: %s' % name)
    for directory in path_env.split(os.pathsep):
        if not directory:
            continue
        candidate = os.path.join(directory, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return {'path': candidate}
    raise HelperError('ENOENT', 'not found on PATH: %s' % name)


# ---------------------------------------------------------------------------
# processes
# ---------------------------------------------------------------------------

class Child(object):
    """One spawned process tree plus its relay threads."""

    def __init__(self, handle, popen, spill):
        self.handle = handle
        self.popen = popen
        self.pid = popen.pid
        # start_new_session=True makes the child a session leader, so its pgid
        # equals its pid. Every later signal targets the group, never the pid.
        self.pgid = popen.pid
        self.stdin_closed = False
        # Spill lives HERE, on the target: the path is handed to a model whose
        # world is this machine, so a host-side file would be unreadable to it.
        self.spill = spill


class Spill(object):
    """A bounded full-stream record written on the target.

    The cap is whole-stream: once it is passed the file can no longer honour the
    promise its path implies, so it is deleted and its loss reported. A partial
    file presented as a complete record is worse than no file at all.
    """

    def __init__(self, path, max_bytes):
        self.path = path
        self.max_bytes = max_bytes
        self.written = 0
        self.lost = False
        self.lock = threading.Lock()
        directory = os.path.dirname(path)
        if directory:
            try:
                os.makedirs(directory, 0o700)
            except OSError as error:
                if error.errno != errno.EEXIST:
                    raise
        # Exclusive creation: two handles must never share one spill file.
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        self.fd = os.open(path, flags, 0o600)

    def write(self, handle, chunk):
        with self.lock:
            if self.lost:
                return
            if self.written + len(chunk) > self.max_bytes:
                self._discard(handle, 'cap')
                return
            try:
                os.write(self.fd, chunk)
                self.written += len(chunk)
            except OSError as error:
                self._discard(handle, 'write failed: %s' % error)

    def _discard(self, handle, reason):
        self.lost = True
        try:
            os.close(self.fd)
        except OSError:
            pass
        try:
            os.unlink(self.path)
        except OSError:
            pass
        _send({'ev': 'spill', 'h': handle, 'lost': True, 'reason': reason})

    def close(self):
        with self.lock:
            if self.lost:
                return
            try:
                os.close(self.fd)
            except OSError:
                pass


def _relay(child, stream, label):
    """Forward one child stream to the control channel as data events."""
    spill = child.spill.get(label) if child.spill else None
    try:
        while True:
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            # The spill is written before the frame is emitted, so a client that
            # sees the bytes can always assume the record already holds them.
            if spill is not None:
                spill.write(child.handle, chunk)
            _send({'ev': 'data', 'h': child.handle, 's': label, 'b64': _b64(chunk)})
    except Exception as error:  # noqa: BLE001 - a closed pipe is normal
        _log('debug', 'relay %s/%s ended: %s' % (child.handle, label, error))
    finally:
        try:
            stream.close()
        except Exception:
            pass
        if spill is not None:
            spill.close()
        _send({'ev': 'eof', 'h': child.handle, 's': label})


def _reap(child):
    """Await the direct child, publish exit facts, then await tree quiescence."""
    code = child.popen.wait()
    if code < 0:
        _send({'ev': 'exit', 'h': child.handle, 'code': None, 'signal': -code})
    else:
        _send({'ev': 'exit', 'h': child.handle, 'code': code, 'signal': None})
    # The direct child is gone, but a descendant may still hold the group. The
    # contract's waitForExit observes the tree, so quiescence is a separate fact.
    while True:
        if not _group_alive(child.pgid):
            break
        threading.Event().wait(0.05)
    _send({'ev': 'gone', 'h': child.handle})
    with _children_lock:
        _children.pop(child.handle, None)


def _group_alive(pgid):
    if pgid <= 1:
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except OSError as error:
        if error.errno == errno.ESRCH:
            return False
        # EPERM means the group exists but is not ours to signal.
        return error.errno == errno.EPERM


def op_spawn(req):
    """Start one child in its own session with a fully explicit environment.

    argv arrives as a list and is passed to execvp without a shell, so no
    quoting layer exists to get wrong. `env -i` semantics are achieved by
    handing Popen the complete environment the client computed.
    """
    argv = req['argv']
    if not argv:
        raise HelperError('EINVAL', 'argv must not be empty')
    cwd = req['cwd']
    env = req.get('env') or {}
    handle = req['handle']
    stdin_mode = req.get('stdin') or 'ignore'
    spill = req.get('spill')

    if not os.path.isdir(cwd):
        # Reported as a spawn-level failure, never as an exit code: a child that
        # legitimately exits 125 must stay distinguishable from a bad cwd.
        raise HelperError('ENOTDIR', 'cwd is not a directory: %s' % cwd)

    stdin_target = subprocess.PIPE if stdin_mode == 'pipe' else subprocess.DEVNULL
    spills = {}
    if spill:
        # The client names each stream's file explicitly: deriving names here
        # would put the authoritative path in two places, and the client is what
        # must report `spillPath` back to its caller.
        max_bytes = spill.get('maxBytes')
        if max_bytes is None:
            raise HelperError('EINVAL', 'spill requires maxBytes')
        streams = spill.get('streams') or {}
        if not isinstance(streams, dict) or not streams:
            raise HelperError('EINVAL', 'spill requires a streams map of label -> path')
        for label, path in streams.items():
            if label not in ('out', 'err'):
                raise HelperError('EINVAL', 'spill stream must be out or err: %s' % label)
            if not path.startswith('/'):
                raise HelperError('EINVAL', 'spill path must be absolute: %s' % path)
            try:
                spills[label] = Spill(path, max_bytes)
            except OSError as error:
                for entry in spills.values():
                    entry.close()
                raise _os_error(error, path)

    try:
        popen = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=stdin_target,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
        )
    except OSError as error:
        for entry in spills.values():
            entry.close()
        raise _os_error(error, argv[0])

    child = Child(handle, popen, spills)
    with _children_lock:
        _children[handle] = child

    for stream, label in ((popen.stdout, 'out'), (popen.stderr, 'err')):
        if stream is not None:
            thread = threading.Thread(target=_relay, args=(child, stream, label))
            thread.daemon = True
            thread.start()
    reaper = threading.Thread(target=_reap, args=(child,))
    reaper.daemon = True
    reaper.start()

    return {
        'pid': child.pid,
        'pgid': child.pgid,
        'spill': dict((label, entry.path) for label, entry in spills.items()),
    }


def _child(handle):
    with _children_lock:
        child = _children.get(handle)
    if child is None:
        raise HelperError('ENOENT', 'no such process handle: %s' % handle)
    return child


def op_stdin(req):
    child = _child(req['handle'])
    if child.popen.stdin is None or child.stdin_closed:
        raise HelperError('EPIPE', 'stdin is not writable')
    data = _unb64(req['dataB64']) if req.get('dataB64') else b''
    try:
        if data:
            child.popen.stdin.write(data)
            child.popen.stdin.flush()
        if req.get('close'):
            child.popen.stdin.close()
            child.stdin_closed = True
    except OSError as error:
        raise _os_error(error, 'stdin')
    return {'written': len(data)}


def op_kill(req):
    """Signal a process group. The client owns the TERM -> grace -> KILL ladder.

    Both a missing group and an unsignalable one are reported as facts rather
    than errors: only a liveness probe proves quiescence, so a failed signal is
    never authoritative on its own.
    """
    pgid = req['pgid']
    if pgid <= 1:
        raise HelperError('EINVAL', 'refusing to signal pgid %d' % pgid)
    name = req.get('signal') or 'TERM'
    number = getattr(signal, 'SIG' + name, None)
    if number is None:
        raise HelperError('EINVAL', 'unknown signal: %s' % name)
    try:
        os.killpg(pgid, number)
        return {'delivered': True, 'alive': _group_alive(pgid)}
    except OSError as error:
        return {'delivered': False, 'alive': _group_alive(pgid),
                'code': errno.errorcode.get(error.errno, 'EIO')}


def op_alive(req):
    return {'alive': _group_alive(req['pgid'])}


def op_ping(req):
    return {
        'protocol': PROTOCOL_VERSION,
        'python': '%d.%d.%d' % sys.version_info[:3],
        'pid': os.getpid(),
        'platform': sys.platform,
        'uname': list(os.uname()) if hasattr(os, 'uname') else [],
    }


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

OPS = {
    'ping': op_ping,
    'stat': op_stat,
    'lstat': op_lstat,
    'realpath': op_realpath,
    'listdir': op_listdir,
    'read': op_read,
    'write': op_write,
    'mkdir': op_mkdir,
    'remove': op_remove,
    'env': op_env,
    'which': op_which,
    'spawn': op_spawn,
    'stdin': op_stdin,
    'kill': op_kill,
    'alive': op_alive,
}

# Operations that must not be queued behind a slow peer: each runs on its own
# thread. Everything is thread-safe through the send lock and the child table.
def _handle(req):
    request_id = req.get('id')
    op = req.get('op')
    handler = OPS.get(op)
    if handler is None:
        _send({'id': request_id, 'ok': False,
               'error': {'code': 'ENOSYS', 'message': 'unknown op: %s' % op}})
        return
    try:
        result = handler(req)
    except HelperError as error:
        _send({'id': request_id, 'ok': False,
               'error': {'code': error.code, 'message': error.message, 'errno': error.errno}})
    except Exception as error:  # noqa: BLE001 - never let one request kill the daemon
        _send({'id': request_id, 'ok': False,
               'error': {'code': 'EHELPER', 'message': '%s: %s' % (type(error).__name__, error),
                         'trace': traceback.format_exc()[-2000:]}})
    else:
        _send({'id': request_id, 'ok': True, 'result': result})


def main():
    # SIGPIPE default disposition kills the daemon when the control channel
    # closes mid-write; the read loop below is the only exit path we want.
    try:
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    except (AttributeError, ValueError):
        pass
    _send({'ev': 'ready', 'protocol': PROTOCOL_VERSION, 'pid': os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            _log('error', 'malformed request frame discarded')
            continue
        thread = threading.Thread(target=_handle, args=(req,))
        thread.daemon = True
        thread.start()
    # stdin EOF: the client is gone. Terminate every tree we still own so no
    # orphan survives the connection.
    with _children_lock:
        children = list(_children.values())
    for child in children:
        try:
            os.killpg(child.pgid, signal.SIGKILL)
        except OSError:
            pass


if __name__ == '__main__':
    main()
