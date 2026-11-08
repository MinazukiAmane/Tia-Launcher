import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class ClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


class Storage:
    def __init__(self):
        self.uploaded = []
        self.existing = {}

    def head_object(self, **args):
        if args["Key"] not in self.existing:
            raise ClientError("404")
        return {"Metadata": {"sha256": self.existing[args["Key"]]}}

    def put_object(self, **args):
        body = args["Body"].read()
        assert hashlib.sha256(body).hexdigest() == args["Metadata"]["sha256"]
        self.uploaded.append(args)


class PublishReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tia-publish-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.storage = Storage()
        modules = {"boto3": types.SimpleNamespace(client=lambda *args, **kwargs: self.storage),
                   "botocore.exceptions": types.SimpleNamespace(ClientError=ClientError)}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location("publish_release", Path(__file__).parents[2] / "migration/installer/publish-release.py")
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)
        self.write("native/latest.json", json.dumps({"version": "2.0.0", "platforms": {"windows-x86_64": {}}}))
        self.write("native/2.0.0/app.exe", "new native")
        self.write("bridge/1.19.0/latest.yml", "version: 2.0.0")
        self.write("latest.yml", "version: 1.19.0")

    def write(self, name, body):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)

    def publish(self):
        self.module.publish(self.root, "test-bucket", "https://example.com", "us-east-1")

    def test_payloads_precede_bridge_and_live_metadata(self):
        self.publish()
        keys = [item["Key"] for item in self.storage.uploaded]
        self.assertLess(keys.index("native/2.0.0/app.exe"), keys.index("bridge/1.19.0/latest.yml"))
        self.assertLess(keys.index("bridge/1.19.0/latest.yml"), keys.index("latest.yml"))
        for item in self.storage.uploaded:
            immutable = item["Key"].startswith(("native/2.0.0/", "bridge/"))
            self.assertEqual(item.get("IfNoneMatch"), "*" if immutable else None)
            self.assertIn("immutable" if immutable else "max-age=60", item["CacheControl"])

    def test_conflicting_immutable_payload_does_not_change_live_feeds(self):
        self.storage.existing["native/2.0.0/app.exe"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.publish()
        self.assertEqual(self.storage.uploaded, [])

    def test_private_key_rejected_before_upload(self):
        self.write("signing.key", "private fixture")
        with self.assertRaisesRegex(ValueError, "private"):
            self.publish()
        self.assertEqual(self.storage.uploaded, [])


if __name__ == "__main__":
    unittest.main()
