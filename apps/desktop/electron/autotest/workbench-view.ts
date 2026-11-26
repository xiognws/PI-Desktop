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
      void Promise.resolve(this.view.webContents.loadURL(url)).catch(
        (error: unknown) => {
          this.deps.log?.(`could not load the workbench: ${String(error)}`);
        },
      );
      return this.view;
    }
    // A different port (a restarted service) is a different page.
    if (this.url !== url) {
      this.url = url;
      void Promise.resolve(this.view.webContents.loadURL(url)).catch(
        (error: unknown) => {
          this.deps.log?.(`could not load the workbench: ${String(error)}`);
        },
      );
    }
    return this.view;
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

  /** Hide and drop the page, so the next attach loads the current URL afresh. */
  reload(): void {
    this.hide();
    const view = this.view;
    this.view = null;
    this.url = null;
    try {
      const contents = view?.webContents;
      if (contents && !(contents.isDestroyed?.() ?? false)) contents.close?.();
    } catch (error) {
      this.deps.log?.(`could not discard the workbench view: ${String(error)}`);
    }
  }
}
