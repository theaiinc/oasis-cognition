#!/Users/stevetran/oasis-cognition/.venv/bin/python3
"""
Oasis Computer Control — mouse/keyboard automation helper.

Runs as a macOS .app bundle so it gets its own Accessibility permission
entry ("Oasis Computer Control") instead of requiring Terminal/IDE permission.

Usage:
  control <action> [--x X] [--y Y] [--text TEXT] [--key KEY] [--keys K1,K2]
                   [--clicks N] [--button left|right] [--direction up|down]
                   [--amount N] [--duration F] [--json]

Actions:
  mouse_move, click, double_click, right_click, type_text, key_press,
  hotkey, scroll, drag, get_screen_size
"""

import argparse
import json
import subprocess
import sys
import time


# ── AppleScript key mapping ───────────────────────────────────────────────────
# Maps common key names to AppleScript key codes or keystroke strings.
# AppleScript uses `key code N` for special keys and `keystroke "x"` for characters.

_AS_KEY_CODES = {
    "enter": 36, "return": 36, "tab": 48, "space": 49, "delete": 51,
    "backspace": 51, "escape": 53, "esc": 53,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
}

_AS_MODIFIER_MAP = {
    "command": "command down", "cmd": "command down", "meta": "command down",
    "shift": "shift down",
    "option": "option down", "alt": "option down",
    "control": "control down", "ctrl": "control down",
}


def _send_key_to_app(app_name: str, key: str, modifiers: list[str]) -> None:
    """Send a keystroke to a specific app process via AppleScript.

    This ensures the keystroke goes to the target app even if another app has focus.
    Uses `tell process "X"` which targets the app directly.
    """
    safe_app = app_name.replace('"', '\\"')
    key_lower = key.lower().strip()

    # Build modifier clause: {command down, shift down}
    as_modifiers = []
    for m in modifiers:
        mapped = _AS_MODIFIER_MAP.get(m.lower().strip())
        if mapped:
            as_modifiers.append(mapped)

    modifier_clause = ""
    if as_modifiers:
        modifier_clause = f" using {{{', '.join(as_modifiers)}}}"

    # Determine if we need key code (special keys) or keystroke (characters)
    if key_lower in _AS_KEY_CODES:
        code = _AS_KEY_CODES[key_lower]
        script = f'''
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.2
        key code {code}{modifier_clause}
    end tell
end tell
'''
    elif len(key) == 1:
        # Single character keystroke
        safe_key = key.replace('"', '\\"')
        script = f'''
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.2
        keystroke "{safe_key}"{modifier_clause}
    end tell
end tell
'''
    else:
        # Try as keystroke (e.g., multi-char like "abc")
        safe_key = key.replace('"', '\\"')
        script = f'''
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.2
        keystroke "{safe_key}"{modifier_clause}
    end tell
end tell
'''

    subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)


def main():
    parser = argparse.ArgumentParser(description='Oasis Computer Control')
    parser.add_argument('action', help='Action to perform')
    parser.add_argument('--x', type=int, default=None)
    parser.add_argument('--y', type=int, default=None)
    parser.add_argument('--text', type=str, default=None)
    parser.add_argument('--key', type=str, default=None)
    parser.add_argument('--keys', type=str, default=None, help='Comma-separated key combo')
    parser.add_argument('--clicks', type=int, default=1)
    parser.add_argument('--button', type=str, default='left')
    parser.add_argument('--direction', type=str, default='down')
    parser.add_argument('--amount', type=int, default=3)
    parser.add_argument('--duration', type=float, default=0.5)
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--output', type=str, help='Write output to file instead of stdout')
    parser.add_argument('--app', type=str, default=None, help='Target app process name for keystroke targeting')
    args = parser.parse_args()

    # Request Accessibility permission — this triggers the macOS prompt and
    # creates the "Oasis Computer Control" entry in System Settings.
    try:
        import ApplicationServices
        options = {ApplicationServices.kAXTrustedCheckOptionPrompt: True}
        trusted = ApplicationServices.AXIsProcessTrustedWithOptions(options)
        if not trusted:
            result = {"success": False, "output": "Accessibility permission not granted. Enable 'Oasis Computer Control' in System Settings → Privacy & Security → Accessibility."}
            out = open(args.output, 'w') if args.output else sys.stdout
            if args.json:
                json.dump(result, out)
            else:
                print(f"ERROR: {result['output']}", file=sys.stderr)
            if args.output:
                out.close()
            sys.exit(1)
    except Exception:
        pass  # Non-macOS or ApplicationServices not available

    try:
        import pyautogui
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0.3
    except ImportError:
        result = {"success": False, "output": "pyautogui not available"}
        if args.json:
            json.dump(result, sys.stdout)
        else:
            print(f"ERROR: {result['output']}", file=sys.stderr)
        sys.exit(1)

    action = args.action.lower().strip()
    result = {"success": True, "output": ""}

    try:
        if action == "mouse_move":
            if args.x is None or args.y is None:
                raise ValueError("mouse_move requires --x and --y")
            pyautogui.moveTo(args.x, args.y, duration=args.duration)
            result["output"] = f"Moved mouse to ({args.x}, {args.y})"

        elif action == "click":
            if args.x is not None and args.y is not None:
                # Use Quartz CGEvent for negative coords (multi-monitor menu bars)
                # pyautogui clips negative values on some setups
                if args.y < 0 or args.x < 0:
                    try:
                        import Quartz
                        point = (float(args.x), float(args.y))
                        for _ in range(args.clicks):
                            move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, point, 0)
                            Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
                            time.sleep(0.05)
                            down = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, point, 0)
                            up = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, point, 0)
                            Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
                            time.sleep(0.05)
                            Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
                            time.sleep(0.1)
                    except Exception:
                        pyautogui.click(args.x, args.y, clicks=args.clicks, button=args.button)
                else:
                    pyautogui.click(args.x, args.y, clicks=args.clicks, button=args.button)
                result["output"] = f"Clicked ({args.x}, {args.y})"
            else:
                pyautogui.click(clicks=args.clicks, button=args.button)
                result["output"] = "Clicked at current position"
            time.sleep(0.5)

        elif action == "double_click":
            if args.x is not None and args.y is not None:
                pyautogui.doubleClick(args.x, args.y)
                result["output"] = f"Double-clicked ({args.x}, {args.y})"
            else:
                pyautogui.doubleClick()
                result["output"] = "Double-clicked at current position"
            time.sleep(0.5)

        elif action == "right_click":
            if args.x is not None and args.y is not None:
                pyautogui.rightClick(args.x, args.y)
                result["output"] = f"Right-clicked ({args.x}, {args.y})"
            else:
                pyautogui.rightClick()
                result["output"] = "Right-clicked at current position"
            time.sleep(0.5)

        elif action == "type_text":
            if not args.text:
                raise ValueError("type_text requires --text")
            # Use AppleScript keystroke targeted to specific app when --app is provided.
            # Falls back to System Events (frontmost app) then pyautogui.
            try:
                safe = args.text.replace('\\', '\\\\').replace('"', '\\"')
                if args.app:
                    safe_app = args.app.replace('"', '\\"')
                    script = f'''
tell application "System Events"
    tell process "{safe_app}"
        set frontmost to true
        delay 0.2
        keystroke "{safe}"
    end tell
end tell
'''
                else:
                    script = f'tell application "System Events" to keystroke "{safe}"'
                subprocess.run(['osascript', '-e', script], timeout=10, capture_output=True)
                result["output"] = f"Typed: {args.text[:80]}"
            except Exception:
                # Fallback to pyautogui
                if args.text.isascii():
                    pyautogui.typewrite(args.text, interval=0.03)
                else:
                    pyautogui.write(args.text)
                result["output"] = f"Typed: {args.text[:80]}"
            time.sleep(0.3)

        elif action == "key_press":
            if not args.key:
                raise ValueError("key_press requires --key")
            if args.app:
                # Target specific app process via AppleScript
                _send_key_to_app(args.app, args.key, modifiers=[])
            else:
                pyautogui.press(args.key)
            result["output"] = f"Pressed key: {args.key}"
            time.sleep(0.3)

        elif action == "hotkey":
            combo = args.keys.split(",") if args.keys else ([args.key] if args.key else [])
            if not combo:
                raise ValueError("hotkey requires --keys or --key")
            if args.app:
                # Target specific app process via AppleScript
                # Last element is the key, rest are modifiers
                key = combo[-1].strip()
                modifiers = [m.strip() for m in combo[:-1]]
                _send_key_to_app(args.app, key, modifiers)
            else:
                pyautogui.hotkey(*combo)
            result["output"] = f"Hotkey: {'+'.join(combo)}"
            time.sleep(0.3)

        elif action == "scroll":
            scroll_amount = args.amount if args.direction == "up" else -args.amount
            if args.x is not None and args.y is not None:
                pyautogui.scroll(scroll_amount, args.x, args.y)
                result["output"] = f"Scrolled {args.direction} {args.amount} at ({args.x}, {args.y})"
            else:
                pyautogui.scroll(scroll_amount)
                result["output"] = f"Scrolled {args.direction} {args.amount}"
            time.sleep(0.3)

        elif action == "drag":
            if args.x is None or args.y is None:
                raise ValueError("drag requires --x and --y")
            pyautogui.drag(args.x, args.y, duration=args.duration, button=args.button)
            result["output"] = f"Dragged to ({args.x}, {args.y})"

        elif action == "get_screen_size":
            w, h = pyautogui.size()
            result["output"] = f"{w}x{h}"
            result["width"] = w
            result["height"] = h

        else:
            result["success"] = False
            result["output"] = f"Unknown action: {action}"

    except Exception as e:
        result["success"] = False
        result["output"] = str(e)

    out = open(args.output, 'w') if args.output else sys.stdout

    if args.json:
        json.dump(result, out)
    else:
        if result["success"]:
            out.write(result["output"] + "\n")
        else:
            print(f"ERROR: {result['output']}", file=sys.stderr)
            if args.output:
                out.close()
            sys.exit(1)

    if args.output:
        out.close()


if __name__ == '__main__':
    main()
