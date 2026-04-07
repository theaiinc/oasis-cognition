"""Cloudflare Tunnel manager for mobile companion pairing.

Uses cloudflared quick tunnels (no account needed) to expose the mobile relay
on a temporary public URL. Only one tunnel is active at a time.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import threading
from typing import Optional

logger = logging.getLogger(__name__)

TUNNEL_URL_PATTERN = re.compile(r"(https://[a-z0-9-]+\.trycloudflare\.com)")
STARTUP_TIMEOUT_SECONDS = 30


class TunnelManager:
    def __init__(self) -> None:
        self._process: Optional[subprocess.Popen] = None
        self._tunnel_url: Optional[str] = None
        self._lock = threading.Lock()

    @property
    def is_active(self) -> bool:
        with self._lock:
            return self._process is not None and self._process.poll() is None

    @property
    def url(self) -> Optional[str]:
        with self._lock:
            if self._process and self._process.poll() is None:
                return self._tunnel_url
            return None

    def start(self, local_port: int = 8015) -> str:
        """Start a cloudflared quick tunnel pointing at the given local port.

        Returns the public tunnel URL. Raises RuntimeError on failure.
        """
        cloudflared = shutil.which("cloudflared")
        # Fallback: check common Homebrew paths not in the venv's PATH
        if not cloudflared:
            for candidate in ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]:
                if shutil.os.path.isfile(candidate) and shutil.os.access(candidate, shutil.os.X_OK):
                    cloudflared = candidate
                    break
        if not cloudflared:
            raise RuntimeError(
                "cloudflared is not installed. "
                "Install it with: brew install cloudflared (macOS) "
                "or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            )

        with self._lock:
            # Kill any existing tunnel first
            self._kill_process()

            cmd = [cloudflared, "tunnel", "--url", f"http://localhost:{local_port}"]
            logger.info("Starting tunnel: %s", " ".join(cmd))

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self._process = proc

        # cloudflared prints the URL to stderr; read until we find it
        url = self._wait_for_url(proc)
        if not url:
            self.stop()
            raise RuntimeError(
                "Failed to parse tunnel URL from cloudflared output. "
                "Check that cloudflared is working correctly."
            )

        with self._lock:
            self._tunnel_url = url

        logger.info("Tunnel active: %s → localhost:%d", url, local_port)
        return url

    def stop(self) -> None:
        """Stop the active tunnel if any."""
        with self._lock:
            self._kill_process()
            self._tunnel_url = None

    def status(self) -> dict:
        """Return tunnel status."""
        return {
            "active": self.is_active,
            "url": self.url,
        }

    def _wait_for_url(self, proc: subprocess.Popen) -> Optional[str]:
        """Read stderr line by line until the tunnel URL appears or timeout."""
        import select
        import time

        deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS

        while time.monotonic() < deadline:
            if proc.poll() is not None:
                # Process exited before giving us a URL
                remaining = proc.stderr.read().decode("utf-8", errors="replace") if proc.stderr else ""
                logger.error("cloudflared exited early. stderr: %s", remaining)
                return None

            if proc.stderr is None:
                return None

            # Use select to avoid blocking indefinitely
            ready, _, _ = select.select([proc.stderr], [], [], 1.0)
            if not ready:
                continue

            line = proc.stderr.readline().decode("utf-8", errors="replace")
            if not line:
                continue

            logger.debug("cloudflared: %s", line.rstrip())
            match = TUNNEL_URL_PATTERN.search(line)
            if match:
                return match.group(1)

        logger.error("Timed out waiting for tunnel URL")
        return None

    def _kill_process(self) -> None:
        """Kill the tunnel process (must hold self._lock)."""
        if self._process and self._process.poll() is None:
            logger.info("Stopping existing tunnel (pid=%d)", self._process.pid)
            try:
                self._process.terminate()
                self._process.wait(timeout=5)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
            self._process = None
