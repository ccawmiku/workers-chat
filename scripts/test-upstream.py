"""Opt-in real upstream checks. Reads a dedicated credential without logging it."""
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

config_path = Path.home() / '.config/workers-chat/upstream-test.json'
config = json.loads(config_path.read_text()) if config_path.is_file() else {}
base_url = os.environ.get('UPSTREAM_BASE_URL', config.get('baseUrl', '')).rstrip('/')
api_key = os.environ.get('UPSTREAM_API_KEY', config.get('apiKey', ''))
if not base_url.startswith('https://') or not api_key:
    sys.exit('Provide dedicated HTTPS upstream configuration via environment or the private test file.')
opener = urllib.request.build_opener(NoRedirect())

def emit(value):
    print(json.dumps(value, ensure_ascii=False).replace(api_key, '[redacted]'))

def call(path, payload=None):
    headers = {'Authorization': 'Bearer ' + api_key}
    data = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(payload).encode()
    request = urllib.request.Request(base_url + path, data=data, headers=headers)
    try:
        with opener.open(request, timeout=180) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        message = error.read(2048).decode(errors='replace').replace(api_key, '[redacted]')
        return error.code, {'error': message}

status, result = call('/models')
if status != 200:
    emit({'phase': 'models', 'status': status, 'error': result['error']})
    sys.exit(1)
models = [m['id'] for m in result.get('data', []) if isinstance(m.get('id'), str)]
preferred = os.environ.get('TEST_OPENAI_MODEL', 'Gemini3.8flash-low')
model = next((m for m in models if m.casefold() == preferred.casefold()), None)
if not model:
    emit({'phase': 'models', 'preferredNotFound': preferred, 'available': models})
    sys.exit(1)
for effort in ['low', 'max', None]:
    payload = {'model': model, 'messages': [{'role': 'user', 'content': 'Return only OK.'}], 'stream': False}
    if effort is not None:
        payload['reasoning_effort'] = effort
    status, result = call('/chat/completions', payload)
    emit({'phase': 'completions', 'model': model, 'effort': effort or 'omitted', 'status': status,
                      'usage': result.get('usage'), 'hasReply': bool(result.get('choices')),
                      **({'error': result['error']} if 'error' in result else {})})
