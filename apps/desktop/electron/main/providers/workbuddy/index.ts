/**
 * WorkBuddy as an in-app provider.
 *
 * The gateway behind this descriptor is the vendored MIT bridge in this
 * directory (`server.cjs` / `core.cjs` / `dashboard.cjs` / `home.cjs`, taken
 * from the `community.workbuddy-connect` plugin). `gateway.cjs` is our own
 * transport shim; it is the only file here we wrote.
 *
 * The bridge reads the login the WorkBuddy desktop client already made
 * (`~/.pi-workbuddy-connect` for our own copy of its credential), which is why
 * no API key is ever pasted by the user: the loopback key is generated here,
 * handed to the gateway, and stored on the provider row as its secret.
 */
import type { InAppProvider } from "../types.ts";

export const WORKBUDDY_PRODUCT = "workbuddy";

export const workbuddyProvider: InAppProvider = {
  id: "workbuddy",
  label: "WorkBuddy",
  defaultPort: 18765,
  healthPath: "/healthz",
  // The bridge answers `/<product>/v1/...`; omitting `/v1` answers
  // `{"message":"Unknown bridge endpoint"}`, so the base URL carries it.
  openaiBasePath: `/${WORKBUDDY_PRODUCT}/v1`,
  product: WORKBUDDY_PRODUCT,
  creditsPath: `/${WORKBUDDY_PRODUCT}/v1/credits`,
};

export default workbuddyProvider;
