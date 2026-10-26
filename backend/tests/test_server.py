"""Real HTTP requests against the C server; no Python server or third-party packages."""
import concurrent.futures
import base64
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
import urllib.parse

EXE = pathlib.Path(sys.argv[1]).resolve()
sys.argv = sys.argv[:1]
ADMIN = 'test-only-admin-token-' + 'a' * 32
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lJ8AAAAASUVORK5CYII=')
PROOF_HEADERS = {'Content-Type': 'image/png', 'X-Document-Type': 'student_card', 'X-Verification-Consent': '1'}


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
        env = dict(os.environ, CR_ADMIN_TOKEN=ADMIN, CR_ALLOWED_ORIGIN='http://localhost:5173',
                   CR_SEED_UNIVERSITIES=getattr(self, 'seed_catalog', '0'))
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

    def register(self, name='runner', university=1, verified=True):
        account = self.call('POST', '/api/auth/register',
                         {'nickname': name, 'password': 'Strong-pass-123!', 'university_id': university}, expected=201)
        if verified:
            proof = self.upload(account['token'])
            self.review(proof['id'])
            account.update(self.call('GET', '/api/me', token=account['token']))
        return account

    def upload(self, token, expected=201):
        return self.call('POST', '/api/me/university-verifications', raw=PNG, headers=PROOF_HEADERS, token=token, expected=expected)

    def review(self, request_id, decision='approved', expected=200):
        return self.call('POST', f'/api/admin/university-verifications/{request_id}/decision',
                         {'decision': decision, 'reviewer': '담당자', 'reason': '학교와 제출 서류 확인' if decision == 'approved' else '학교명이 다릅니다'},
                         token=ADMIN, expected=expected)

    def proof_image(self, request_id, token, admin=False, expected=200):
        root = '/api/admin/university-verifications' if admin else '/api/me/university-verifications'
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            connection.request('GET', f'{root}/{request_id}/image', headers={'Authorization': 'Bearer '+token})
            response = connection.getresponse()
            payload = response.read()
            self.assertEqual(response.status, expected, payload)
            self.assertEqual(response.getheader('Cache-Control'), 'no-store')
            return payload
        finally:
            connection.close()

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

    def test_single_university_stats_keep_global_rank_and_verification_rules(self):
        a, b = self.register('a'), self.register('b', 2)
        unverified = self.register('unverified', verified=False)
        self.call('POST', '/api/runs', self.run_body('a'), token=a['token'], expected=201)
        self.call('POST', '/api/runs', self.run_body('b', degrees=.002, seconds=120), token=b['token'], expected=201)
        self.call('POST', '/api/runs', self.run_body('not-counted', degrees=.003, seconds=120), token=unverified['token'], expected=201)
        self.call('POST', '/api/universities', {'id': 3, 'name': '비활동대학교'}, token=ADMIN, expected=201)
        rows = self.call('GET', '/api/rankings?from=0&to=2000')
        for row in rows:
            result = self.call('GET', f"/api/universities/{row['university_id']}/stats?from=0&to=2000")
            self.assertEqual(result, row)
        self.assertEqual(self.call('GET', '/api/universities/1/stats?from=0&to=2000')['rank'], 2)
        empty = self.call('GET', '/api/universities/3/stats?from=0&to=2000')
        self.assertEqual((empty['participants'], empty['distance_m'], empty['rank']), (0, 0, 3))
        self.assertEqual(self.call('GET', '/api/universities/1/stats?from=0&to=1000')['runs'], 0)
        for bad in ('0', '-1', '01', '2147483648', '9999999999999999999999999999', 'abc'):
            self.call('GET', f'/api/universities/{bad}/stats?from=0&to=2000', expected=404)
        self.call('GET', '/api/universities/999/stats?from=0&to=2000', expected=404)
        self.call('GET', '/api/universities/1/stats', expected=400)
        self.call('GET', '/api/universities/1/stats?from=2000&to=0', expected=400)
        self.call('POST', '/api/universities/1/stats?from=0&to=2000', {}, expected=405)

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

    def test_unverified_run_then_manual_approval_and_revocation(self):
        account = self.register(verified=False)
        token = account['token']
        self.assertEqual(account['verification_status'], 'not_submitted')
        run = self.call('POST', '/api/runs', self.run_body(), token=token, expected=201)
        self.assertTrue(run['accepted'])
        self.assertFalse(run['counts_for_university'])
        self.assertEqual(self.call('GET', '/api/rankings?from=0&to=2000')[0]['runs'], 0)
        proof = self.upload(token)
        self.assertEqual(proof['status'], 'pending')
        self.assertEqual(self.call('GET', '/api/me', token=token)['verification_status'], 'pending')
        self.review(proof['id'])
        self.assertTrue(self.call('GET', '/api/me', token=token)['university_verified'])
        self.assertEqual(self.call('GET', '/api/rankings?from=0&to=2000')[0]['runs'], 1)
        self.assertTrue(self.call('GET', '/api/me/runs', token=token)[0]['counts_for_university'])
        self.proof_image(proof['id'], ADMIN, admin=True, expected=410)
        self.upload(token, expected=409)
        self.call('POST', f"/api/admin/university-verifications/{proof['id']}/revoke",
                  {'reviewer': '다른담당자', 'reason': '오승인 정정'}, token=ADMIN)
        self.assertFalse(self.call('GET', '/api/me', token=token)['university_verified'])
        self.assertEqual(self.call('GET', '/api/rankings?from=0&to=2000')[0]['runs'], 0)
        self.assertEqual(len(self.call('GET', '/api/me/runs', token=token)), 1)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('select count(*) from verification_audit').fetchone()[0], 2)
            self.assertIsNone(db.execute('select image from university_verifications').fetchone()[0])

    def test_proof_access_rejection_and_resubmission(self):
        a, b = self.register('a', verified=False), self.register('b', verified=False)
        proof = self.upload(a['token'])
        self.assertEqual(self.proof_image(proof['id'], a['token']), PNG)
        self.assertEqual(self.proof_image(proof['id'], ADMIN, admin=True), PNG)
        self.proof_image(proof['id'], b['token'], expected=404)
        self.proof_image(proof['id'], b['token'], admin=True, expected=403)
        self.call('GET', '/api/admin/university-verifications', token=a['token'], expected=403)
        self.call('POST', f"/api/admin/university-verifications/{proof['id']}/decision",
                  {'decision': 'approved', 'reviewer': 'fake', 'reason': 'fake'}, token=a['token'], expected=403)
        self.upload(a['token'], expected=409)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute('UPDATE university_verifications SET submitted_at=? WHERE id=?', (int(time.time())-2*86400, proof['id']))
            db.commit()
        self.upload(a['token'], expected=409)  # still pending after 24h, before 7-day expiry
        self.review(proof['id'], 'rejected')
        self.assertEqual(self.call('GET', '/api/me', token=a['token'])['verification_status'], 'rejected')
        self.proof_image(proof['id'], a['token'], expected=410)
        second = self.upload(a['token'])
        self.assertNotEqual(second['id'], proof['id'])
        self.review(second['id'])

    def test_expiry_cancel_and_university_change_invalidate_proof(self):
        token = self.register(verified=False)['token']
        proof = self.upload(token)
        self.call('PATCH', '/api/me', {'university_id': 2}, token=token)
        self.review(proof['id'], expected=409)
        self.proof_image(proof['id'], token, expected=410)
        proof = self.upload(token)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute('UPDATE university_verifications SET expires_at=0 WHERE id=?', (proof['id'],))
            db.commit()
        self.assertEqual(self.call('GET', '/api/me', token=token)['verification_status'], 'expired')
        self.proof_image(proof['id'], token, expected=410)
        proof = self.upload(token)
        self.call('POST', f"/api/me/university-verifications/{proof['id']}/cancel", {}, token=token)
        self.assertEqual(self.call('GET', '/api/me', token=token)['verification_status'], 'cancelled')
        self.proof_image(proof['id'], token, expected=410)

    def test_proof_input_validation(self):
        token = self.register(verified=False)['token']
        root = '/api/me/university-verifications'
        self.call('POST', root, raw=PNG, headers=PROOF_HEADERS, expected=401)
        self.call('POST', root, raw=b'<svg>bad</svg>', headers=PROOF_HEADERS, token=token, expected=400)
        self.call('POST', root, raw=PNG, headers={'Content-Type': 'image/png', 'X-Document-Type': 'student_card'}, token=token, expected=400)
        self.call('POST', root, raw=PNG, headers=dict(PROOF_HEADERS, **{'Content-Type': 'image/jpeg'}), token=token, expected=400)
        self.call('POST', root, raw=b'bad', headers=dict(PROOF_HEADERS, **{'Content-Length': '5242881'}), token=token, expected=413)
        self.call('PATCH', '/api/me', {'university_verified': True}, token=token, expected=400)
        self.assertEqual(self.call('GET', root, token=token), [])

    def test_verification_history_pagination_and_validation(self):
        a = self.register('a', verified=False)
        b = self.register('b', verified=False)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            for account, count in ((a, 103), (b, 3)):
                db.executemany('INSERT INTO university_verifications '
                    '(member_id,university_id,document_type,status,mime,image_hash,submitted_at,expires_at,consent_version) '
                    "VALUES(?,1,'student_card','rejected','image/png',?,1000,2000,1)",
                    [(account['id'], bytes(32)) for _ in range(count)])
            own_ids = [r[0] for r in db.execute('SELECT id FROM university_verifications WHERE member_id=? ORDER BY id DESC', (a['id'],))]
            all_ids = [r[0] for r in db.execute('SELECT id FROM university_verifications ORDER BY submitted_at,id')]
            db.commit()
        root = '/api/me/university-verifications'
        self.assertEqual([r['id'] for r in self.call('GET', root, token=a['token'])], own_ids[:20])
        self.assertEqual([r['id'] for r in self.call('GET', root+'?limit=100&offset=20', token=a['token'])], own_ids[20:])
        admin = '/api/admin/university-verifications?status=rejected'
        self.assertEqual([r['id'] for r in self.call('GET', admin, token=ADMIN)], all_ids[:100])
        tail = self.call('GET', admin+'&limit=100&offset=100', token=ADMIN)
        self.assertEqual([r['id'] for r in tail], all_ids[100:])
        self.assertEqual(self.call('GET', root+'?offset=1000000', token=a['token']), [])
        for invalid in ('limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'offset=-1',
                        'offset=1000001', 'offset=999999999999999999999999999999999', 'limit=%201', 'offset=%2B1'):
            self.call('GET', root+'?'+invalid, token=a['token'], expected=400)
            self.call('GET', admin+'&'+invalid, token=ADMIN, expected=400)
        self.call('GET', admin+'&limit=1&limit=2', token=ADMIN, expected=400)
        self.call('GET', admin+'&offset=100', token=a['token'], expected=403)

    def test_admin_can_revoke_approval_after_first_hundred(self):
        account = self.register(verified=False)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            # Generate independent approved members without spending 101 password KDFs.
            for i in range(101):
                member_id = db.execute('INSERT INTO members '
                    '(nickname,university_id,salt,password_hash,iterations,created_at,university_verified_at) '
                    'SELECT ?,university_id,salt,password_hash,iterations,created_at,1000 FROM members WHERE id=?',
                    (f'approved-{i}', account['id'])).lastrowid
                db.execute('INSERT INTO university_verifications '
                    '(member_id,university_id,document_type,status,mime,image_hash,submitted_at,expires_at,consent_version) '
                    "VALUES(?,1,'student_card','approved','image/png',?,1000,2000,1)", (member_id, bytes(32)))
            db.commit()
        root = '/api/admin/university-verifications'
        self.assertEqual(len(self.call('GET', root+'?status=approved', token=ADMIN)), 100)
        tail = self.call('GET', root+'?status=approved&offset=100', token=ADMIN)
        self.assertEqual(len(tail), 1)
        result = self.call('POST', f"{root}/{tail[0]['id']}/revoke",
                          {'reviewer': '담당자', 'reason': '오승인 정정'}, token=ADMIN)
        self.assertEqual(result['status'], 'revoked')
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            self.assertIsNone(db.execute('SELECT university_verified_at FROM members WHERE id=?', (tail[0]['member_id'],)).fetchone()[0])

    def test_verification_detail_owner_access_and_admin_audit_history(self):
        account = self.register(verified=False)
        other = self.register('other', verified=False)
        proof = self.upload(account['token'])
        own = f"/api/me/university-verifications/{proof['id']}"
        admin = f"/api/admin/university-verifications/{proof['id']}"
        self.assertEqual(self.call('GET', own, token=account['token']), proof)
        self.assertEqual(self.call('GET', admin, token=ADMIN), proof)
        self.call('GET', own, expected=401)
        self.call('GET', own, token=other['token'], expected=404)
        self.call('GET', admin, token=account['token'], expected=403)
        self.call('GET', '/api/me/university-verifications/99999', token=account['token'], expected=404)
        self.call('POST', own, {}, token=account['token'], expected=405)
        self.assertEqual(self.call('GET', admin+'/audit', token=ADMIN), [])
        self.review(proof['id'])
        self.review(proof['id'], expected=409)
        self.call('POST', admin+'/revoke', {'reviewer': '정정담당자', 'reason': '오승인 정정'}, token=ADMIN)
        rows = self.call('GET', admin+'/audit', token=ADMIN)
        self.assertEqual([row['action'] for row in rows], ['approved', 'revoked'])
        self.assertEqual([row['reviewer'] for row in rows], ['담당자', '정정담당자'])
        self.assertEqual(rows[1]['reason'], '오승인 정정')
        self.assertTrue(all(row['request_id'] == proof['id'] and row['member_id'] == account['id'] for row in rows))
        self.assertEqual(set(rows[0]), {'id', 'request_id', 'member_id', 'action', 'reviewer', 'reason', 'created_at'})
        self.assertEqual(self.call('GET', admin+'/audit?limit=1&offset=1', token=ADMIN), rows[1:])
        self.assertEqual(self.call('GET', admin+'/audit?offset=100', token=ADMIN), [])
        for query in ('limit=0', 'limit=101', 'offset=-1', 'offset=1000001'):
            self.call('GET', admin+'/audit?'+query, token=ADMIN, expected=400)
        self.call('GET', admin+'/audit', token=account['token'], expected=403)
        self.call('GET', own+'/audit', token=account['token'], expected=404)
        self.call('GET', '/api/admin/university-verifications/99999/audit', token=ADMIN, expected=404)
        self.call('POST', admin+'/audit', {}, token=ADMIN, expected=405)
        self.assertEqual(self.call('GET', own, token=account['token'])['status'], 'revoked')
        self.proof_image(proof['id'], account['token'], expected=410)

    def test_automatic_expiration_audit_on_restart_and_concurrent_requests(self):
        account = self.register(verified=False)
        first = self.upload(account['token'])
        self.stop()
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute('UPDATE university_verifications SET expires_at=0 WHERE id=?', (first['id'],))
            db.commit()
        self.start()  # startup maintenance must write the same audit as request maintenance
        second = self.upload(account['token'])
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute('UPDATE university_verifications SET expires_at=0 WHERE id=?', (second['id'],))
            db.commit()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertTrue(all(r['status'] == 'ok' for r in pool.map(lambda _: self.call('GET', '/health'), range(8))))
        for proof in (first, second):
            path = f"/api/admin/university-verifications/{proof['id']}"
            rows = self.call('GET', path+'/audit', token=ADMIN)
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0]['action'], rows[0]['reviewer'], rows[0]['reason']),
                             ('expired', 'system', 'review_window_expired'))
            self.assertEqual(self.call('GET', path, token=ADMIN)['status'], 'expired')
            self.proof_image(proof['id'], account['token'], expected=410)

    def test_university_changes_audit_pending_and_approved_cancellations(self):
        account = self.register(verified=False)
        first = self.upload(account['token'])
        self.call('PATCH', '/api/me', {'university_id': 2}, token=account['token'])
        second = self.upload(account['token'])
        self.review(second['id'])
        self.call('PATCH', '/api/me', {'university_id': 2}, token=account['token'])  # unchanged school
        self.call('PATCH', '/api/me', {'university_id': 1}, token=account['token'])
        for proof, expected in ((first, ['cancelled']), (second, ['approved', 'cancelled'])):
            path = f"/api/admin/university-verifications/{proof['id']}/audit"
            rows = self.call('GET', path, token=ADMIN)
            self.assertEqual([row['action'] for row in rows], expected)
            self.assertEqual((rows[-1]['reviewer'], rows[-1]['reason']), ('member', 'university_changed'))
            self.proof_image(proof['id'], account['token'], expected=410)
        self.assertFalse(self.call('GET', '/api/me', token=account['token'])['university_verified'])

    def test_audit_failure_rolls_back_review_school_change_and_expiration(self):
        account = self.register(verified=False)
        proof = self.upload(account['token'])
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute("CREATE TRIGGER block_audit BEFORE INSERT ON verification_audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END")
            db.commit()
        self.review(proof['id'], expected=500)
        self.call('PATCH', '/api/me', {'university_id': 2}, token=account['token'], expected=500)
        profile = self.call('GET', '/api/me', token=account['token'])
        self.assertEqual(profile['university_id'], 1)
        self.assertFalse(profile['university_verified'])
        self.assertEqual(self.proof_image(proof['id'], account['token']), PNG)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute('UPDATE university_verifications SET expires_at=0 WHERE id=?', (proof['id'],))
            db.commit()
        self.call('GET', '/health', expected=503)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT status,image FROM university_verifications WHERE id=?', (proof['id'],)).fetchone(), ('pending', PNG))
            self.assertEqual(db.execute('SELECT count(*) FROM verification_audit').fetchone()[0], 0)
            db.execute('DROP TRIGGER block_audit')
            db.commit()
        self.call('GET', '/health')
        rows = self.call('GET', f"/api/admin/university-verifications/{proof['id']}/audit", token=ADMIN)
        self.assertEqual([row['action'] for row in rows], ['expired'])

    def test_two_reviewers_cannot_overwrite_decision(self):
        token = self.register(verified=False)['token']
        proof = self.upload(token)
        def approve(_):
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
            connection.request('POST', f"/api/admin/university-verifications/{proof['id']}/decision",
                               json.dumps({'decision': 'approved', 'reviewer': 'operator', 'reason': 'checked'}),
                               {'Content-Type': 'application/json', 'Authorization': 'Bearer '+ADMIN})
            response = connection.getresponse()
            status = response.status
            response.read()
            connection.close()
            return status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(approve, range(2))), [200, 409])

    def test_official_catalog_seed_search_and_stable_existing_ids(self):
        self.stop()
        self.seed_catalog = '1'
        self.start()
        rows = self.call('GET', '/api/universities')
        self.assertEqual(len(rows), 385)
        query = urllib.parse.urlencode({'q': '서울대학교', 'region': '서울특별시'})
        row = self.call('GET', '/api/universities?'+query)[0]
        self.assertEqual(row['id'], 1)  # existing member FK IDs must never be renumbered
        self.assertEqual(row['kind'], '대학교')
        alias = urllib.parse.urlencode({'q': '국립강릉원주대학교'})
        self.assertEqual(self.call('GET', '/api/universities?'+alias)[0]['name'], '강원대학교')
        closed = urllib.parse.urlencode({'q': '서남대학교'})
        self.assertEqual(self.call('GET', '/api/universities?'+closed), [])
        self.stop()
        self.start()
        self.assertEqual(len(self.call('GET', '/api/universities')), 385)

    def test_v1_database_upgrade_preserves_users_tokens_runs(self):
        account = self.register()
        self.call('POST', '/api/runs', self.run_body(), token=account['token'], expected=201)
        self.stop()
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute('DROP TABLE verification_audit')
            db.execute('DROP TABLE university_verifications')
            db.execute('ALTER TABLE members DROP COLUMN university_verified_at')
            for column in ('kind', 'regions_json', 'aliases_json', 'campuses_json', 'source_date'):
                db.execute('ALTER TABLE universities DROP COLUMN '+column)
            db.execute('PRAGMA user_version=1')
            db.commit()
        self.start()
        self.assertEqual(self.call('GET', '/api/me', token=account['token'])['id'], account['id'])
        self.assertEqual(self.call('GET', '/api/me', token=account['token'])['verification_status'], 'not_submitted')
        self.assertEqual(len(self.call('GET', '/api/me/runs', token=account['token'])), 1)
        self.assertEqual(self.call('GET', '/api/rankings?from=0&to=2000')[0]['runs'], 0)
        proof = self.upload(account['token'])
        self.review(proof['id'])
        self.assertEqual(self.call('GET', '/api/rankings?from=0&to=2000')[0]['runs'], 1)

    def test_backups_exclude_identity_photos_without_changing_live_data(self):
        token = self.register(verified=False)['token']
        proof = self.upload(token)
        backup = self.cwd / 'private-backup.sqlite3'
        tool = pathlib.Path(__file__).resolve().parent.parent / 'tools' / 'backup.py'
        p = subprocess.run([sys.executable, str(tool), str(self.db), str(backup)], capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        with contextlib.closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute('SELECT status,image FROM university_verifications').fetchone(), ('cancelled', None))
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
        self.assertEqual(self.proof_image(proof['id'], token), PNG)
        self.stop()
        self.db = backup
        self.start()
        self.call('GET', '/api/me', token=token, expected=401)

    def test_strict_json_grammar_and_unicode(self):
        invalid = [b'{"id":03,"name":"bad"}', b'{"id":4.,"name":"bad"}',
                   b'{"id":+4,"name":"bad"}', b'{"id":.4,"name":"bad"}',
                   b'{"id":4e,"name":"bad"}', b'{"id":4e+,"name":"bad"}',
                   b'{\x0b"id":4,"name":"bad"}', b'{"id":4,"name":"\xff"}',
                   b'{"id":4,"name":"\xed\xa0\x80"}', b'{"id":4,"name":"\xc0\xaf"}',
                   b'{"id":4,"name":"bad\\u0000tail"}', b'{"id":4,"name":"bad\x00tail"}',
                   b'{"id":4,"name":"bad\\x41"}', b'{"id":4,"name":"\\uD800"}']
        for body in invalid:
            with self.subTest(body=body):
                self.call('POST', '/api/universities', raw=body, token=ADMIN, expected=400)
        result = self.call('POST', '/api/universities', raw=b'{"id":4e0,"name":"\\uD83C\\uDFC3 University"}', token=ADMIN, expected=201)
        self.assertEqual(result['name'], '🏃 University')
        self.assertEqual(len(self.call('GET', '/api/universities')), 3)

    def test_query_and_path_encoding_reject_truncation(self):
        invalid = ['/api/rankings?from=0%00junk&to=2000', '/api/me/runs?limit=1%00junk',
                   '/api/universities?q=%', '/api/universities?q=%2', '/api/universities?q=%GG',
                   '/api/universities?q=%ff', '/api/universities?q=%c0%af', '/api/universities?q=%0d',
                   '/api/universities?q=%7f', '/api/universities%00suffix', '/api%2funiversities']
        for path in invalid:
            with self.subTest(path=path):
                self.call('GET', path, expected=400)
        query = urllib.parse.urlencode({'q': '서울대학교'})
        self.assertEqual(self.call('GET', '/api/universities?'+query)[0]['id'], 1)

    def test_duplicate_headers_and_request_framing(self):
        cases = [
            ['Content-Length: +2'], ['Content-Length: 2junk'],
            ['Content-Length: 2', 'content-length: 2'],
            ['Transfer-Encoding: chunked', 'Content-Length: 2'],
            ['Content-Length: 2', 'Authorization: Bearer '+ADMIN, 'authorization: Bearer '+ADMIN],
            ['Content-Length: 2', 'Origin: http://localhost:5173', 'Origin: http://localhost:5173'],
            ['Content-Length: 2', 'Content-Type: application/json'],
            ['Content-Length: 2', 'Host: localhost'],
        ]
        for headers in cases:
            with self.subTest(headers=headers):
                with socket.create_connection(('127.0.0.1', self.port), timeout=5) as sock:
                    request = '\r\n'.join(['POST /api/universities HTTP/1.1', 'Host: localhost',
                                           'Content-Type: application/json', *headers, 'Connection: close', '', '{}'])
                    sock.sendall(request.encode('ascii'))
                    response = http.client.HTTPResponse(sock)
                    response.begin()
                    self.assertEqual(response.status, 400)
                    response.read()

    def test_protected_routes_authenticate_before_reading_body(self):
        # Do not send the advertised body: rejection must not wait for 15s timeout.
        for path, expected in [('/api/universities', 403), ('/api/admin/university-verifications/1/decision', 403),
                               ('/api/runs', 401), ('/api/me/university-verifications', 401), ('/api/auth/logout', 401)]:
            with self.subTest(path=path), socket.create_connection(('127.0.0.1', self.port), timeout=3) as sock:
                sock.sendall(f'POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n'.encode('ascii'))
                response = http.client.HTTPResponse(sock)
                response.begin()
                self.assertEqual(response.status, expected)
                response.read()

    def test_maximum_gps_request_survives_parser_budget(self):
        token = self.register()['token']
        points = [{'timestamp': 1000+i, 'latitude': 0, 'longitude': i*.000001} for i in range(20000)]
        result = self.call('POST', '/api/runs', {'key': 'maximum-points', 'points': points}, token=token, expected=201)
        self.assertGreater(result['distance_m'], 2000)

    def test_cancel_and_logout_require_empty_object(self):
        token = self.register(verified=False)['token']
        proof = self.upload(token)
        self.call('POST', f"/api/me/university-verifications/{proof['id']}/cancel", {'ignored': True}, token=token, expected=400)
        self.assertEqual(self.call('GET', '/api/me', token=token)['verification_status'], 'pending')
        self.call('POST', '/api/auth/logout', {'ignored': True}, token=token, expected=400)
        self.call('GET', '/api/me', token=token)

    def test_invalid_server_configuration_does_not_create_database(self):
        cases = [('8080', 'http://localhost:5173'), ('127.0.0.1:0', 'http://localhost:5173'),
                 ('127.0.0.1:65536', 'http://localhost:5173'), ('256.0.0.1:8080', 'http://localhost:5173')]
        cases += [('127.0.0.1:8080', origin) for origin in ['http://', 'https://localhost/path', 'https://user@localhost',
                  'http://localhost:0', 'http://localhost:abc', 'http://localhost/', 'http://local host', 'null']]
        for index, (listen, origin) in enumerate(cases):
            with self.subTest(listen=listen, origin=origin):
                db = self.cwd / f'invalid-{index}.sqlite3'
                result = subprocess.run([str(EXE), str(db), listen], env=dict(os.environ, CR_ALLOWED_ORIGIN=origin, CR_ADMIN_TOKEN=ADMIN),
                                        capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(db.exists())

    def test_concurrent_fresh_database_migration(self):
        database = self.cwd / 'concurrent.sqlite3'
        processes, ports = [], []
        env = dict(os.environ, CR_SEED_UNIVERSITIES='0', CR_ADMIN_TOKEN=ADMIN, CR_ALLOWED_ORIGIN='http://localhost:5173')
        with contextlib.closing(sqlite3.connect(database)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('BEGIN IMMEDIATE')
            try:
                for _ in range(2):
                    with socket.socket() as sock:
                        sock.bind(('127.0.0.1', 0))
                        ports.append(sock.getsockname()[1])
                    processes.append(subprocess.Popen([str(EXE), str(database), f'127.0.0.1:{ports[-1]}'],
                                                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
                time.sleep(.5)
                db.commit()
                for port, process in zip(ports, processes):
                    for _ in range(100):
                        self.assertIsNone(process.poll(), 'Concurrent migration failed')
                        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                        try:
                            connection.request('GET', '/health')
                            response = connection.getresponse()
                            response.read()
                            self.assertEqual(response.status, 200)
                            break
                        except (OSError, http.client.HTTPException):
                            time.sleep(.05)
                        finally:
                            connection.close()
                    else:
                        self.fail('Concurrent server failed to become healthy')
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 2)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            finally:
                db.rollback()
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
