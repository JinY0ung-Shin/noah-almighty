"""Die with the parent: ``arm()`` = prctl(PR_SET_PDEATHSIG, SIGKILL) through ctypes (Linux; a no-op elsewhere).

deck.mjs sets NOAH_PPTX_PARENT_PID for its Python children; when the parent already died between fork and prctl
(the child was reparented), arm() exits at once instead of running unattended.
"""
from __future__ import annotations

import os
import signal
import sys

PR_SET_PDEATHSIG = 1


def arm() -> None:
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(PR_SET_PDEATHSIG, int(signal.SIGKILL), 0, 0, 0)
    except Exception:  # noqa: BLE001 — best effort: the parent's own cleanup still kills its children
        return
    want = os.environ.get("NOAH_PPTX_PARENT_PID", "")
    if want.isdigit() and os.getppid() != int(want):
        os._exit(143)
