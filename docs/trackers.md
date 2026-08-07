# Tracker guide

Symphony includes local file and GitHub issue trackers. Select one with `tracker.kind`
in the workflow. For building another adapter, see [`INTEGRATION.md`](../INTEGRATION.md).

## File tracker

The file tracker is the default and requires no credentials:

```yaml
tracker:
  kind: file
  provider:
    dir: ./issues
  backlog_states: [backlog]
  active_states: [todo, in progress]
  terminal_states: [done, canceled]
```

Each `*.json` file directly inside `provider.dir` represents one issue. Relative paths
resolve from the workflow file. A minimal issue looks like this:

```json
{
  "id": "SYM-1",
  "identifier": "SYM-1",
  "title": "Add health check",
  "state": "backlog"
}
```

`id`, `identifier`, `title`, and `state` must be non-empty strings. Labels are trimmed,
lowercased, and deduplicated; priority is an integer from 1 to 4 or `null`; and
`dispatchable` defaults to `true`. Invalid records are omitted from board listings and
reported as errors when fetched directly.

The file tracker supports creating, editing, deleting, and transitioning issues, as well
as follow-ups and repository delivery records. Its agent tools can update state, add a
comment, or set the final result.

## GitHub tracker

The GitHub tracker reads and writes repository issues through the REST API:

```yaml
tracker:
  kind: github
  provider:
    owner: your-org
    repo: your-repo
    token_env: GITHUB_TOKEN
  backlog_states: [backlog]
  active_states: [todo, in progress]
  terminal_states: [done, canceled]
  review_state: review
```

`token_env` names the environment variable containing the token; never put the token in
the workflow. A classic token needs repository access, while a fine-grained token needs
read and write access to Issues. `provider.api_base` can override the API URL for GitHub
Enterprise.

Symphony represents state with exactly one `sym:<state>` label. An open issue without a
`sym:*` label is treated as backlog so unrelated repository issues are not dispatched.
Terminal transitions close the issue, and non-terminal transitions reopen it. Pull
requests returned by GitHub's issues endpoint are ignored.

The GitHub tracker supports board listing, creation, state changes, comments, and agent
results. Editing, deletion, same-branch follow-ups, and delivery records are not
available because those records have no equivalent storage in the current adapter.

## Agent-facing tracker tools

Both included trackers expose host-side tools to the coding agent:

| Tool | Purpose |
|---|---|
| `update_issue_state` | Change state and optionally add a comment |
| `add_issue_comment` | Add a comment without changing state |
| `set_issue_result` | Record the final state, summary, tests, or pull request URL |

Secrets named by a tracker are removed from the child agent's environment. The tools run
inside the Symphony host, so the agent can update an issue without receiving the tracker
credential.
