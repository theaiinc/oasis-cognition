/**
 * ComputerUseRuntime — abstraction over the host-level desktop automation backend.
 *
 * The runtime handles all screen observation (screenshots, OCR, DOM extraction)
 * and input actions (click, type, scroll, key presses) on the host machine.
 *
 * Current implementations:
 *   - LocalMacOSRuntime → calls dev-agent → native macOS binaries
 *   - YggdrasilRuntime  → calls Yggdrasil → Ratatoskr → Realm (future)
 *
 * Cognition itself must NOT depend on infrastructure details like
 * @theaiinc/yggdrasil or Realm URLs. This interface is all it sees.
 */

export interface ScreenInfo {
  index: number;
  width: number;
  height: number;
  x: number;
  y: number;
  /** macOS display name or IOKit display ID. */
  name?: string;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  /** Device pixel ratio scaling. A scale of 2 means retina — the runtime
   *  should halve coordinates for native API calls. Defaults to 2. */
  scale?: number;
  /** Optional region to capture (x, y, width, height in CSS pixels). */
  region?: { x: number; y: number; width: number; height: number };
}

export interface ClickOptions {
  x: number;
  y: number;
  /** How many times to click (1 = single, 2 = double). */
  clickCount?: number;
  /** Mouse button. */
  button?: 'left' | 'right' | 'middle';
}

export interface ScrollOptions {
  /** Horizontal scroll delta (positive = right, negative = left). */
  deltaX?: number;
  /** Vertical scroll delta (positive = down, negative = up). */
  deltaY?: number;
}

export interface TypeOptions {
  /** Text to type. */
  text: string;
  /** Replace current input content instead of appending. */
  replace?: boolean;
}

export interface KeyPressOptions {
  /** Single key or key combination (e.g. 'enter', 'command+n'). */
  keys: string | string[];
}

export interface ComputerActionResult {
  output: string;
  screenshot?: string;
}

export interface OcrResult {
  text: string;
  elements?: Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface PageTextResult {
  text: string;
  url?: string;
  title?: string;
}

export interface HealthInfo {
  platform: 'darwin' | 'linux' | 'windows' | 'unknown';
  version?: string;
  screens?: ScreenInfo[];
}

export interface UIDetection {
  elements: Array<{
    id?: number;
    type: string;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  ocr_text?: string;
}

export interface RuntimeCapabilities {
  /** Whether the runtime can observe the screen (screenshot, OCR, DOM). */
  canObserve: boolean;
  /** Whether the runtime can send input (click, type, scroll). */
  canInput: boolean;
  /** Native screenshot resolution support. */
  screenshotMaxWidth?: number;
  /** Whether the runtime supports Chrome Bridge DOM automation. */
  supportsChromeBridge: boolean;
  /** Whether the runtime supports OCR-based UI detection. */
  supportsOcr: boolean;
  /** Whether the runtime supports user interference detection. */
  supportsInterferenceDetection: boolean;
}

export const ComputerUseRuntimeToken = Symbol('ComputerUseRuntime');

export interface ComputerUseRuntime {
  /** Human-readable name for debugging / feature flag reporting. */
  readonly name: string;
  /** Advertised capabilities of this runtime. */
  readonly capabilities: RuntimeCapabilities;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Check whether the runtime backend is reachable and healthy. */
  health(): Promise<HealthInfo>;

  // ── Screen observation ─────────────────────────────────────────────────

  /** Capture the current screen. Returns a base64-encoded JPEG. */
  getScreenImage(options?: ScreenshotOptions): Promise<string | undefined>;

  /** Capture a thumbnail of the current screen (smaller / faster). */
  getScreenThumbnail?(options?: ScreenshotOptions): Promise<string | undefined>;

  /** List available displays. */
  listScreens(): Promise<ScreenInfo[]>;

  /** Get the native CSS-pixel dimensions of the current display. */
  getScreenSize(): Promise<{ width: number; height: number }>;

  /**
   * Perform OCR on the current screen.
   * Requires `capabilities.supportsOcr === true`.
   */
  ocrScreenshot(options?: ScreenshotOptions): Promise<OcrResult>;

  /**
   * Extract visible page text via Chrome Bridge / DOM.
   * Requires `capabilities.supportsChromeBridge === true`.
   */
  getPageText(options?: { tabHint?: string }): Promise<PageTextResult>;

  /**
   * Parse UI elements from a screenshot (via OmniParser or similar).
   * Returns typed elements with bounding boxes and OCR text.
   */
  parseUI?(imageB64: string): Promise<UIDetection>;

  // ── Window / app management ────────────────────────────────────────────

  /** Focus a specific window by its name/title. */
  focusWindow(name: string): Promise<void>;

  /** List open window titles. */
  listWindows?(): Promise<string[]>;

  /** Open an application by bundle name or path. */
  openApplication?(name: string): Promise<void>;

  /** Get bounding box of a window. */
  getWindowBounds(name: string): Promise<WindowBounds | null>;

  /**
   * Move a window to a specific display.
   * displayIndex is the 0-based index from listScreens().
   */
  moveWindowToScreen?(windowName: string, displayIndex: number): Promise<void>;

  // ── Input actions ──────────────────────────────────────────────────────

  /** Click at the specified coordinates. */
  click(options: ClickOptions): Promise<void>;

  /** Type text at the focused element. */
  type(options: TypeOptions): Promise<void>;

  /** Press a key or key combination. */
  keyPress(options: KeyPressOptions): Promise<void>;

  /** Scroll at the current cursor position. */
  scroll(options: ScrollOptions): Promise<void>;

  /** Move the mouse to coordinates. */
  mouseMove?(x: number, y: number, duration?: number): Promise<void>;

  // ── Convenience helpers ────────────────────────────────────────────────

  /**
   * Execute a high-level plan step on the host.
   * This is the primary entry point used by the CU controller's
   * adaptive loop. Subclasses can override to add domain logic,
   * but should eventually call one of the typed methods above.
   */
  executeStep(
    action: string,
    target?: string,
    options?: {
      text?: string;
      x?: number;
      y?: number;
      keys?: string | string[];
      windowName?: string;
      displayIndex?: number;
      clickCount?: number;
    },
    sessionId?: string,
  ): Promise<ComputerActionResult>;

  // ── Overlay & interference ─────────────────────────────────────────────

  /** Launch the CU overlay window so the user can see what the agent is doing. */
  launchOverlay?(): Promise<void>;

  /** Start monitoring for user mouse/keyboard interference. */
  startInterferenceDetection?(): Promise<void>;

  /** Stop monitoring for user interference. */
  stopInterferenceDetection?(): Promise<void>;
}
