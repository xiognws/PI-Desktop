import { Suspense } from "react";
import { useAppStore } from "../../stores/app-store";
import { RoutePending } from "../app/chrome";
import {
  SURFACES,
  surfaceDescriptor,
  type SurfaceShellProps,
} from "./registry";

/**
 * Renders the surface the window is on.
 *
 * Mounted surfaces, not rendered-and-hidden surfaces: the home surface stays
 * mounted for the whole session (`keepMounted`), everything else is mounted
 * only while it is active, so its bundle and its page are paid for on use.
 *
 * A surface that is not the active one is neither rendered here nor expected to
 * hide itself — the rail selects, this host mounts.
 */
export function SurfaceHost({ runtime, overlaysOpen }: SurfaceShellProps) {
  const surface = useAppStore((state) => state.surface);
  const active = surfaceDescriptor(surface);

  return (
    <Suspense fallback={<RoutePending />}>
      {SURFACES.filter(
        (descriptor) =>
          descriptor.keepMounted || descriptor.id === active.id,
      ).map((descriptor) => {
        const Shell = descriptor.shell;
        return (
          <Shell
            key={descriptor.id}
            runtime={runtime}
            overlaysOpen={overlaysOpen}
          />
        );
      })}
    </Suspense>
  );
}
