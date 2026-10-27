/**
 * Thin REST client for the Autotest backend.
 *
 * `request` is injected by the plugin so every call still goes through
 * `pi.net.fetch` (permission `net.fetch`, domain 127.0.0.1) instead of an
 * unguarded global fetch. Tests pass a plain fetch-based implementation.
 */
export function createClient({ request }) {
  const call = async (path, { method = "GET", body } = {}) => {
    const response = await request(path, { method, body });
    return response;
  };

  return {
    async createPipeline(projectId, body) {
      return call(`/api/projects/${projectId}/pipelines`, { method: "POST", body });
    },
    async getPipeline(projectId, pipelineId) {
      return call(`/api/projects/${projectId}/pipelines/${pipelineId}`);
    },
    async listPipelines(projectId) {
      return call(`/api/projects/${projectId}/pipelines`);
    },
    async reportStage(projectId, pipelineId, stage, body) {
      return call(`/api/projects/${projectId}/pipelines/${pipelineId}/stages/${stage}`, {
        method: "POST",
        body,
      });
    },
    async recordCall(projectId, pipelineId, body) {
      return call(`/api/projects/${projectId}/pipelines/${pipelineId}/agent-calls`, {
        method: "POST",
        body,
      });
    },
    async resume(projectId, pipelineId, action) {
      return call(`/api/projects/${projectId}/pipelines/${pipelineId}/${action}`, { method: "POST" });
    },
    async requirementText(projectId, filename) {
      return call(`/api/projects/${projectId}/requirements/${encodeURIComponent(filename)}/content`);
    },
    async listCases(projectId) {
      return call(`/api/projects/${projectId}/cases`);
    },
    async createCase(projectId, body) {
      return call(`/api/projects/${projectId}/cases`, { method: "POST", body });
    },
    async listScripts(projectId) {
      return call(`/api/projects/${projectId}/scripts`);
    },
    async createScript(projectId, body) {
      return call(`/api/projects/${projectId}/scripts`, { method: "POST", body });
    },
    async checkScript(projectId, scriptId) {
      return call(`/api/projects/${projectId}/scripts/${scriptId}/gate`, { method: "POST" });
    },
    async scriptContent(projectId, scriptId) {
      return call(`/api/projects/${projectId}/scripts/${scriptId}/content`);
    },
    async saveScript(projectId, scriptId, content) {
      return call(`/api/projects/${projectId}/scripts/${scriptId}/content`, {
        method: "PUT",
        body: { content },
      });
    },
    async runScript(projectId, scriptId) {
      return call(`/api/projects/${projectId}/scripts/${scriptId}/run?background=true`, {
        method: "POST",
        body: {},
      });
    },
    async listExecutions(projectId) {
      return call(`/api/projects/${projectId}/executions`);
    },
    async getExecution(projectId, executionId) {
      return call(`/api/projects/${projectId}/executions/${executionId}`);
    },
    async setCaseStatus(projectId, caseId, status) {
      return call(`/api/projects/${projectId}/cases/${caseId}/status`, {
        method: "POST",
        body: { status },
      });
    },
    async readReport(projectId, pipelineId) {
      return call(`/api/projects/${projectId}/pipelines/${pipelineId}/report`);
    },
  };
}
