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

### Changed
- `package-lock.json` is now committed (required by `npm ci`).

### Known issues
- Found by the new tests and tracked as `todo` tests: relative `output_dir`
  with a workdir writes logs outside the created directory; compound commands
  starting with `cd`/`mkdir`/`source` have their output cut to one line; a
  malformed watch entry makes a successful submission report "Submit failed";
  the `ssh_exec` guard lets 3-line commands and `<<-EOF` heredocs through.

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
