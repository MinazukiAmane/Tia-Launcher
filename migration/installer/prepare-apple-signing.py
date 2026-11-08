#!/usr/bin/env python3
import base64
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("This signing setup is restricted to the ephemeral CI runner")
root = Path(os.environ["RUNNER_TEMP"])
state = root / "tia-apple-signing.json"


def run(*args):
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Apple signing step failed: {args[0]} {args[1]}")
    return result.stdout.strip()


if "--cleanup" in sys.argv:
    if state.exists():
        previous = json.loads(state.read_text())
        run("security", "list-keychains", "-d", "user", "-s", *previous["search"])
        run("security", "delete-keychain", previous["keychain"])
        for name in ("tia-developer-id.p12", "tia-notarization.p8", "tia-apple-signing.json"):
            (root / name).unlink(missing_ok=True)
else:
    for name in ("APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_API_KEY_CONTENT"):
        if not os.environ.get(name):
            raise SystemExit(f"Missing official macOS signing secret: {name}")
    keychain = str(root / "tia-release.keychain-db")
    password = secrets.token_hex(32)
    previous = shlex.split(run("security", "list-keychains", "-d", "user"))
    state.write_text(json.dumps({"search": previous, "keychain": keychain}))
    state.chmod(0o600)
    certificate = root / "tia-developer-id.p12"
    certificate.write_bytes(base64.b64decode(os.environ["APPLE_CERTIFICATE"], validate=True))
    certificate.chmod(0o600)
    api_key = root / "tia-notarization.p8"
    api_key.write_text(os.environ["APPLE_API_KEY_CONTENT"])
    api_key.chmod(0o600)
    run("security", "create-keychain", "-p", password, keychain)
    run("security", "set-keychain-settings", "-lut", "21600", keychain)
    run("security", "unlock-keychain", "-p", password, keychain)
    run("security", "import", str(certificate), "-P", os.environ["APPLE_CERTIFICATE_PASSWORD"], "-k", keychain, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security")
    run("security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-k", password, keychain)
    run("security", "list-keychains", "-d", "user", "-s", keychain, *previous)
    with open(os.environ["GITHUB_ENV"], "a") as environment:
        environment.write(f"APPLE_API_KEY={api_key}\n")
    certificate.unlink()
    print("Developer ID and notarization credentials prepared in the temporary CI keychain.")
