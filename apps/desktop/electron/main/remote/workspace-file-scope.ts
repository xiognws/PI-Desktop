import type { ProjectGroupRecord, RemoteWorkspace } from "@pi-workspace/shared";
import { nativeSessionStore } from "../native-sessions";

type FileHost = { call<T>(method: string, input?: unknown): Promise<T> };

export async function sessionForFiles(
  getHost: () => FileHost | null,
  sessionId: string,
  getSidecar?: () => FileHost | null,
): Promise<{ projectPath?: string; worktree?: unknown }> {
  if (sessionId.startsWith("native-pi:")) {
    // A legacy pi session has no host-core row and no worktree: its project is
    // the `cwd` its own file records. The store is read in main now, so this
    // needs neither the sidecar nor a "source replaced" re-check — the store is
    // a process singleton, not a swappable runtime. `getSidecar` stays in the
    // signature for the call sites that already resolve one.
    void getSidecar;
    return nativeSessionStore().get(sessionId, { messageLimit: 1 });
  }
  const owner = getHost();
  if (!owner) throw Object.assign(new Error("session source unavailable"), { errorCode: "HOST_UNAVAILABLE" });
  const { session } = await owner.call<{ session?: { projectPath?: string; worktree?: unknown } }>(
    "session.get", { id: sessionId, messageLimit: 1 },
  );
  if (getHost() !== owner) throw Object.assign(new Error("session source replaced"), { errorCode: "HOST_UNAVAILABLE" });
  if (!session) throw Object.assign(new Error("session not found"), { errorCode: "NOT_FOUND" });
  return session;
}

/** Retained file views authorize against their own durable session, not the selected project. */
export async function remoteWorkspaceForFiles(getHost: () => FileHost | null, sessionId?: string, getSidecar?: () => FileHost | null): Promise<RemoteWorkspace | null> {
  const owner = getHost();
  if (!owner) throw new Error("host unavailable");
  let path: string | undefined;
  if (sessionId) {
    const session = await sessionForFiles(getHost, sessionId, getSidecar);
    path = session.projectPath;
  } else {
    const { workspace } = await owner.call<{ workspace?: { path: string } }>("workspace.get");
    path = workspace?.path;
  }
  if (getHost() !== owner) throw Object.assign(new Error("host replaced"), { errorCode: "HOST_UNAVAILABLE" });
  if (!path?.startsWith("remote-project:")) return null;
  const { groups } = await owner.call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
  if (getHost() !== owner) throw Object.assign(new Error("host replaced"), { errorCode: "HOST_UNAVAILABLE" });
  const remote = groups.find((group) => group.primaryPath === path)?.remote;
  if (!remote) throw Object.assign(new Error("remote workspace binding unavailable"), { errorCode: "NOT_FOUND" });
  return remote;
}
