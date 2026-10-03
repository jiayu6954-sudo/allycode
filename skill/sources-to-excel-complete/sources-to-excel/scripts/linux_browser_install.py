"""Install an isolated browser; existing user browsers are never overwritten."""
import os
import subprocess
import sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, PLAYWRIGHT_BROWSERS_PATH=str(root), PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT="120000")
subprocess.run([sys.executable, "-I", "-m", "playwright", "install", "chromium", "--no-shell"], env=env, check=True, timeout=850)
