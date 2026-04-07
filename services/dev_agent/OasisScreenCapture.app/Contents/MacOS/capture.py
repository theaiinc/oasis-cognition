#!/Users/stevetran/oasis-cognition/.venv/bin/python3
"""
Oasis Screen Capture — lightweight screenshot helper.

Runs as a macOS .app bundle so it gets its own Screen Recording permission
entry ("Oasis Screen Capture") instead of requiring Terminal/IDE permission.

Usage:
  capture                          # full screen, JPEG base64 to stdout
  capture --region X,Y,W,H         # region capture
  capture --screen INDEX            # specific display by index
  capture --thumbnail [--max-width N]  # small preview (default 320px wide)
  capture --json                   # wrap output in JSON {"screenshot": "..."}
"""

import argparse
import base64
import io
import json
import sys

def _cg_image_to_pil(cg_image):
    """Convert a Quartz CGImage to a PIL Image."""
    import Quartz
    from PIL import Image

    width = Quartz.CGImageGetWidth(cg_image)
    height = Quartz.CGImageGetHeight(cg_image)
    bytes_per_row = Quartz.CGImageGetBytesPerRow(cg_image)
    data_provider = Quartz.CGImageGetDataProvider(cg_image)
    data = Quartz.CGDataProviderCopyData(data_provider)

    img = Image.frombuffer(
        'RGBA', (width, height),
        data, 'raw', 'BGRA', bytes_per_row, 1,
    )
    return img.convert('RGB')


def capture_screen(region=None, screen_index=None):
    """Capture screen using Quartz CoreGraphics."""
    try:
        import Quartz
    except ImportError:
        import pyautogui
        img = pyautogui.screenshot(region=region)
        return img

    if screen_index is not None:
        displays = Quartz.CGGetActiveDisplayList(32, None, None)
        if displays and len(displays) > 1:
            display_list = displays[1]
            if screen_index < len(display_list):
                display_id = display_list[screen_index]
                cg_image = Quartz.CGDisplayCreateImage(display_id)
            else:
                cg_image = Quartz.CGWindowListCreateImage(
                    Quartz.CGRectInfinite,
                    Quartz.kCGWindowListOptionOnScreenOnly,
                    Quartz.kCGNullWindowID,
                    Quartz.kCGWindowImageDefault,
                )
        else:
            cg_image = Quartz.CGWindowListCreateImage(
                Quartz.CGRectInfinite,
                Quartz.kCGWindowListOptionOnScreenOnly,
                Quartz.kCGNullWindowID,
                Quartz.kCGWindowImageDefault,
            )
    elif region:
        x, y, w, h = region
        rect = Quartz.CGRectMake(x, y, w, h)
        cg_image = Quartz.CGWindowListCreateImage(
            rect,
            Quartz.kCGWindowListOptionOnScreenOnly,
            Quartz.kCGNullWindowID,
            Quartz.kCGWindowImageDefault,
        )
    else:
        cg_image = Quartz.CGWindowListCreateImage(
            Quartz.CGRectInfinite,
            Quartz.kCGWindowListOptionOnScreenOnly,
            Quartz.kCGNullWindowID,
            Quartz.kCGWindowImageDefault,
        )

    if cg_image is None:
        print("ERROR: Screen capture returned None — Screen Recording permission not granted", file=sys.stderr)
        sys.exit(1)

    return _cg_image_to_pil(cg_image)


def main():
    parser = argparse.ArgumentParser(description='Oasis Screen Capture')
    parser.add_argument('--region', type=str, help='Capture region: X,Y,W,H')
    parser.add_argument('--screen', type=int, help='Capture specific display by index')
    parser.add_argument('--thumbnail', action='store_true', help='Output small thumbnail')
    parser.add_argument('--max-width', type=int, default=1280, help='Max output width (default 1280)')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--output', type=str, help='Write output to file instead of stdout')
    args = parser.parse_args()

    region = None
    if args.region:
        parts = [int(x) for x in args.region.split(',')]
        if len(parts) == 4:
            region = tuple(parts)

    if args.thumbnail:
        args.max_width = min(args.max_width, 480)

    try:
        img = capture_screen(region=region, screen_index=args.screen)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # Resize
    w, h = img.size
    max_w = args.max_width
    if w > max_w:
        ratio = max_w / w
        img = img.resize((max_w, int(h * ratio)))

    # Encode
    buf = io.BytesIO()
    quality = 65 if args.thumbnail else 70
    img.save(buf, format='JPEG', quality=quality)
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')

    # Determine output destination
    out = open(args.output, 'w') if args.output else sys.stdout

    if args.json:
        json.dump({'screenshot': b64, 'width': img.size[0], 'height': img.size[1]}, out)
    else:
        out.write(b64)

    if args.output:
        out.close()


if __name__ == '__main__':
    main()
