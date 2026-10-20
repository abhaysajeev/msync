"""Server clock. Monotonic milliseconds; clients only ever see it through offsets."""
import time


def now_ms() -> float:
    return time.monotonic() * 1000.0
