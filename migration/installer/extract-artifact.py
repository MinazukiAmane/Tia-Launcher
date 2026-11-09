import os
from pathlib import Path
import re
import shutil
import stat
import sys
import zipfile

directory = Path(sys.argv[2]).resolve()
directory.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if not entries or len(entries) > 128 or sum(item.file_size for item in entries) > 3 * 1024**3:
        raise ValueError('Invalid release artifact archive size')
    for entry in entries:
        if entry.is_dir():
            continue
        if not re.fullmatch(r'[A-Za-z0-9._-]+', entry.filename) or entry.filename in ('.', '..'):
            raise ValueError('Release archives must contain only flat artifact filenames')
        kind = stat.S_IFMT(entry.external_attr >> 16)
        if kind not in (0, stat.S_IFREG) or entry.file_size > 1024**3:
            raise ValueError('Linked, special, or oversized release artifact')
        target = directory / entry.filename
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as output, archive.open(entry) as source:
            shutil.copyfileobj(source, output, 1024 * 1024)
    print(f'Extracted {len(entries)} verified artifact entries.')
