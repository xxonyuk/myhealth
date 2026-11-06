"""MYHEALTH 사진 인식 중계 서버 (Python 표준 라이브러리만 사용)

폰 앱 → (Cloudflare Tunnel) → API 서버(8787) → 로컬 Ollama 비전 모델
- 회원 계정(ID·비밀번호)으로 로그인해야 사용 가능, 회원별 하루 사용량 제한
- 회원 정보는 users.db(SQLite)에 저장 (공개 저장소에 올리지 않음), 비밀번호는 해시로만 저장
- 사진은 메모리에서 인식만 하고 저장하지 않음
- 관리자 페이지(8788)는 이 PC의 브라우저에서만 열림 (터널은 8787만 연결하므로 외부에서 접근 불가)

사용법:
  python gateway.py      서버 실행 → 이 PC에서 http://localhost:8788 열면 관리자 페이지
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.environ.get('MYHEALTH_DB', os.path.join(HERE, 'users.db'))

API_PORT = int(os.environ.get('MYHEALTH_PORT', '8787'))
ADMIN_PORT = int(os.environ.get('MYHEALTH_ADMIN_PORT', '8788'))
OLLAMA = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434')
MODEL = os.environ.get('MYHEALTH_MODEL', 'gemma4:12b')
DEFAULT_LIMIT = int(os.environ.get('MYHEALTH_DAILY_LIMIT', '20'))
SESSION_DAYS = 90
MAX_BODY = 8 * 1024 * 1024
ALLOWED_ORIGINS = {
    'https://xxonyuk.github.io',
    *filter(None, os.environ.get('MYHEALTH_EXTRA_ORIGINS', '').split(',')),
}


PROMPT = """너는 한국 음식 영양 분석가야. 사진 속 음식이나 제품을 보고 영양정보를 추정해서 JSON으로 답해.

규칙:
- 항목은 '먹는 단위'로 나눠: 그릇·접시 하나가 항목 하나야. 반찬 그릇이 여러 개면 그릇마다 하나씩.
  한 접시 안의 재료·고명(양파, 파, 깨, 채소 등)은 절대 따로 나누지 말고 그 요리에 포함해.
- 요리 이름은 한국에서 부르는 정확한 메뉴명으로 (예: 빨간 양념 돼지고기 볶음 → 제육볶음, 간장 양념 소고기 → 불고기).
- 포장 제품이면 제품 1개를 항목 하나로 하고, 제품명은 포장에 적힌 그대로 읽어.
  영양성분표가 보이면 그 숫자를 우선 쓰고, 총 내용량 기준으로 환산해.
- grams는 사진에 보이는 양(제품이면 총 내용량) 추정 중량(g). 영양값은 모두 그 중량 전체 기준.
- brand는 포장 제품의 브랜드만. 집밥·외식이면 빈 문자열.
- search_name은 식약처 DB 검색용 짧은 일반 이름 (예: "제육볶음", "햇반", "비빔밥").
- 확실하지 않으면 가장 가능성 높은 것으로 추정하고 confidence를 low로.
- 음식이 하나라도 보이면 items를 절대 비우지 마. 음식이 전혀 없을 때만 빈 배열.
- 모든 이름은 한국어. note는 30자 이내 한 문장."""

SCHEMA = {
    'type': 'object',
    'properties': {
        'items': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'name': {'type': 'string'},
                    'brand': {'type': 'string'},
                    'search_name': {'type': 'string'},
                    'grams': {'type': 'number'},
                    'kcal': {'type': 'number'},
                    'carb': {'type': 'number'},
                    'protein': {'type': 'number'},
                    'fat': {'type': 'number'},
                    'sugar': {'type': 'number'},
                    'sodium': {'type': 'number'},
                    'confidence': {'type': 'string', 'enum': ['high', 'medium', 'low']},
                },
                'required': ['name', 'search_name', 'grams', 'kcal', 'carb', 'protein', 'fat', 'sugar', 'sodium', 'confidence'],
            },
        },
        'note': {'type': 'string'},
    },
    'required': ['items'],
}


# ---------- DB ----------
db_lock = threading.Lock()


def db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')  # 회원 삭제 시 로그인·사용 기록도 같이 삭제
    return conn


def init_db():
    with db_lock, db() as c:
        c.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                pw_hash TEXT NOT NULL,
                daily_limit INTEGER NOT NULL,        -- 0 = 무제한
                active INTEGER NOT NULL DEFAULT 1,
                must_change INTEGER NOT NULL DEFAULT 1,  -- 임시 비밀번호면 첫 로그인 후 변경해야 함
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                day TEXT NOT NULL,
                count INTEGER NOT NULL,
                last_at TEXT NOT NULL,
                PRIMARY KEY (user_id, day)
            );
        ''')


def now():
    return datetime.now().isoformat(timespec='seconds')


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(salt), 240_000).hex()
    return f'pbkdf2${salt}${h}'


def check_pw(pw, stored):
    _, salt, _ = stored.split('$')
    return hmac.compare_digest(hash_pw(pw, salt), stored)


def temp_password():
    # 헷갈리는 글자(0/O, 1/l/I) 없이 8자리
    abc = 'abcdefghjkmnpqrstuvwxyz23456789'
    return ''.join(secrets.choice(abc) for _ in range(8))


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def new_session(c, user_id):
    token = secrets.token_urlsafe(32)
    c.execute('INSERT INTO sessions VALUES (?, ?, ?)',
              (token_hash(token), user_id, (datetime.now() + timedelta(days=SESSION_DAYS)).isoformat(timespec='seconds')))
    return token


def user_by_token(token):
    if not token:
        return None
    with db() as c:
        return c.execute('''SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1''',
                         (token_hash(token), now())).fetchone()


def used_today(c, user_id):
    r = c.execute('SELECT count FROM usage WHERE user_id = ? AND day = ?', (user_id, date.today().isoformat())).fetchone()
    return r['count'] if r else 0


def remaining(c, user):
    return None if user['daily_limit'] == 0 else max(0, user['daily_limit'] - used_today(c, user['id']))


def use_quota(user):
    """오늘 사용량을 1 올림. 한도를 넘으면 False."""
    with db_lock, db() as c:
        if user['daily_limit'] and used_today(c, user['id']) >= user['daily_limit']:
            return False
        c.execute('''INSERT INTO usage VALUES (?, ?, 1, ?)
                     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1, last_at = excluded.last_at''',
                  (user['id'], date.today().isoformat(), now()))
        return True


# 로그인 연속 실패 제한: ID별·IP별 15분에 5회
fails = {}


def too_many_fails(*keys):
    t = time.time()
    return any(len([x for x in fails.get(k, []) if t - x < 900]) >= 5 for k in keys)


def add_fail(*keys):
    t = time.time()
    for k in keys:
        fails[k] = [x for x in fails.get(k, []) if t - x < 900] + [t]


# ---------- Ollama ----------
def clean_brand(b):
    # 모델이 브랜드 칸에 "none", "없음"이나 설명문을 넣는 경우가 있어 걸러냄
    b = str(b or '').strip().strip("'\"")
    return '' if not b or len(b) > 30 or b.lower() in ('none', 'null', 'n/a') or '없음' in b else b


def analyze(image_b64):
    body = {
        'model': MODEL,
        'stream': False,
        'format': SCHEMA,
        'think': False,  # 생각 모드가 있는 모델은 끄고 바로 답하게 (속도·출력 길이)
        'keep_alive': '30m',  # 30분 안에 다음 사진이 오면 모델을 다시 올리지 않음 (첫 요청은 ~40초)
        'options': {'temperature': 0, 'num_predict': 1500},
        'messages': [{'role': 'user', 'content': PROMPT, 'images': [image_b64]}],
    }
    req = urllib.request.Request(f'{OLLAMA}/api/chat', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=180) as res:
        data = json.load(res)
    result = json.loads(data['message']['content'])
    items = []
    for it in result.get('items', []):
        items.append({
            'name': str(it.get('name', '')).strip() or '알 수 없는 음식',
            'brand': clean_brand(it.get('brand')),
            'search_name': str(it.get('search_name', '') or '').strip(),
            'grams': max(0.0, float(it.get('grams') or 0)),
            **{k: max(0.0, float(it.get(k) or 0)) for k in ('kcal', 'carb', 'protein', 'fat', 'sugar', 'sodium')},
            'confidence': it.get('confidence', 'low'),
        })
    return {'items': items, 'note': str(result.get('note', '') or '')}


# ---------- HTTP 공통 ----------
class Base(BaseHTTPRequestHandler):
    server_version = 'myhealth'

    def extra_headers(self):
        pass

    def reply(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.extra_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self, limit=64 * 1024):
        size = int(self.headers.get('Content-Length') or 0)
        if not 0 < size <= limit:
            raise ValueError('size')
        return json.loads(self.rfile.read(size))


# ---------- API 서버 (터널로 외부에 공개되는 쪽) ----------
class Api(Base):
    def extra_headers(self):
        origin = self.headers.get('Origin', '')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def client_ip(self):
        # Cloudflare 터널을 거치면 실제 접속 IP는 이 헤더에 있음
        return self.headers.get('CF-Connecting-IP') or self.client_address[0]

    def user(self):
        auth = self.headers.get('Authorization', '')
        return user_by_token(auth[7:].strip()) if auth.startswith('Bearer ') else None

    def me(self, u):
        with db() as c:
            return {'id': u['id'], 'name': u['name'], 'must_change': bool(u['must_change']),
                    'remaining': remaining(c, u), 'limit': u['daily_limit'] or None}

    def do_OPTIONS(self):
        self.send_response(204)
        self.extra_headers()
        self.end_headers()

    def do_GET(self):
        if self.path != '/me':
            return self.reply(404, {'error': '없는 주소'})
        u = self.user()
        if not u:
            return self.reply(401, {'error': '다시 로그인해 주세요'})
        self.reply(200, self.me(u))

    def do_POST(self):
        routes = {'/login': self.login, '/logout': self.logout, '/password': self.password, '/analyze': self.analyze}
        if self.path not in routes:
            return self.reply(404, {'error': '없는 주소'})
        try:
            routes[self.path]()
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': '요청을 읽지 못했어요'})

    def login(self):
        b = self.body()
        uid, pw = str(b['id']).strip().lower(), str(b['password'])
        ip = self.client_ip()
        if too_many_fails('id:' + uid, 'ip:' + ip):
            return self.reply(429, {'error': '로그인 실패가 많아요. 15분 뒤에 다시 시도해 주세요.'})
        with db_lock, db() as c:
            u = c.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
            if not u or not check_pw(pw, u['pw_hash']):
                add_fail('id:' + uid, 'ip:' + ip)
                return self.reply(401, {'error': 'ID 또는 비밀번호가 맞지 않아요'})
            if not u['active']:
                return self.reply(403, {'error': '정지된 계정이에요. 관리자에게 문의해 주세요.'})
            c.execute('DELETE FROM sessions WHERE expires_at < ?', (now(),))
            token = new_session(c, uid)
        self.log_message('login %s', uid)
        self.reply(200, {'token': token, **self.me(u)})

    def logout(self):
        auth = self.headers.get('Authorization', '')
        with db_lock, db() as c:
            c.execute('DELETE FROM sessions WHERE token_hash = ?', (token_hash(auth[7:].strip()),))
        self.reply(200, {'ok': True})

    def password(self):
        u = self.user()
        if not u:
            return self.reply(401, {'error': '다시 로그인해 주세요'})
        b = self.body()
        old, new = str(b['old']), str(b['new'])
        if not check_pw(old, u['pw_hash']):
            add_fail('id:' + u['id'])
            return self.reply(400, {'error': '지금 비밀번호가 맞지 않아요'})
        if len(new) < 8:
            return self.reply(400, {'error': '새 비밀번호는 8자 이상으로 해 주세요'})
        with db_lock, db() as c:
            c.execute('UPDATE users SET pw_hash = ?, must_change = 0 WHERE id = ?', (hash_pw(new), u['id']))
            # 다른 기기의 로그인은 모두 끊고 이 기기만 새로 로그인
            c.execute('DELETE FROM sessions WHERE user_id = ?', (u['id'],))
            token = new_session(c, u['id'])
            u = c.execute('SELECT * FROM users WHERE id = ?', (u['id'],)).fetchone()
        self.reply(200, {'token': token, **self.me(u)})

    def analyze(self):
        u = self.user()
        if not u:
            return self.reply(401, {'error': '다시 로그인해 주세요'})
        if u['must_change']:
            return self.reply(403, {'error': '설정에서 비밀번호를 먼저 바꿔 주세요'})
        image = self.body(MAX_BODY)['image']
        base64.b64decode(image, validate=True)
        if not use_quota(u):
            return self.reply(429, {'error': f'오늘 사용량({u["daily_limit"]}회)을 다 썼어요. 내일 다시 써 주세요.'})
        started = time.time()
        try:
            result = analyze(image)
        except urllib.error.URLError:
            return self.reply(503, {'error': 'AI 서버(Ollama)가 꺼져 있어요'})
        except (ValueError, KeyError):
            return self.reply(502, {'error': 'AI 응답을 해석하지 못했어요. 다시 시도해 주세요.'})
        with db() as c:
            result['remaining'] = remaining(c, u)
        self.log_message('analyze %s %d items %.1fs', u['id'], len(result['items']), time.time() - started)
        self.reply(200, result)


# ---------- 관리자 서버 (이 PC에서만) ----------
ADMIN_HOSTS = {f'localhost:{ADMIN_PORT}', f'127.0.0.1:{ADMIN_PORT}'}


class Admin(Base):
    def allowed(self):
        # 다른 사이트가 몰래 관리자 기능을 부르지 못하게 Host·Origin 확인 (DNS 리바인딩·CSRF 방지)
        origin = self.headers.get('Origin')
        return (self.headers.get('Host') in ADMIN_HOSTS
                and (origin is None or origin.split('://', 1)[-1] in ADMIN_HOSTS))

    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {'error': 'forbidden'})
        if self.path in ('/', '/index.html'):
            data = ADMIN_HTML.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if self.path == '/api/users':
            return self.reply(200, list_users())
        self.reply(404, {'error': '없는 주소'})

    def do_POST(self):
        if not self.allowed() or self.headers.get('X-Admin') != '1':
            return self.reply(403, {'error': 'forbidden'})
        try:
            b = self.body()
            action = self.path.removeprefix('/api/')
            if action == 'create':
                uid = str(b['id']).strip().lower()
                if not uid.replace('_', '').replace('-', '').isalnum() or not 2 <= len(uid) <= 20 or not uid.isascii():
                    return self.reply(400, {'error': 'ID는 영문·숫자 2~20자로 해 주세요'})
                pw = temp_password()
                with db_lock, db() as c:
                    if c.execute('SELECT 1 FROM users WHERE id = ?', (uid,)).fetchone():
                        return self.reply(400, {'error': '이미 있는 ID예요'})
                    c.execute('INSERT INTO users (id, name, pw_hash, daily_limit, created_at) VALUES (?, ?, ?, ?, ?)',
                              (uid, str(b.get('name', '')).strip(), hash_pw(pw), int(b.get('limit', DEFAULT_LIMIT)), now()))
                return self.reply(200, {'id': uid, 'password': pw})
            uid = str(b['id'])
            with db_lock, db() as c:
                if action == 'reset':
                    pw = temp_password()
                    c.execute('UPDATE users SET pw_hash = ?, must_change = 1 WHERE id = ?', (hash_pw(pw), uid))
                    c.execute('DELETE FROM sessions WHERE user_id = ?', (uid,))
                    return self.reply(200, {'id': uid, 'password': pw})
                if action == 'active':
                    c.execute('UPDATE users SET active = ? WHERE id = ?', (1 if b['active'] else 0, uid))
                    if not b['active']:
                        c.execute('DELETE FROM sessions WHERE user_id = ?', (uid,))
                elif action == 'limit':
                    c.execute('UPDATE users SET daily_limit = ? WHERE id = ?', (max(0, int(b['limit'])), uid))
                elif action == 'delete':
                    c.execute('DELETE FROM users WHERE id = ?', (uid,))
                else:
                    return self.reply(404, {'error': '없는 기능'})
            self.reply(200, {'ok': True})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': '요청을 읽지 못했어요'})


def list_users():
    today = date.today().isoformat()
    with db() as c:
        return [dict(r) for r in c.execute('''
            SELECT u.id, u.name, u.daily_limit AS "limit", u.active, u.must_change, u.created_at,
                   COALESCE(SUM(CASE WHEN g.day = ? THEN g.count END), 0) AS today,
                   COALESCE(SUM(CASE WHEN substr(g.day, 1, 7) = ? THEN g.count END), 0) AS month,
                   MAX(g.last_at) AS last_at
            FROM users u LEFT JOIN usage g ON g.user_id = u.id
            GROUP BY u.id ORDER BY u.created_at''', (today, today[:7]))]


ADMIN_HTML = '''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MYHEALTH 관리자</title>
<style>
  :root { --bg:#f5f6f8; --card:#fff; --text:#1d2129; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; --bad:#ef4444; --ok:#10b981; }
  body { margin:0; font-family:-apple-system,"Malgun Gothic",sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:900px; margin:0 auto; padding:16px; }
  h1 { font-size:20px; } h2 { font-size:16px; margin:0 0 12px; }
  .card { background:var(--card); border-radius:14px; padding:16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,0,0,.05); }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:end; }
  label { display:flex; flex-direction:column; font-size:13px; color:var(--muted); gap:4px; }
  input { padding:9px; border:1px solid var(--line); border-radius:8px; font-size:15px; }
  button { padding:9px 12px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-size:14px; cursor:pointer; }
  button.ghost { background:none; color:var(--accent); border:1px solid var(--line); }
  button.danger { background:none; color:var(--bad); border:1px solid var(--line); }
  .wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  td, th { padding:8px 6px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  .muted { color:var(--muted); font-size:13px; }
  .tag { font-size:12px; padding:2px 8px; border-radius:99px; background:#dcfce7; color:#15803d; }
  .tag.off { background:#fee2e2; color:var(--bad); } .tag.tmp { background:#fef3c7; color:#b45309; }
  .pw { background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:12px; margin-top:12px; }
  .pw code { font-size:18px; font-weight:700; }
</style></head><body><main>
<h1>MYHEALTH 관리자</h1>
<p class="muted">이 페이지는 이 PC에서만 열려요. 회원에게는 ID와 임시 비밀번호를 알려주면, 첫 로그인 때 본인이 비밀번호를 바꿔요.</p>

<div class="card">
  <h2>회원 만들기</h2>
  <div class="row">
    <label>ID (영문·숫자)<input id="nid" placeholder="friend1" autocomplete="off"></label>
    <label>이름<input id="nname" placeholder="홍길동"></label>
    <label>하루 한도 (0 = 무제한)<input id="nlimit" type="number" min="0" value="__LIMIT__" style="width:120px"></label>
    <button id="create">만들기</button>
  </div>
  <div id="out"></div>
</div>

<div class="card">
  <h2>회원 목록</h2>
  <div class="wrap"><table>
    <thead><tr><th>ID</th><th>이름</th><th>상태</th><th>오늘</th><th>이번 달</th><th>하루 한도</th><th>최근 사용</th><th></th></tr></thead>
    <tbody id="list"></tbody>
  </table></div>
</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let users = [];

async function api(path, body) {
  const res = await fetch('/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin': '1' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

function showPw(d, what) {
  $('out').innerHTML = `<div class="pw">${what} · ID <code>${esc(d.id)}</code> · 임시 비밀번호 <code>${esc(d.password)}</code>
    <div class="muted">이 비밀번호는 지금만 보여요. 회원에게 전달하세요. 첫 로그인 후 본인이 바꿔요.</div></div>`;
}

async function load() {
  users = await api('users');
  $('list').innerHTML = users.map((u) => `<tr>
    <td><b>${esc(u.id)}</b></td><td>${esc(u.name)}</td>
    <td>${!u.active ? '<span class="tag off">정지</span>' : u.must_change ? '<span class="tag tmp">임시 비번</span>' : '<span class="tag">사용 중</span>'}</td>
    <td>${u.today}</td><td>${u.month}</td>
    <td>${u.limit || '무제한'}</td>
    <td class="muted">${u.last_at ? esc(u.last_at.replace('T', ' ').slice(0, 16)) : '–'}</td>
    <td>
      <button class="ghost" data-act="limit" data-id="${esc(u.id)}">한도</button>
      <button class="ghost" data-act="reset" data-id="${esc(u.id)}">비번 초기화</button>
      <button class="ghost" data-act="active" data-id="${esc(u.id)}">${u.active ? '정지' : '해제'}</button>
      <button class="danger" data-act="delete" data-id="${esc(u.id)}">삭제</button>
    </td></tr>`).join('') || '<tr><td colspan="8" class="muted">아직 회원이 없어요.</td></tr>';
}

$('create').onclick = async () => {
  try {
    const d = await api('create', { id: $('nid').value, name: $('nname').value, limit: Number($('nlimit').value) });
    showPw(d, '회원을 만들었어요');
    $('nid').value = $('nname').value = '';
    load();
  } catch (e) { alert(e.message); }
};

$('list').onclick = async (e) => {
  const { act, id } = e.target.dataset;
  if (!act) return;
  const u = users.find((x) => x.id === id);
  try {
    if (act === 'limit') {
      const v = prompt(`${id}의 하루 한도 (0 = 무제한)`, u.limit);
      if (v === null) return;
      await api('limit', { id, limit: Number(v) });
    } else if (act === 'reset') {
      if (!confirm(`${id}의 비밀번호를 초기화할까요? 로그인된 기기도 모두 로그아웃돼요.`)) return;
      showPw(await api('reset', { id }), '비밀번호를 초기화했어요');
    } else if (act === 'active') {
      if (u.active && !confirm(`${id}를 정지할까요? 바로 로그아웃되고 사진 인식을 못 써요.`)) return;
      await api('active', { id, active: !u.active });
    } else if (act === 'delete') {
      if (!confirm(`${id}를 삭제할까요? 사용 기록도 같이 지워져요.`)) return;
      await api('delete', { id });
    }
    load();
  } catch (err) { alert(err.message); }
};

load();
</script></body></html>'''.replace('__LIMIT__', str(DEFAULT_LIMIT))


def main():
    init_db()
    api = ThreadingHTTPServer(('127.0.0.1', API_PORT), Api)
    admin = ThreadingHTTPServer(('127.0.0.1', ADMIN_PORT), Admin)
    threading.Thread(target=admin.serve_forever, daemon=True).start()
    print(f'MYHEALTH 중계 서버  API http://127.0.0.1:{API_PORT}  모델 {MODEL}')
    print(f'관리자 페이지        http://localhost:{ADMIN_PORT}  (이 PC 브라우저에서만)')
    api.serve_forever()


if __name__ == '__main__':
    main()
