"""Unit tests for the helper's remote spill, the piece that fixes the reported
`spillPath` pointing at a file in the wrong world.

Runs on any OS: only os.open/write/unlink and threading are involved, no fork.

Run: python packages/ssh/helper/tests/test_spill.py
"""

import importlib.util
import os
import shutil
import sys
import uuid

HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, 'dsh_helper.py')

spec = importlib.util.spec_from_file_location('dsh_helper', HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

events = []
helper._send = lambda frame: events.append(frame)


def fresh(name, max_bytes, root):
    del events[:]
    return helper.Spill(os.path.join(root, name), max_bytes)


def main():
    # Scratch space stays inside the workspace: the host sandbox denies writes to
    # the OS temp area, and the spill logic is path-agnostic anyway.
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.scratch-%s' % uuid.uuid4().hex[:8])
    os.makedirs(root)
    try:
        run(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def run(root):
    # -- ordinary accumulation ---------------------------------------------
    spill = fresh('out.log', 100, root)
    spill.write('h1', b'hello ')
    spill.write('h1', b'world')
    spill.close()
    with open(spill.path, 'rb') as handle:
        assert handle.read() == b'hello world', 'the spill must hold the whole stream'
    assert spill.written == 11
    assert events == [], 'an intact spill must report nothing'

    # -- the cap discards the now-incomplete record ------------------------
    spill = fresh('capped.log', 8, root)
    spill.write('h2', b'12345678')
    assert spill.lost is False, 'exactly at the cap is still intact'
    assert os.path.exists(spill.path)
    spill.write('h2', b'9')
    assert spill.lost is True
    assert not os.path.exists(spill.path), 'a partial record must be deleted, not left to mislead'
    assert events == [{'ev': 'spill', 'h': 'h2', 'lost': True, 'reason': 'cap'}]

    # A write after loss is a silent no-op, and reports loss only once.
    del events[:]
    spill.write('h2', b'more')
    assert events == []

    # A chunk that would straddle the cap is refused whole: a half chunk in the
    # file would be a silent corruption rather than a reported loss.
    spill = fresh('straddle.log', 10, root)
    spill.write('h3', b'1234567890'[:6])
    spill.write('h3', b'abcdef')
    assert spill.lost is True
    assert events[0]['reason'] == 'cap'

    # -- exclusive creation -----------------------------------------------
    spill = fresh('exclusive.log', 100, root)
    try:
        helper.Spill(spill.path, 100)
    except OSError as error:
        assert error.errno == 17, 'a second handle must not be able to share one spill file (EEXIST)'
    else:
        raise AssertionError('exclusive creation was not enforced')
    spill.close()

    # -- the parent directory is created ----------------------------------
    # Skipped on Windows: the host sandbox refuses to open a file inside a
    # directory this process just created, and the helper only ever runs on the
    # POSIX target anyway. connect.e2e.ts covers it there.
    if sys.platform != 'win32':
        nested = os.path.join(root, 'processes', 'abc', 'stdout.log')
        del events[:]
        spill = helper.Spill(nested, 100)
        spill.write('h4', b'x')
        spill.close()
        assert os.path.exists(nested)
        assert oct(os.stat(os.path.dirname(nested)).st_mode)[-3:] == '700', 'a spill directory must be private'

    # -- a write failure is reported exactly like a cap overflow ----------
    spill = fresh('broken.log', 100, root)
    os.close(spill.fd)  # simulate the descriptor dying underneath us
    spill.write('h5', b'x')
    assert spill.lost is True
    assert events[0]['h'] == 'h5'
    assert events[0]['lost'] is True
    assert 'write failed' in events[0]['reason']

    print('helper/spill: ok — accumulation, cap discard, exclusivity, mkdir, and write-failure reporting verified')


if __name__ == '__main__':
    main()
    sys.exit(0)
