# Tool Reference

## SSH Tools

### ssh_status
Check if SSH connection to HPC is active. Reports one of: the live ControlMaster; "ControlMaster not configured — direct BatchMode connections" (no `ControlPath` for the host; tools connect directly, see README → SSH Setup); or "SSH not connected" (dead master, or no ControlPath with `HPC_REQUIRE_MASTER=1`).

**Parameters:** None

---

### ssh_exec
Execute a command on HPC via SSH.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| command | string | ✅ | — | Shell command (max 500 chars). No heredoc, python -c, or multi-line. |
| timeout | number | ❌ | 30000 | Timeout in milliseconds, integer 1000–600000 (0 = "no timeout" is rejected: the call is synchronous) |
| verbose | boolean | ❌ | false | Force full output (bypass noise filter) |

**Command Guard:** The following patterns are blocked:
- Heredocs (`<<EOF`, `<<-EOF`)
- `python -c` inline code (any version / flags: `python3.11 -c`, `python -u -c`)
- Multi-line commands (3 or more lines)
- Double quotes, single quotes
- `grep`, `awk`, `sed` commands
- Commands over 500 characters

**Output filter:** simple commands like `cd`/`mkdir`/`source` are reduced to their first line and `ls`-style listings to 30 lines; compound commands (`&&`, `;`, `|`) are always returned in full. Use `verbose: true` to bypass.

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

### ssh_interactive
Start an interactive SSH session to HPC inside a local tmux session (for 2FA, confirmation prompts, long monitoring). Use `terminal_read` / `terminal_send` to interact.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| command | string | ❌ | — | Command to run after connecting |
| session | string | ❌ | hpc-interactive | tmux session name |

---

## SLURM Tools

### slurm_status
Check SLURM job status.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| job_id | string | ❌ | — | `12345`, array task `12345_3`, or task range `12345_[1-5]` (omit for all your jobs) |

---

### slurm_submit
Submit a SLURM batch job with automatic resource checking.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| script | string | ✅ | — | Main command(s) to run |
| job_name | string | ❌ | slurm-job | Job name, `[A-Za-z0-9_.-]{1,64}` |
| partition | string | ❌ | `SLURM_DEFAULT_PARTITION` or batch | SLURM partition (`[A-Za-z0-9_.-]+`, e.g. `gpu.a100`, no leading `-`). See `cluster_info` for per-user caps |
| gpus | number | ❌ | `SLURM_DEFAULT_GPUS` or 1 | Number of GPUs (non-negative integer; 0 = no `--gres` line; some sites reject 0). If sbatch rejects the GPU request, the error suggests `SLURM_DEFAULT_GPUS=0` / `gpus: 0` |
| mem | string | ❌ | 4G | Memory, `^\d+[KMGT]?$` |
| time | string | ❌ | 00:15:00 | Time limit: `M`, `M:S`, `H:M:S`, `D-H`, `D-H:M`, `D-H:M:S` (surrounding whitespace is trimmed) |
| cpus_per_task | number | ❌ | — | CPUs per task (non-negative integer) |
| output_dir | string | ❌ | results/logs | Log output directory. Relative paths are made absolute under the workdir (if set) for both `mkdir` and `#SBATCH --output` |
| array | string | ❌ | — | Array spec: `1-10`, `1,3,5-7`, `1-10:2`, `1-100%5` (`%N` = max concurrent tasks) |
| dependency | string | ❌ | — | e.g. `afterok:12345`, `afterany:12345_2`, `singleton` (comma-separated list allowed; `after*` types need at least one job id) |
| template | string | ❌ | — | Saved template to use as defaults (unknown name → error) |
| preamble | boolean | ❌ | true | Inject `HPC_PREAMBLE` (primary cluster only). A template's string `preamble` is injected regardless, after `HPC_PREAMBLE` and before `cd` |

**Features:**
- Every parameter is validated against a whitelist; invalid input returns an error instead of a broken script
- `#SBATCH --account` is written only when `SLURM_ACCOUNT` is set (for the active cluster)
- Auto-checks resource history before submitting
- Workdir guard prevents wrong-directory submissions
- Logs go to `slurm_%j.out`, or `slurm_%A_%a.out` for arrays
- Registers the job for automatic watch polling — the completion notification (with an `N ok / M failed` tally for arrays) is prepended to your next tool result. Do not poll with ssh loops.
- Once sbatch succeeded the result is never an error: if the watch cannot be registered, the text says the job IS queued plus a warning
- Non-blocking ⚠️ hints when the partition's per-user cap will serialize array tasks / extra jobs, or when gpus/mem/time exceed the cap (DenyOnLimit would reject)

---

### slurm_submit_file
Submit an existing `.slurm`/`.sh` script already on the cluster, and register a watch for it.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| path | string | ✅ | — | Absolute path to the script on HPC |

---

### slurm_cancel
Cancel a SLURM job.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| job_id | string | ✅ | — | `12345` (whole job/array), `12345_3` (one task) or `12345_[1-5]` (task range) |

Only a whole-job cancel removes the watch; cancelling some array tasks keeps watching the rest.

---

### slurm_logs
Read a job's output log (sacct `StdOut` → `scontrol` → workdir log dirs fallback). A sacct path with unexpanded `%j`/`%A`/`%a` placeholders is not used as-is: `scontrol` is asked first, then the placeholders are expanded from the job id when possible, then `<workdir>/{results/logs,logs,.}/slurm_<id>.out` (arrays: `slurm_<A>_<a>.out`) are searched.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| job_id | string | ✅ | — | Job ID; for arrays pass one task, e.g. `12345_3` |
| lines | number | ❌ | 50 | Lines to read from the end (0 = all) |

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
| job_name | string | ✅ | — | Job name pattern (case-insensitive substring of recent COMPLETED job names, last 7 days, up to 5 jobs) |

Returns: sacct rows including `.batch`/`.extern` steps (MaxRSS is only recorded on steps), peak memory/time per job, recommended resource allocations. If ssh or sacct fails, the output says `resource history unavailable: <reason>` instead of suggesting a benchmark.

---

### resource_report
Summarize your usage over a period: job counts, compute hours, GPU jobs, peak memory (max `MaxRSS` over each job's steps).

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| days | number | ❌ | 7 | Days to look back |
| format | enum | ❌ | text | `text` or `csv` |

---

### cluster_info
Get cluster partitions (`sinfo -s`), your jobs, a queue estimate, and a `Per-user limits` section (MaxTime / MaxJobsPU / MaxTRESPU per partition, from `scontrol show partition` + `sacctmgr show qos`). If `sacctmgr` fails, partition MaxTime is still shown and the section says "QoS limits unavailable". Association-level limits are not shown.

**Parameters:** None

---

### cluster_switch
Switch the active cluster (multi-cluster `HPC_HOST`). Omit `host` to list clusters. Existing watches keep polling their own cluster.

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| host | string | ❌ | — | Cluster host to switch to |

---

## File Tools

### sync_files
Sync files between local and HPC via rsync (`rsync -avz --partial -e "ssh -o BatchMode=yes" -- <src> <dst>`; `--` stops option parsing, so a path can never become an rsync option).

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

## Template Tools

### template_save
Save a reusable job template (stored in `~/.claude/slurm-templates.json`).

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|:---:|---------|-------------|
| name | string | ✅ | — | Template name |
| partition | string | ❌ | — | Partition |
| gpus | number | ❌ | — | GPUs |
| mem | string | ❌ | — | Memory |
| time | string | ❌ | — | Time limit |
| cpus_per_task | number | ❌ | — | CPUs per task |
| preamble | string | ❌ | — | Extra shell lines injected after `HPC_PREAMBLE` and before `cd` |

---

### template_list
List saved templates.

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
| keys | string | ✅ | — | Text, typed literally (`send-keys -l --`, so a leading `-` or the word "Enter" inside it is just text), or exactly one special key: `Enter`, `Tab`, `Escape`, `C-c` (alias `Ctrl-C`), `Up`, … Max 500 chars. |

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
Read the built-in HPC usage guide, plus the file at `HPC_GUIDE_EXTRA` (appended under "Site-specific guide") when set, plus current watch status.

**Parameters:** None
