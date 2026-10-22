"""Consistent online SQLite backup, including committed WAL transactions.
Usage: python tools/backup.py data/campus.sqlite3 backups/campus-20261022.sqlite3
Never copy the .sqlite3 file alone while the server is running.
"""
import contextlib
import pathlib
import sqlite3
import sys

def backup(source, target):
    source, target = pathlib.Path(source).resolve(), pathlib.Path(target).resolve()
    if not source.is_file():
        raise ValueError('Source database does not exist')
    if source == target or target.exists():
        raise ValueError('Choose a new destination file')
    target.parent.mkdir(parents=True, exist_ok=True)
    # Reserve destination exclusively to avoid accidentally replacing a live DB.
    with target.open('xb'):
        pass
    with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
        with contextlib.closing(sqlite3.connect(target)) as dst:
            src.backup(dst)
            # Identity documents have short retention. Do not copy them into
            # long-lived operational backups. Restored pending cases re-submit.
            has_verification = dst.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='university_verifications'").fetchone()
            if has_verification:
                dst.execute('PRAGMA journal_mode=DELETE')
                dst.execute('PRAGMA secure_delete=ON')
                dst.execute("UPDATE university_verifications SET image=NULL,"
                            "status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,"
                            "reason=CASE WHEN status='pending' THEN 'backup_restore_resubmission_required' ELSE reason END")
                dst.commit()
                dst.execute('VACUUM')
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup integrity check failed')
    print('Backup created:', target)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: backup.py source.sqlite3 new-backup.sqlite3')
    backup(*sys.argv[1:])
