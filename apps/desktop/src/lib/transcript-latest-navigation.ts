type Geometry = { scrollTop: number; scrollHeight: number; clientHeight: number };
type ScrollPort = {
  geometry: () => Geometry | undefined;
  move: (top: number) => void;
  request: (frame: (now: number) => void) => number;
  cancel: (frame: number) => void;
  now: () => number;
  reducedMotion: () => boolean;
};
type Navigation = { from: number; startedAt: number; duration: number; lastTop: number; arrive: () => void };
const NO_ARRIVE = () => {};

/** One viewport owner for a short, interruptible trip through mounted content. */
export function createTranscriptLatestNavigation(port: ScrollPort) {
  let current: Navigation | undefined;
  // The accepted latest intent of a hide that stopped a trip mid-flight. It is
  // kept only until the hide carries it out, so a later reveal cannot commit
  // the same intent twice.
  let parkedArrive: (() => void) | undefined;
  let parked = false;
  let frame = 0;
  // Trip state for the explicit "show me the newest" intent. "done" means
  // that request was carried out; it stops blocking the follow-up scroll a
  // pane reveal needs, while starting a new trip still clears it.
  let phase: "idle" | "moving" | "parked" | "done" = "idle";
  // Retiring a trip can carry the accepted latest intent even when no frame is
  // left in flight: a pane hide arrives one layout after the final frame
  // already reached the bottom, and dropping the intent there would strand the
  // reader mid-history. A reader takeover therefore releases with commit
  // false, and only the explicit latest paths commit.
  const release = (commit: boolean) => {
    const previous = current;
    current = undefined;
    // A reader takeover or an unmount retires the trip; only a new start may
    // put the viewport back under this owner.
    phase = commit && previous ? "done" : "idle";
    port.cancel(frame);
    frame = 0;
    if (commit && previous) previous.arrive();
    parkedArrive = undefined;
    parked = false;
  };
  const cancel = (commit = false) => release(commit);
  /**
   * Run the accepted latest intent again from where the reader stands. Without
   * an arrival of its own the trip carries the one a parked trip stopped with,
   * so a reveal after a hide still commits the latest the reader asked for.
   * A movement too small to animate still counts as an explicit latest: the
   * reader gets the newest turn, and the intent is carried out either way.
   */
  const start = (arrive: () => void = NO_ARRIVE) => {
    // Parking keeps the accepted intent, so a start without an arrival of its
    // own inherits the one the parked trip was carrying: the reveal that
    // follows a hide still commits the latest the reader already asked for.
    // An explicit arrival replaces it, which is how a new reader intent wins
    // over a trip that was parked before it.
    const resume = phase === "parked" && parked ? parkedArrive : undefined;
    // The carried intent belongs to this trip now: retiring it must not leave
    // a stale park behind for a later reveal to run a second time.
    cancel();
    parkedArrive = undefined;
    parked = false;
    const carried = arrive === NO_ARRIVE ? (resume ?? NO_ARRIVE) : arrive;
    phase = "moving";
    const geometry = port.geometry();
    const target = geometry ? Math.max(0, geometry.scrollHeight - geometry.clientHeight) : 0;
    const distance = geometry ? Math.max(0, target - geometry.scrollTop) : 0;
    if (!geometry || geometry.clientHeight <= 0 || port.reducedMotion() || distance <= 1) {
      port.move(target);
      phase = "done";
      carried();
      return;
    }
    const navigation: Navigation = { from: geometry.scrollTop, lastTop: geometry.scrollTop,
      startedAt: port.now(), duration: Math.min(420, Math.max(180, distance / 30)), arrive: carried };
    current = navigation;
    const advance = (now: number) => {
      frame = 0;
      if (current !== navigation) return;
      const box = port.geometry();
      if (!box || box.clientHeight <= 0) { cancel(true); return; }
      const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
      const progress = Math.min(1, Math.max(0, (now - navigation.startedAt) / navigation.duration));
      const eased = 1 - (1 - progress) ** 3;
      // Retarget late content growth without reversing the reader's movement.
      const top = Math.min(bottom, Math.max(navigation.lastTop,
        navigation.from + (bottom - navigation.from) * eased));
      navigation.lastTop = top;
      port.move(top);
      if (progress === 1) {
        current = undefined;
        phase = "done";
        navigation.arrive();
      } else frame = port.request(advance);
    };
    frame = port.request(advance);
  };
  // A trip still in flight is parked: it stops owning the viewport and keeps
  // its accepted intent, because a pane that hides one layout later still lands
  // the reader on the newest turn. A reduced-motion or zero-distance trip
  // already reached bottom inside start(), so it has nothing to park.
  const landed = () => {
    const moving = phase === "moving";
    const flight = current;
    if (moving) {
      parked = true;
      // The arrival is kept, not the phase alone: a reveal has to run the
      // intent the reader accepted, and an in-flight trip is the one place it
      // is still recorded.
      parkedArrive = flight?.arrive;
      phase = "parked";
    }
    // A hidden box cannot animate and its frames would measure a layout nobody
    // sees, so the accepted intent is carried out here in one step: the trip
    // lands on the newest turn it was already travelling to, instead of
    // reversing when the pane comes back.
    if (phase === "parked" && parkedArrive && flight) {
      const arrival = parkedArrive;
      const bottom = port.geometry();
      parkedArrive = undefined;
      parked = false;
      phase = "done";
      const target = bottom ? Math.max(0, bottom.scrollHeight - bottom.clientHeight) : flight.lastTop;
      port.move(target);
      arrival();
    }
    current = undefined;
    port.cancel(frame);
    frame = 0;
    return moving;
  };
  /**
   * A reveal re-claims the viewport. A parked trip — or one that never received
   * a frame while the pane was hidden — is carried out here in a single step:
   * the reveal's layout is not the reader's position, so animating through it
   * would paint motion nobody asked for. A finished trip keeps its bottom and a
   * trip the reader interrupted keeps control of the viewport.
   */
  const settle = () => {
    const flight = current;
    const moving = phase === "moving";
    if (!moving && !parked) return;
    current = undefined;
    port.cancel(frame);
    frame = 0;
    const arrival = moving ? flight?.arrive : parkedArrive;
    parkedArrive = undefined;
    parked = false;
    phase = "idle";
    if (!arrival) return;
    phase = "done";
    arrival();
  };
  return {
    start, cancel, landed, settle,
    // A completed trip must not keep scrollToBottom blocked: the reveal that
    // follows a pane hide lands on the newest turn instead of a stale offset.
    phase: () => phase,
  };
}
