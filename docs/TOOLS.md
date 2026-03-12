# Tool Reference

## SSH Tools

### ssh_status
Check if SSH connection to HPC is active.

**Parameters:** None

---

### ssh_exec
Execute a command on HPC via SSH.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| command | string | ✅ | — | Shell command (max 500 chars). No heredoc, python -c, or multi-line. |
| timeout | number | ❌ | 30000 | Timeout in milliseconds |
| verbose | boolean | ❌ | false | Force full output (bypass noise filter) |

**Command Guard:** The following patterns are blocked:
- Heredocs (`<<`)
- `python -c` inline code
- Multi-line commands (>2 lines)
- Double quotes, single quotes
- `grep`, `awk`, `sed` commands
- Commands over 500 characters

**Recommended workflow:** Write scripts locally → `sync_files` upload → `ssh_exec bash script.sh`

---

### ssh_read_file
Read a file from HPC.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| path | string | ✅ | — | Absolute file path on HPC |
| tail | number | ❌ | — | Only read last N lines |
| head | number | ❌ | — | Only read first N lines |

---

### ssh_write_file
Write content to a file on HPC.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| path | string | ✅ | — | Absolute file path on HPC |
| content | string | ❌ | — | File content (omit if using from_file) |
| from_file | string | ❌ | — | Local file to read content from |
| append | boolean | ❌ | false | Append instead of overwrite |

---

## SLURM Tools

### slurm_status
Check SLURM job status.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| job_id | string | ❌ | — | Specific job ID (omit for all your jobs) |

---

### slurm_submit
Submit a SLURM batch job with automatic resource checking.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| script | string | ✅ | — | Main command to run |
| job_name | string | ❌ | nanoclaw-job | Job name |
| partition | string | ❌ | batch | SLURM partition |
| gpus | number | ❌ | 1 | Number of GPUs |
| mem | string | ❌ | 4G | Memory allocation |
| time | string | ❌ | 00:15:00 | Time limit (HH:MM:SS) |
| cpus_per_task | number | ❌ | — | CPUs per task |
| output_dir | string | ❌ | results/logs | Log output directory |

**Features:**
- Auto-checks resource history before submitting
- Workdir guard prevents wrong-directory submissions
- Registers job for automatic watch polling
- Returns POLL_CMD for background monitoring

---

### slurm_cancel
Cancel a SLURM job.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| job_id | string | ✅ | — | Job ID to cancel |

---

### slurm_watches
List active SLURM job watches and pending notifications.

**Parameters:** None

Shows: active watches (this window), other windows' watch count, polling diagnostics, pending notifications.

---

### resource_check
Check actual resource usage of past jobs. **Call before submitting jobs.**

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| job_name | string | ✅ | — | Job name pattern to search |

Returns: sacct history, peak memory/time, recommended resource allocations.

---

### cluster_info
Get HPC cluster partitions and job status.

**Parameters:** None

---

## File Tools

### sync_files
Sync files between local and HPC via rsync.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| direction | enum | ✅ | — | "upload" or "download" |
| local_path | string | ✅ | — | Local absolute path |
| remote_path | string | ✅ | — | Remote path on HPC |
| delete | boolean | ❌ | false | Delete extraneous files on destination |

---

## Workdir Tools

### workdir_set
Set HPC working directory for this terminal window.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| path | string | ✅ | — | Absolute path on HPC |

---

### workdir_get
Get HPC working directory for this terminal window.

**Parameters:** None

---

## Terminal (tmux) Tools

### terminal_start
Start a tmux session on the local machine.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| session | string | ❌ | hpc | Session name |
| command | string | ❌ | — | Initial command |

---

### terminal_read
Read tmux terminal content (last 100 lines).

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| session | string | ❌ | hpc | Session name |

---

### terminal_send
Send keys to tmux session.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| session | string | ❌ | hpc | Session name |
| keys | string | ✅ | — | Keys to send (text or special: Enter, Ctrl-C, Tab). Max 500 chars. |

---

### terminal_exec
Run an interactive command in tmux and return output.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| session | string | ❌ | hpc | Session name |
| command | string | ✅ | — | Command to run |
| wait | number | ❌ | 1000 | Ms to wait for output |

---

### terminal_stop
Kill a tmux session.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| session | string | ❌ | hpc | Session name |

---

## Reference

### guide
Read the built-in HPC usage guide.

**Parameters:** None
