#!/usr/bin/env python3
"""Run the Linux preview against a temporary profile on a virtual display."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

repository = Path(__file__).resolve().parents[2]
binary = repository / 'src-tauri/target/debug/tia-launcher'
with tempfile.TemporaryDirectory(prefix='tia-tauri-smoke-') as temporary:
    profile = Path(temporary)
    key = secrets.token_bytes(32)
    encoded = base64.b64encode(key).decode()
    message = json.dumps([1, 'file', encoded], separators=(',', ':')).encode()
    envelope = dict(version=1, mode='file', data=encoded, tag=hmac.new(key, message, hashlib.sha256).hexdigest())
    key_file = profile / 'launcher.tauri.key'
    key_file.write_text(json.dumps(envelope))
    key_file.chmod(0o600)
    environment = os.environ.copy()
    environment['GDK_BACKEND'] = 'x11'
    result = subprocess.run(
        ['xvfb-run', '-a', str(binary), '--profile', str(profile), '--smoke-test'],
        env=environment, capture_output=True, text=True, timeout=40,
    )
    print(result.stdout, end='')
    reports = []
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and 'ok' in value:
                reports.append(value)
        except json.JSONDecodeError:
            pass
    success = result.returncode == 0 and bool(reports) and reports[-1].get('ok') is True
    if not success:
        print(result.stderr, end='')
    raise SystemExit(0 if success else 1)
