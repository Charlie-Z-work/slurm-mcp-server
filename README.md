# slurm-mcp-server

A zero-dependency MCP server for SLURM HPC clusters. Single file, `npx`-ready.

## Highlights

- **Single file, zero config** — `npx slurm-mcp-server` and you're done
- **TTY-aware job watching** — each terminal window tracks its own jobs, no cross-talk
- **Orphan watch adoption** — jobs outliving their session are adopted by any live instance; completion notifications survive session restarts
- **MFA/fail2ban-safe** — never attempts non-interactive re-auth; dead SSH master ⇒ fail fast with clear guidance, polling backs off exponentially
- **Clean lifecycle** — server exits with its client (no zombie pollers), heartbeat files let peers detect dead sessions
- **Command Guard** — blocks 8 patterns of SSH escape traps (plus a 500-char limit) that silently corrupt commands
- **Array-aware watches** — array jobs notify once, when every task is done, with an `N ok / M failed` tally
- **Partition cap hints** — `slurm_submit` warns when a per-user QoS cap will serialize your jobs or reject the request; `cluster_info` lists the caps
- **Desktop notifications** — native alerts on macOS and Linux when jobs finish
- **Resource waste prevention** — checks historical usage before submitting, warns on over-allocation
- **No Docker required** — runs directly on your machine via SSH

## Quick Start (3 steps)

### 1. Set environment variables

```bash
export HPC_HOST=your-cluster        # SSH host alias or hostname (user@host also works)
export HPC_USER=your-username       # Your cluster username (used for squeue/sacct -u)
# Optional:
export SLURM_ACCOUNT=your-account   # SLURM account; unset = no #SBATCH --account (site default)
export HPC_PREAMBLE='module load python/3.11\nconda activate myenv'
export SLURM_DEFAULT_PARTITION=batch  # default partition for slurm_submit (per-cluster list allowed)
export SLURM_DEFAULT_GPUS=1           # sites without GPUs: set SLURM_DEFAULT_GPUS=0 (per-cluster list allowed)
```

Values are validated at startup (the server exits with an error otherwise);
none may start with `-`, and comma-separated lists configure multiple clusters:

- `HPC_HOST`: letters, digits, `_ . -`, optionally `user@host`
- `HPC_USER`: letters, digits, `_ . - @ \` (AD/LDAP/Kerberos names such as
  `u@ad.example.edu` or `DOMAIN\u`; always single-quoted in remote commands)
- `SLURM_ACCOUNT`: letters, digits, `_ . -`; an empty list entry means "no
  account" for that cluster (`acct1,,acct3`)
- `SLURM_DEFAULT_PARTITION`: letters, digits, `_ . -` (e.g. `gpu.a100`)
- `SLURM_DEFAULT_PARTITION` / `SLURM_DEFAULT_GPUS`: one value for every
  cluster, or a list in `HPC_HOST` order (`batch,standard-s`, `1,0`); a shorter
  list reuses its last entry, an empty entry means the built-in default

### 2. Add to your MCP client

<details>
<summary><b>Claude Code</b></summary>

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "hpc": {
      "command": "npx",
      "args": ["-y", "slurm-mcp-server"],
      "env": {
        "HPC_HOST": "your-cluster",
        "HPC_USER": "your-username",
        "SLURM_ACCOUNT": "your-account"
      }
    }
  }
}
```
</details>

<details>
<summary><b>OpenAI Codex CLI</b></summary>

Add to your `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "hpc": {
      "command": "npx",
      "args": ["-y", "slurm-mcp-server"],
      "env": {
        "HPC_HOST": "your-cluster",
        "HPC_USER": "your-username",
        "SLURM_ACCOUNT": "your-account"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "hpc": {
      "command": "npx",
      "args": ["-y", "slurm-mcp-server"],
      "env": {
        "HPC_HOST": "your-cluster",
        "HPC_USER": "your-username",
        "SLURM_ACCOUNT": "your-account"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Other MCP clients</b></summary>

This is a standard MCP server using stdio transport. Configure it in your client with:
- **Command**: `npx -y slurm-mcp-server`
- **Environment variables**: `HPC_HOST`, `HPC_USER` (required), `SLURM_ACCOUNT`, `HPC_PREAMBLE`, `NOTIFY_WEBHOOK`, `HPC_RESOURCE_LOG`, `HPC_GUIDE_EXTRA`, `SLURM_DEFAULT_PARTITION`, `SLURM_DEFAULT_GPUS`, `HPC_REQUIRE_MASTER`, `HPC_ALLOW_UNSAFE_REUSE` (optional)
</details>

### 3. Restart your client

That's it. See [SSH Setup](#ssh-setup) for the two connection modes (ControlMaster, required on MFA clusters, or direct BatchMode connections).

## Features

### 🖥️ TTY-Aware Job Watching
Each terminal window tracks its own SLURM jobs independently. No cross-talk between windows. Automatic 30-second polling (one batched `sacct` per cluster) with state change detection. A watch only expires after successful `sacct` queries of its cluster have not reported the job for max(48h, 4 × the time limit); long queue waits and master outages (no successful query) never expire it. Watches are keyed by cluster + job id, so the same id on two clusters never collides. Array jobs are tracked per task and reported once all tasks reach a terminal state (`CANCELLED by <uid>`, `PREEMPTED`, `BOOT_FAIL`, `DEADLINE`, `REVOKED` included). Watch/notification/template state files are written atomically under a lock file, and a corrupt file is moved aside as `.corrupt-<ts>` instead of being overwritten.

### 👪 Orphan Watch Adoption
Every server writes a heartbeat every 30s on its own timer (independent of poll backoff); when a session dies, its watches are adopted by any live instance and keep being monitored. Pending notifications from closed sessions are surfaced (and drained) by whichever session runs next — long jobs never complete silently.

### 🛡️ Command Guard
Blocks 8 patterns of SSH escape traps that silently corrupt commands, plus a length limit:
- Heredocs, `python -c`, multi-line commands
- Quotes (single & double), grep/awk/sed patterns
- Commands over 500 characters

The Command Guard prevents accidental breakage, it is not a security boundary: `ssh_exec` still runs arbitrary commands as your cluster user.

### 🔔 Desktop Notifications
Job completion triggers native desktop notifications:
- **macOS**: `osascript` with sound
- **Linux**: `notify-send`

### 📊 Resource Check
Before submitting jobs, automatically queries `sacct` for historical resource usage of similar jobs (peak `MaxRSS` over all job steps, elapsed time). Warns when requested resources exceed 10× actual usage. An ssh/sacct failure is reported as "resource history unavailable: <reason>", distinct from "no history yet".

### 📁 Workdir Guard
Per-window working directory tracking prevents accidentally submitting jobs to wrong directories.

### 🌐 Multi-Cluster Support
Configure multiple clusters with comma-separated `HPC_HOST`. Switch between them with `cluster_switch`. Each watch remembers its cluster, so jobs on multiple clusters are polled correctly at the same time. `HPC_PREAMBLE` is only injected on the primary cluster (module names differ across clusters); pass `preamble: false` on `slurm_submit` to skip it entirely.

### 🚦 MFA-Safe Connection Handling
On clusters enforcing chained MFA (publickey **and** Duo), a background process can never re-authenticate — each blind reconnect attempt is just a failed login that feeds the bastion's fail2ban. This server therefore never kills or rebuilds your SSH ControlMaster. Every ssh/rsync call runs with `BatchMode=yes`, so nothing ever falls back to an interactive prompt. It probes the master socket locally (`ssh -O check`, zero network) before any traffic; if the master is dead it fails fast with instructions to reconnect interactively, and polling of that cluster pauses with exponential backoff (30s → 10min). Backoff is per cluster: a dead master on one cluster never delays notifications from another.

### 📋 Job Templates
Save and reuse common SLURM configurations (partition, GPU count, memory, time, extra preamble lines). Apply with `template: "my-template"` on submit; an unknown template name is an error.

### 🚧 Partition Limit Awareness
`slurm_submit` validates every parameter (job name, partition, mem, time, array, dependency, output dir) before building the script, then reads the partition's `MaxTime` and QoS per-user caps (`MaxJobsPU`, `MaxTRESPU`). It appends non-blocking ⚠️ hints when array tasks or extra jobs would serialize on a 1–2 job partition, or when gpus/mem/time exceed the cap. `cluster_info` shows a `Per-user limits` section for every partition (partition QoS only; association limits and a job QoS are not queried and may be stricter).

### 📊 Resource Report
Summarize your compute usage over any time period — total jobs, compute hours, GPU jobs, peak memory.

### 🪝 Webhook Notifications
Send job completion alerts to Slack, Discord, or any webhook endpoint via `NOTIFY_WEBHOOK` env var.

### 📄 Direct Script Submit
Submit existing `.slurm`/`.sh` files on the cluster without rebuilding the script locally.

### 🖥️ Interactive SSH
Start a tmux-based interactive SSH session for commands needing 2FA, confirmation prompts, or long-running monitoring.

## Tools (26)

| Category | Tool | Description |
|----------|------|-------------|
| **SSH** | `ssh_status` | Check SSH connection |
| | `ssh_exec` | Execute command on HPC |
| | `ssh_read_file` | Read file from HPC |
| | `ssh_write_file` | Write file to HPC |
| | `ssh_interactive` | Start interactive SSH session via tmux |
| **SLURM** | `slurm_status` | Check job status |
| | `slurm_submit` | Submit batch job (supports arrays + templates) |
| | `slurm_submit_file` | Submit existing .slurm/.sh script |
| | `slurm_cancel` | Cancel job |
| | `slurm_logs` | Read job output log (remembers --output patterns of jobs it submitted → sacct → scontrol → workdir fallback; `path` reads a file directly) |
| | `slurm_watches` | List active job watches |
| | `resource_check` | Check historical resource usage |
| | `resource_report` | Summarize usage over time period |
| | `cluster_info` | Get cluster info + queue estimate |
| | `cluster_switch` | Switch active cluster |
| **Files** | `sync_files` | rsync between local and HPC |
| **Workdir** | `workdir_set` | Set working directory (per window and cluster) |
| | `workdir_get` | Get working directory (per window and cluster) |
| **Templates** | `template_save` | Save reusable job template |
| | `template_list` | List saved templates |
| **Terminal** | `terminal_start` | Start tmux session |
| | `terminal_read` | Read tmux output |
| | `terminal_send` | Send keys to tmux |
| | `terminal_exec` | Run interactive command |
| | `terminal_stop` | Kill tmux session |
| **Reference** | `guide` | Read HPC usage guide |

## Environment Variables

| Variable | Required | Description |
|----------|:---:|-------------|
| `HPC_HOST` | ✅ | SSH host (alias from `~/.ssh/config` or hostname) |
| `HPC_USER` | ✅ | Username on HPC cluster |
| `SLURM_ACCOUNT` | ❌ | SLURM account for job submission. Unset/empty: no `#SBATCH --account` line (the site's default account applies) |
| `HPC_PREAMBLE` | ❌ | Shell commands to run before job scripts (module loads, conda activate, etc.) — newline-separated |
| `NOTIFY_WEBHOOK` | ❌ | Slack/Discord webhook URL for job completion alerts |
| `HPC_RESOURCE_LOG` | ❌ | Path **on the cluster** to an extra resource log (e.g. TSV of past runs) that `resource_check` greps by job name |
| `HPC_GUIDE_EXTRA` | ❌ | Local path to a site-specific guide appended to the `guide` tool output (accounts, partition policy, envs) |
| `SLURM_DEFAULT_PARTITION` | ❌ | Default `partition` for `slurm_submit` (default `batch`). Comma-separated list = one per cluster, `HPC_HOST` order |
| `SLURM_DEFAULT_GPUS` | ❌ | Default `gpus` for `slurm_submit` (default `1`). Sites without GPUs: set `SLURM_DEFAULT_GPUS=0` (no `--gres` line). Comma-separated list = one per cluster |
| `HPC_REQUIRE_MASTER` | ❌ | `1` = require a ControlMaster: a host without `ControlPath` is treated like a dead master (fail fast, no direct connection). Recommended on MFA clusters |
| `HPC_ALLOW_UNSAFE_REUSE` | ❌ | `1` = when the master is alive but its `ControlPath` cannot be resolved safely via `ssh -G`, run calls with plain `BatchMode=yes` instead of refusing them (a new connection is opened if the master dies meanwhile). Ignored under `HPC_REQUIRE_MASTER=1` |

## SSH Setup

Every ssh/rsync call runs with `BatchMode=yes` (never an interactive prompt).
Before connecting, the server runs `ssh -O check <host>` locally and picks one
of two modes:

**1. ControlMaster (required for MFA clusters, e.g. publickey + Duo).** A
background process can never answer an MFA prompt, so all traffic must reuse a
master connection you opened interactively. `~/.ssh/config`:

```
Host mycluster
    HostName login.cluster.edu
    User yourusername
    ControlMaster auto
    ControlPath ~/.ssh/sockets/%r@%h-%p
    ControlPersist 12h
```

Create the socket directory (`mkdir -p ~/.ssh/sockets`) and run `ssh mycluster`
once in a terminal. If the master dies, tools fail fast with a "reconnect
interactively" message and polling of that cluster pauses — nothing ever
retries a login in the background. In this mode every ssh/rsync call also
carries `-o ProxyCommand=false`: if the master dies between the local check and
the call, ssh cannot reuse it and fails locally instead of opening a new
connection (a doomed publickey attempt that would feed the bastion's
fail2ban). The effective `ControlPath` (read locally with `ssh -G <host>`) is
passed explicitly as well, because a `%C` socket name hashes the `ProxyJump`
value and would otherwise change. If it cannot be resolved safely (`ssh -G`
fails, or the path contains `%`, quotes, backslashes or tabs), every call is
refused locally — nothing is sent — unless `HPC_ALLOW_UNSAFE_REUSE=1`
(plain `BatchMode=yes`). Paths with plain spaces work (quoted for ssh and for
`rsync -e`). Set `HPC_REQUIRE_MASTER=1` so that a
missing `ControlPath` is also treated as "dead" instead of falling back to
mode 2.

**2. Direct connections (no ControlPath configured, no MFA).** When `ssh -O
check` answers "No ControlPath specified", every call connects directly with
`ssh -o BatchMode=yes` — this works with key-based login without MFA (an
agent or unencrypted key). `ssh_status` reports "ControlMaster not configured —
direct BatchMode connections". Each call is a new login, so on clusters with
fail2ban prefer mode 1.

## Known limitations

- **Synchronous ssh calls block the event loop.** Tool handlers use `execFileSync`, so while one remote command runs (up to its timeout, max 10 min for `ssh_exec`), the server handles no other request and the poller waits. The heartbeat announces `busyUntil` for the duration, so other windows do not mistake the busy server for a dead one. Moving to async execution is planned.
- **Windows clients are not supported.** Local paths (`sync_files`, state files under `~/.claude`), the tty detection and the ControlMaster checks assume a POSIX client (macOS / Linux).
- **The Command Guard is not a security boundary.** It only catches quoting mistakes that break the `bash --login -c '...'` transport; `ssh_exec` runs arbitrary commands as your cluster user.
- **GPU default.** `SLURM_DEFAULT_GPUS` defaults to `1` for backward compatibility, so on a CPU-only site every `slurm_submit` without `gpus` writes `--gres=gpu:1` and sbatch rejects it; the error then suggests `SLURM_DEFAULT_GPUS=0` / `gpus: 0`. Set `SLURM_DEFAULT_GPUS=0` on such sites.
- **Job watches need `sacct` (Slurm accounting).** The watcher polls `sacct`; on a site without accounting storage (no slurmdbd) sacct fails, so `slurm_submit` registers no watch and says "sacct unavailable on this cluster — job watches cannot complete; use slurm_status". Check such jobs with `slurm_status`.
- **`sync_files` and rsync `-s`.** `-s` (protect-args) is passed when the local rsync supports it; macOS' default openrsync does not, so remote paths are restricted to a whitelist (no whitespace or shell metacharacters) either way.
- **Association-level QoS limits are not shown.** `cluster_info` and the submit hints read partition `MaxTime` and the partition QoS (`sacctmgr show qos`); limits set on your user/account association are not queried.

## License

MIT
