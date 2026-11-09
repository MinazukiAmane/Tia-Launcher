#!/usr/bin/env python3
import hashlib
import json
import os
import re
from pathlib import Path
import sys

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def repair_linux_bridge(client, bucket, root):
    """Route the broken 1.19.1 installer through its fixed bridge."""
    replacement = (root / "latest-linux.yml").read_bytes()
    if not replacement.startswith(b"version: 1.19.2\n") or len(replacement) > 32768:
        raise ValueError("Bridge repair requires the validated 1.19.2 Linux feed")
    urls = re.findall(rb"^  - url: (.+)$", replacement, re.MULTILINE)
    expected = {f"https://tia-launcher.serenetia.com/api/updates/Tia-Launcher-1.19.2-linux-{name}" for name in ("x86_64.AppImage", "amd64.deb", "x64.pacman")}
    if len(urls) != 3 or {json.loads(url) for url in urls} != expected:
        raise ValueError("Bridge repair requires all three validated Linux packages")
    live = client.get_object(Bucket=bucket, Key="latest-linux.yml")
    with live["Body"] as body:
        if body.read(32769) != replacement:
            raise ValueError("Publish the fixed root Linux feed before repairing the bridge")
    key = "bridge/1.19.1/latest-linux.yml"
    previous = client.get_object(Bucket=bucket, Key=key)
    with previous["Body"] as body:
        original = body.read(32769)
    if original == replacement:
        print("Linux 1.19.1 bridge already repaired", flush=True)
        return
    if len(original) > 32768 or not original.startswith(b"version: 2.0.0\n"):
        raise ValueError("The old bridge changed; review its replacement first")
    if not previous.get("ETag"):
        raise ValueError("The old bridge has no concurrency guard")
    client.put_object(Bucket=bucket, Key=key, Body=replacement, ContentLength=len(replacement),
                      ContentType="text/yaml", CacheControl="public, max-age=60",
                      Metadata={"sha256": hashlib.sha256(replacement).hexdigest()}, IfMatch=previous["ETag"])
    print("Repaired Linux 1.19.1 bridge: update through 1.19.2", flush=True)


def publish(directory, bucket, endpoint, region, linux_bridge_only=False, repair_broken_bridge=False):
    if repair_broken_bridge and not linux_bridge_only:
        raise ValueError("Bridge repair is limited to the Linux hotfix workflow")
    root = Path(directory).resolve(strict=True)
    manifest = json.loads((root / "native/latest.json").read_text())
    if not manifest.get("platforms") or not manifest.get("version", "").startswith("2."):
        raise ValueError("Missing validated native release manifest")
    client = boto3.client("s3", endpoint_url=endpoint, region_name=region, config=Config(
        signature_version="s3v4", request_checksum_calculation="when_required",
        response_checksum_validation="when_required", connect_timeout=10, read_timeout=120,
        retries={"max_attempts": 3, "mode": "standard"}))
    artifacts, bridge_feeds, feeds = [], [], []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Linked release artifacts are not allowed")
        if not path.is_file():
            continue
        key = path.relative_to(root).as_posix()
        if path.suffix in (".pem", ".key") or "secret" in key.lower():
            raise ValueError("Unexpected private release file")
        if linux_bridge_only:
            if key == "native/latest.json":
                continue
            allowed = key == "latest-linux.yml" or re.fullmatch(r"bridge/1\.\d+\.\d+/(latest-linux\.yml|SHA256SUMS)", key) or re.fullmatch(r"Tia-Launcher-1\.\d+\.\d+-linux-(x86_64\.AppImage|amd64\.deb|x64\.pacman)", key)
            if not allowed:
                raise ValueError("Linux bridge publication cannot change native, Windows or macOS releases")
        if key.startswith("bridge/") and path.suffix == ".yml":
            bridge_feeds.append((path, key))
        elif key == "native/latest.json" or "/" not in key and path.suffix == ".yml":
            feeds.append((path, key))
        else:
            artifacts.append((path, key))
    # Publish the native marker before retiring the legacy feed.
    feeds.sort(key=lambda item: item[1] != "native/latest.json")
    for path, key in artifacts + bridge_feeds + feeds:
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        mutable = (path, key) in feeds
        try:
            existing = client.head_object(Bucket=bucket, Key=key)
        except ClientError as error:
            if error.response["Error"]["Code"] not in ("404", "NoSuchKey", "NotFound"):
                raise
            existing = None
        if existing and not mutable:
            previous = existing.get("Metadata", {}).get("sha256")
            if previous is None:
                response = client.get_object(Bucket=bucket, Key=key)
                with response["Body"] as body:
                    hasher = hashlib.sha256()
                    for chunk in body.iter_chunks(1024 * 1024):
                        hasher.update(chunk)
                    previous = hasher.hexdigest()
            if previous != digest:
                raise ValueError(f"Refusing to overwrite an immutable release: {key}")
            print(f"Already uploaded: {key}", flush=True)
            continue
        content_type = "application/json" if key.endswith(".json") else "text/yaml" if key.endswith(".yml") else "application/octet-stream"
        args = dict(Bucket=bucket, Key=key, ContentLength=path.stat().st_size,
                    ContentType=content_type, Metadata={"sha256": digest},
                    CacheControl="public, max-age=60" if mutable else "public, max-age=31536000, immutable")
        if not mutable:
            args["IfNoneMatch"] = "*"
        with path.open("rb") as body:
            client.put_object(Body=body, **args)
        print(f"Published: {key}", flush=True)

    if repair_broken_bridge:
        repair_linux_bridge(client, bucket, root)


if __name__ == "__main__":
    publish(sys.argv[1], os.environ["TIA_S3_BUCKET"], os.environ["TIA_S3_ENDPOINT"], os.environ["AWS_DEFAULT_REGION"], linux_bridge_only="--linux-bridge-only" in sys.argv[2:], repair_broken_bridge="--repair-linux-1.19.1" in sys.argv[2:])
