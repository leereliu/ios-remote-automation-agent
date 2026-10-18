#!/usr/bin/env python3
"""Render runtime configuration; private files stay outside version control."""
import argparse
import json
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--queue-config', type=Path, required=True,
                        help='private JSON with url and agent_token')
    args = parser.parse_args()
    config = json.loads(args.queue_config.read_text())
    url = urlsplit(config['url'])
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or
            url.query or url.fragment or url.port not in (None, 443)):
        parser.error('queue must use HTTPS on port 443')
    token = config.get('agent_token', '')
    if not isinstance(token, str) or len(token) < 32:
        parser.error('agent_token must contain at least 32 characters')
    node = shutil.which('node')
    if not node:
        parser.error('Node.js is required')
    agent = ROOT / 'devbox'
    values = {'@NODE_BIN@': node, '@AGENT_DIR@': str(agent)}
    for value in values.values():
        if any(c.isspace() for c in value) or any(c in value for c in ['"', '\\', '%']):
            parser.error('repository and Node paths contain unsupported characters')
    toml = (ROOT / 'config/codex-config.toml.in').read_text()
    unit = (ROOT / 'deploy/ipad-https-agent.service.in').read_text()
    for key, value in values.items():
        toml = toml.replace(key, value)
        unit = unit.replace(key, value)
    private_write(agent / 'agent-private.json', json.dumps({
        'url': config['url'], 'token': token,
    }, indent=2) + '\n')
    private_write(agent / 'codex-home/config.toml', toml)
    private_write(ROOT / '.local/ipad-https-agent.service', unit)
    print('Agent config and systemd unit rendered; service has not been started.')


if __name__ == '__main__':
    main()
