"""Backup confidentiality and failure-injection tests; standard library only."""
import contextlib
import importlib.util
import os
import pathlib
import sqlite3
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('campus_backup', pathlib.Path(__file__).resolve().parents[1] / 'tools' / 'backup.py')
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source, self.target = self.root / 'live.sqlite3', self.root / 'backup.sqlite3'
        with contextlib.closing(sqlite3.connect(self.source)) as db:
            db.executescript("CREATE TABLE university_verifications(image BLOB,status TEXT,reason TEXT);"
                             "CREATE TABLE sessions(token_hash BLOB);"
                             "CREATE TABLE records(value TEXT);")
            db.execute("INSERT INTO university_verifications VALUES(?,'pending',NULL)", (b'private-photo-marker',))
            db.execute("INSERT INTO sessions VALUES(?)", (b'old-token-marker',))
            db.execute("INSERT INTO records VALUES('keep-me')")
            db.commit()

    def assert_clean_failure(self):
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.root.glob('.campus-backup-*')))

    def test_sanitized_backup_preserves_source_and_non_photo_data(self):
        TOOL.backup(self.source, self.target)
        with contextlib.closing(sqlite3.connect(self.target)) as db:
            self.assertEqual(db.execute('SELECT image,status,reason FROM university_verifications').fetchone(),
                             (None, 'cancelled', 'backup_restore_resubmission_required'))
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT value FROM records').fetchone()[0], 'keep-me')
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertNotIn(b'private-photo-marker', self.target.read_bytes())
        self.assertNotIn(b'old-token-marker', self.target.read_bytes())
        with contextlib.closing(sqlite3.connect(self.source)) as db:
            self.assertEqual(db.execute('SELECT image,status FROM university_verifications').fetchone(), (b'private-photo-marker', 'pending'))
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 1)
        self.assertFalse(list(self.root.glob('.campus-backup-*')))
        if os.name != 'nt':
            self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)

    def test_sanitization_failure_leaves_no_photo_file(self):
        with contextlib.closing(sqlite3.connect(self.source)) as db:
            db.execute("CREATE TRIGGER fail_cleanup BEFORE UPDATE ON university_verifications BEGIN SELECT RAISE(ABORT,'injected'); END")
            db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            TOOL.backup(self.source, self.target)
        self.assert_clean_failure()

    def test_existing_destination_is_never_overwritten(self):
        self.target.write_bytes(b'other-backup')
        with self.assertRaises(ValueError):
            TOOL.backup(self.source, self.target)
        self.assertEqual(self.target.read_bytes(), b'other-backup')

    def test_publication_race_preserves_other_writer(self):
        original_link = os.link
        def racing_link(source, destination):
            pathlib.Path(destination).write_bytes(b'other-writer')
            return original_link(source, destination)
        with mock.patch.object(TOOL.os, 'link', side_effect=racing_link), self.assertRaises(FileExistsError):
            TOOL.backup(self.source, self.target)
        self.assertEqual(self.target.read_bytes(), b'other-writer')
        self.assertFalse(list(self.root.glob('.campus-backup-*')))

    def test_publication_error_removes_staging_files(self):
        with mock.patch.object(TOOL.os, 'link', side_effect=OSError('injected disk error')), self.assertRaises(OSError):
            TOOL.backup(self.source, self.target)
        self.assert_clean_failure()

    def test_source_and_destination_must_differ(self):
        with self.assertRaises(ValueError):
            TOOL.backup(self.source, self.source)
        self.assertTrue(self.source.exists())

    def test_missing_source_creates_nothing(self):
        with self.assertRaises(ValueError):
            TOOL.backup(self.root / 'missing.sqlite3', self.target)
        self.assert_clean_failure()


if __name__ == '__main__':
    unittest.main()
