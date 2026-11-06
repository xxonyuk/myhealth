"""MYHEALTH 사진 인식 중계 서버 (Python 표준 라이브러리만 사용)

폰 앱 → (Cloudflare Tunnel) → 이 서버 → 로컬 Ollama 비전 모델
- 초대코드가 있어야 사용 가능 (codes.txt, 공개 저장소에 올리지 않음)
- 코드당 하루 사용량 제한
- 사진은 메모리에서 인식만 하고 저장하지 않음

사용법:
  python gateway.py                 서버 실행 (127.0.0.1:8787)
  python gateway.py add 이름        초대코드 만들기
  python gateway.py list            초대코드 목록
  python gateway.py remove 코드     초대코드 삭제
"""
import base64
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CODES_FILE = os.path.join(HERE, 'codes.txt')
USAGE_FILE = os.path.join(HERE, 'usage.json')

HOST = os.environ.get('MYHEALTH_HOST', '127.0.0.1')
PORT = int(os.environ.get('MYHEALTH_PORT', '8787'))
OLLAMA = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434')
MODEL = os.environ.get('MYHEALTH_MODEL', 'gemma4:12b')
DAILY_LIMIT = int(os.environ.get('MYHEALTH_DAILY_LIMIT', '20'))
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

lock = threading.Lock()


# ---------- 초대코드 · 사용량 ----------
def load_codes():
    codes = {}
    if os.path.exists(CODES_FILE):
        with open(CODES_FILE, encoding='utf-8') as f:
            for line in f:
                parts = line.strip().split(None, 1)
                if parts and not parts[0].startswith('#'):
                    codes[parts[0]] = parts[1] if len(parts) > 1 else ''
    return codes


def save_codes(codes):
    with open(CODES_FILE, 'w', encoding='utf-8') as f:
        f.write('# 초대코드 이름\n')
        for c, name in codes.items():
            f.write(f'{c} {name}\n')


def load_usage():
    try:
        with open(USAGE_FILE, encoding='utf-8') as f:
            u = json.load(f)
        return u if u.get('date') == date.today().isoformat() else {'date': date.today().isoformat(), 'count': {}}
    except (OSError, ValueError):
        return {'date': date.today().isoformat(), 'count': {}}


def use_quota(code):
    """오늘 사용량을 1 올리고 남은 횟수를 돌려줌. 한도를 넘으면 -1."""
    with lock:
        u = load_usage()
        n = u['count'].get(code, 0)
        if n >= DAILY_LIMIT:
            return -1
        u['count'][code] = n + 1
        with open(USAGE_FILE, 'w', encoding='utf-8') as f:
            json.dump(u, f)
        return DAILY_LIMIT - n - 1


def remaining(code):
    return DAILY_LIMIT - load_usage()['count'].get(code, 0)


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
        'think': False,
        'keep_alive': '30m',  # 30분 안에 다음 사진이 오면 모델을 다시 올리지 않아도 됨 (첫 요청은 ~40초)  # 생각 모드가 있는 모델은 끄고 바로 답하게 (속도·출력 길이)
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


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = 'myhealth'

    def cors(self):
        origin = self.headers.get('Origin', '')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Invite-Code')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def reply(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def code(self):
        c = self.headers.get('X-Invite-Code', '').strip()
        return c if c and c in load_codes() else None

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path != '/health':
            return self.reply(404, {'error': '없는 주소'})
        c = self.code()
        if not c:
            return self.reply(401, {'error': '초대코드가 맞지 않아요'})
        self.reply(200, {'ok': True, 'name': load_codes()[c], 'remaining': remaining(c), 'limit': DAILY_LIMIT})

    def do_POST(self):
        if self.path != '/analyze':
            return self.reply(404, {'error': '없는 주소'})
        c = self.code()
        if not c:
            return self.reply(401, {'error': '초대코드가 맞지 않아요'})
        size = int(self.headers.get('Content-Length') or 0)
        if not 0 < size <= MAX_BODY:
            return self.reply(413, {'error': '사진이 너무 커요'})
        try:
            image = json.loads(self.rfile.read(size))['image']
            base64.b64decode(image, validate=True)
        except (ValueError, KeyError, TypeError):
            return self.reply(400, {'error': '사진을 읽지 못했어요'})
        left = use_quota(c)
        if left < 0:
            return self.reply(429, {'error': f'오늘 사용량({DAILY_LIMIT}회)을 다 썼어요. 내일 다시 써 주세요.'})
        started = time.time()
        try:
            result = analyze(image)
        except urllib.error.URLError:
            return self.reply(503, {'error': 'AI 서버(Ollama)가 꺼져 있어요'})
        except (ValueError, KeyError):
            return self.reply(502, {'error': 'AI 응답을 해석하지 못했어요. 다시 시도해 주세요.'})
        result['remaining'] = left
        self.log_message('analyze %s %d items %.1fs', load_codes()[c] or c[:4], len(result['items']), time.time() - started)
        self.reply(200, result)


def main():
    args = sys.argv[1:]
    if args[:1] == ['add']:
        codes = load_codes()
        c = secrets.token_urlsafe(6)
        codes[c] = ' '.join(args[1:])
        save_codes(codes)
        print(f'초대코드: {c}  ({codes[c]})')
    elif args[:1] == ['list']:
        for c, name in load_codes().items():
            print(f'{c}  {name}  (오늘 남은 횟수 {remaining(c)})')
    elif args[:1] == ['remove'] and len(args) == 2:
        codes = load_codes()
        print('삭제됨' if codes.pop(args[1], None) is not None else '없는 코드')
        save_codes(codes)
    elif not args:
        print(f'MYHEALTH 중계 서버: http://{HOST}:{PORT}  모델 {MODEL}  하루 {DAILY_LIMIT}회')
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
