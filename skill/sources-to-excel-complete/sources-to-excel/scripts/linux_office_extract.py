"""Extract the hash-verified office distribution without modifying system packages."""
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
archive, target = Path(sys.argv[1]), Path(sys.argv[2])
target.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ally-office-') as stage:
    with tarfile.open(archive) as source:
        source.extractall(stage, filter='data')
    packages = sorted(Path(stage).glob('*/DEBS/*.deb'))
    if not packages:
        raise ValueError('The office distribution contains no DEB packages')
    for package in packages:
        subprocess.run(['dpkg-deb', '-x', str(package), str(target)], check=True, timeout=60)
