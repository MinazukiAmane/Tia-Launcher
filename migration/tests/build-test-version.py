"""Build an isolated prerelease without changing the working tree's version."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('version')
parser.add_argument('--target', default='x86_64-pc-windows-gnu')
arguments = parser.parse_args()
if not re.fullmatch(r'2\.0\.0-alpha\.\d+', arguments.version):
    parser.error('Use an isolated test prerelease version')
root = Path(__file__).resolve().parents[2]
output = root / 'release-test/native-updater/update-binary'
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='tia-native-version-') as temporary:
    copy = Path(temporary)
    shutil.copytree(root / 'src-tauri', copy / 'src-tauri', ignore=shutil.ignore_patterns('target'))
    shutil.copytree(root / 'src/shared', copy / 'src/shared')
    (copy / 'src/main').mkdir(parents=True)
    shutil.copy2(root / 'src/main/mediaConverterAssets.json', copy / 'src/main/mediaConverterAssets.json')
    shutil.copytree(root / 'dist', copy / 'dist')
    (copy / 'build/licenses').mkdir(parents=True)
    shutil.copy2(root / 'build/licenses/Orbitron-OFL.txt', copy / 'build/licenses/Orbitron-OFL.txt')
    native = copy / 'build/native'
    (native / 'cedar').mkdir(parents=True)
    for name in ['csore-start-x86.exe', 'csore-start-x64.exe']:
        shutil.copy2(root / 'build/native' / name, native / name)
    for name in ['cedar-start-x64.exe', 'cedar-client-x64.dll', 'launcher-services.json', 'LICENSE-Minhook.txt']:
        shutil.copy2(root / 'build/native/cedar' / name, native / 'cedar' / name)
    manifest = copy / 'src-tauri/Cargo.toml'
    text = re.sub(r'(?m)^version = "2\.0\.0-alpha\.\d+"$', f'version = "{arguments.version}"', manifest.read_text(), count=1)
    manifest.write_text(text)
    config = copy / 'src-tauri/tauri.conf.json'
    value = json.loads(config.read_text())
    value['version'] = arguments.version
    config.write_text(json.dumps(value, indent=2) + '\n')
    environment = os.environ.copy()
    environment['CARGO_TARGET_DIR'] = str(root / 'src-tauri/target')
    subprocess.run(['cargo', 'build', '--manifest-path', str(manifest), '--bin', 'tia-launcher', '--target', arguments.target, '--features', 'tauri/custom-protocol', '-j', '1'], env=environment, check=True)
    target = root / 'src-tauri/target' / arguments.target / 'debug'
    for name in ['tia-launcher.exe', 'WebView2Loader.dll']:
        shutil.copy2(target / name, output / name)
print(json.dumps({'version': arguments.version, 'output': str(output)}))
