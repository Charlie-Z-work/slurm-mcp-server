# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added
- Offline release gate: `npm test` (Node built-in `node:test`, no new
  dependencies) runs unit tests for the pure helpers, MCP stdio protocol tests
  against a fake `ssh`/`rsync` (`test/fake-bin/`, scenarios `normal`, `array`,
  `cancelled_by`, `master_dead`, `sbatch_fail`) and an `npm pack` check.
- GitHub Actions CI on Node 18 / 20 / 22 (`npm ci && npm test`).
- `scripts/live-smoke.mjs` (`npm run test:live`): manual end-to-end smoke test
  against a real cluster. It submits a real array job and deletes its self-test
  directory; never run in CI.
- `SLURM_MCP_NO_START=1` imports `index.mjs` without starting the poller, the
  stdin lifecycle hooks or the stdio transport; pure helpers are exported.
- `SLURM_MCP_POLL_MS` overrides the watch poll interval (default unchanged: 30s).
- `SLURM_DEFAULT_PARTITION` (default `batch`) and `SLURM_DEFAULT_GPUS`
  (default `1`; `0` writes no `--gres` line) set the `slurm_submit` defaults.
  Sites without GPUs: set `SLURM_DEFAULT_GPUS=0`.
- README "Known limitations" section.
- Two documented SSH modes: ControlMaster (MFA clusters) or, when
  `ssh -O check` reports "No ControlPath specified", direct
  `ssh -o BatchMode=yes` connections (key-based login without MFA).
  `ssh_status` says "ControlMaster not configured — direct BatchMode
  connections". `HPC_REQUIRE_MASTER=1` treats a missing ControlPath as a dead
  master. Offline tests: fake-ssh scenario `master_unconfigured`, per-host
  scenarios (`FAKE_SCENARIO_BY_HOST`), a fake `tmux`.

### Changed
- `package-lock.json` is now committed (required by `npm ci`).
- Startup validates the environment and exits with an error on invalid
  values (no entry may start with `-`): `HPC_HOST` `[\w.-]+` with an optional
  `user@` prefix, `HPC_USER` `[\w.@\\-]+` (AD/LDAP/Kerberos names; always
  single-quoted in remote commands), `SLURM_ACCOUNT` `[\w.-]+`,
  `SLURM_DEFAULT_PARTITION` `[\w.-]+` (same whitelist as the `partition`
  parameter, e.g. `gpu.a100`), `HPC_RESOURCE_LOG` a safe path,
  `SLURM_DEFAULT_GPUS` a non-negative integer.
- `SLURM_ACCOUNT` is optional: unset/empty writes no `#SBATCH --account` line
  (site default account); an empty list entry means "none" for that cluster.
  Only `HPC_HOST` and `HPC_USER` are required (smithery.yaml too).
- Watch expiry: a watch expires only after successful sacct queries of its
  cluster have not reported the job for max(48h, 4 × time limit)
  (`unseenSince`, set on the first such query and cleared when the job shows
  up). A dead master or failing sacct no longer counts toward expiry.
  `lastSeenAt` is no longer written or used.
- Poll backoff is per cluster: a failing host is skipped (no ssh, not even
  `ssh -O check`) until its own next attempt; the loop keeps the base interval
  for healthy clusters. Only crashing poll cycles back off the whole loop.
- `withFileLock`: the holder writes `owner.json` (pid, host, time, token). A
  lock is reclaimed only when its owner pid is gone (or, for owner-less legacy
  locks, when older than 10s); a live owner is never preempted — waiters fail
  open at the 2s deadline. Reclaim runs under a `.reclaim` guard, re-checks
  staleness, and deletes the stale dir (never puts it back). Release only
  removes the caller's own lock.
- `parseMemToMB`: a suffix-less sacct value is read as KB (was bytes): sacct
  normally prints a unit suffix, and KB never under-states the peak 1024×.
- `terminal_send` / `terminal_exec` / `ssh_interactive` send text with
  `tmux send-keys -l --` (literal, never parsed as an option); `Enter` and
  other key names are sent as keys, `Ctrl-C` is accepted as `C-c`.
- `sync_files` passes `--` before the rsync paths.
- `@modelcontextprotocol/sdk` lower bound raised to `^1.29.0`, the version the
  test suite runs against (package-lock).

- `ssh_exec` `timeout` must be an integer 1000–600000 ms (0 meant "no
  timeout" for a synchronous call and could block the server forever).
- `resource_check` matches the pattern against recent COMPLETED jobs (still a
  case-insensitive substring) and then reads every row of those jobs,
  including `.batch`/`.extern` steps.

### Fixed
- Env validation rejected valid values: `HPC_HOST=user@host`,
  `HPC_USER=u@ad.example.edu`, `SLURM_DEFAULT_PARTITION=gpu.a100` (and the
  `partition` parameter `gpu.a100`). `ssh_interactive` keeps the `@` of
  `user@host`.
- Without a ControlPath, `ssh -O check` always fails ("No ControlPath
  specified"), so every tool reported a dead master; see the two SSH modes
  above.
- Stale lock reclaim could put a moved lock back over a lock that a third
  process had just created (see `withFileLock` above).
- A master outage longer than the watch TTL expired the watches of that
  cluster (see watch expiry above).
- Server shutdown deleted the heartbeat file even when a newer server in the
  same tty had already replaced it; it now removes the file only if its pid is
  its own.
- A dead master on one cluster delayed notifications of every other cluster
  (see per-cluster backoff above).
- `slurm_logs` on an array base id: `scontrol show job` prints one `StdOut=`
  per task; the multi-line value was rejected as "Suspicious log path". The
  first path is used. (`%j` of an array task is deliberately not expanded from
  `12345_1`: in SLURM it is the task's own job id; `%A_%a` is expanded.)
- Watch file entries: `host` is checked with the `HPC_HOST` whitelist before it
  reaches `ssh -O check`; a numeric `jobId` is converted to a string instead
  of dropping the watch.
- `resource_check` / `resource_report` computed the sacct start date with GNU
  `date -d` on the cluster; it is now computed locally (`-S YYYY-MM-DD`). The
  history filter accepts heterogeneous job ids (`12345+0`).
- `slurm_submit` / `slurm_submit_file`: when sbatch's stderr mentions
  gres/GPU, the error adds "this site may not offer GPUs: set
  SLURM_DEFAULT_GPUS=0 or pass gpus:0" (the default stays 1).
- Removed a no-op ternary (`X.length > 1 ? X[0] : X[0]`) for the user/account
  defaults.
- Relative `output_dir` with a workdir: `mkdir` and `#SBATCH --output` now use
  the same absolute directory (logs used to land relative to `$HOME`).
- `ssh_exec` output filter: compound commands (`&&`, `;`, `|`) starting with
  `cd`/`mkdir`/`source`/`ls`… are no longer cut to one line / 30 lines.
- Command Guard: 3-line commands are blocked (">2 lines" needed 4 before),
  `<<-EOF` heredocs are blocked (also in `terminal_send`), and `python3.11 -c`,
  `python -u -c`, `python -uc` are caught.
- Malformed entries in `slurm-watches.json` (e.g. `null`) are skipped instead
  of throwing; watch registration runs in its own try/catch, so a successful
  sbatch is never reported as "Submit failed" (`slurm_submit` and
  `slurm_submit_file` say the job IS queued and warn instead).
- Heterogeneous job ids (`12345+0`, `12345+1.batch`) are parsed; the watch
  completes when every component is terminal.
- `time` is trimmed before validation; the validated string is the one written
  to `#SBATCH --time`.
- Resource history counts distinct jobs, not `.batch`/`.extern` step rows.
- `dependency`: `after*` types require at least one job id, `singleton` takes
  none. `array` accepts range steps (`1-10:2`).
- Stale lock reclaim in `withFileLock` can no longer delete a fresh lock when
  two waiters act on the same stale observation (owner-based reclaim, see
  Changed).
- `ssh -O check` (poller liveness probe and `ssh_status`) is spawned with an
  argv array instead of a shell string (the host comes from the shared watch
  file).
- Watches are keyed by host + job id: the same job id on two clusters no
  longer removes the other cluster's watch (poll write-back and
  `slurm_cancel`, which only removes the active cluster's watch).
- The poller heartbeat is written by its own 30s timer from startup, not by the
  poll loop: poll backoff (up to 10 min) used to make live servers look dead,
  and their watches were adopted by other windows.
- A poll cycle that throws no longer stops polling forever (or crashes the
  process): the error is recorded in `lastPollError` and counted toward backoff.
- A completion notification that cannot be written to disk keeps the watch
  and is retried next cycle instead of being lost.
- Watch expiry no longer counts from submission, so jobs that queue for days
  keep their watch (see `unseenSince` under Changed).
- `resource_check` / `slurm_submit` memory history: MaxRSS is read from the
  step rows (the allocation row has none), so peak memory is no longer always
  missing. MaxRSS parsing handles decimals and `T`/`P` units
  (`parseMemToMB`); `resource_report` takes each job's peak over its steps.
- ssh or sacct failures in the resource history are reported as
  "resource history unavailable: <reason>" (also for `HPC_RESOURCE_LOG`
  errors); only a real absence of data suggests running a benchmark.
- `sshExec` only rewrites an error as "SSH connection failed mid-command" when
  ssh itself failed (exit 255), not when the remote command's stderr happens to
  contain "Connection refused".
- `slurm_logs`: a sacct `StdOut` with unexpanded `%j`/`%A`/`%a` is not used
  as-is; scontrol is asked, then the placeholders are expanded from the job id
  when possible, then the workdir log dirs (incl. `slurm_<A>_<a>.out`) are
  searched.
- `slurm_status`: squeue failing (job already left the queue) no longer hides
  the sacct history; only both failing is an error.
- `cluster_info` / partition hints: a failing `sacctmgr` keeps the partition
  MaxTime and prints "QoS limits unavailable".
- The server declares `capabilities.logging`, so job-completion
  `notifications/message` are actually sent (the SDK dropped them silently),
  and `instructions` are passed as a server option (they were ignored). "MCP
  logging notification sent" is logged only after the send resolved.
- Removed unused locals (`gpuH`) and an extra tmux `capture-pane` call in
  `ssh_interactive`. `atomicWriteJson` removes its tmp file when the rename fails.

## 2.2.0 - 2026-09-27

### Added
- Array-aware job watches: sacct ids (`.batch`/`.extern` steps, `_N`, `_[..]`
  ranges) are normalized to the base id and every task state is collected. The
  watch notifies only once all tasks are terminal, with an "N ok / M failed"
  tally; partial arrays stay RUNNING/PENDING with progress shown in
  `slurm_watches`.
- `slurm_submit` `dependency` parameter (`#SBATCH --dependency=`); array logs
  use `slurm_%A_%a.out`.
- Partition limit awareness: partition MaxTime plus QoS MaxJobsPU /
  MaxSubmitPU / MaxTRESPU / MaxWall, cached per host and partition.
  `slurm_submit` appends non-blocking warnings for serialized arrays or extra
  jobs on partitions capped at 2 jobs or fewer, and for gpus/mem/time above the
  caps. `cluster_info` gains a "Per-user limits" section.
- `guide` appends the file at `HPC_GUIDE_EXTRA` under "Site-specific guide".

### Changed
- Terminal states match on the first word (`CANCELLED by <uid>`) and include
  PREEMPTED, BOOT_FAIL, DEADLINE and REVOKED.
- State files (watches, notifications, templates, workdir) are written
  atomically (tmp file + rename) and every read-modify-write runs under a
  mkdir-based `withFileLock` (~2s, fail-open). Unparsable state files are moved
  aside as `.corrupt-<ts>` instead of being overwritten with `[]`.
- `slurm_submit` parameter whitelist: partition, mem, time (new
  `parseSlurmTime`: M, M:S, H:M:S, D-H, D-H:M, D-H:M:S), array, gpus/cpus,
  output_dir and the stored workdir. Random `SLURM_EOF_<hex>` heredoc
  delimiter; mkdir/cd targets are single-quoted.
- `BatchMode=yes` on every ssh spawn: `sshExec`, the poller, `ssh_write_file`
  (now with a dead-master fail-fast) and `rsync -e`.
- Template string `preamble` is injected after `HPC_PREAMBLE` and before `cd`;
  unknown template names are an error instead of silently using defaults.
- `validateJobId` accepts `12345_3` and `12345_[1-5]`; ids are single-quoted in
  remote commands since `[..]` is a bash glob.
- Tool descriptions updated (array, dependency, auto-watch, cap hints, array id
  forms); README/TOOLS/GUIDE docs aligned (26 tools, env vars, "not a security
  boundary" note).

### Fixed
- Desktop notifications use `execFileSync` (`osascript -e` / `notify-send`)
  without a local shell; `job_name` is validated as `^[\w.-]{1,64}$` and
  `slurm_submit_file` sanitizes the derived watch label the same way.
- `cluster_switch` referenced an undefined `WATCH_FILE`; it now counts this
  window's watches on the previous host.

Verified with a stdio JSON-RPC smoke test against a production SLURM cluster:
26 tools, cap hints, validation errors, and a 2-task array job notified
"2 ok / 0 failed" with both per-task log files present.
