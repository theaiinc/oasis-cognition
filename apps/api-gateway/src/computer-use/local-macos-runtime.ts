/**
 * LocalMacOSRuntime — ComputerUseRuntime implementation that talks to the
 * local dev-agent (OasisScreenCapture.app / OasisComputerControl.app).
 *
 * This is the CURRENT backend — it uses macOS-native binaries for screen
 * capture, mouse/keyboard control, and Chrome Bridge for DOM automation.
 */

import axios from 'axios';
import { Logger } from '@nestjs/common';
import type {
  ComputerUseRuntime,
  ComputerActionResult,
  HealthInfo,
  ScreenInfo,
  ScreenshotOptions,
  ClickOptions,
  TypeOptions,
  KeyPressOptions,
  ScrollOptions,
  OcrResult,
  PageTextResult,
  WindowBounds,
  RuntimeCapabilities,
} from './computer-use-runtime.interface';

const ACTION_TIMEOUT_MS = 30_000;

export class LocalMacOSRuntime implements ComputerUseRuntime {
  readonly name = 'local-macos';
  readonly capabilities: RuntimeCapabilities = {
    canObserve: true,
    canInput: true,
    screenshotMaxWidth: 1024,
    supportsChromeBridge: true,
    supportsOcr: true,
    supportsInterferenceDetection: true,
  };

  private readonly logger = new Logger(LocalMacOSRuntime.name);
  private readonly client;

  constructor(private readonly devAgentUrl: string) {
    this.client = axios.create({
      baseURL: devAgentUrl,
      timeout: ACTION_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async health(): Promise<HealthInfo> {
    const { data } = await this.client.get('/health', { timeout: 5000 });
    return {
      platform: data?.platform || 'unknown',
      version: data?.version,
      screens: data?.screens,
    };
  }

  // ── Screen observation ─────────────────────────────────────────────────

  async getScreenImage(options?: ScreenshotOptions): Promise<string | undefined> {
    const payload: Record<string, any> = { tool: 'computer_action', action: 'screenshot' };
    if (options?.scale) {
      payload.scale = options.scale;
    }
    if (options?.region) {
      payload.screen_region = options.region;
    }

    try {
      const { data } = await this.client.post('/internal/dev-agent/execute', payload);
      if (data?.screenshot) {
        const b64Len = data.screenshot.length;
        if (b64Len > 20_000) {
          return data.screenshot;
        }
        this.logger.warn(
          `Native screenshot appears blank (${b64Len} chars) — Screen Recording permission may not be granted`,
        );
      }
    } catch {
      this.logger.warn('Native screenshot failed');
    }
    return undefined;
  }

  async listScreens(): Promise<ScreenInfo[]> {
    try {
      const { data } = await this.client.post('/internal/dev-agent/execute', {
        tool: 'computer_action',
        action: 'list_screens',
      });
      return data?.screens || [];
    } catch {
      return [];
    }
  }

  async getScreenSize(): Promise<{ width: number; height: number }> {
    try {
      const { data } = await this.client.post('/internal/dev-agent/execute', {
        tool: 'computer_action',
        action: 'get_screen_size',
      });
      const sizeMatch = data?.output?.match(/(\d+)x(\d+)/);
      if (sizeMatch) {
        return { width: parseInt(sizeMatch[1], 10), height: parseInt(sizeMatch[2], 10) };
      }
    } catch { /* fall through */ }
    return { width: 1920, height: 1080 };
  }

  async ocrScreenshot(options?: ScreenshotOptions): Promise<OcrResult> {
    const payload: Record<string, any> = { tool: 'computer_action', action: 'ocr_screenshot' };
    if (options?.region) {
      payload.screen_region = options.region;
    }

    const { data } = await this.client.post('/internal/dev-agent/execute', payload, {
      timeout: 30_000,
    });

    return {
      text: data?.output || '',
      elements: data?.elements,
    };
  }

  async getPageText(options?: { tabHint?: string }): Promise<PageTextResult> {
    const { data } = await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'get_page_text',
      ...(options?.tabHint ? { text: options.tabHint } : {}),
    });

    if (data?.success && data.output) {
      const raw = data.output as string;
      const urlMatch = raw.match(/^URL:\s*(.+)$/m);
      const titleMatch = raw.match(/^Title:\s*(.+)$/m);
      const contentIdx = raw.indexOf('Page content:\n');
      const pageContent = contentIdx >= 0
        ? raw.slice(contentIdx + 'Page content:\n'.length).trim()
        : '';

      return {
        text: pageContent,
        url: urlMatch ? urlMatch[1].trim() : undefined,
        title: titleMatch ? titleMatch[1].trim() : undefined,
      };
    }

    return { text: '' };
  }

  // ── Window / app management ────────────────────────────────────────────

  async focusWindow(name: string): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'focus_window',
      text: name,
    }).catch(() => { /* best effort */ });
  }

  async getWindowBounds(name: string): Promise<WindowBounds | null> {
    try {
      const { data } = await this.client.post('/internal/dev-agent/execute', {
        tool: 'computer_action',
        action: 'get_window_bounds',
        text: name,
      });
      return data?.bounds || null;
    } catch {
      return null;
    }
  }

  async openApplication(name: string): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'open_app',
      text: name,
    });
  }

  async moveWindowToScreen(windowName: string, displayIndex: number): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'move_window_to_screen',
      text: windowName,
      x: displayIndex,
    }).catch(() => { /* best effort */ });
  }

  // ── Input actions ──────────────────────────────────────────────────────

  async click(options: ClickOptions): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'click',
      x: options.x,
      y: options.y,
      ...(options.clickCount && options.clickCount > 1 ? { click_count: options.clickCount } : {}),
      ...(options.button && options.button !== 'left' ? { button: options.button } : {}),
    });
  }

  async type(options: TypeOptions): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'type_text',
      text: options.text,
      ...(options.replace ? { replace: true } : {}),
    });
  }

  async keyPress(options: KeyPressOptions): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'hotkey',
      keys: typeof options.keys === 'string' ? options.keys : options.keys.join(','),
    });
  }

  async scroll(options: ScrollOptions): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'scroll',
      deltaX: options.deltaX ?? 0,
      deltaY: options.deltaY ?? 0,
    });
  }

  async mouseMove(x: number, y: number, duration?: number): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'mouse_move',
      x,
      y,
      ...(duration !== undefined ? { duration } : {}),
    });
  }

  // ── Chrome-specific helpers ────────────────────────────────────────────

  async chromeNavigate(url: string, screenRegion?: { x: number; y: number; width: number; height: number }): Promise<void> {
    const payload: Record<string, any> = {
      tool: 'computer_action',
      action: 'chrome_navigate',
      text: url,
    };
    if (screenRegion) {
      payload.x = screenRegion.x;
      payload.y = screenRegion.y;
      payload.screen_region = { ...screenRegion };
    }
    await this.client.post('/internal/dev-agent/execute', payload);
  }

  async chromeSetUrl(url: string, options?: { tabHint?: string; newTab?: boolean }): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'chrome_set_url',
      text: url,
      ...(options?.tabHint ? { url_hint: options.tabHint } : {}),
      ...(options?.newTab !== undefined ? { new_tab: options.newTab } : {}),
    });
  }

  async switchTab(target: string): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'switch_tab',
      text: target,
    });
  }

  async chromeBridgeType(text: string, replace?: boolean): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'chrome_bridge_type',
      text,
      ...(replace ? { replace: true } : {}),
    });
  }

  async clickUIElement(text: string): Promise<void> {
    await this.client.post('/internal/dev-agent/execute', {
      tool: 'computer_action',
      action: 'click_ui_element',
      text,
    });
  }

  // ── Overlay & interference ─────────────────────────────────────────────

  async launchOverlay(): Promise<void> {
    await this.client.post('/internal/dev-agent/cu-overlay/launch').catch(() => {});
  }

  async startInterferenceDetection(): Promise<void> {
    await this.client.post('/internal/dev-agent/cu-interference/start').catch(() => {});
  }

  async stopInterferenceDetection(): Promise<void> {
    await this.client.post('/internal/dev-agent/cu-interference/stop').catch(() => {});
  }

  // ── Convenience: execute a high-level step ──────────────────────────

  async executeStep(
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
    _sessionId?: string,
  ): Promise<ComputerActionResult> {
    // Delegate to the dev-agent based on the action name.
    // The caller (controller) handles focus, validation, and session-level state.
    const a = action.toLowerCase();

    if (a === 'screenshot' || a === 'read_screen') {
      const img = await this.getScreenImage();
      return { output: 'Screen captured', screenshot: img };
    }

    if (a === 'navigate' && target) {
      await this.chromeNavigate(target);
      await new Promise(r => setTimeout(r, 2500));
      const navScreen = await this.getScreenImage();
      return { output: `Navigated to ${target}`, screenshot: navScreen };
    }

    if (a === 'click' && options?.x !== undefined && options?.y !== undefined) {
      await this.click({ x: options.x, y: options.y, clickCount: options.clickCount });
      return { output: `Clicked at (${options.x}, ${options.y})` };
    }

    if (a === 'click_scoped' && target) {
      await this.clickUIElement(target);
      return { output: `Clicked scoped element: ${target}` };
    }

    if ((a === 'type' || a === 'type_text') && options?.text) {
      await this.type({ text: options.text });
      return { output: `Typed "${options.text.slice(0, 60)}"` };
    }

    if (a === 'key_press' && options?.keys) {
      await this.keyPress({ keys: options.keys });
      return { output: `Pressed key: ${options.keys}` };
    }

    if (a === 'scroll') {
      await this.scroll({ deltaX: options?.x, deltaY: options?.y });
      return { output: 'Scrolled' };
    }

    if (a === 'wait') {
      await new Promise(r => setTimeout(r, 1000));
      return { output: 'Waited 1 second' };
    }

    if (a === 'focus_window' && options?.windowName) {
      await this.focusWindow(options.windowName);
      return { output: `Focused window: ${options.windowName}` };
    }

    if (a === 'open_app' && target) {
      await this.openApplication(target);
      return { output: `Opened app: ${target}` };
    }

    if (a === 'switch_tab' && target) {
      // Try chrome_bridge type first
      try {
        await this.switchTab(target);
      } catch {
        await this.clickUIElement(target);
      }
      return { output: `Switched to tab: ${target}` };
    }

    // Generic fallthrough — call dev-agent directly with the raw action
    const payload: Record<string, any> = { tool: 'computer_action', action: a };
    if (target) payload.text = target;
    if (options?.text) payload.text = options.text;
    if (options?.x !== undefined) payload.x = options.x;
    if (options?.y !== undefined) payload.y = options.y;
    if (options?.keys) payload.keys = options.keys;

    const { data } = await this.client.post('/internal/dev-agent/execute', payload);
    return { output: data?.output || `Executed ${action}`, screenshot: data?.screenshot || undefined };
  }
}
