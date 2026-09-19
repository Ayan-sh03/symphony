# Portable workspace snapshots

Phase 3 ([issue #35](https://github.com/Ayan-sh03/symphony/issues/35)) provides
provider-independent workspace transfer. The contract lives in
[`src/workspace/snapshot.ts`](../src/workspace/snapshot.ts). Execution providers
advertise `workspace-snapshot` when their sessions implement `exportSnapshot` and
`importSnapshot`; the local provider implements both.

## Version 1 format

A `WorkspaceSnapshot` is a JSON-serializable object:

| Field | Meaning |
| --- | --- |
| `version` | Exactly `1`; unknown versions are rejected. |
| `kind` | `directory` or `git`. |
| `entries` | Complete transferred working tree, with portable relative paths. |
| `git` | `null` for plain directories; Git history and index state otherwise. |

Entries are regular files (`path`, `type: "file"`, `mode`, `content`), directories
(`path`, `type: "directory"`, `mode`), or relative file symlinks (`path`,
`type: "symlink"`, `target`). Content has a decoded byte `size`, a SHA-256 `sha256`,
and canonical base64 `data`. Modes preserve ordinary permission bits, excluding
setuid, setgid, and sticky bits. POSIX permissions are restored on POSIX hosts;
Windows retains Git executable modes through the index.

Git metadata carries `headCommit`, `baseCommit`, the current `branch` (or `null`
for detached HEAD), a hashed `bundle`, and a hashed binary `indexPatch`. The
bundle contains HEAD and its complete reachable history, with no prerequisites.
The patch preserves staging independently of working files, including binary
edits, staged additions/deletions, and executable modes. Missing working files
remain deleted. Other branches, tags, reflogs, and unreachable commits are not
part of this workspace snapshot.

Git exports include tracked files and untracked files selected by
`git ls-files --others --exclude-standard`; ignored files stay on the source.
Plain-directory exports include their files and empty directories. Export never
copies Git metadata, hooks, configuration, remotes, or alternates. An imported
worktree becomes an independent repository with its own `.git` directory.
Git's regular-file symlink placeholders (`core.symlinks=false`) export as portable
symlinks. Clean tracked text files are stored as their committed bytes, so checkout
end-of-line smudging (for example `core.autocrlf=true` on Windows) is not carried
into the snapshot: an import with `core.autocrlf=false` reports no spurious
modifications. Dirty working bytes and untracked files are preserved verbatim.

## Export, stage, and import

```ts
import {
  exportWorkspaceSnapshot,
  stageWorkspaceSnapshot,
  importWorkspaceSnapshot,
} from "../src/workspace/snapshot.ts";

// Stop workspace writers first. Use the trusted stream base when available.
const snapshot = await exportWorkspaceSnapshot(sourcePath, { baseCommit });
const wire = JSON.stringify(snapshot);

// The receiver supplies its trusted base independently of the received JSON.
// Plain directories use expectedBaseCommit: null.
const options = { expectedBaseCommit: baseCommit };
const staged = await stageWorkspaceSnapshot(JSON.parse(wire), stagingParent, options);
try {
  // staged.path is a complete, verified, independent workspace.
  // The caller's checkpoint transaction can import it into a delivery branch.
} finally {
  await staged.dispose();
}

// For a fresh sandbox, publish only into an absent or empty destination.
await importWorkspaceSnapshot(destinationPath, snapshot, options);
```

The staging parent must already exist. Payloads are validated before
materialization. Git imports verify the bundle, declared HEAD, object sizes,
base ancestry, index paths, and repository integrity without checking out archive
files or executing checkout filters/hooks. Files are written into a newly owned
staging directory and hashed again. Only then can `importWorkspaceSnapshot` rename
the staged workspace into its destination. Failed staging is cleaned up;
populated destinations, including existing worktrees, are always preserved.

The local session rejects snapshots while its processes or file operations are
active, rejects other operations during a snapshot, and waits for an active
snapshot when closed. Standalone callers must keep the workspace and staging
parent quiescent and exclusively controlled; these functions do not synchronize
with arbitrary external processes.

Updating an existing delivery branch, advancing tracker state, and retaining
retry checkpoints are handled by the [checkpoint transaction](checkpoints.md).
It consumes the staged API and preserves the registered worktree and its Git
metadata instead of replacing them with an independent repository.

## Validation and limits

Defaults can be changed through the `limits` option:

| Limit | Default |
| --- | --- |
| `maxEntries` | 100,000 paths, including implicit parent directories |
| `maxFileBytes` | 64 MiB per file, index patch, or unpacked Git object |
| `maxTotalBytes` | 256 MiB of payload bytes; also bounds unpacked history bytes |
| `maxSnapshotBytes` | 384 MiB of serialized JSON |

Limits must be positive safe integers. Git subprocesses have a 60-second deadline
and bounded output. Transport adapters must also limit incoming bytes before
parsing JSON; this module receives already-parsed objects. Hashes detect corruption,
while the independently supplied expected base binds a transfer to its intended
history. They are not sender authentication.

Paths reject absolute names, traversal, backslashes, alternate data streams,
Windows device names, Git metadata aliases, malformed Unicode, non-NFC names,
case collisions, duplicates, and non-directory parents. Each component is limited
to 255 UTF-8 bytes and each path to 4,096 bytes. Links must point directly to an
included regular file using a safe relative target. Directory links, chains,
cycles, dangling links, hard links, junctions, and special files are rejected.
A platform unable to create symlinks fails import without publishing partial work.

Version 1 rejects nested repositories, submodules, unmerged indexes, intent-to-add
entries, and repositories without a commit. Resolve or stage those states before
exporting. Git index flags, sparse-checkout configuration, timestamps, ownership,
ACLs, and extended attributes are not transported.

## Verification

```bash
node --test test/workspaceSnapshot.test.ts test/executionProvider.test.ts
node --test --experimental-test-coverage --test-coverage-include=src/workspace/snapshot.ts test/workspaceSnapshot.test.ts
npm run typecheck
npm test
```

Tests cover plain directories and Git worktrees, detached HEAD, staged/unstaged
binary changes, deletions, modes, safe links, Windows symlink placeholders,
malformed archives, incorrect bases, inflated history, concurrent operations, and
preservation of existing destinations. POSIX permission and symlink tests also
run on Linux; Windows skips those two platform-specific tests.
