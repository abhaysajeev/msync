import os
import tempfile

# settings are read at import time, so set the environment before app modules load
_tmp = tempfile.mkdtemp(prefix="msync-test-")
os.environ.setdefault("DATA_DIR", _tmp)
os.environ.setdefault("DEV_ADMIN_PASSWORD", "test-password-123")
os.environ.setdefault("SECURE_COOKIES", "0")
os.environ.setdefault("SESSION_SECRET", "x" * 64)
