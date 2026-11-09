import hashlib
import io
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
                   "botocore.config": types.SimpleNamespace(Config=lambda **kwargs: kwargs),
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
        self.assertLess(keys.index("native/latest.json"), keys.index("latest.yml"))
        for item in self.storage.uploaded:
            immutable = item["Key"].startswith(("native/2.0.0/", "bridge/"))
            self.assertEqual(item.get("IfNoneMatch"), "*" if immutable else None)
            self.assertIn("immutable" if immutable else "max-age=60", item["CacheControl"])

    def test_conflicting_immutable_payload_does_not_change_live_feeds(self):
        self.storage.existing["native/2.0.0/app.exe"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.publish()
        self.assertEqual(self.storage.uploaded, [])

    def test_linux_hotfix_never_rewrites_native_or_other_platforms(self):
        (self.root / "native/2.0.0/app.exe").unlink()
        (self.root / "bridge/1.19.0/latest.yml").unlink()
        (self.root / "latest.yml").unlink()
        self.write("latest-linux.yml", "version: 1.19.1")
        self.write("bridge/1.19.1/latest-linux.yml", "version: 2.0.0")
        self.write("Tia-Launcher-1.19.1-linux-x64.pacman", "signed bridge fixture")
        self.module.publish(self.root, "test-bucket", "https://example.com", "us-east-1", linux_bridge_only=True)
        keys = [item["Key"] for item in self.storage.uploaded]
        self.assertNotIn("native/latest.json", keys)
        self.assertEqual(keys[-1], "latest-linux.yml")
        self.assertLess(keys.index("Tia-Launcher-1.19.1-linux-x64.pacman"), keys.index("bridge/1.19.1/latest-linux.yml"))

    def test_linux_hotfix_rejects_a_native_payload_before_upload(self):
        with self.assertRaisesRegex(ValueError, "cannot change"):
            self.module.publish(self.root, "test-bucket", "https://example.com", "us-east-1", linux_bridge_only=True)
        self.assertEqual(self.storage.uploaded, [])

    def repair_feed(self):
        urls = [f"https://tia-launcher.serenetia.com/api/updates/Tia-Launcher-1.19.2-linux-{name}" for name in ("x86_64.AppImage", "amd64.deb", "x64.pacman")]
        return ("version: 1.19.2\nfiles:\n" + "".join("  - url: " + json.dumps(url) + "\n" for url in urls)).encode()

    def test_repair_only_replaces_the_known_broken_feed_after_root_is_live(self):
        replacement = self.repair_feed()
        self.write("latest-linux.yml", replacement.decode())
        with patch.object(self.storage, "get_object", create=True, side_effect=[
            {"Body": io.BytesIO(replacement)}, {"Body": io.BytesIO(b"version: 2.0.0\n"), "ETag": '"original"'}
        ]), patch.object(self.storage, "put_object") as put:
            self.module.repair_linux_bridge(self.storage, "bucket", self.root)
            self.assertEqual(put.call_args.kwargs["Key"], "bridge/1.19.1/latest-linux.yml")
            self.assertEqual(put.call_args.kwargs["Body"], replacement)
            self.assertEqual(put.call_args.kwargs["IfMatch"], '"original"')

    def test_repair_refuses_unpublished_or_changed_feeds(self):
        replacement = self.repair_feed()
        self.write("latest-linux.yml", replacement.decode())
        for root_feed, previous in [(b"version: 1.19.1\n", b"version: 2.0.0\n"), (replacement, b"version: 2.0.1\n")]:
            with patch.object(self.storage, "get_object", create=True, side_effect=[
                {"Body": io.BytesIO(root_feed)}, {"Body": io.BytesIO(previous), "ETag": '"original"'}
            ]), patch.object(self.storage, "put_object") as put:
                with self.assertRaises(ValueError):
                    self.module.repair_linux_bridge(self.storage, "bucket", self.root)
                put.assert_not_called()

    def test_repair_rejects_arbitrary_target_and_missing_formats(self):
        for feed in (self.repair_feed().replace(b"1.19.2", b"1.19.3"), b"version: 1.19.2\nfiles:\n"):
            self.write("latest-linux.yml", feed.decode())
            with self.assertRaises(ValueError):
                self.module.repair_linux_bridge(self.storage, "bucket", self.root)
        self.assertEqual(self.storage.uploaded, [])

    def test_private_key_rejected_before_upload(self):
        self.write("signing.key", "private fixture")
        with self.assertRaisesRegex(ValueError, "private"):
            self.publish()
        self.assertEqual(self.storage.uploaded, [])


if __name__ == "__main__":
    unittest.main()
