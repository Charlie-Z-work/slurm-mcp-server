# HPC Usage Guide

## Workflow

1. **Connect**: Ensure SSH is connected (`ssh_status` to check)
2. **Set workdir**: `workdir_set` to your project directory
3. **Upload code**: Write locally, `sync_files` upload
4. **Check resources**: `resource_check` before submitting
5. **Submit**: `slurm_submit` with appropriate resources
6. **Monitor**: Jobs are auto-watched; check with `slurm_watches`

## SSH Tips

- Use SSH ControlMaster for persistent connections (12h recommended)
- If your cluster requires 2FA, connect manually first: `ssh your-cluster`
- The server uses `bash --login` for remote commands to ensure PATH is set

## Command Safety

The Command Guard blocks patterns that silently break over SSH:

| Pattern | Why It Breaks | What To Do Instead |
|---------|--------------|-------------------|
| Heredoc (`<<EOF`) | Shell escaping corrupts content | `ssh_write_file` or `sync_files` |
| `python -c "..."` | Quotes get eaten by SSH | Write .py file → upload → execute |
| Multi-line (>2 lines) | Newlines lost in transmission | Write script file → upload |
| Quotes (`"` or `'`) | Multi-layer shell escaping strips them | Use `ssh_read_file` + local processing |
| `grep` patterns | Regex metacharacters get mangled | `ssh_read_file` → local grep |
| `awk`/`sed` | `$` variables expand locally | Write .py script → upload |

## Resource Management

**Always check before submitting:**
```
resource_check("my-job-name")
```

This queries `sacct` for recent completed jobs with similar names and recommends:
- Memory: actual peak × 3 (minimum 2G)
- Time: actual elapsed × 4 (minimum 5 min)

**Warning signs of waste:**
- Requesting 10× more memory than actual usage
- Requesting 10× more time than actual elapsed

## SLURM Partitions

Partition availability varies by cluster. Common patterns:

| Partition | Typical Use | Notes |
|-----------|------------|-------|
| batch | Production jobs | Usually no concurrency limit |
| short/debug | Quick tests | Often limited to 1-2 concurrent jobs |
| gpu | GPU jobs | May require `--gres=gpu:N` |

Set your default partition via `HPC_PREAMBLE` or per-job with the `partition` parameter.

## Environment Setup (HPC_PREAMBLE)

The `HPC_PREAMBLE` environment variable lets you customize what runs before your job script. Common setups:

**Module-based cluster:**
```bash
export HPC_PREAMBLE='source /etc/profile.d/modules.sh
module load python/3.11 cuda/12.4
conda activate myenv'
```

**Spack-based cluster:**
```bash
export HPC_PREAMBLE='source /opt/spack/share/spack/setup-env.sh
spack load python@3.11'
```

**Direct path (no module system):**
```bash
export HPC_PREAMBLE='export PATH=/opt/python/3.11/bin:$PATH
source /home/user/venv/bin/activate'
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `module: command not found` | Non-interactive shell doesn't load profiles | Add `source /etc/profile.d/modules.sh` to HPC_PREAMBLE |
| SSH timeout | Network or ControlMaster expired | Reconnect: `ssh your-cluster` |
| `BLOCKED: ...` | Command Guard rejected unsafe command | Follow the suggestion in the error message |
| Job stuck PENDING | Resources unavailable | Check `cluster_info`, try smaller allocation |
