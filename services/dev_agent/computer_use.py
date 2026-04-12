"""
Computer Use — host-level mouse/keyboard/screen control.

Runs on the HOST (not Docker) so it can interact with the real desktop.
All actions are gated by the API gateway's policy guard before reaching here.

On macOS, all screen capture and mouse/keyboard actions are routed through
dedicated .app bundles (OasisScreenCapture.app, OasisComputerControl.app)
so that macOS TCC permissions show "Oasis Screen Capture" and
"Oasis Computer Control" — not Python or Terminal.

pyautogui is NEVER imported in this process to avoid TCC prompts for Python.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import time
from typing import Any

from services.dev_agent.chrome_bridge import chrome_bridge

logger = logging.getLogger(__name__)


# ── Path to OasisScreenCapture.app binary ─────────────────────────────────

import os as _os
import sys as _sys

_THIS_DIR = _os.path.dirname(_os.path.abspath(__file__))
_CAPTURE_APP = _os.path.join(_THIS_DIR, "OasisScreenCapture.app")
_CAPTURE_BIN = _os.path.join(_CAPTURE_APP, "Contents", "MacOS", "capture")
_CONTROL_APP = _os.path.join(_THIS_DIR, "OasisComputerControl.app")
_CONTROL_BIN = _os.path.join(_CONTROL_APP, "Contents", "MacOS", "control")


def _run_app_bundle(app_path: str, args: list[str], timeout: int = 15) -> str:
    """Launch a .app bundle via `open -W -a` so macOS attributes TCC permissions
    to the app bundle (not Terminal/Python).  Output goes to a temp file since
    `open` doesn't capture stdout.
    """
    import subprocess, tempfile
    with tempfile.NamedTemporaryFile(mode='r', suffix='.json', delete=False) as tmp:
        tmp_path = tmp.name
    try:
        cmd = ["open", "-W", "-a", app_path, "--args"] + args + ["--output", tmp_path]
        subprocess.run(cmd, capture_output=True, timeout=timeout)
        with open(tmp_path, 'r') as f:
            return f.read()
    except Exception as e:
        logger.warning("_run_app_bundle(%s) error: %s", _os.path.basename(app_path), e)
        return ""
    finally:
        try:
            _os.unlink(tmp_path)
        except OSError:
            pass


def _run_control(action: str, **kwargs) -> dict[str, Any]:
    """Run a mouse/keyboard action via OasisComputerControl.app.

    Launched via `open -a` so macOS Accessibility permission shows
    "Oasis Computer Control" instead of Terminal/IDE.
    """
    args = [action, "--json"]
    for k, v in kwargs.items():
        if v is not None:
            args += [f"--{k}", str(v)]
    raw = _run_app_bundle(_CONTROL_APP, args, timeout=15)
    if raw:
        try:
            import json as _j
            return _j.loads(raw)
        except Exception:
            pass
    return {"success": False, "output": "OasisComputerControl.app returned no output"}


# ── Screenshot helper ──────────────────────────────────────────────────────

def _hide_overlay() -> None:
    """Hide the CU overlay before screenshots so it doesn't pollute OCR/vision/cache."""
    try:
        import subprocess
        subprocess.run(["osascript", "-e",
            'tell application "System Events" to tell process "Electron" to '
            'set visible to false'],
            capture_output=True, timeout=1)
    except Exception:
        pass


def _show_overlay() -> None:
    """Show the CU overlay after screenshots."""
    try:
        import subprocess
        subprocess.run(["osascript", "-e",
            'tell application "System Events" to tell process "Electron" to '
            'set visible to true'],
            capture_output=True, timeout=1)
    except Exception:
        pass


def _take_screenshot(region: tuple[int, int, int, int] | None = None, max_width: int = 1024) -> str:
    """Capture screen (or region) and return as base64 JPEG string.

    Hides the CU overlay before capture and shows it after, so screenshots
    are clean for OCR, vision LLM, and caching.
    """
    if _os.path.isfile(_CAPTURE_BIN):
        _hide_overlay()
        args = ["--max-width", str(max_width)]
        if region:
            args += ["--region", f"{region[0]},{region[1]},{region[2]},{region[3]}"]
        raw = _run_app_bundle(_CAPTURE_APP, args, timeout=10)
        _show_overlay()
        if raw:
            return raw.strip()

    logger.debug("OasisScreenCapture.app not available — screenshot unavailable")
    return ""


def _take_screenshot_thumbnail(region: tuple[int, int, int, int] | None = None, max_width: int = 320) -> str:
    """Capture a small thumbnail screenshot for the picker UI."""
    if _os.path.isfile(_CAPTURE_BIN):
        args = ["--thumbnail", "--max-width", str(max_width)]
        if region:
            args += ["--region", f"{region[0]},{region[1]},{region[2]},{region[3]}"]
        raw = _run_app_bundle(_CAPTURE_APP, args, timeout=10)
        if raw:
            return raw.strip()

    return ""


async def _take_window_thumbnail(app_name: str, max_width: int = 480) -> str:
    """Capture a specific window's thumbnail by getting its bounds via AppleScript
    (runs in the dev-agent process which has Automation permission) then doing
    a Quartz region capture via OasisScreenCapture.app.

    No window focusing needed — captures whatever is visible at that region.
    """
    # Get window bounds from the dev-agent process (has System Events access)
    bounds = await _get_window_bounds(app_name)
    if bounds.get("bounds"):
        b = bounds["bounds"]
        return _take_screenshot_thumbnail(
            region=(b["x"], b["y"], b["width"], b["height"]),
            max_width=max_width,
        )
    return ""


# ── Multi-display helpers ─────────────────────────────────────────────────

async def _list_screens() -> dict[str, Any]:
    """Detect all connected displays and return their info + thumbnails.

    Uses system_profiler + AppleScript for display info (no AppKit/pyautogui
    import in this process — those would trigger TCC prompts for Python).
    """
    import asyncio, subprocess

    if platform.system() != "Darwin":
        thumb = _take_screenshot_thumbnail()
        return {"success": True, "screens": [{"index": 0, "name": "Screen", "width": 1920, "height": 1080, "x": 0, "y": 0, "thumbnail": thumb}]}

    # macOS: use system_profiler for display info
    try:
        proc = await asyncio.create_subprocess_exec(
            "system_profiler", "SPDisplaysDataType", "-json",
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        import json as _json
        data = _json.loads(stdout.decode())
        screens = []
        idx = 0
        for gpu in data.get("SPDisplaysDataType", []):
            for display in gpu.get("spdisplays_ndrvs", []):
                res = display.get("_spdisplays_resolution", "")
                parts = res.replace(" ", "").split("x") if "x" in res.lower() else []
                w = int(parts[0]) if len(parts) >= 2 else 1920
                h = int(parts[1].split("@")[0]) if len(parts) >= 2 else 1080
                name = display.get("_name", f"Display {idx + 1}")
                screens.append({
                    "index": idx, "name": name,
                    "width": w, "height": h, "x": 0, "y": 0, "thumbnail": "",
                })
                idx += 1

        if not screens:
            screens = [{"index": 0, "name": "Screen", "width": 1920, "height": 1080, "x": 0, "y": 0, "thumbnail": ""}]

        # Get screen positions via AppleScript (no AppKit import in this process)
        try:
            script = '''
            set output to ""
            tell application "Finder"
                set displayBounds to bounds of window of desktop
            end tell
            -- Use a Python one-liner via the capture app to get NSScreen info
            '''
            # Use the capture app's python3 to query NSScreen (runs in the app's TCC context)
            ns_script = '''
import json
try:
    from AppKit import NSScreen
    import Quartz
    ns_screens = NSScreen.screens()
    # Get CG display bounds for accurate coordinates (CG uses top-left origin, y-down)
    # NSScreen uses bottom-left origin, y-up — these DON'T match for CGWindowListCreateImage
    err, display_ids, count = Quartz.CGGetActiveDisplayList(10, None, None)
    cg_bounds = {}
    if display_ids:
        for did in display_ids:
            b = Quartz.CGDisplayBounds(did)
            cg_bounds[did] = {"x": int(b.origin.x), "y": int(b.origin.y), "w": int(b.size.width), "h": int(b.size.height)}
    screens = []
    for i, ns in enumerate(ns_screens):
        f = ns.frame()
        ns_x, ns_y = int(f.origin.x), int(f.origin.y)
        ns_w, ns_h = int(f.size.width), int(f.size.height)
        # Try to match with CG display by size and x position
        cg_match = None
        for did, cb in cg_bounds.items():
            if cb["w"] == ns_w and cb["h"] == ns_h and cb["x"] == ns_x:
                cg_match = cb
                break
        if cg_match:
            # Use CG coordinates (correct for CGWindowListCreateImage)
            screens.append({"x": cg_match["x"], "y": cg_match["y"], "w": cg_match["w"], "h": cg_match["h"], "name": ns.localizedName() if hasattr(ns, 'localizedName') else ""})
        else:
            # Fallback: convert NSScreen to CG coords manually
            main_h = int(ns_screens[0].frame().size.height)
            cg_y = main_h - ns_y - ns_h
            screens.append({"x": ns_x, "y": cg_y, "w": ns_w, "h": ns_h, "name": ns.localizedName() if hasattr(ns, 'localizedName') else ""})
    print(json.dumps(screens))
except:
    print("[]")
'''
            capture_python = _os.path.join(_CAPTURE_APP, "Contents", "MacOS", "python3")
            if _os.path.isfile(capture_python):
                ns_proc = await asyncio.create_subprocess_exec(
                    capture_python, "-c", ns_script,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                ns_stdout, _ = await asyncio.wait_for(ns_proc.communicate(), timeout=5)
                ns_data = _json.loads(ns_stdout.decode())
                for i, ns in enumerate(ns_data):
                    if i < len(screens):
                        screens[i]["x"] = ns["x"]
                        screens[i]["y"] = ns["y"]
                        screens[i]["width"] = ns["w"]
                        screens[i]["height"] = ns["h"]
                        if ns.get("name"):
                            screens[i]["name"] = ns["name"]
                    else:
                        screens.append({
                            "index": i, "name": ns.get("name", f"Display {i + 1}"),
                            "width": ns["w"], "height": ns["h"],
                            "x": ns["x"], "y": ns["y"], "thumbnail": "",
                        })
        except Exception as e:
            logger.debug("NSScreen query failed: %s", e)

        # Take per-screen thumbnails using OasisScreenCapture.app
        for s in screens:
            try:
                if len(screens) > 1:
                    s["thumbnail"] = _take_screenshot_thumbnail(
                        region=(s["x"], s["y"], s["width"], s["height"])
                    )
                else:
                    s["thumbnail"] = _take_screenshot_thumbnail()
            except Exception:
                s["thumbnail"] = ""

        return {"success": True, "screens": screens}
    except Exception as e:
        logger.warning("list_screens failed: %s", e)
        thumb = _take_screenshot_thumbnail()
        return {"success": True, "screens": [{"index": 0, "name": "Screen", "width": 1920, "height": 1080, "x": 0, "y": 0, "thumbnail": thumb}]}


# ── Window management helpers ──────────────────────────────────────────────

def _extract_app_name(label: str) -> str:
    """Extract the macOS app/process name from a window label.

    Browser window labels are typically "Page Title - Google Chrome" or
    "Page Title — Mozilla Firefox" where the APP NAME is the LAST segment.
    The caller may also pass just "Google Chrome" directly.
    """
    for sep in [" - ", " — ", " – "]:
        parts = label.split(sep)
        if len(parts) > 1:
            return parts[-1].strip()
    return label.strip()


async def _focus_window(app_or_title: str) -> dict[str, Any]:
    """Activate/focus a window by app name or window title. macOS uses AppleScript, Linux uses wmctrl."""
    import subprocess

    if platform.system() == "Darwin":
        # The input may be an app name ("Google Chrome") or a full label ("Page - Google Chrome")
        app_name = _extract_app_name(app_or_title)
        logger.info("focus_window: input=%r → app_name=%r", app_or_title, app_name)

        # Activate the app AND ensure its window is visible, un-minimized,
        # and raised to front (not just the app activation which may leave
        # the window hidden behind other windows).
        script = f'''
tell application "{app_name}" to activate
delay 0.2
tell application "System Events"
    tell process "{app_name}"
        set frontmost to true
        try
            -- Un-minimize the first window if minimized
            set miniaturized of window 1 to false
        end try
        try
            -- Raise window 1 to front
            perform action "AXRaise" of window 1
        end try
    end tell
end tell
'''
        try:
            subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)
            time.sleep(0.5)
            return {"success": True, "output": f"Focused: {app_name}", "screenshot": ""}
        except Exception as e:
            logger.warning("AppleScript activate failed for '%s': %s", app_name, e)

        # Fallback: if the extracted name didn't work, try the raw input
        if app_name != app_or_title:
            try:
                script_raw = f'tell application "{app_or_title}" to activate'
                subprocess.run(["osascript", "-e", script_raw], capture_output=True, timeout=5)
                time.sleep(0.5)
                return {"success": True, "output": f"Focused: {app_or_title}", "screenshot": ""}
            except Exception:
                pass

        # Fallback: try System Events to find window by title keyword
        # Escape quotes in the search string
        safe_title = app_or_title.replace('"', '\\"')
        script2 = f'''
        tell application "System Events"
            set allProcs to every process whose visible is true
            repeat with proc in allProcs
                try
                    set wins to every window of proc
                    repeat with w in wins
                        if name of w contains "{safe_title}" then
                            set frontmost of proc to true
                            return "Focused: " & name of proc
                        end if
                    end repeat
                end try
            end repeat
        end tell
        return "Not found"
        '''
        try:
            r = subprocess.run(["osascript", "-e", script2], capture_output=True, text=True, timeout=5)
            output = r.stdout.strip()
            if "Not found" in output:
                return {"success": False, "output": f"Window not found: {app_or_title}", "screenshot": ""}
            time.sleep(0.3)
            return {"success": True, "output": output, "screenshot": ""}
        except Exception as e:
            return {"success": False, "output": f"Focus failed: {e}", "screenshot": ""}

    elif platform.system() == "Linux":
        try:
            subprocess.run(["wmctrl", "-a", app_or_title], capture_output=True, timeout=5)
            time.sleep(0.3)
            return {"success": True, "output": f"Focused: {app_or_title}", "screenshot": ""}
        except Exception as e:
            return {"success": False, "output": f"wmctrl failed: {e}", "screenshot": ""}

    return {"success": False, "output": f"Focus not supported on {platform.system()}", "screenshot": ""}


async def _get_window_bounds(app_name: str) -> dict[str, Any]:
    """Get the position and size of a window. Returns {x, y, width, height} in ABSOLUTE screen pixels.

    On multi-monitor setups, x/y reflect the actual screen position (e.g. x=1920 for a
    window on the second monitor). This is critical for correct coordinate targeting.
    """
    import subprocess

    if platform.system() == "Darwin":
        clean_name = _extract_app_name(app_name)
        logger.info("get_window_bounds: input=%r → process=%r", app_name, clean_name)
        script = f'''
        tell application "System Events"
            tell process "{clean_name}"
                set w to front window
                set pos to position of w
                set sz to size of w
                return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)
            end tell
        end tell
        '''
        try:
            r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)
            parts = r.stdout.strip().split(",")
            if len(parts) == 4:
                x, y, w, h = [int(p.strip()) for p in parts]
                logger.info("Window bounds for %r: x=%d y=%d w=%d h=%d", clean_name, x, y, w, h)
                return {
                    "success": True,
                    "output": f"Window bounds: x={x} y={y} w={w} h={h}",
                    "screenshot": "",
                    "bounds": {"x": x, "y": y, "width": w, "height": h},
                }
        except Exception as e:
            logger.warning("get_window_bounds failed for '%s': %s", clean_name, e)

        # Fallback: try with the raw input name
        if clean_name != app_name:
            try:
                script2 = f'''
                tell application "System Events"
                    tell process "{app_name}"
                        set w to front window
                        set pos to position of w
                        set sz to size of w
                        return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)
                    end tell
                end tell
                '''
                r2 = subprocess.run(["osascript", "-e", script2], capture_output=True, text=True, timeout=10)
                parts2 = r2.stdout.strip().split(",")
                if len(parts2) == 4:
                    x, y, w, h = [int(p.strip()) for p in parts2]
                    logger.info("Window bounds (raw name) for %r: x=%d y=%d w=%d h=%d", app_name, x, y, w, h)
                    return {
                        "success": True,
                        "output": f"Window bounds: x={x} y={y} w={w} h={h}",
                        "screenshot": "",
                        "bounds": {"x": x, "y": y, "width": w, "height": h},
                    }
            except Exception as e:
                logger.warning("get_window_bounds fallback failed for '%s': %s", app_name, e)

    return {"success": False, "output": f"Could not get bounds for {app_name}", "screenshot": ""}


async def _list_windows() -> dict[str, Any]:
    """List visible apps/windows on the desktop (macOS via AppleScript, Linux via wmctrl).

    Returns a flat list of visible apps. Getting per-window bounds is too slow
    for an interactive UI — use get_window_bounds for a specific app instead.
    """
    import asyncio, subprocess

    if platform.system() == "Darwin":
        # Fast: just get visible app names (< 1s)
        script = 'tell application "System Events" to get name of every process whose visible is true'
        try:
            proc = await asyncio.create_subprocess_exec(
                "osascript", "-e", script,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            raw = stdout.decode("utf-8", errors="replace").strip()
            # Output is comma-separated: "Finder, Google Chrome, Cursor, ..."
            app_names = [n.strip() for n in raw.split(",") if n.strip()]
            windows = [{"app": name, "title": name, "icon": _get_app_icon(name)} for name in app_names]
            return {"success": True, "windows": windows, "output": ""}
        except Exception as e:
            logger.warning("list_windows failed: %s", e)
            return {"success": False, "windows": [], "output": str(e)}

    elif platform.system() == "Linux":
        try:
            proc = await asyncio.create_subprocess_exec(
                "wmctrl", "-l",
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            lines = stdout.decode("utf-8", errors="replace").strip().split("\n")
            windows = []
            for line in lines:
                parts = line.split(None, 3)
                if len(parts) >= 4:
                    windows.append({"app": parts[3], "title": parts[3]})
            return {"success": True, "windows": windows, "output": ""}
        except Exception as e:
            return {"success": False, "windows": [], "output": str(e)}

    return {"success": False, "windows": [], "output": f"Unsupported platform: {platform.system()}"}


# ── Action executors ───────────────────────────────────────────────────────

def _find_app_path(app_name: str) -> str | None:
    """Find the .app bundle path for a given app name."""
    import subprocess

    # Check common locations first
    for base in ["/Applications", "/System/Library/CoreServices"]:
        candidate = _os.path.join(base, f"{app_name}.app")
        if _os.path.isdir(candidate):
            return candidate

    # Fallback: Spotlight search
    try:
        r = subprocess.run(
            ["mdfind", f"kind:app {app_name}"],
            capture_output=True, text=True, timeout=5,
        )
        for line in r.stdout.strip().splitlines():
            if line.endswith(".app"):
                return line
    except Exception:
        pass

    return None


def _get_app_icon(app_name: str) -> str:
    """Get an app's icon as a base64 JPEG string. Returns empty string on any error."""
    import subprocess, tempfile, base64, json as _json

    try:
        app_path = _find_app_path(app_name)
        if not app_path:
            return ""

        info_plist = _os.path.join(app_path, "Contents", "Info.plist")
        if not _os.path.isfile(info_plist):
            return ""

        # Read CFBundleIconFile from Info.plist
        r = subprocess.run(
            ["defaults", "read", info_plist, "CFBundleIconFile"],
            capture_output=True, text=True, timeout=5,
        )
        icon_name = r.stdout.strip()
        if not icon_name:
            return ""

        # Add .icns extension if needed
        if not icon_name.endswith(".icns"):
            icon_name += ".icns"

        icns_path = _os.path.join(app_path, "Contents", "Resources", icon_name)
        if not _os.path.isfile(icns_path):
            return ""

        with tempfile.TemporaryDirectory() as tmpdir:
            iconset_path = _os.path.join(tmpdir, "icon.iconset")

            # Convert .icns to iconset
            r = subprocess.run(
                ["iconutil", "-c", "iconset", icns_path, "-o", iconset_path],
                capture_output=True, timeout=5,
            )
            if r.returncode != 0 or not _os.path.isdir(iconset_path):
                return ""

            # Pick the best PNG: prefer 128x128, then @2x, then any available
            png_path = None
            candidates = ["icon_128x128.png", "icon_128x128@2x.png"]
            for name in candidates:
                p = _os.path.join(iconset_path, name)
                if _os.path.isfile(p):
                    png_path = p
                    break

            if not png_path:
                # Pick any available PNG
                for f in sorted(_os.listdir(iconset_path)):
                    if f.endswith(".png"):
                        png_path = _os.path.join(iconset_path, f)
                        break

            if not png_path:
                return ""

            # Convert to JPEG via sips
            jpeg_path = _os.path.join(tmpdir, "icon.jpg")
            r = subprocess.run(
                ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85",
                 png_path, "--out", jpeg_path],
                capture_output=True, timeout=5,
            )
            if r.returncode != 0 or not _os.path.isfile(jpeg_path):
                return ""

            with open(jpeg_path, "rb") as f:
                return base64.b64encode(f.read()).decode("ascii")

    except Exception:
        return ""


def _get_screen_size() -> dict[str, int]:
    """Get screen size via OasisComputerControl.app (never imports pyautogui here)."""
    if _os.path.isfile(_CONTROL_BIN):
        ctrl = _run_control("get_screen_size")
        output = ctrl.get("output", "")
        if "x" in output:
            parts = output.split("x")
            try:
                return {"width": int(parts[0]), "height": int(parts[1])}
            except (ValueError, IndexError):
                pass
    return {"width": 1920, "height": 1080}


async def execute_computer_action(
    action: str,
    x: int | None = None,
    y: int | None = None,
    text: str | None = None,
    key: str | None = None,
    keys: list[str] | None = None,
    clicks: int = 1,
    button: str = "left",
    direction: str = "down",
    amount: int = 3,
    duration: float = 0.5,
    **kwargs,
) -> dict[str, Any]:
    """
    Execute a computer-use action on the host.

    Supported actions:
      - screenshot         : capture the screen
      - mouse_move         : move mouse to (x, y)
      - click              : click at (x, y) with given button
      - double_click       : double-click at (x, y)
      - right_click        : right-click at (x, y)
      - type_text          : type the given text string
      - key_press          : press a single key (e.g. 'enter', 'tab', 'escape')
      - hotkey             : press key combination (e.g. ['command', 'c'])
      - scroll             : scroll up/down at (x, y)
      - drag               : drag from current position to (x, y)
      - get_screen_size    : return screen dimensions
      - locate_on_screen   : find text/image on screen (returns coordinates)
    """
    action = action.lower().strip()
    logger.info("Computer action: %s (x=%s, y=%s, text=%s, key=%s)", action, x, y, text, key)

    # Actions that don't require pyautogui — handle before loading it
    if action == "focus_window":
        if not text:
            return {"success": False, "output": "focus_window requires text (app/window name)", "screenshot": ""}
        return await _focus_window(text)

    if action == "open_application":
        if not text:
            return {"success": False, "output": "open_application requires text (app name)", "screenshot": ""}
        # Optional: x = target screen index (0-based). If not provided, uses primary screen.
        target_screen_idx = x if x is not None else None
        try:
            proc = await asyncio.create_subprocess_exec(
                "open", "-a", text,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode != 0:
                return {"success": False, "output": f"Failed to open {text}: {stderr.decode().strip()}", "screenshot": ""}

            # Wait for the app to finish launching
            await asyncio.sleep(1.0)

            # Get screen info
            screens_info = await _list_screens()
            screens = screens_info.get("screens", [])
            if not screens:
                screens = [{"x": 0, "y": 0, "width": 1920, "height": 1080}]

            # Determine target screen
            if target_screen_idx is not None and 0 <= target_screen_idx < len(screens):
                target_scr = screens[target_screen_idx]
            else:
                # Default: use primary screen (index 0)
                target_scr = screens[0]

            # Move window to target screen and maximize to fill it (100vw x 100vh)
            safe_app = text.replace('"', '\\"')
            menu_bar_h = 25
            sx, sy = target_scr["x"], target_scr["y"]
            sw, sh = target_scr["width"], target_scr["height"]
            scr_name = target_scr.get("name", f"Screen {target_screen_idx or 0}")

            maximize_script = f'''
tell application "{safe_app}" to activate
delay 1.0
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.3
        -- Retry loop: Electron apps may take a moment to create windows
        set maxRetries to 5
        set moved to false
        repeat maxRetries times
            try
                set win to window 1
                -- Un-minimize if needed
                try
                    set miniaturized of win to false
                end try
                -- Move to target screen and maximize
                set position of win to {{{sx}, {sy + menu_bar_h}}}
                delay 0.2
                set size of win to {{{sw}, {sh - menu_bar_h}}}
                -- Raise window to front
                try
                    perform action "AXRaise" of win
                end try
                set moved to true
                exit repeat
            on error
                delay 0.5
            end try
        end repeat
    end tell
end tell
'''
            try:
                mx_proc = await asyncio.create_subprocess_exec(
                    "osascript", "-e", maximize_script,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                mx_stdout, mx_stderr = await asyncio.wait_for(mx_proc.communicate(), timeout=6)
                if mx_proc.returncode == 0:
                    logger.info("open_application: %r moved to %s and maximized (%d,%d %dx%d)",
                                text, scr_name, sx, sy + menu_bar_h, sw, sh - menu_bar_h)
                else:
                    logger.debug("open_application: maximize script error: %s", mx_stderr.decode()[:200])
            except Exception as e:
                logger.debug("open_application: maximize failed for %r: %s", text, e)

            return {"success": True, "output": f"Opened {text} — maximized on {scr_name}", "screenshot": ""}
        except Exception as e:
            return {"success": False, "output": f"Failed to open {text}: {e}", "screenshot": ""}

    if action == "move_window_to_screen":
        if not text or x is None or y is None:
            return {"success": False, "output": "move_window_to_screen requires text (app name), x, y (screen origin)", "screenshot": ""}
        try:
            # Use AppleScript to move and resize the app's front window to the target screen
            script = f'''
            tell application "{text}"
                activate
            end tell
            delay 0.3
            tell application "System Events"
                tell process "{text}"
                    set frontWindow to front window
                    set position of frontWindow to {{{x}, {y}}}
                end tell
            end tell
            '''
            proc = await asyncio.create_subprocess_exec(
                "osascript", "-e", script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            logger.info("move_window_to_screen: moved %r to (%d, %d)", text, x, y)
            return {"success": True, "output": f"Moved {text} to ({x}, {y})", "screenshot": ""}
        except Exception as e:
            return {"success": False, "output": f"Failed to move {text}: {e}", "screenshot": ""}

    if action == "ocr_screenshot":
        # Use macOS Vision framework for native OCR on a screenshot.
        # No API calls, no vendor lock-in, runs entirely locally.
        # Pass screen_region to OCR a specific monitor, or omit for full screen.
        # Takes a HIGH-RESOLUTION screenshot (not the default 1024px thumbnail)
        # because OCR needs sharp text to work accurately.
        screen_region = kwargs.get("screen_region")
        region_args = []
        if screen_region:
            region_args = ["--region", f"{screen_region['x']},{screen_region['y']},{screen_region['width']},{screen_region['height']}"]
        # Full resolution for OCR (max-width 1920 instead of 1024)
        if _os.path.isfile(_CAPTURE_BIN):
            screenshot_b64 = _run_app_bundle(
                _CAPTURE_APP,
                ["--max-width", "1920"] + region_args,
                timeout=10,
            )
            if screenshot_b64:
                screenshot_b64 = screenshot_b64.strip()
        else:
            screenshot_b64 = ""
        if not screenshot_b64:
            return {"success": False, "output": "Failed to capture screenshot for OCR", "screenshot": ""}

        try:
            import base64 as _b64
            # Use the main venv python which has pyobjc-framework-Vision installed
            venv_python = _os.path.join(_os.path.dirname(_os.path.dirname(_THIS_DIR)), ".venv", "bin", "python")
            if not _os.path.isfile(venv_python):
                venv_python = _sys.executable  # fallback to current interpreter
            ocr_script = '''
import sys, base64, json
img_data = base64.b64decode(sys.stdin.read())
try:
    import Vision, Quartz
    from Foundation import NSData
    ns_data = NSData.dataWithBytes_length_(img_data, len(img_data))
    ci_image = Quartz.CIImage.imageWithData_(ns_data)
    context = Quartz.CIContext.contextWithOptions_(None)
    cg_image = context.createCGImage_fromRect_(ci_image, ci_image.extent())
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(1)  # VNRequestTextRecognitionLevelAccurate
    request.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, None)
    success, error = handler.performRequests_error_([request], None)
    if success:
        texts = []
        for obs in request.results():
            candidate = obs.topCandidates_(1)[0]
            texts.append(candidate.string())
        print(json.dumps({"success": True, "texts": texts}))
    else:
        print(json.dumps({"success": False, "error": str(error)}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
'''
            import subprocess
            proc = await asyncio.create_subprocess_exec(
                venv_python, "-c", ocr_script,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            import json as _json
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=screenshot_b64.encode()),
                timeout=30,
            )
            if proc.returncode == 0 and stdout:
                result = _json.loads(stdout.decode())
                if result.get("success"):
                    ocr_text = "\n".join(result["texts"])
                    logger.info("ocr_screenshot: extracted %d text blocks (%d chars)", len(result["texts"]), len(ocr_text))
                    return {"success": True, "output": ocr_text[:8000], "screenshot": screenshot_b64}
                else:
                    logger.warning("ocr_screenshot failed: %s", result.get("error"))
                    return {"success": False, "output": f"OCR failed: {result.get('error')}", "screenshot": screenshot_b64}
            else:
                err = stderr.decode().strip() if stderr else "unknown error"
                logger.warning("ocr_screenshot process failed: %s", err)
                return {"success": False, "output": f"OCR process error: {err}", "screenshot": screenshot_b64}
        except Exception as e:
            logger.warning("ocr_screenshot error: %s", e)
            return {"success": False, "output": f"OCR error: {e}", "screenshot": screenshot_b64}

    if action == "get_page_text":
        # ── Try Chrome Bridge extension first (fast, reliable, no AppleScript perm needed) ──
        if chrome_bridge.connected:
            try:
                resp = await chrome_bridge.send_command("get_page_text", {"url_hint": text or ""}, timeout=10)
                if resp.get("success"):
                    p = resp.get("payload", {})
                    tabs_str = p.get("tabs", "")
                    meta = p.get("meta", {})
                    page_text = p.get("text", "")
                    # Inject discovered meta values into page text for discovery extraction
                    meta_lines = []
                    if meta.get("user-login"):
                        meta_lines.append(f"Signed in as {meta['user-login']}")
                    if meta.get("data-login"):
                        meta_lines.append(f"Signed in as {meta['data-login']}")
                    meta_prefix = "\n".join(meta_lines) + "\n" if meta_lines else ""
                    # Build interactive elements section for the LLM
                    interactive = p.get("interactive", [])
                    interactive_lines = ""
                    if interactive:
                        items = []
                        for el in interactive[:60]:
                            parts = [el.get("tag", "")]
                            if el.get("role"):
                                parts.append(f'role="{el["role"]}"')
                            if el.get("href"):
                                parts.append(f'href="{el["href"][:80]}"')
                            items.append(f'  [{" ".join(parts)}] {el.get("label", "")}')
                        interactive_lines = "\n\nClickable elements:\n" + "\n".join(items)

                    # Format to match the expected output the CU controller parses
                    output = (
                        f"URL: {p.get('url', '')}\n"
                        f"Title: {p.get('title', '')}\n\n"
                        f"Open tabs:\n{tabs_str}\n\n"
                        f"Page content:\n{meta_prefix}{page_text}"
                        f"{interactive_lines}"
                    )
                    logger.info("get_page_text via Chrome Bridge: %d chars (%d interactive elements)", len(output), len(interactive))
                    return {"success": True, "output": output[:12000], "screenshot": ""}
                else:
                    logger.warning("Chrome Bridge get_page_text failed: %s", resp.get("error"))
            except Exception as e:
                logger.warning("Chrome Bridge get_page_text error: %s — falling back to AppleScript", e)

        # ── Fallback: AppleScript (requires "Allow JavaScript from Apple Events") ──
        # Extract page info + visible text from Chrome via AppleScript.
        # Searches ALL Chrome windows for the right page (non-localhost),
        # then uses JS to extract the actual page content.
        # If `text` is provided, it's used as a URL hint to find the right window.
        url_hint = (text or "").replace('"', '\\"').replace("'", "\\'")

        # Single AppleScript that finds the right window AND extracts page content
        script = f'''
        tell application "Google Chrome"
            set urlHint to "{url_hint}"
            set bestWinIdx to 0

            -- Search all windows for the best match
            repeat with i from 1 to count of windows
                try
                    set tabURL to URL of active tab of window i
                    if urlHint is not "" then
                        if tabURL contains urlHint then
                            set bestWinIdx to i
                            exit repeat
                        end if
                    else
                        if tabURL does not contain "localhost" and tabURL does not contain "127.0.0.1" then
                            if bestWinIdx is 0 then set bestWinIdx to i
                        end if
                    end if
                end try
            end repeat

            -- Fallback to front window
            if bestWinIdx is 0 then set bestWinIdx to 1

            set w to window bestWinIdx
            set pageURL to URL of active tab of w
            set pageTitle to title of active tab of w

            -- Extract visible text via JavaScript
            set pageText to ""
            try
                set pageText to execute active tab of w javascript "
                    (function() {{
                        var el = document.body;
                        if (!el) return '';
                        return el.innerText.substring(0, 6000);
                    }})()
                "
            end try

            -- Get tab list
            set tabList to ""
            try
                repeat with t in tabs of w
                    set tabList to tabList & title of t & " | " & URL of t & "\\n"
                end repeat
            end try

            return "URL: " & pageURL & "\\nTitle: " & pageTitle & "\\n\\nOpen tabs:\\n" & tabList & "\\n\\nPage content:\\n" & pageText
        end tell
        '''
        try:
            proc = await asyncio.create_subprocess_exec(
                "osascript", "-e", script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
            if proc.returncode == 0:
                page_info = stdout.decode().strip()
                logger.info("get_page_text: extracted %d chars", len(page_info))
                return {"success": True, "output": page_info[:8000], "screenshot": ""}
            else:
                err = stderr.decode().strip()
                logger.warning("get_page_text failed: %s", err)
                return {"success": False, "output": f"get_page_text failed: {err}", "screenshot": ""}
        except Exception as e:
            return {"success": False, "output": f"get_page_text error: {e}", "screenshot": ""}

    if action == "chrome_navigate":
        # ── Try Chrome Bridge extension first ──
        if not text:
            return {"success": False, "output": "chrome_navigate requires text (URL)", "screenshot": ""}

        if chrome_bridge.connected:
            try:
                screen_region_nav = kwargs.get("screen_region") or {}
                bounds = None
                if screen_region_nav:
                    bounds = {
                        "x": x if x is not None else screen_region_nav.get("x", 0),
                        "y": y if y is not None else screen_region_nav.get("y", 0),
                        "width": screen_region_nav.get("width", 1280),
                        "height": screen_region_nav.get("height", 900),
                    }
                resp = await chrome_bridge.send_command("navigate", {
                    "url": text,
                    "new_window": True,
                    "bounds": bounds,
                }, timeout=15)
                if resp.get("success"):
                    logger.info("chrome_navigate via Chrome Bridge: %s", text)
                    return {"success": True, "output": f"Opened Chrome window at ({bounds or 'default'}) → {text}", "screenshot": ""}
                else:
                    logger.warning("Chrome Bridge navigate failed: %s — falling back", resp.get("error"))
            except Exception as e:
                logger.warning("Chrome Bridge navigate error: %s — falling back to AppleScript", e)

        # ── Fallback: AppleScript ──
        # Open a NEW Chrome window at a specific screen position and navigate to a URL.
        # text = URL, x/y = screen origin, screen_region may contain width/height.
        url = text
        screen_region = kwargs.get("screen_region") or {}
        scr_x = x if x is not None else screen_region.get("x", 0)
        scr_y = y if y is not None else screen_region.get("y", 0)
        scr_w = screen_region.get("width", 1920)
        scr_h = screen_region.get("height", 1080)
        right = scr_x + scr_w
        bottom = scr_y + scr_h
        script = f'''
        tell application "Google Chrome"
            set newWin to make new window
            set bounds of newWin to {{{scr_x}, {scr_y}, {right}, {bottom}}}
            set URL of active tab of newWin to "{url}"
            activate
        end tell
        '''
        try:
            proc = await asyncio.create_subprocess_exec(
                "osascript", "-e", script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
            if proc.returncode != 0:
                err = stderr.decode().strip()
                logger.warning("chrome_navigate failed: %s", err)
                return {"success": False, "output": f"chrome_navigate failed: {err}", "screenshot": ""}
            logger.info("chrome_navigate: opened %r at (%d,%d) %dx%d", url, scr_x, scr_y, scr_w, scr_h)
            return {"success": True, "output": f"Opened Chrome window at ({scr_x},{scr_y}) → {url}", "screenshot": ""}
        except Exception as e:
            return {"success": False, "output": f"chrome_navigate error: {e}", "screenshot": ""}

    if action == "find_ui_element":
        # CUA: Find a UI element — Chrome Bridge DOM first, ui_parser OCR/OmniParser fallback
        if not text:
            return {"success": False, "output": "find_ui_element requires text (element query)", "screenshot": ""}

        # Strategy 1: Chrome Bridge DOM elements (fastest, most reliable)
        if chrome_bridge.connected:
            try:
                resp = await chrome_bridge.send_command("get_page_text", {}, timeout=8)
                if resp.get("success"):
                    interactive = resp.get("payload", {}).get("interactive", [])
                    from difflib import SequenceMatcher as _SM
                    query_lower = text.lower().strip()
                    matches = []
                    for el in interactive:
                        label = (el.get("label") or "").strip()
                        if not label: continue
                        label_lower = label.lower()
                        if query_lower == label_lower: score = 1.0
                        elif query_lower in label_lower or label_lower in query_lower: score = 0.9
                        else: score = _SM(None, query_lower, label_lower).ratio()
                        if score >= 0.5:
                            matches.append({**el, "confidence": round(score, 3), "method": "dom"})
                    matches.sort(key=lambda d: d["confidence"], reverse=True)
                    if matches:
                        best = matches[0]
                        return {
                            "success": True,
                            "output": f"Found '{best.get('label', text)}' via DOM (confidence {best['confidence']})",
                            "screenshot": "",
                            "element": best,
                        }
            except Exception as e:
                logger.debug("Chrome Bridge find failed: %s", e)

        # Strategy 2: macOS Accessibility API — find by text in focused app
        # Searches name, description, value, title, help, and AXStaticText children
        if platform.system() == "Darwin":
            try:
                # Escape single quotes in query for AppleScript safety
                safe_text = text.replace("'", "'\\''").replace('"', '\\"')
                ax_script = f'''
tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set queryText to "{safe_text}"
    set results to ""

    -- Search menu bar items by name
    try
        set menuItems to every menu bar item of menu bar 1 of frontApp
        repeat with m in menuItems
            try
                if (name of m as text) contains queryText then
                    set elemPos to position of m
                    set elemSize to size of m
                    set posX to item 1 of elemPos
                    set posY to item 2 of elemPos
                    set sW to item 1 of elemSize
                    set sH to item 2 of elemSize
                    set centerX to posX + (sW / 2)
                    set centerY to posY + (sH / 2)
                    set results to results & "AXMenuBarItem|" & (name of m as text) & "|" & (centerX as integer) & "," & (centerY as integer) & "|" & sW & "x" & sH & linefeed
                end if
            end try
        end repeat
    end try

    -- Search window UI elements (buttons, text fields, static text, etc.)
    try
        set uiElems to entire contents of window 1 of frontApp
        set counter to 0
        repeat with e in uiElems
            set counter to counter + 1
            if counter > 300 then exit repeat
            try
                set roleName to role of e
                set matchText to ""
                try
                    set matchText to matchText & " " & (name of e as text)
                end try
                try
                    set matchText to matchText & " " & (description of e as text)
                end try
                try
                    set matchText to matchText & " " & (value of e as text)
                end try
                if matchText contains queryText then
                    set elemPos to position of e
                    set elemSize to size of e
                    set posX to item 1 of elemPos
                    set posY to item 2 of elemPos
                    set sW to item 1 of elemSize
                    set sH to item 2 of elemSize
                    if sW > 0 and sH > 0 then
                        set centerX to posX + (sW / 2)
                        set centerY to posY + (sH / 2)
                        set elemName to "?"
                        try
                            set elemName to name of e as text
                        end try
                        set results to results & roleName & "|" & elemName & "|" & (centerX as integer) & "," & (centerY as integer) & "|" & sW & "x" & sH & linefeed
                    end if
                end if
            end try
        end repeat
    end try

    return results
end tell
'''
                proc = await asyncio.create_subprocess_exec(
                    "osascript", "-e", ax_script,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=12)
                ax_output = stdout.decode().strip()
                if ax_output:
                    lines = [l.strip() for l in ax_output.split("\n") if l.strip()]
                    # Prefer interactive elements (buttons, links, menus) over static text
                    interactive_roles = {"AXButton", "AXLink", "AXMenuItem", "AXMenuButton",
                                        "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXTextField"}
                    sorted_lines = sorted(lines, key=lambda l: 0 if l.split("|")[0] in interactive_roles else 1)
                    if sorted_lines:
                        parts = sorted_lines[0].split("|")
                        if len(parts) >= 3:
                            coords = parts[2].split(",")
                            cx, cy = int(coords[0]), int(coords[1])
                            label = parts[1] if parts[1] not in ("?", "missing value") else text
                            logger.info("find_ui_element: '%s' found via Accessibility at native (%d,%d) — role=%s label=%s (%d matches)",
                                        text, cx, cy, parts[0], label, len(lines))
                            return {
                                "success": True,
                                "output": f"Found '{label}' at native ({cx}, {cy}) via Accessibility API",
                                "screenshot": "",
                                "element": {
                                    "label": label,
                                    "method": "accessibility",
                                    "native_center": [cx, cy],
                                    "role": parts[0],
                                    "center": [cx, cy],
                                },
                            }
                else:
                    logger.debug("Accessibility: no match for '%s' (stderr: %s)", text, stderr.decode().strip()[:200])
            except Exception as e:
                logger.debug("Accessibility find failed: %s", e)

        # Strategy 3: Per-screen OCR + GroundingDINO (capture each screen separately for accuracy)
        UI_PARSER_URL = _os.getenv("UI_PARSER_URL", "http://localhost:8011")
        try:
            import httpx as _httpx
            screens_info = await _list_screens()
            screens = screens_info.get("screens", [])
            if not screens:
                screens = [{"index": 0, "name": "Screen", "width": 1920, "height": 1080, "x": 0, "y": 0}]

            best_overall = None
            best_screen = None
            best_screenshot = ""

            async with _httpx.AsyncClient(timeout=15) as client:
                for scr in screens:
                    # Capture each screen at native resolution (up to 1920px) for accurate OCR
                    scr_screenshot = _take_screenshot(
                        region=(scr["x"], scr["y"], scr["width"], scr["height"]),
                        max_width=min(scr["width"], 1920),
                    )
                    if not scr_screenshot:
                        continue

                    resp = await client.post(f"{UI_PARSER_URL}/internal/ui-parser/ground", json={
                        "image": scr_screenshot,
                        "query": text,
                    })
                    data = resp.json()
                    detections = data.get("detections", [])
                    if detections:
                        det = detections[0]
                        det_score = det.get("score", 0)
                        best_score = best_overall.get("score", 0) if best_overall else -1
                        # Strongly prefer primary screen (index 0): only use secondary
                        # if its score is significantly higher (>0.3 better)
                        is_primary = scr.get("index", 0) == 0
                        best_is_primary = best_screen is not None and best_screen.get("index", 0) == 0
                        if best_overall is None:
                            use_this = True
                        elif is_primary and not best_is_primary:
                            use_this = True  # always prefer primary over secondary
                        elif not is_primary and best_is_primary:
                            use_this = det_score > best_score + 0.3  # secondary needs much higher score
                        else:
                            use_this = det_score > best_score  # same screen type: higher wins
                        if use_this:
                            best_overall = det
                            best_screen = scr
                            best_screenshot = scr_screenshot

            if best_overall and best_screen:
                # Convert from per-screen image coords to NATIVE screen coords
                # Get the actual per-screen image dimensions
                img_w, img_h = 1024, 768
                try:
                    import io as _io, base64 as _b64
                    from PIL import Image as _PILImage
                    img_bytes = _b64.b64decode(best_screenshot)
                    img = _PILImage.open(_io.BytesIO(img_bytes))
                    img_w, img_h = img.size
                except Exception:
                    pass

                # Scale from image space to per-screen native coords, then add screen offset
                scale_x = best_screen["width"] / img_w
                scale_y = best_screen["height"] / img_h
                native_cx = best_overall["center"][0] * scale_x + best_screen["x"]
                native_cy = best_overall["center"][1] * scale_y + best_screen["y"]

                logger.info(
                    "find_ui_element: '%s' found via %s on screen '%s' — "
                    "img(%d,%d) img_size=%dx%d scr_offset=(%d,%d) scr_size=%dx%d → native(%.0f,%.0f)",
                    text, best_overall.get("method", "?"), best_screen.get("name", "?"),
                    int(best_overall["center"][0]), int(best_overall["center"][1]),
                    img_w, img_h, best_screen["x"], best_screen["y"],
                    best_screen["width"], best_screen["height"], native_cx, native_cy,
                )

                return {
                    "success": True,
                    "output": f"Found '{best_overall.get('label', text)}' at native ({native_cx:.0f}, {native_cy:.0f}) on {best_screen.get('name', 'screen')} via {best_overall.get('method', 'ocr')}",
                    "screenshot": best_screenshot,
                    "element": {
                        **best_overall,
                        "method": best_overall.get("method", "ocr"),
                        # Store pre-computed native coords so click_ui_element can use them directly
                        "native_center": [round(native_cx), round(native_cy)],
                        "screen_name": best_screen.get("name", ""),
                        "screen_index": best_screen.get("index", 0),
                    },
                }
        except Exception as e:
            logger.warning("ui_parser find failed: %s", e)

        return {"success": False, "output": f"Element '{text}' not found on screen", "screenshot": ""}

    if action == "click_ui_element":
        # CUA: Find element then click it using the best available method
        if not text:
            return {"success": False, "output": "click_ui_element requires text (element query)", "screenshot": ""}

        # Step 1: Find the element
        find_result = await execute_computer_action(action="find_ui_element", text=text, x=None, y=None, **kwargs)
        if not find_result.get("success") or not find_result.get("element"):
            return {"success": False, "output": f"Could not find '{text}' on screen", "screenshot": find_result.get("screenshot", "")}

        el = find_result["element"]
        method = el.get("method", "")
        logger.info("click_ui_element: found '%s' via %s — element keys: %s", text, method, list(el.keys()))

        # Step 2: Click using the best method
        # If found via DOM → use Chrome Bridge click (trusted events)
        if method == "dom" and chrome_bridge.connected:
            try:
                resp = await chrome_bridge.send_command("click_element", {"text_match": el.get("text", text)}, timeout=10)
                if resp.get("success"):
                    logger.info("click_ui_element: '%s' clicked via Chrome Bridge DOM", text)
                    return {"success": True, "output": f"Clicked '{el.get('text', text)}' via DOM", "screenshot": ""}
            except Exception:
                pass

        # If found via Accessibility → click directly via AppleScript (handles multi-monitor/negative coords)
        if method == "accessibility" and platform.system() == "Darwin":
            try:
                safe_text = text.replace("'", "'\\''").replace('"', '\\"')
                role = el.get("role", "")
                # For menu bar items, use direct AppleScript click (non-blocking via AXPress)
                if role == "AXMenuBarItem":
                    ax_click = f'''
tell application "System Events"
    set frontApp to first application process whose frontmost is true
    perform action "AXPress" of menu bar item "{safe_text}" of menu bar 1 of frontApp
end tell
'''
                else:
                    # For window elements, use coordinate-based click via System Events
                    # (handles negative coords unlike pyautogui)
                    nc = el.get("native_center", [0, 0])
                    ax_click = f'''
tell application "System Events"
    -- Use CGEvent-style click via System Events (handles multi-monitor negative coords)
    set frontApp to first application process whose frontmost is true
    set uiElems to entire contents of window 1 of frontApp
    repeat with e in uiElems
        try
            set matchText to ""
            try
                set matchText to matchText & " " & (name of e as text)
            end try
            try
                set matchText to matchText & " " & (description of e as text)
            end try
            try
                set matchText to matchText & " " & (value of e as text)
            end try
            if matchText contains "{safe_text}" then
                perform action "AXPress" of e
                return "clicked"
            end if
        end try
    end repeat
    return "not_found"
end tell
'''
                proc = await asyncio.create_subprocess_exec(
                    "osascript", "-e", ax_click,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=8)
                ax_result = stdout.decode().strip()
                if proc.returncode == 0:
                    logger.info("click_ui_element: '%s' clicked via Accessibility AXPress (role=%s)", text, role)
                    return {"success": True, "output": f"Clicked '{el.get('label', text)}' via Accessibility", "screenshot": ""}
                else:
                    logger.debug("AXPress failed: %s", stderr.decode().strip()[:200])
            except asyncio.TimeoutError:
                logger.debug("AXPress timed out for '%s'", text)
            except Exception as e:
                logger.debug("AXPress failed: %s", e)

        # Pixel click: use pre-computed native_center if available (from per-screen find),
        # otherwise fall back to scaling image-space coords
        native_center = el.get("native_center")
        if native_center and isinstance(native_center, (list, tuple)) and len(native_center) >= 2:
            click_x, click_y = int(native_center[0]), int(native_center[1])
            logger.info("click_ui_element: using pre-computed native_center (%d, %d) on screen '%s'",
                        click_x, click_y, el.get("screen_name", "?"))
        else:
            # Legacy path: scale image-space coords to native
            center = el.get("center")
            if not center or not isinstance(center, (list, tuple)) or len(center) < 2:
                center = el.get("center_px")
            if not center or not isinstance(center, (list, tuple)) or len(center) < 2:
                bbox = el.get("bbox")
                if bbox and isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
                    center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
            click_x, click_y = 0, 0
            if center and center[0] > 0 and center[1] > 0:
                click_x, click_y = int(center[0]), int(center[1])
                # Get actual image dimensions from the screenshot
                img_w, img_h = 1024, 768
                screenshot_b64 = find_result.get("screenshot", "")
                if screenshot_b64:
                    try:
                        import io as _io, base64 as _b64
                        from PIL import Image as _PILImage
                        img_bytes = _b64.b64decode(screenshot_b64)
                        img = _PILImage.open(_io.BytesIO(img_bytes))
                        img_w, img_h = img.size
                    except Exception:
                        pass
                try:
                    screens_info = await execute_computer_action(action="list_screens", text="", x=None, y=None, **kwargs)
                    screens = screens_info.get("screens", [])
                    if screens:
                        total_w = max(s["x"] + s["width"] for s in screens)
                        total_h = max(s["y"] + s["height"] for s in screens)
                        scale_x = total_w / img_w
                        scale_y = total_h / img_h
                        click_x = int(center[0] * scale_x)
                        click_y = int(center[1] * scale_y)
                        logger.info("click_ui_element: legacy scale image(%d,%d) → native(%d,%d) scale=%.3f",
                                    int(center[0]), int(center[1]), click_x, click_y, scale_x)
                except Exception as e:
                    logger.warning("Scale calculation failed: %s — using raw coords", e)

        # macOS multi-monitor can have negative coords (screens above/left of primary)
        has_valid_coords = (click_x != 0 or click_y != 0) and click_x >= -5000 and click_y >= -5000
        if has_valid_coords:
            click_result = await execute_computer_action(
                action="click", text="", x=click_x, y=click_y, **kwargs
            )
            ctrl_success = click_result.get("success", False)
            ctrl_output = click_result.get("output", "")
            if not ctrl_success:
                logger.error("click_ui_element: click FAILED at (%d,%d): %s", click_x, click_y, ctrl_output)
                return {"success": False, "output": f"Click at ({click_x},{click_y}) failed: {ctrl_output}", "screenshot": click_result.get("screenshot", "")}

            logger.info("click_ui_element: '%s' clicked at native (%d, %d)", text, click_x, click_y)
            return {"success": True, "output": f"Clicked '{el.get('text', text)}' at native ({click_x}, {click_y})", "screenshot": click_result.get("screenshot", "")}

        logger.error("click_ui_element: no valid coords for '%s' — element: %s", text, {k: v for k, v in el.items() if k != 'thumbnail'})
        return {"success": False, "output": f"Found '{text}' but could not determine click coordinates", "screenshot": ""}

    if action == "chrome_bridge_type":
        # Type text into the focused browser element via Chrome Bridge.
        # Uses execCommand('insertText') which works with contenteditable (Facebook, etc.)
        if not text:
            return {"success": False, "output": "chrome_bridge_type requires text", "screenshot": ""}
        if not chrome_bridge.connected:
            return {"success": False, "output": "Chrome Bridge not connected", "screenshot": ""}
        try:
            resp = await chrome_bridge.send_command("type_text", {
                "text": text,
                "selector": kwargs.get("selector", ""),
            }, timeout=10)
            if resp.get("success"):
                payload = resp.get("payload", {})
                logger.info("chrome_bridge_type: typed %d chars via %s", payload.get("typed", 0), payload.get("method", "?"))
                return {"success": True, "output": f"Typed via DOM: {text[:60]}", "screenshot": ""}
            else:
                return {"success": False, "output": resp.get("error", "type failed"), "screenshot": ""}
        except Exception as e:
            return {"success": False, "output": str(e), "screenshot": ""}

    if action == "switch_tab":
        # Switch to an existing Chrome tab by title or URL match (no navigation)
        if not text:
            return {"success": False, "output": "switch_tab requires text (tab title or URL fragment)", "screenshot": ""}
        if chrome_bridge.connected:
            try:
                resp = await chrome_bridge.send_command("switch_tab", {"query": text}, timeout=8)
                if resp.get("success"):
                    payload = resp.get("payload", {})
                    logger.info("switch_tab: activated '%s' → %s", text, payload.get("title", "?"))
                    return {"success": True, "output": f"Switched to tab: {payload.get('title', text)}", "screenshot": ""}
                else:
                    logger.info("switch_tab: no tab matching '%s'", text)
                    return {"success": False, "output": f"No tab matching '{text}'", "screenshot": ""}
            except Exception as e:
                logger.warning("switch_tab via Chrome Bridge failed: %s", e)
                return {"success": False, "output": str(e), "screenshot": ""}
        return {"success": False, "output": "Chrome Bridge not connected — cannot switch tabs", "screenshot": ""}

    if action == "chrome_bridge_click":
        # Click an element via the Chrome Bridge extension using text match.
        # Falls back gracefully if the bridge isn't connected.
        if not text:
            return {"success": False, "output": "chrome_bridge_click requires text (element description)", "screenshot": ""}
        if not chrome_bridge.connected:
            return {"success": False, "output": "Chrome Bridge not connected", "screenshot": ""}
        try:
            resp = await chrome_bridge.send_command("click_element", {
                "text_match": text,
            }, timeout=10)
            if resp.get("success"):
                payload = resp.get("payload", {})
                href = payload.get("href")
                logger.info("Chrome Bridge click: '%s' → success (bounds: %s, href: %s)", text, payload.get("bounds"), href)

                # If the click was via DOM fallback and the element is a link,
                # navigate directly since synthetic clicks may not trigger
                # client-side routing (GitHub Turbo, Next.js, etc.).
                if href and payload.get("method") == "dom_fallback":
                    logger.info("DOM fallback detected link — navigating to %s", href)
                    try:
                        await chrome_bridge.send_command("set_url", {"url": href}, timeout=10)
                    except Exception as nav_err:
                        logger.warning("Fallback navigation failed: %s", nav_err)

                return {"success": True, "output": f"Clicked '{text}' via DOM", "screenshot": ""}
            else:
                error = resp.get("error", "element not found")
                logger.info("Chrome Bridge click failed: '%s' → %s", text, error)
                return {"success": False, "output": error, "screenshot": ""}
        except Exception as e:
            logger.warning("Chrome Bridge click error: %s", e)
            return {"success": False, "output": str(e), "screenshot": ""}

    if action == "chrome_set_url":
        if not text:
            return {"success": False, "output": "chrome_set_url requires text (URL)", "screenshot": ""}

        # ── Try Chrome Bridge extension first ──
        if chrome_bridge.connected:
            try:
                payload = {
                    "url": text,
                    "url_hint": kwargs.get("url_hint", ""),
                }
                if kwargs.get("new_tab"):
                    payload["new_tab"] = True
                resp = await chrome_bridge.send_command("set_url", payload, timeout=15)
                if resp.get("success"):
                    logger.info("chrome_set_url via Chrome Bridge: %s", text)
                    return {"success": True, "output": f"Navigated to {text}", "screenshot": ""}
                else:
                    logger.warning("Chrome Bridge set_url failed: %s — falling back", resp.get("error"))
            except Exception as e:
                logger.warning("Chrome Bridge set_url error: %s — falling back to AppleScript", e)

        # ── Fallback: AppleScript ──
        # Navigate an EXISTING Chrome window to a new URL.
        # Finds the work window by url_hint, then sets its active tab URL.
        # text = URL, kwargs.url_hint = hint to find the right window
        url = text.replace('"', '\\"')
        url_hint = kwargs.get("url_hint", "").replace('"', '\\"').replace("'", "\\'")
        script = f'''
        tell application "Google Chrome"
            set urlHint to "{url_hint}"
            set bestWinIdx to 0

            repeat with i from 1 to count of windows
                try
                    set tabURL to URL of active tab of window i
                    if urlHint is not "" then
                        if tabURL contains urlHint then
                            set bestWinIdx to i
                            exit repeat
                        end if
                    else
                        if tabURL does not contain "localhost" and tabURL does not contain "127.0.0.1" then
                            if bestWinIdx is 0 then set bestWinIdx to i
                        end if
                    end if
                end try
            end repeat

            if bestWinIdx is 0 then set bestWinIdx to 1

            set w to window bestWinIdx
            set URL of active tab of w to "{url}"
            set index of w to 1
            activate
        end tell
        '''
        try:
            proc = await asyncio.create_subprocess_exec(
                "osascript", "-e", script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
            if proc.returncode != 0:
                err = stderr.decode().strip()
                logger.warning("chrome_set_url failed: %s", err)
                return {"success": False, "output": f"chrome_set_url failed: {err}", "screenshot": ""}
            logger.info("chrome_set_url: navigated to %r (hint=%r)", text, url_hint)
            return {"success": True, "output": f"Navigated work window to {text}", "screenshot": ""}
        except Exception as e:
            return {"success": False, "output": f"chrome_set_url error: {e}", "screenshot": ""}

    if action == "get_window_bounds":
        if not text:
            return {"success": False, "output": "get_window_bounds requires text (app name)", "screenshot": ""}
        return await _get_window_bounds(text)

    if action == "list_windows":
        return await _list_windows()

    if action == "list_screens":
        return await _list_screens()

    if action == "window_thumbnail":
        if not text:
            return {"success": False, "output": "window_thumbnail requires text (app name)", "screenshot": "", "thumbnail": ""}
        thumb = await _take_window_thumbnail(text)
        return {"success": True, "output": "", "screenshot": "", "thumbnail": thumb}

    # ── Use OasisComputerControl.app on macOS for dedicated Accessibility permission ──
    use_control_app = platform.system() == "Darwin" and _os.path.isfile(_CONTROL_BIN)

    if action == "screenshot":
        # Support screen_region for capturing a specific display region.
        # Default: capture only the PRIMARY screen (not all monitors) to avoid
        # coordinate mapping issues on multi-monitor setups.
        screen_region = kwargs.get("screen_region")  # {x, y, width, height}
        if screen_region:
            region = (screen_region["x"], screen_region["y"], screen_region["width"], screen_region["height"])
            screenshot = _take_screenshot(region=region)
        else:
            # Default to primary screen only
            try:
                screens_info = await _list_screens()
                primary = (screens_info.get("screens") or [{}])[0]
                if primary.get("width"):
                    region = (primary.get("x", 0), primary.get("y", 0), primary["width"], primary["height"])
                    screenshot = _take_screenshot(region=region)
                else:
                    screenshot = _take_screenshot()
            except Exception:
                screenshot = _take_screenshot()
        return {"success": True, "output": "Screenshot captured", "screenshot": screenshot}

    if action == "get_screen_size":
        size = _get_screen_size()
        return {"success": True, "output": f"Screen size: {size['width']}x{size['height']}", "screenshot": ""}

    # All mouse/keyboard actions go through OasisComputerControl.app
    # so permissions are attributed to "Oasis Computer Control", not Python/Terminal.
    if not use_control_app:
        return {"success": False, "output": "OasisComputerControl.app not found — cannot perform computer actions", "screenshot": ""}

    ctrl_kwargs: dict[str, Any] = {}
    if x is not None:
        ctrl_kwargs["x"] = x
    if y is not None:
        ctrl_kwargs["y"] = y
    if text is not None:
        ctrl_kwargs["text"] = text
    if key is not None:
        ctrl_kwargs["key"] = key
    if keys:
        ctrl_kwargs["keys"] = ",".join(keys)
    if clicks != 1:
        ctrl_kwargs["clicks"] = clicks
    if button != "left":
        ctrl_kwargs["button"] = button
    if direction != "down":
        ctrl_kwargs["direction"] = direction
    if amount != 3:
        ctrl_kwargs["amount"] = amount
    if duration != 0.5:
        ctrl_kwargs["duration"] = duration
    # Mark agent as acting — interference monitor should ignore this input
    from services.dev_agent.input_monitor import input_monitor as _input_monitor
    _input_monitor.set_agent_acting(True)

    # App-targeted keystrokes: handle directly via AppleScript (more reliable than routing through control app)
    # Auto-detect frontmost app if no explicit app target is given for keyboard actions.
    # This prevents keystrokes from being lost when OasisComputerControl.app steals focus.
    app_target = kwargs.get("app")
    if not app_target and action in ("key_press", "hotkey", "type_text"):
        try:
            _detect_proc = await asyncio.create_subprocess_exec(
                "osascript", "-e",
                'tell application "System Events" to get name of first application process whose frontmost is true',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _detect_out, _ = await asyncio.wait_for(_detect_proc.communicate(), timeout=3)
            _detected = _detect_out.decode().strip()
            if _detected and _detected not in ("Oasis Computer Control", "OasisComputerControl"):
                app_target = _detected
                logger.info("Auto-detected frontmost app for %s: '%s'", action, app_target)
        except Exception:
            pass  # Fall through to OasisComputerControl.app

    if app_target and action in ("key_press", "hotkey", "type_text"):
        try:
            safe_app = app_target.replace('"', '\\"')
            if action == "type_text" and text:
                safe_text = text.replace('\\', '\\\\').replace('"', '\\"')
                ax_script = f'''
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.3
        keystroke "{safe_text}"
    end tell
end tell
'''
            elif action == "hotkey" and keys:
                # keys = ["command", "n"] → keystroke "n" using {command down}
                _mod_map = {"command": "command down", "cmd": "command down", "shift": "shift down",
                            "option": "option down", "alt": "option down", "control": "control down", "ctrl": "control down"}
                the_key = keys[-1]
                mods = [_mod_map.get(m.lower(), m + " down") for m in keys[:-1]]
                mod_clause = f" using {{{', '.join(mods)}}}" if mods else ""
                ax_script = f'''
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.3
        keystroke "{the_key}"{mod_clause}
    end tell
end tell
'''
            elif action == "key_press" and key:
                _key_codes = {"enter": 36, "return": 36, "tab": 48, "space": 49, "escape": 53,
                              "up": 126, "down": 125, "left": 123, "right": 124, "delete": 51}
                kc = _key_codes.get(key.lower())
                if kc:
                    ax_script = f'''
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.3
        key code {kc}
    end tell
end tell
'''
                else:
                    ax_script = f'''
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.3
        keystroke "{key}"
    end tell
end tell
'''
            else:
                ax_script = None

            if ax_script:
                proc = await asyncio.create_subprocess_exec(
                    "osascript", "-e", ax_script,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.communicate(), timeout=10)
                output = f"{action}: {text or key or ','.join(keys or [])} → {app_target}"
                logger.info("App-targeted %s to '%s' via AppleScript", action, app_target)
                _input_monitor.set_agent_acting(False)
                screenshot = _take_screenshot()
                return {"success": True, "output": output, "screenshot": screenshot}
        except Exception as e:
            logger.warning("App-targeted %s failed: %s — falling back to control app", action, e)

    # For click/mouse actions with an explicit app target, bring that app's
    # window to front first so the click lands on the right window instead of
    # whatever happens to be on top at those coordinates.
    if app_target and action in ("click", "double_click", "right_click", "mouse_move"):
        try:
            _raise_script = f'''
tell application "{app_target}" to activate
delay 0.2
tell application "System Events"
    tell process "{app_target}"
        set frontmost to true
        try
            perform action "AXRaise" of window 1
        end try
    end tell
end tell
'''
            _raise_proc = await asyncio.create_subprocess_exec(
                "osascript", "-e", _raise_script,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(_raise_proc.communicate(), timeout=5)
            await asyncio.sleep(0.3)
            logger.info("Auto-raised '%s' window before %s at (%s, %s)", app_target, action, x, y)
        except Exception as e:
            logger.debug("Auto-raise failed for '%s': %s", app_target, e)

    ctrl = _run_control(action, **ctrl_kwargs)
    _input_monitor.set_agent_acting(False)
    screenshot = _take_screenshot()
    return {
        "success": ctrl.get("success", True),
        "output": ctrl.get("output", ""),
        "screenshot": screenshot,
    }
