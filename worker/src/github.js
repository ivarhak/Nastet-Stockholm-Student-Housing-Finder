// Starting the publish workflow from here rather than from GitHub's own
// `schedule:` trigger.
//
// GitHub's scheduler is best-effort and has been dropping scheduled runs
// across the platform: asking this repo for hourly runs delivered a median of
// one every 6.1 hours (Oct 4–9, 20 runs, 2.8–9.4 h apart). A workflow_dispatch
// call is not subject to that throttling, so a Cloudflare cron that dispatches
// the workflow is the dependable clock, and the workflow's own schedule stays
// only as a slow fallback in case this Worker is ever down.

const API = 'https://api.github.com';

export async function dispatchWorkflow(env, fetchImpl = fetch) {
  const repo = env.GITHUB_REPO;
  const workflow = env.WORKFLOW || 'publish.yml';
  if (!repo || !env.GITHUB_TOKEN) {
    return { ok: false, status: 0, detail: 'GITHUB_REPO or GITHUB_TOKEN not configured' };
  }
  const res = await fetchImpl(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects API calls without a User-Agent.
      'User-Agent': 'nastet-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main' }),
  });
  // 204 No Content is success; anything else carries a JSON reason worth logging.
  const detail = res.status === 204 ? '' : await res.text().catch(() => '');
  return { ok: res.status === 204, status: res.status, detail };
}
