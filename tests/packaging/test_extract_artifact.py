from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile


class ExtractArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tia-artifact-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / 'input.zip'
        self.output = self.root / 'output'
        self.script = Path(__file__).parents[2] / 'migration/installer/extract-artifact.py'

    def extract(self):
        return subprocess.run([sys.executable, self.script, self.archive, self.output], capture_output=True, text=True)

    def test_keeps_payload_bytes_and_refuses_to_overwrite_them(self):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('Tia-Launcher-2.0.0-win-x64.exe', b'signed payload fixture')
        self.assertEqual(self.extract().returncode, 0)
        self.assertEqual((self.output / 'Tia-Launcher-2.0.0-win-x64.exe').read_bytes(), b'signed payload fixture')
        self.assertNotEqual(self.extract().returncode, 0)

    def test_rejects_parent_paths_and_linked_entries(self):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('../outside.exe', b'unsafe fixture')
        self.assertNotEqual(self.extract().returncode, 0)
        self.assertFalse((self.root / 'outside.exe').exists())
        with zipfile.ZipFile(self.archive, 'w') as archive:
            linked = zipfile.ZipInfo('linked.exe')
            linked.create_system = 3
            linked.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(linked, '../outside.exe')
        self.assertNotEqual(self.extract().returncode, 0)


if __name__ == '__main__':
    unittest.main()
