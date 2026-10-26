"""Consistent online SQLite backup, including committed WAL transactions.
Usage: python tools/backup.py data/campus.sqlite3 backups/campus-20261022.sqlite3
Never copy the .sqlite3 file alone while the server is running.
"""
import contextlib
import os
import pathlib
import sqlite3
import sys
import tempfile

def backup(source, target):
    source, target = pathlib.Path(source).resolve(), pathlib.Path(target).resolve()
    if not source.is_file():
        raise ValueError('Source database does not exist')
    if source == target or target.exists():
        raise ValueError('Choose a new destination file')
    target.parent.mkdir(parents=True, exist_ok=True)
    # A private staging directory keeps the unsanitized copy out of the final
    # backup name. Every error removes it, including journal/WAL sidecars.
    with tempfile.TemporaryDirectory(prefix='.campus-backup-', dir=target.parent) as directory:
        staged = pathlib.Path(directory) / 'snapshot.sqlite3'
        descriptor = os.open(staged, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
            with contextlib.closing(sqlite3.connect(staged)) as dst:
                src.backup(dst)
                dst.execute('PRAGMA journal_mode=DELETE')
                dst.execute('PRAGMA secure_delete=ON')
                tables = {row[0] for row in dst.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if 'university_verifications' in tables:
                    dst.execute("UPDATE university_verifications SET image=NULL,"
                                "status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,"
                                "reason=CASE WHEN status='pending' THEN 'backup_restore_resubmission_required' ELSE reason END")
                # A restore must not resurrect tokens revoked after the backup.
                if 'sessions' in tables:
                    dst.execute('DELETE FROM sessions')
                dst.commit()
                dst.execute('VACUUM')
                if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Backup integrity check failed')
        # Atomic publication without replacement: if another writer creates the
        # destination first, link() fails and leaves that writer's file intact.
        # Both files are on the same filesystem; unsupported filesystems fail closed.
        os.link(staged, target)
    print('Backup created:', target)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: backup.py source.sqlite3 new-backup.sqlite3')
    backup(*sys.argv[1:])
