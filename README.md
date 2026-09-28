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
export HPC_HOST=your-cluster        # SSH host alias or hostname
export HPC_USER=your-username       # Your cluster username
export SLURM_ACCOUNT=your-account   # SLURM account/allocation
# Optional:
export HPC_PREAMBLE='module load python/3.11\nconda activate myenv'
```

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
- **Environment variables**: `HPC_HOST`, `HPC_USER`, `SLURM_ACCOUNT` (required), `HPC_PREAMBLE`, `NOTIFY_WEBHOOK`, `HPC_RESOURCE_LOG`, `HPC_GUIDE_EXTRA` (optional)
</details>

### 3. Restart your client

That's it. SSH ControlMaster is recommended for persistent connections.

## Features

### 🖥️ TTY-Aware Job Watching
Each terminal window tracks its own SLURM jobs independently. No cross-talk between windows. Automatic 30-second polling (one batched `sacct` per cluster) with state change detection. Watch TTL follows the job's own time limit, so multi-day jobs are never silently dropped. Array jobs are tracked per task and reported once all tasks reach a terminal state (`CANCELLED by <uid>`, `PREEMPTED`, `BOOT_FAIL`, `DEADLINE`, `REVOKED` included). Watch/notification/template state files are written atomically under a lock file, and a corrupt file is moved aside as `.corrupt-<ts>` instead of being overwritten.

### 👪 Orphan Watch Adoption
Every poller writes a heartbeat; when a session dies, its watches are adopted by any live instance and keep being monitored. Pending notifications from closed sessions are surfaced (and drained) by whichever session runs next — long jobs never complete silently.

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
Before submitting jobs, automatically queries `sacct` for historical resource usage of similar jobs. Warns when requested resources exceed 10× actual usage.

### 📁 Workdir Guard
Per-window working directory tracking prevents accidentally submitting jobs to wrong directories.

### 🌐 Multi-Cluster Support
Configure multiple clusters with comma-separated `HPC_HOST`. Switch between them with `cluster_switch`. Each watch remembers its cluster, so jobs on multiple clusters are polled correctly at the same time. `HPC_PREAMBLE` is only injected on the primary cluster (module names differ across clusters); pass `preamble: false` on `slurm_submit` to skip it entirely.

### 🚦 MFA-Safe Connection Handling
On clusters enforcing chained MFA (publickey **and** Duo), a background process can never re-authenticate — each blind reconnect attempt is just a failed login that feeds the bastion's fail2ban. This server therefore never kills or rebuilds your SSH ControlMaster. Every ssh/rsync call runs with `BatchMode=yes`, so nothing ever falls back to an interactive prompt. It probes the master socket locally (`ssh -O check`, zero network) before any traffic; if the master is dead it fails fast with instructions to reconnect interactively, and polling pauses with exponential backoff (30s → 10min).

### 📋 Job Templates
Save and reuse common SLURM configurations (partition, GPU count, memory, time, extra preamble lines). Apply with `template: "my-template"` on submit; an unknown template name is an error.

### 🚧 Partition Limit Awareness
`slurm_submit` validates every parameter (job name, partition, mem, time, array, dependency, output dir) before building the script, then reads the partition's `MaxTime` and QoS per-user caps (`MaxJobsPU`, `MaxTRESPU`). It appends non-blocking ⚠️ hints when array tasks or extra jobs would serialize on a 1–2 job partition, or when gpus/mem/time exceed the cap. `cluster_info` shows a `Per-user limits` section for every partition.

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
| | `slurm_logs` | Read job output log (sacct → scontrol → workdir fallback) |
| | `slurm_watches` | List active job watches |
| | `resource_check` | Check historical resource usage |
| | `resource_report` | Summarize usage over time period |
| | `cluster_info` | Get cluster info + queue estimate |
| | `cluster_switch` | Switch active cluster |
| **Files** | `sync_files` | rsync between local and HPC |
| **Workdir** | `workdir_set` | Set working directory |
| | `workdir_get` | Get working directory |
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
| `SLURM_ACCOUNT` | ✅ | SLURM account for job submission |
| `HPC_PREAMBLE` | ❌ | Shell commands to run before job scripts (module loads, conda activate, etc.) — newline-separated |
| `NOTIFY_WEBHOOK` | ❌ | Slack/Discord webhook URL for job completion alerts |
| `HPC_RESOURCE_LOG` | ❌ | Path **on the cluster** to an extra resource log (e.g. TSV of past runs) that `resource_check` greps by job name |
| `HPC_GUIDE_EXTRA` | ❌ | Local path to a site-specific guide appended to the `guide` tool output (accounts, partition policy, envs) |

## SSH Setup

This server requires an active SSH connection. Recommended `~/.ssh/config`:

```
Host mycluster
    HostName login.cluster.edu
    User yourusername
    ControlMaster auto
    ControlPath ~/.ssh/sockets/%r@%h-%p
    ControlPersist 12h
```

Create the socket directory: `mkdir -p ~/.ssh/sockets`

## License

MIT
