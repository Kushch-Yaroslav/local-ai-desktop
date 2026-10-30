#!/usr/bin/env python3
"""Privileged, bounded swappiness controller. Does not launch model processes.
Run through systemd with RuntimeMaxSec=660. Records the original value before
writing 0; restores in finally on normal stop, SIGTERM/SIGINT/SIGHUP, or timeout.
State and stop paths must be supplied explicitly by the operator.
"""
import json
import os
from pathlib import Path
import signal
import sys
import time


def main():
    if os.geteuid() != 0:
        raise SystemExit('Requires host administrative authorization')
    state_path, stop_path = map(Path, sys.argv[1:3])
    knob = Path('/proc/sys/vm/swappiness')
    original = int(knob.read_text().strip())
    state = {'original': original, 'pid': os.getpid(), 'status': 'saved'}
    def record():
        state_path.write_text(json.dumps(state, indent=2) + '\n')
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, interrupted)
    record()  # persist before any change
    try:
        knob.write_text('0\n')
        if int(knob.read_text()) != 0:
            raise RuntimeError('swappiness=0 verification failed')
        state['status'] = 'active'
        record()
        deadline = time.monotonic() + 600
        while not stop_path.exists() and time.monotonic() < deadline:
            time.sleep(0.5)
    finally:
        # Do not allow a repeated cancellation to interrupt restoration.
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        knob.write_text(str(original) + '\n')
        state['restored'] = int(knob.read_text())
        state['status'] = 'restored' if state['restored'] == original else 'RESTORE_FAILED'
        record()
        if state['restored'] != original:
            raise RuntimeError('swappiness restoration failed')


if __name__ == '__main__':
    main()
