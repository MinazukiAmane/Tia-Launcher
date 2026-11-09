#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='tia-native-desktop-') as directory:
    env = os.environ.copy()
    directories = [
        ('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
        ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'runtime'),
    ]
    for variable, folder in directories:
        env[variable] = str(Path(directory) / folder)
        Path(env[variable]).mkdir(mode=0o700)
    env['XDG_CURRENT_DESKTOP'] = 'TiaCI'
    env['XDG_SESSION_TYPE'] = 'x11'
    env['GDK_BACKEND'] = 'x11'
    env['QT_QPA_PLATFORM'] = 'xcb'
    env['NO_AT_BRIDGE'] = '1'
    env['PIPEWIRE_RUNTIME_DIR'] = env['XDG_RUNTIME_DIR']
    env['GNOME_KEYRING_CONTROL'] = str(Path(directory) / 'keyring')
    Path(env['GNOME_KEYRING_CONTROL']).mkdir(mode=0o700)
    for name in ['WAYLAND_DISPLAY', 'AT_SPI_BUS_ADDRESS', 'PIPEWIRE_REMOTE']:
        env.pop(name, None)
    portal_locations = [Path('/usr/libexec/xdg-desktop-portal'), Path('/usr/lib/xdg-desktop-portal')]
    env['TIA_PORTAL_BINARY'] = str(next(path for path in portal_locations if path.is_file()))
    portals = Path(env['XDG_CONFIG_HOME']) / 'xdg-desktop-portal'
    portals.mkdir()
    (portals / 'portals.conf').write_text('[preferred]\ndefault=gtk\norg.freedesktop.impl.portal.Secret=gnome-keyring\n')
    pipewire = Path(env['XDG_CONFIG_HOME']) / 'pipewire'
    pipewire.mkdir()
    (pipewire / 'pipewire.conf').write_text('''context.properties = {
 core.daemon = true
 core.name = pipewire-0
}
context.spa-libs = { support.* = support/libspa-support }
context.modules = [
 { name = libpipewire-module-protocol-native }
 { name = libpipewire-module-metadata }
 { name = libpipewire-module-client-node }
 { name = libpipewire-module-access }
]
''')
    script = '''
set -eu
portal_pid=''
keyring_pid=''
pipewire_pid=''
cleanup() {
  for service_pid in "$portal_pid" "$keyring_pid" "$pipewire_pid"; do
    if test -n "$service_pid"; then
      kill "$service_pid" 2>/dev/null || true
      wait "$service_pid" 2>/dev/null || true
    fi
  done
  for service_log in portal pipewire keyring; do
    test ! -f "$XDG_RUNTIME_DIR/$service_log.log" || cat "$XDG_RUNTIME_DIR/$service_log.log"
  done
}
trap cleanup EXIT
pipewire -c "$XDG_CONFIG_HOME/pipewire/pipewire.conf" >"$XDG_RUNTIME_DIR/pipewire.log" 2>&1 &
pipewire_pid=$!
for attempt in $(seq 1 100); do
  test ! -S "$XDG_RUNTIME_DIR/pipewire-0" || break
  sleep 0.1
done
test -S "$XDG_RUNTIME_DIR/pipewire-0"
printf '%s' 'temporary-test-password' | gnome-keyring-daemon --foreground --login --control-directory="$GNOME_KEYRING_CONTROL" >"$XDG_RUNTIME_DIR/keyring.log" 2>&1 &
keyring_pid=$!
for attempt in $(seq 1 100); do
  test ! -S "$GNOME_KEYRING_CONTROL/control" || break
  sleep 0.1
done
test -S "$GNOME_KEYRING_CONTROL/control"
gnome-keyring-daemon --start --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" >/dev/null 2>&1
gdbus wait --session --timeout 10 org.freedesktop.secrets
"$TIA_PORTAL_BINARY" >"$XDG_RUNTIME_DIR/portal.log" 2>&1 &
portal_pid=$!
gdbus wait --session --timeout 20 org.freedesktop.portal.Desktop
node node_modules/vitest/vitest.mjs run tests/migration/appImageStartup.native.test.ts --maxWorkers=1
'''
    completed = subprocess.run(['xvfb-run', '-a', 'dbus-run-session', '--', 'bash', '-c', script], cwd=root, env=env, timeout=240)
    raise SystemExit(completed.returncode)
