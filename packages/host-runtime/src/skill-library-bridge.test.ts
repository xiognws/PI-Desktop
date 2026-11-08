import { afterEach, expect, it } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

const source = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map();rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;
let sidecar: AgentSidecar | undefined;
afterEach(async () => { await sidecar?.dispose(); });

// ADR 0377: the background skill review writes through `skill_manage`, and every
// one of its actions is a `skills.*` RPC. A method missing from the sidecar's
// proxy allowlist fails closed with -32601, which the review reports as
// "skill_manage writes are disabled in this environment" and the library never
// grows. This pins the write path, not the whole RPC surface.
it("forwards the skill library write methods through the production sidecar bridge", async () => {
  sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr: () => {} });
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: SidecarHostLink = {
    call: async <T>(method: string, params?: unknown) => { calls.push({ method, params }); return { ok: true } as T; },
    onNotification: () => () => {}, onExit: () => () => {},
  };
  sidecar.setHost(host);
  for (const method of ["skills.create", "skills.read", "skills.update", "skills.writeFile", "skills.removeFile", "skills.remove"]) {
    const params = { id: "lesson" };
    await expect(sidecar.call("probe", { method, params })).resolves.toEqual({ ok: true });
    expect(calls.at(-1)).toEqual({ method, params });
  }
  // Anything that mutates configuration or reaches outside the library stays out.
  await expect(sidecar.call("probe", { method: "skills.import", params: {} })).rejects.toMatchObject({ code: -32601 });
  await expect(sidecar.call("probe", { method: "skills.setBuiltinEnabled", params: {} })).rejects.toMatchObject({ code: -32601 });
  expect(calls).toHaveLength(6);
});
