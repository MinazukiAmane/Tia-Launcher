#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import sys

import boto3
from botocore.exceptions import ClientError


def publish(directory, bucket, endpoint, region):
    root = Path(directory).resolve(strict=True)
    manifest = json.loads((root / "native/latest.json").read_text())
    if not manifest.get("platforms") or not manifest.get("version", "").startswith("2."):
        raise ValueError("Missing validated native release manifest")
    client = boto3.client("s3", endpoint_url=endpoint, region_name=region)
    artifacts, bridge_feeds, feeds = [], [], []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Linked release artifacts are not allowed")
        if not path.is_file():
            continue
        key = path.relative_to(root).as_posix()
        if path.suffix in (".pem", ".key") or "secret" in key.lower():
            raise ValueError("Unexpected private release file")
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


if __name__ == "__main__":
    publish(sys.argv[1], os.environ["TIA_S3_BUCKET"], os.environ["TIA_S3_ENDPOINT"], os.environ["AWS_DEFAULT_REGION"])
