import type { Session } from "electron";
import { GEN_UI_SCHEME } from "@pi-workspace/shared";

const GEN_UI_PREFIX = `${GEN_UI_SCHEME}:`;

/**
 * Visualization frames (ADR gen-ui-inline-visualization) run model-written code
 * in this same session, so they get no permission at all — not even the ones
 * this session otherwise leaves to the platform default. The frame is sandboxed
 * without `allow-same-origin`, so its origin may read as "null"; the frame URL
 * still carries the scheme, so both are checked.
 */
export function isGenUiPermissionRequester(...urls: ReadonlyArray<string | undefined>): boolean {
  return urls.some((url) => typeof url === "string" && url.toLowerCase().startsWith(GEN_UI_PREFIX));
}

/**
 * Deny every permission request and check that comes from a visualization
 * frame, and leave every other requester on the platform default.
 *
 * Main keeps this policy even though the microphone feature that used to own
 * this handler is gone (ADR 0387): installing a handler replaces the platform
 * default for the whole session, so the "deny gen-UI, allow the rest" split is
 * what keeps both the model-written frames powerless and the app's own APIs
 * working.
 */
export function installGenUiPermissionHandlers(input: { targetSession: Session }): void {
  input.targetSession.setPermissionRequestHandler((_contents, _permission, callback, details) => {
    callback(!isGenUiPermissionRequester(details.requestingUrl));
  });

  input.targetSession.setPermissionCheckHandler((_contents, _permission, requestingOrigin, details) => {
    return !isGenUiPermissionRequester(requestingOrigin, details.requestingUrl);
  });
}
