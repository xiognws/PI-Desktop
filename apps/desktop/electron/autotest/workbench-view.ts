/**
 * The AutoTest workbench, composited inside the main window.
 *
 * Until the surface existed this page only ever appeared in its own
 * `BrowserWindow`, opened from the application menu. The surface needs the same
 * page in the main window's main pane, so this module owns exactly one
 * `WebContentsView` and the rules around it:
 *
 * - it is created once and kept warm, so hiding the surface (or opening an
 *   overlay above it) does not reload the workbench and lose its in-page state;
 * - it is only attached while the surface is visible, because a
 *   `WebContentsView` always draws above renderer content — the renderer stays
 *   the visibility authority, as it is for plugin work-panel views;
 * - it loads loopback URLs only, through the same guard the window uses.
 *
 * Electron is injected rather than imported, so `node --test` can drive the
 * whole lifecycle with a fake view and no Electron process (same seam as
 * `autotest/window.ts`).
 */

import { WORKBENCH_THEME_CSS, workbenchThemeScript, type WorkbenchTheme } from "./workbench-theme";

export type WorkbenchBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** The subset of `WebContentsView` this module uses. */
export type WorkbenchViewLike = {
  webContents: {
    loadURL(url: string): Promise<unknown> | unknown;
    isDestroyed?: () => boolean;
    close?: () => void;
    /** Present on a real `WebContents`; the fake in tests may omit them. */
    insertCSS?: (css: string) => Promise<unknown> | unknown;
    executeJavaScript?: (code: string) => Promise<unknown> | unknown;
    /**
     * `webContents.on`. Present on a real `WebContents` only: the fake in tests
     * omits it, and the module then relies on the `loadURL` promises alone.
     */
    on?: (
      event: "did-start-loading" | "did-finish-load",
      listener: () => void,
    ) => void;
  };
  setBounds(bounds: WorkbenchBounds): void;
};

export type WorkbenchViewDeps = {
  /** Adds the view above renderer content (`contentView.addChildView`). */
  addView: (view: WorkbenchViewLike) => void;
  /** Removes it again (`contentView.removeChildView`). */
  removeView: (view: WorkbenchViewLike) => void;
  /** The window's current zoom factor; a CSS-pixel rect scales by it. */
  zoomFactor: () => number;
  createView: () => WorkbenchViewLike;
  log?: (message: string) => void;
};

/** CSS pixels → DIPs. Local copy keeps this module free of Electron imports. */
export function scaleWorkbenchBounds(
  bounds: WorkbenchBounds,
  zoomFactor: number,
): WorkbenchBounds {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: Math.max(0, Math.round((Number(bounds.x) || 0) * zoom)),
    y: Math.max(0, Math.round((Number(bounds.y) || 0) * zoom)),
    width: Math.max(0, Math.round((Number(bounds.width) || 0) * zoom)),
    height: Math.max(0, Math.round((Number(bounds.height) || 0) * zoom)),
  };
}

/** A rect too small to see is treated as "not measured yet" by the caller. */
export function boundsAreUsable(bounds: WorkbenchBounds | null | undefined): boolean {
  return (
    !!bounds &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 32 &&
    bounds.height >= 32
  );
}

export class AutotestWorkbenchView {
  private view: WorkbenchViewLike | null = null;
  private url: string | null = null;
  private attached = false;
  private cssBounds: WorkbenchBounds | null = null;
  private theme: WorkbenchTheme | null = null;
  private themeCssInserted = false;
  private readonly deps: WorkbenchViewDeps;

  // Assigned rather than declared as a parameter property: `node --test` strips
  // types instead of compiling them, and it rejects parameter properties.
  constructor(deps: WorkbenchViewDeps) {
    this.deps = deps;
  }

  private ensureView(url: string): WorkbenchViewLike {
    if (!this.view) {
      this.view = this.deps.createView();
      this.url = url;
      this.watchDocumentLoads(this.view);
      void Promise.resolve(this.view.webContents.loadURL(url))
        .then(() => this.applyThemeNow())
        .catch((error: unknown) => {
          this.deps.log?.(`could not load the workbench: ${String(error)}`);
        });
      return this.view;
    }
    // A different port (a restarted service) is a different page.
    if (this.url !== url) {
      this.url = url;
      // A new document starts without the stylesheet the old one carried.
      this.themeCssInserted = false;
      void Promise.resolve(this.view.webContents.loadURL(url))
        .then(() => this.applyThemeNow())
        .catch((error: unknown) => {
          this.deps.log?.(`could not load the workbench: ${String(error)}`);
        });
    }
    return this.view;
  }

  /**
   * Re-apply the palette whenever a document arrives.
   *
   * The `loadURL` promises cover the loads this module starts, but the page can
   * also reload itself — then nothing in this module runs until the next attach,
   * and the page wears its own chrome (its title bar, its own environment strip)
   * in the meantime. `did-finish-load` is the one signal every document gives.
   *
   * The guard is cleared when a document *starts*, not when it finishes, so each
   * document gets the stylesheet exactly once: the `loadURL` promise and the
   * event both end up calling `applyThemeNow`, and whichever runs second finds
   * `themeCssInserted` already true.
   */
  private watchDocumentLoads(view: WorkbenchViewLike): void {
    const contents = view.webContents;
    if (!contents.on) return;
    contents.on("did-start-loading", () => {
      this.themeCssInserted = false;
    });
    contents.on("did-finish-load", () => {
      this.applyThemeNow();
    });
  }

  /**
   * Hand the page the host's palette.
   *
   * The stylesheet is injected once per page — `insertCSS` persists for the
   * webContents' lifetime — while the class toggle runs on every call, because a
   * reload or an earlier session may have left the other theme in place.
   */
  applyTheme(theme: WorkbenchTheme): void {
    this.theme = theme;
    this.applyThemeNow();
  }

  private applyThemeNow(): void {
    const contents = this.view?.webContents;
    if (!contents) return;
    if (!this.themeCssInserted && contents.insertCSS) {
      this.themeCssInserted = true;
      try {
        void Promise.resolve(contents.insertCSS(WORKBENCH_THEME_CSS)).catch(
          (error: unknown) => {
            this.themeCssInserted = false;
            this.deps.log?.(`could not inject the workbench palette: ${String(error)}`);
          },
        );
      } catch (error) {
        this.themeCssInserted = false;
        this.deps.log?.(`could not inject the workbench palette: ${String(error)}`);
      }
    }
    if (!contents.executeJavaScript) return;
    const theme = this.theme;
    if (!theme) return;
    try {
      void Promise.resolve(contents.executeJavaScript(workbenchThemeScript(theme))).catch(
        (error: unknown) => {
          this.deps.log?.(`could not apply the workbench theme: ${String(error)}`);
        },
      );
    } catch (error) {
      this.deps.log?.(`could not apply the workbench theme: ${String(error)}`);
    }
  }

  /** Where the view currently sits, in CSS pixels, or null before first measure. */
  lastBounds(): WorkbenchBounds | null {
    return this.cssBounds;
  }

  isAttached(): boolean {
    return this.attached;
  }

  /** True once a page was requested; used to report "already loading". */
  hasView(): boolean {
    return this.view !== null;
  }

  /**
   * Attach the workbench and place it.
   *
   * `bounds` arrives from the renderer, which measures the pane it reserved.
   * An unusable rect attaches nothing: a zero-sized view would be a blank
   * rectangle over the surface instead of the surface's own placeholder.
   */
  show(url: string, bounds: WorkbenchBounds): void {
    this.cssBounds = bounds;
    if (!boundsAreUsable(bounds)) {
      this.deps.log?.("workbench bounds are not usable yet; deferring attach");
      return;
    }
    const view = this.ensureView(url);
    if (!this.attached) {
      this.deps.addView(view);
      this.attached = true;
    }
    view.setBounds(scaleWorkbenchBounds(bounds, this.deps.zoomFactor()));
    // A page that reloaded itself (or was left on the other theme) is corrected
    // here rather than only at creation time.
    this.applyThemeNow();
  }

  /** Re-place the view without changing what is loaded. */
  setBounds(bounds: WorkbenchBounds): void {
    this.cssBounds = bounds;
    if (!this.view || !this.attached) return;
    if (!boundsAreUsable(bounds)) return;
    this.view.setBounds(scaleWorkbenchBounds(bounds, this.deps.zoomFactor()));
  }

  /** Re-apply the stored rect after the window zoom changed. */
  resyncZoom(): void {
    if (!this.cssBounds) return;
    this.setBounds(this.cssBounds);
  }

  /** Detach without destroying: in-page state and scroll survive a hide. */
  hide(): void {
    if (!this.view || !this.attached) return;
    try {
      this.deps.removeView(this.view);
    } catch (error) {
      this.deps.log?.(`could not detach the workbench view: ${String(error)}`);
    }
    this.attached = false;
  }

  /** Where the page currently is, as a path (`/project/<id>/pipeline`). */
  location(): string {
    if (!this.url) return "/";
    try {
      return new URL(this.url).pathname || "/";
    } catch {
      return "/";
    }
  }

  /**
   * Send the page somewhere else.
   *
   * The workbench menu is drawn by the shell's sidebar now, but the router lives
   * in the page, so a click loads the target route in the same view. The service
   * answers locally, so this is a page load against loopback, not a network wait.
   */
  navigate(path: string): string {
    const target = path.startsWith("/") ? path : `/${path}`;
    if (!this.view || !this.url) return this.location();
    try {
      const base = new URL(this.url).origin;
      this.url = `${base}${target}`;
      // A navigation is a new document. `insertCSS` belongs to the document it
      // was injected into, so the stylesheet that hides the page's own title bar
      // and menu goes with the old one — and the "already inserted" guard would
      // then leave the new page wearing its own chrome.
      this.themeCssInserted = false;
      void Promise.resolve(this.view.webContents.loadURL(this.url))
        .then(() => this.applyThemeNow())
        .catch((error: unknown) => {
          this.deps.log?.(`could not navigate the workbench: ${String(error)}`);
        });
    } catch (error) {
      this.deps.log?.(`could not navigate the workbench: ${String(error)}`);
    }
    return target;
  }

  /** Hide and drop the page, so the next attach loads the current URL afresh. */
  reload(): void {
    this.hide();
    const view = this.view;
    this.view = null;
    this.url = null;
    // The stylesheet went with the page; the next one gets it again.
    this.themeCssInserted = false;
    try {
      const contents = view?.webContents;
      if (contents && !(contents.isDestroyed?.() ?? false)) contents.close?.();
    } catch (error) {
      this.deps.log?.(`could not discard the workbench view: ${String(error)}`);
    }
  }
}
