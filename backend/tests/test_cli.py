"""End-to-end file persistence, JSON contract and invalid GPS tests. Stdlib only."""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

EXE = str(pathlib.Path(sys.argv[1]).resolve())
sys.argv = sys.argv[:1]


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=pathlib.Path(EXE).parent)
        self.addCleanup(self.temp.cleanup)
        self.cwd = pathlib.Path(self.temp.name)
        self.call("university-add", "1", 'Campus "A"')
        self.call("member-add", "1", "runner", "1")

    def call(self, *args, ok=True):
        p = subprocess.run([EXE, "state.tsv", *args], cwd=self.cwd, capture_output=True)
        self.assertEqual(p.returncode == 0, ok, (p.stdout, p.stderr))
        return json.loads((p.stdout if ok else p.stderr).decode("utf-8"))

    def gps(self, content):
        (self.cwd / "gps.csv").write_text(content, encoding="ascii")

    def test_roundtrip_rankings_and_duplicate(self):
        self.gps("timestamp,latitude,longitude\n100,0,0\n160,0,0.001\n")
        run = self.call("run-import", "r1", "1", "gps.csv")
        self.assertTrue(run["accepted"])
        self.assertAlmostEqual(run["distance_m"], 111.194927, places=5)
        self.assertEqual(self.call("universities")[0]["name"], 'Campus "A"')
        self.assertEqual(self.call("members")[0]["nickname"], "runner")
        self.assertEqual(self.call("rankings", "100", "160")[0]["participants"], 1)
        self.assertEqual(self.call("rankings", "0", "100")[0]["participants"], 0)
        self.assertEqual(self.call("run-import", "r1", "1", "gps.csv", ok=False)["error"], "duplicate")
        self.assertEqual(len(self.call("runs")), 1)

    def test_vehicle_excluded(self):
        self.gps("timestamp,latitude,longitude\n100,0,0\n250,0,0.01\n")
        run = self.call("run-import", "vehicle", "1", "gps.csv")
        self.assertFalse(run["accepted"])
        self.assertEqual(run["flags"] & 6, 6)
        self.assertEqual(self.call("rankings", "0", "1000")[0]["distance_m"], 0)

    def test_bad_inputs_do_not_modify_snapshot(self):
        snapshot = (self.cwd / "state.tsv").read_bytes()
        cases = [
            "timestamp,latitude,longitude\n100,0,0\n100,0,.001\n",
            "timestamp,latitude,longitude\n100,0,0\n160,nan,.001\n",
            "timestamp,latitude,longitude\n100,0,0\n160,91,.001\n",
            "timestamp,latitude,longitude\n100,0,0\n160,0,.001,extra\n",
            "timestamp,latitude,longitude\n100,0,0\n",
            "wrong,header\n100,0,0\n160,0,.001\n",
        ]
        for text in cases:
            with self.subTest(text=text):
                self.gps(text)
                self.assertEqual(self.call("run-import", "bad", "1", "gps.csv", ok=False)["error"], "invalid_input")
                self.assertEqual((self.cwd / "state.tsv").read_bytes(), snapshot)
        self.call("member-add", "2", "missing", "999", ok=False)
        self.call("rankings", "200", "100", ok=False)
        self.call("university-add", "2147483648", "overflow", ok=False)
        self.assertEqual((self.cwd / "state.tsv").read_bytes(), snapshot)

    def test_korean_names_and_paths(self):
        self.call("university-add", "2", "서울대학교")
        self.call("member-add", "2", "달리는학생", "2")
        self.assertEqual(self.call("universities")[1]["name"], "서울대학교")
        self.assertEqual(self.call("members")[1]["nickname"], "달리는학생")
        path = self.cwd / "대학기록.tsv"
        p = subprocess.run([EXE, str(path), "university-add", "1", "한국대학교"], capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        p = subprocess.run([EXE, str(path), "universities"], capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout.decode("utf-8"))[0]["name"], "한국대학교")

    def test_corrupt_snapshot_not_overwritten(self):
        (self.cwd / "state.tsv").write_bytes(b"broken\n")
        self.call("university-add", "2", "Other", ok=False)
        self.assertEqual((self.cwd / "state.tsv").read_bytes(), b"broken\n")


if __name__ == "__main__":
    unittest.main()
