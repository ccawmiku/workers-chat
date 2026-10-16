"""Opt-in checks with private, persistent claims to prevent duplicate model calls."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def call(opener, base_url, api_key, path, payload=None):
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
        message = error.read(2048).decode(errors='replace')
        return error.code, {'error': message}

def run_checks(base_url, api_key, preferred, opener, ledger_dir):
    def emit(value):
        print(json.dumps(value, ensure_ascii=False).replace(api_key, '[redacted]'))

    status, result = call(opener, base_url, api_key, '/models')
    if status != 200:
        emit({'phase': 'models', 'status': status, 'error': result.get('error')})
        return 1
    models = [m['id'] for m in result.get('data', [])
              if isinstance(m, dict) and isinstance(m.get('id'), str)]
    model = next((m for m in models if m.casefold() == preferred.casefold()), None)
    if not model:
        emit({'phase': 'models', 'preferredNotFound': preferred, 'available': models})
        return 1
    ledger_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    failed = False
    for effort in ['low', 'max', None]:
        payload = {'model': model, 'messages': [{'role': 'user', 'content': 'Return only OK.'}], 'stream': False}
        if effort is not None:
            payload['reasoning_effort'] = effort
        identity = json.dumps({'baseUrl': base_url, 'payload': payload,
                               'keyHash': hashlib.sha256(api_key.encode()).hexdigest()}, sort_keys=True)
        path = ledger_dir / (hashlib.sha256(identity.encode()).hexdigest() + '.json')
        record = {'phase': 'completions', 'model': model, 'effort': effort or 'omitted',
                  'attemptedAt': int(time.time()), 'status': 'attempted'}
        try:
            # Claim before the non-idempotent POST. Uncertain outcomes stay claimed.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            try:
                prior = json.loads(path.read_text())
            except (ValueError, OSError):
                prior = {}
            if prior.get('status') != 200 or not prior.get('hasReply'):
                failed = True
            emit({'phase': 'completions', 'model': model, 'effort': effort or 'omitted',
                  'skipped': True, 'previousStatus': prior.get('status', 'unknown'),
                  'reason': 'Already attempted; see private upstream-checks ledger.'})
            continue
        with os.fdopen(fd, 'w') as file:
            json.dump(record, file)
            file.flush()
            os.fsync(file.fileno())
        try:
            status, result = call(opener, base_url, api_key, '/chat/completions', payload)
            usage = result.get('usage', {})
            safe_usage = {k: v for k, v in usage.items()
                          if k in ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']
                          and isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0} if isinstance(usage, dict) else {}
            record.update(status=status, usage=safe_usage, hasReply=bool(result.get('choices')))
            if status != 200 or not record['hasReply']:
                failed = True
            if 'error' in result:
                record['error'] = str(result['error']).replace(api_key, '[redacted]')[:2000]
        except Exception as error:
            failed = True
            record.update(status='transport-error', error=str(error).replace(api_key, '[redacted]')[:2000])
        path.write_text(json.dumps(record, ensure_ascii=False))
        emit(record)
    return int(failed)


def main():
    private_dir = Path.home() / '.config/workers-chat'
    config_path = private_dir / 'upstream-test.json'
    config = json.loads(config_path.read_text()) if config_path.is_file() else {}
    base_url = os.environ.get('UPSTREAM_BASE_URL', config.get('baseUrl', '')).rstrip('/')
    api_key = os.environ.get('UPSTREAM_API_KEY', config.get('apiKey', ''))
    url = urllib.parse.urlsplit(base_url)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or not api_key:
        sys.exit('Provide dedicated HTTPS upstream configuration via environment or the private test file.')
    try:
        return run_checks(base_url, api_key, os.environ.get('TEST_OPENAI_MODEL', 'Gemini3.8flash-low'),
                          urllib.request.build_opener(NoRedirect()), private_dir / 'upstream-checks')
    except Exception as error:
        print(json.dumps({'phase': 'models', 'error': str(error).replace(api_key, '[redacted]')[:2000]}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
