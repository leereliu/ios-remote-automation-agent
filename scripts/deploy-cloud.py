"""Deploy only this authenticated queue. Credentials never appear in arguments/logs."""
import argparse
import json
import os
import secrets
import urllib.request
import urllib.error
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / '.local'
ACCOUNT = ''
STATE = SETUP / 'cloud-deployment.json'
PRIVATE = SETUP / 'queue-private.json'

def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(json.dumps(data, indent=2) + '\n')

def main():
    global ACCOUNT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-id', default=os.environ.get('CLOUDFLARE_ACCOUNT_ID', ''))
    parser.add_argument('--script-name', default='ipad-https-agent')
    parser.add_argument('--device-id', default='home-ipad')
    parser.add_argument('--subdomain', help='only needed if this account has no workers.dev subdomain')
    args = parser.parse_args()
    ACCOUNT = args.account_id
    if len(ACCOUNT) != 32 or any(c not in '0123456789abcdef' for c in ACCOUNT):
        parser.error('set CLOUDFLARE_ACCOUNT_ID to the target account ID')
    token = os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
    if not token:
        parser.error('CLOUDFLARE_API_TOKEN is required')
    if not args.script_name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in args.script_name):
        parser.error('script name must contain lowercase letters, digits or hyphens')
    SETUP.mkdir(parents=True, exist_ok=True, mode=0o700)
    private = json.loads(PRIVATE.read_text()) if PRIVATE.exists() else {
        'controller_token': secrets.token_urlsafe(32),
        'agent_token': secrets.token_urlsafe(32),
        'device_token': secrets.token_urlsafe(32),
        'device_id': args.device_id,
    }
    private_write(PRIVATE, private)
    state = json.loads(STATE.read_text()) if STATE.exists() else {
        'account': ACCOUNT, 'script': args.script_name, 'database_name': args.script_name,
    }
    if state['account'] != ACCOUNT or state['script'] != args.script_name or private['device_id'] != args.device_id:
        raise RuntimeError('Existing local deployment targets another account, script or device')
    def api(path, method='GET', body=None, content_type='application/json'):
        data = None if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        req = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, data=data, method=method,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                details = json.load(exc)
                message = json.dumps(details.get('errors', []))[:1200]
            except Exception:
                message = 'Cloudflare rejected the request'
            for value in [token] + list(private.values()):
                if isinstance(value, str): message = message.replace(value, '[redacted]')
            raise RuntimeError(f'Cloudflare HTTP {exc.code}: {message}') from None
        if not result.get('success'):
            raise RuntimeError('Cloudflare API reported failure')
        return result.get('result')

    databases = api(f'/accounts/{ACCOUNT}/d1/database?name={state["database_name"]}')
    matching = [d for d in databases if d.get('name') == state['database_name']]
    if len(matching) > 1: raise RuntimeError('Ambiguous database identity')
    database = matching[0] if matching else api(f'/accounts/{ACCOUNT}/d1/database', 'POST',
        {'name': state['database_name'], 'location_hint': 'apac'})
    state['database_id'] = database['uuid']
    private_write(STATE, state)
    schema = (ROOT / 'cloud/schema.sql').read_text()
    api(f'/accounts/{ACCOUNT}/d1/database/{state["database_id"]}/query', 'POST', {'sql': schema, 'params': []})
    current = api(f'/accounts/{ACCOUNT}/workers/subdomain')
    subdomain = current.get('subdomain')
    if not subdomain:
        subdomain = args.subdomain
        if not subdomain:
            raise RuntimeError('Account has no workers.dev subdomain; choose one with --subdomain')
        api(f'/accounts/{ACCOUNT}/workers/subdomain', 'PUT', {'subdomain': subdomain})
    state['subdomain'] = subdomain
    bindings = [{'name': 'DB', 'type': 'd1', 'id': state['database_id']},
        {'name': 'DEVICE_ID', 'type': 'plain_text', 'text': private['device_id']}]
    for name, key in [('CONTROLLER_TOKEN', 'controller_token'), ('AGENT_TOKEN', 'agent_token'), ('DEVICE_TOKEN', 'device_token')]:
        bindings.append({'name': name, 'type': 'secret_text', 'text': private[key]})
    metadata = {'main_module': 'worker.mjs', 'compatibility_date': '2026-10-18', 'bindings': bindings,
        'observability': {'enabled': False}}
    boundary = '----ipadqueue' + uuid.uuid4().hex
    pieces = []
    for field, data, content_type in [
        ('metadata', json.dumps(metadata).encode(), 'application/json'),
        ('worker.mjs', (ROOT/'cloud/worker.mjs').read_bytes(), 'application/javascript+module'),
        ('console-ui.mjs', (ROOT/'cloud/console-ui.mjs').read_bytes(), 'application/javascript+module')]:
        header = f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"'
        if field != 'metadata': header += f'; filename="{field}"'
        pieces.extend([(header + f'\r\nContent-Type: {content_type}\r\n\r\n').encode(), data, b'\r\n'])
    pieces.append(f'--{boundary}--\r\n'.encode())
    api(f'/accounts/{ACCOUNT}/workers/scripts/{state["script"]}', 'PUT', b''.join(pieces), f'multipart/form-data; boundary={boundary}')
    api(f'/accounts/{ACCOUNT}/workers/scripts/{state["script"]}/subdomain', 'POST', {'enabled': True, 'previews_enabled': False})
    state['url'] = f'https://{state["script"]}.{subdomain}.workers.dev'
    state['status'] = 'deployed_authentication_required'
    private_write(STATE, state)
    private['url'] = state['url']
    private_write(PRIVATE, private)
    print(json.dumps({'url': state['url'], 'database_id': state['database_id'], 'status': state['status']}))

if __name__ == '__main__':
    main()
