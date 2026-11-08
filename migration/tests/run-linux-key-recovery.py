#!/usr/bin/env python3
import os
import json
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='tia-key-session-') as directory:
    env = os.environ.copy()
    env['XDG_DATA_HOME'] = str(Path(directory) / 'data')
    env['XDG_CONFIG_HOME'] = str(Path(directory) / 'config')
    env['XDG_RUNTIME_DIR'] = str(Path(directory) / 'runtime')
    Path(env['XDG_RUNTIME_DIR']).mkdir(mode=0o700)
    env['XDG_CURRENT_DESKTOP'] = 'GNOME'
    env['NO_AT_BRIDGE'] = '1'
    env.pop('WAYLAND_DISPLAY', None)
    env['GDK_BACKEND'] = 'x11'
    env['QT_QPA_PLATFORM'] = 'xcb'
    env['GNOME_KEYRING_CONTROL'] = str(Path(directory) / 'keyring')
    script = '''
set -eu
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$GNOME_KEYRING_CONTROL"
chmod 700 "$GNOME_KEYRING_CONTROL"
gnome-keyring-daemon --foreground --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" >"$GNOME_KEYRING_CONTROL/daemon.log" 2>&1 &
keyring_pid=$!
trap 'kill "$keyring_pid" 2>/dev/null || true; wait "$keyring_pid" 2>/dev/null || true' EXIT
for attempt in $(seq 1 100); do
  test ! -S "$GNOME_KEYRING_CONTROL/control" || break
  sleep 0.1
done
test -S "$GNOME_KEYRING_CONTROL/control" || { cat "$GNOME_KEYRING_CONTROL/daemon.log"; exit 1; }
gdbus wait --session --timeout 10 org.freedesktop.secrets
printf '%s' 'temporary-test-password' | gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" >/dev/null 2>&1
keyring_unlocked=0
for attempt in $(seq 1 50); do
  if gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets/collection/login --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked 2>/dev/null | grep -q false; then keyring_unlocked=1; break; fi
  sleep 0.1
done
test "$keyring_unlocked" = 1 || { echo "The isolated keyring did not unlock"; cat "$GNOME_KEYRING_CONTROL/daemon.log"; exit 1; }
electron_binary="$(node -p 'require("electron")')"
for backend in basic gnome-libsecret; do
  "$electron_binary" --ozone-platform=x11 migration/tests/electron-key-recovery.cjs src-tauri/target/debug/tia-migration-helper "$backend"
done
'''
    with (Path(directory) / 'session.log').open('w+') as log:
        completed = subprocess.run(['xvfb-run', '-a', 'dbus-run-session', '--', 'bash', '-c', script], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, text=True, timeout=180)
        log.seek(0)
        output = log.read()
        reports = []
        for line in output.splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict) and value.get('ok') is True: reports.append(value)
            except json.JSONDecodeError: pass
        if completed.returncode or {value.get('backend') for value in reports} != {'basic_text', 'gnome_libsecret'}:
            print(output, end='')
            raise SystemExit(completed.returncode or 1)
        for report in reports: print(json.dumps(report))
    raise SystemExit(completed.returncode)
