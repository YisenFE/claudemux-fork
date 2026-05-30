# artifacts/

Dispatcher-generated intermediate output. Replaces `/tmp/<topic>.md` for anything that should survive reboots and stay attached to this dispatcher.

- Filename convention: `<YYYYMMDD>-<slug>.md` (e.g., `20260526-pr88-triage.md`). The date prefix lets `ls` sort by time and `find -mtime +30 -name '*.md' -delete` clean up stale output safely.
- **Not** auto-imported — Claude `Read`s a file deliberately when relevant.
- Safe to delete by hand or with a `find` cleanup when artifacts go stale.
