/**
 * Repository whose release assets the remote-host lane downloads.
 *
 * Kept in one constant so the bootstrap script, the download URLs, and the
 * verification step cannot drift apart. Nothing here builds a user-facing
 * link: this build exposes no external destination.
 */
export const GITHUB_REPO = "xiognws/Pi-Workspace";
