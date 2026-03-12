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

### 2. Add to Claude Code

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

### 3. Restart Claude Code

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

## Tools (19)

| Category | Tool | Description |
|----------|------|-------------|
| **SSH** | `ssh_status` | Check SSH connection |
| | `ssh_exec` | Execute command on HPC |
| | `ssh_read_file` | Read file from HPC |
| | `ssh_write_file` | Write file to HPC |
| **SLURM** | `slurm_status` | Check job status |
| | `slurm_submit` | Submit batch job |
| | `slurm_cancel` | Cancel job |
| | `slurm_watches` | List active job watches |
| | `resource_check` | Check historical resource usage |
| | `cluster_info` | Get cluster info |
| **Files** | `sync_files` | rsync between local and HPC |
| **Workdir** | `workdir_set` | Set working directory |
| | `workdir_get` | Get working directory |
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
