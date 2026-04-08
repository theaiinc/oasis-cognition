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

def _take_screenshot(region: tuple[int, int, int, int] | None = None) -> str:
    """Capture screen (or region) and return as base64 JPEG string.

    On macOS, uses OasisScreenCapture.app so Screen Recording permission
    shows "Oasis Screen Capture" — never imports pyautogui/Quartz in this process.
    """
    if _os.path.isfile(_CAPTURE_BIN):
        args = ["--max-width", "1024"]
        if region:
            args += ["--region", f"{region[0]},{region[1]},{region[2]},{region[3]}"]
        raw = _run_app_bundle(_CAPTURE_APP, args, timeout=10)
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

        # Try direct app activation (most reliable)
        script = f'tell application "{app_name}" to activate'
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
        try:
            proc = await asyncio.create_subprocess_exec(
                "open", "-a", text,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode != 0:
                return {"success": False, "output": f"Failed to open {text}: {stderr.decode().strip()}", "screenshot": ""}
            logger.info("open_application: opened %r", text)
            return {"success": True, "output": f"Opened {text}", "screenshot": ""}
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
                logger.info("Chrome Bridge click: '%s' → success (bounds: %s)", text, payload.get("bounds"))
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
                resp = await chrome_bridge.send_command("set_url", {
                    "url": text,
                    "url_hint": kwargs.get("url_hint", ""),
                }, timeout=15)
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
        # Support screen_index for capturing a specific display
        screen_region = kwargs.get("screen_region")  # {x, y, width, height}
        if screen_region:
            region = (screen_region["x"], screen_region["y"], screen_region["width"], screen_region["height"])
            screenshot = _take_screenshot(region=region)
        else:
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

    ctrl = _run_control(action, **ctrl_kwargs)
    screenshot = _take_screenshot()
    return {
        "success": ctrl.get("success", True),
        "output": ctrl.get("output", ""),
        "screenshot": screenshot,
    }
