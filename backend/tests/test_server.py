"""Real HTTP requests against the C server; no Python server or third-party packages."""
import concurrent.futures
import contextlib
import http.client
import hashlib
import json
import os
import pathlib
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

EXE = pathlib.Path(sys.argv[1]).resolve()
sys.argv = sys.argv[:1]
ADMIN = 'test-only-admin-token-' + 'a' * 32


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=EXE.parent)
        self.addCleanup(self.temp.cleanup)
        self.cwd = pathlib.Path(self.temp.name)
        self.db = self.cwd / '기록.sqlite3'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.process = None
        self.addCleanup(self.stop)
        self.start()
        self.call('POST', '/api/universities', {'id': 1, 'name': '서울대학교'}, token=ADMIN, expected=201)
        self.call('POST', '/api/universities', {'id': 2, 'name': '연세대학교'}, token=ADMIN, expected=201)

    def start(self):
        env = dict(os.environ, CR_ADMIN_TOKEN=ADMIN, CR_ALLOWED_ORIGIN='http://localhost:5173')
        self.log = open(self.cwd / 'server.log', 'ab')
        self.process = subprocess.Popen([str(EXE), str(self.db), f'127.0.0.1:{self.port}'],
                                        cwd=self.cwd, env=env, stdout=self.log, stderr=self.log)
        for _ in range(100):
            if self.process.poll() is not None:
                self.log.close()
                self.fail((self.cwd / 'server.log').read_text(encoding='utf-8', errors='replace'))
            try:
                self.call('GET', '/health')
                return
            except (OSError, http.client.HTTPException):
                time.sleep(.05)
        self.fail('Server failed to become healthy')

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process = None
        if getattr(self, 'log', None) and not self.log.closed:
            self.log.close()

    def call(self, method, path, body=None, token=None, expected=200, headers=None, raw=None):
        h = dict(headers or {})
        if token:
            h['Authorization'] = 'Bearer ' + token
        if body is not None or raw is not None:
            h.setdefault('Content-Type', 'application/json')
        data = raw if raw is not None else json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            connection.request(method, path, data, h)
            response = connection.getresponse()
            payload = response.read()
            self.assertEqual(response.status, expected, (method, path, payload))
            self.assertEqual(response.getheader('Cache-Control'), 'no-store')
            return json.loads(payload) if payload else None
        finally:
            connection.close()

    def register(self, name='runner', university=1):
        return self.call('POST', '/api/auth/register',
                         {'nickname': name, 'password': 'Strong-pass-123!', 'university_id': university}, expected=201)

    def run_body(self, key='run-1', start=1000, degrees=.001, seconds=60):
        return {'key': key, 'points': [{'timestamp': start, 'latitude': 0, 'longitude': 0},
                                       {'timestamp': start + seconds, 'latitude': 0, 'longitude': degrees}]}

    def test_registration_login_session_and_privacy(self):
        account = self.register('달리는학생')
        self.assertEqual(account['university_name'], '서울대학교')
        self.assertEqual(len(account['token']), 64)
        self.call('GET', '/api/me', expected=401)
        self.call('GET', '/api/me', token='b' * 64, expected=401)
        self.call('POST', '/api/auth/login', {'nickname': '달리는학생', 'password': 'wrong-password'}, expected=401)
        login = self.call('POST', '/api/auth/login', {'nickname': '달리는학생', 'password': 'Strong-pass-123!'})
        self.assertEqual(self.call('GET', '/api/me', token=login['token'])['id'], account['id'])
        other = self.register('other', 2)
        run = self.call('POST', '/api/runs', self.run_body(), token=login['token'], expected=201)
        self.call('GET', '/api/me/runs/' + str(run['id']), token=other['token'], expected=404)
        self.assertEqual(self.call('GET', '/api/me/runs', token=other['token']), [])
        detail = self.call('GET', '/api/me/runs/' + str(run['id']), token=login['token'])
        self.assertEqual(len(detail['points']), 2)
        self.call('POST', '/api/auth/logout', {}, token=login['token'], expected=204)
        self.call('GET', '/api/me', token=login['token'], expected=401)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            salt, password_hash = db.execute('select salt,password_hash from members limit 1').fetchone()
            self.assertEqual(len(salt), 16)
            self.assertEqual(len(password_hash), 32)
            self.assertEqual(password_hash, hashlib.pbkdf2_hmac('sha256', b'Strong-pass-123!', salt, 600000))
            stored_token_hash = db.execute('select token_hash from sessions where member_id=?', (account['id'],)).fetchone()[0]
            self.assertEqual(stored_token_hash, hashlib.sha256(account['token'].encode()).digest())
            self.assertNotIn(account['token'].encode(), self.db.read_bytes())

    def test_real_multi_user_aggregation(self):
        a, b, c = self.register('a'), self.register('b'), self.register('c', 2)
        first = self.call('POST', '/api/runs', self.run_body('a1'), token=a['token'], expected=201)
        self.call('POST', '/api/runs', self.run_body('a2', start=1100), token=a['token'], expected=201)
        self.call('POST', '/api/runs', self.run_body('b1'), token=b['token'], expected=201)
        self.call('POST', '/api/runs', self.run_body('c1', degrees=.002, seconds=120), token=c['token'], expected=201)
        rows = self.call('GET', '/api/rankings?from=1000&to=2000')
        self.assertEqual([row['university_id'] for row in rows], [2, 1])
        self.assertEqual(rows[1]['participants'], 2)
        self.assertEqual(rows[1]['runs'], 3)
        self.assertAlmostEqual(rows[1]['average_distance_m'], first['distance_m'] * 1.5)
        # Shared DB, exact interval boundaries, and sessions survive restart.
        self.stop()
        self.start()
        self.assertEqual(self.call('GET', '/api/rankings?from=1000&to=2000'), rows)
        self.assertEqual(len(self.call('GET', '/api/me/runs', token=a['token'])), 2)
        self.assertEqual(self.call('GET', '/api/rankings?from=0&to=1000')[0]['participants'], 0)
        stats = self.call('GET', '/api/me/stats?from=0&to=2000', token=a['token'])
        self.assertEqual(stats['accepted_runs'], 2)

    def test_idempotency_overlap_and_owner(self):
        token = self.register()['token']
        body = self.run_body()
        first = self.call('POST', '/api/runs', body, token=token, expected=201)
        retry = self.call('POST', '/api/runs', body, token=token)
        self.assertEqual(first['id'], retry['id'])
        self.call('POST', '/api/runs', self.run_body(degrees=.002), token=token, expected=409)
        self.call('POST', '/api/runs', self.run_body('different-key'), token=token, expected=409)
        self.call('POST', '/api/runs', self.run_body('overlap', start=1030), token=token, expected=409)
        body = self.run_body('inject', start=2000)
        body['member_id'] = 999
        self.call('POST', '/api/runs', body, token=token, expected=400)
        self.assertEqual(len(self.call('GET', '/api/me/runs', token=token)), 1)

    def test_abnormal_records_and_bad_gps(self):
        token = self.register()['token']
        for key, degrees, seconds, flag in [('teleport', .1, 1, 1), ('bicycle', .002, 30, 2), ('gap', .001, 121, 8)]:
            body = self.run_body(key, degrees=degrees, seconds=seconds)
            run = self.call('POST', '/api/runs', body, token=token, expected=201)
            self.assertFalse(run['accepted'])
            self.assertTrue(run['flags'] & flag)
        rows = self.call('GET', '/api/rankings?from=0&to=2000')
        self.assertEqual(rows[0]['distance_m'], 0)
        self.assertEqual(rows[0]['rank'], rows[1]['rank'])
        for field, value in [('timestamp', 1000), ('latitude', 91), ('longitude', '127')]:
            body = self.run_body('invalid')
            body['points'][1][field] = value
            self.call('POST', '/api/runs', body, token=token, expected=400)
        self.call('POST', '/api/runs', self.run_body('future', start=int(time.time())+1000), token=token, expected=400)
        self.call('GET', '/api/rankings?from=2000&to=1000', expected=400)

    def test_concurrent_submissions_exactly_once(self):
        token = self.register()['token']
        body = self.run_body()
        def submit(_):
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
            connection.request('POST', '/api/runs', json.dumps(body), {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
            response = connection.getresponse()
            result = (response.status, json.loads(response.read()))
            connection.close()
            return result
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(submit, range(8)))
        self.assertEqual(sum(status == 201 for status, _ in results), 1)
        self.assertEqual(sum(status == 200 for status, _ in results), 7)
        self.assertEqual(len({body['id'] for _, body in results}), 1)
        self.assertEqual(self.call('GET', '/api/rankings?from=0&to=2000')[0]['runs'], 1)

    def test_admin_profile_and_constraints(self):
        self.call('POST', '/api/universities', {'id': 3, 'name': 'Unauthorized'}, expected=403)
        self.call('POST', '/api/universities', {'id': 1, 'name': 'Duplicate'}, token=ADMIN, expected=409)
        self.call('POST', '/api/auth/register', {'nickname': 'bad', 'password': 'Strong-pass-123!', 'university_id': 99}, expected=400)
        token = self.register()['token']
        self.call('POST', '/api/auth/register', {'nickname': 'runner', 'password': 'Strong-pass-123!', 'university_id': 1}, expected=409)
        me = self.call('PATCH', '/api/me', {'nickname': '새이름', 'university_id': 2}, token=token)
        self.assertEqual(me['university_id'], 2)
        self.call('POST', '/api/runs', self.run_body(), token=token, expected=201)
        self.call('PATCH', '/api/me', {'university_id': 1}, token=token, expected=409)
        self.call('PATCH', '/api/me', {'university_id': 2}, token=token)
        self.call('PATCH', '/api/me', {'nickname': '다시변경'}, token=token)

    def test_parallel_distinct_runs_no_lost_updates(self):
        token = self.register()['token']
        def submit(i):
            return self.call('POST', '/api/runs', self.run_body(f'parallel-{i}', start=1000+i*100), token=token, expected=201)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(submit, range(12)))
        row = self.call('GET', '/api/rankings?from=0&to=5000')[0]
        self.assertEqual(row['runs'], 12)
        self.assertEqual(row['participants'], 1)
        self.assertAlmostEqual(row['distance_m'], sum(r['distance_m'] for r in results))

    def test_ranking_ties_and_pagination(self):
        self.call('POST', '/api/universities', {'id': 3, 'name': '빈대학'}, token=ADMIN, expected=201)
        a, b = self.register('a'), self.register('b', 2)
        self.call('POST', '/api/runs', self.run_body(), token=a['token'], expected=201)
        self.call('POST', '/api/runs', self.run_body(), token=b['token'], expected=201)
        rows = self.call('GET', '/api/rankings?from=0&to=2000')
        self.assertEqual([row['rank'] for row in rows], [1, 1, 3])
        self.assertEqual([row['university_id'] for row in rows], [1, 2, 3])
        self.assertEqual(self.call('GET', '/api/rankings?from=0&to=2000&limit=1&offset=1'), [rows[1]])

    def test_auth_rate_limit(self):
        for _ in range(30):
            self.call('POST', '/api/auth/login', {}, expected=400)
        self.call('POST', '/api/auth/login', {}, expected=429)

    def test_json_cors_and_http_contract(self):
        self.call('GET', '/api/universities', headers={'Origin': 'https://evil.example'}, expected=403)
        self.call('OPTIONS', '/api/runs', headers={'Origin': 'http://localhost:5173'}, expected=204)
        self.call('GET', '/not-found', expected=404)
        self.call('POST', '/api/auth/register', raw=b'{"nickname":"a","nickname":"b"}', expected=400)
        self.call('POST', '/api/auth/register', raw=b'{"nickname":"a\\u0000b"}', expected=400)
        self.call('POST', '/api/auth/register', raw=b'{} trailing', expected=400)
        self.call('POST', '/api/auth/register', raw=b'{}', headers={'Content-Type': 'text/plain'}, expected=415)
        self.call('POST', '/api/auth/register', raw=b'{}', headers={'Content-Length': '2097153'}, expected=413)
        self.call('GET', '/api/rankings?from=0&to=2000&limit=0', expected=400)
        self.call('GET', '/api/rankings?from=0&from=1&to=2000', expected=400)

    def test_expired_token(self):
        token = self.register()['token']
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute('UPDATE sessions SET expires_at=0')
            db.commit()
        self.call('GET', '/api/me', token=token, expected=401)

    def test_online_backup(self):
        token = self.register()['token']
        self.call('POST', '/api/runs', self.run_body(), token=token, expected=201)
        backup = self.cwd / 'backup.sqlite3'
        tool = pathlib.Path(__file__).resolve().parent.parent / 'tools' / 'backup.py'
        p = subprocess.run([sys.executable, str(tool), str(self.db), str(backup)], capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        with contextlib.closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute('select count(*) from runs').fetchone()[0], 1)
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        p = subprocess.run([sys.executable, str(tool), str(self.db), str(backup)], capture_output=True)
        self.assertNotEqual(p.returncode, 0)


if __name__ == '__main__':
    unittest.main()
