# slurm-mcp-server

A zero-dependency MCP server for SLURM HPC clusters. Single file, `npx`-ready.

## Highlights

- **Single file, zero config** — `npx slurm-mcp-server` and you're done
- **TTY-aware job watching** — each terminal window tracks its own jobs, no cross-talk
- **Command Guard** — blocks 7 categories of SSH escape traps that silently corrupt commands
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
- **Environment variables**: `HPC_HOST`, `HPC_USER`, `SLURM_ACCOUNT` (required), `HPC_PREAMBLE` (optional)
</details>

### 3. Restart your client

That's it. SSH ControlMaster is recommended for persistent connections.

## Features

### 🖥️ TTY-Aware Job Watching
Each terminal window tracks its own SLURM jobs independently. No cross-talk between windows. Automatic 30-second polling with state change detection.

### 🛡️ Command Guard
Prevents 7 categories of SSH escape traps that silently corrupt commands:
- Heredocs, `python -c`, multi-line commands
- Quotes (single & double), grep/awk/sed patterns
- Commands over 500 characters

### 🔔 Desktop Notifications
Job completion triggers native desktop notifications:
- **macOS**: `osascript` with sound
- **Linux**: `notify-send`

### 📊 Resource Check
Before submitting jobs, automatically queries `sacct` for historical resource usage of similar jobs. Warns when requested resources exceed 10× actual usage.

### 📁 Workdir Guard
Per-window working directory tracking prevents accidentally submitting jobs to wrong directories.

### 🌐 Multi-Cluster Support
Configure multiple clusters with comma-separated `HPC_HOST`. Switch between them with `cluster_switch`.

### 🔄 SSH Auto-Reconnect
Detects dropped SSH connections and automatically re-establishes ControlMaster before retrying the command.

### 📋 Job Templates
Save and reuse common SLURM configurations (partition, GPU count, memory, time). Apply with `template: "my-template"` on submit.

### 📊 Resource Report
Summarize your compute usage over any time period — total jobs, compute hours, GPU jobs, peak memory.

### 🪝 Webhook Notifications
Send job completion alerts to Slack, Discord, or any webhook endpoint via `NOTIFY_WEBHOOK` env var.

### 📄 Direct Script Submit
Submit existing `.slurm`/`.sh` files on the cluster without rebuilding the script locally.

### 🖥️ Interactive SSH
Start a tmux-based interactive SSH session for commands needing 2FA, confirmation prompts, or long-running monitoring.

## Tools (25)

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
| | `slurm_logs` | Read job output log |
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
