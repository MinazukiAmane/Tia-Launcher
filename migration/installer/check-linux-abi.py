#!/usr/bin/env python3
import re
import subprocess
import sys


def check(path):
    result = subprocess.run(["readelf", "--version-info", path], check=True, capture_output=True, text=True)
    required = []
    for line in result.stdout.splitlines():
        match = re.search(r"Name: GLIBC_(\d+(?:\.\d+)+)\s+Flags:\s+(\S+)", line)
        if match and match[2] != "WEAK":
            required.append(tuple(map(int, match[1].split("."))))
    if not required or max(required) > (2, 34):
        raise ValueError(f"{path}: build with a toolchain compatible with the GLIBC 2.34 baseline")
    print(f"Linux ABI verified: {path} (GLIBC {'.'.join(map(str, max(required)))})", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Provide the Linux executables to verify")
    for executable in sys.argv[1:]:
        check(executable)
