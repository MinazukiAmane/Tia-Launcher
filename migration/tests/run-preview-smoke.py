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
    try:
        result = subprocess.run(
            ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24', str(binary), '--profile', str(profile), '--smoke-test'],
            env=environment, capture_output=True, text=True, timeout=75,
        )
    except subprocess.TimeoutExpired as error:
        print((error.stdout or b'').decode(errors='replace'))
        print((error.stderr or b'').decode(errors='replace'))
        raise SystemExit('Preview smoke test timed out')
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
        raise SystemExit(1)

if success:
    overlay = subprocess.run(
        ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24', str(binary), '--launch-overlay', '{"name":null,"x":0,"y":0}'],
        env=environment, capture_output=True, text=True, timeout=10,
    )
    records = [json.loads(line) for line in overlay.stdout.splitlines() if line.startswith('{')]
    record = next((row for row in records if row.get('ready')), None)
    if overlay.returncode or not record or record['right'] - record['x'] - record['width'] != 24 or record['bottom'] - record['y'] - record['height'] != 24:
        raise SystemExit('Native GTK overlay was not anchored to the screen corner: ' + overlay.stdout + overlay.stderr)
    print(json.dumps({'nativeOverlay': record}))
