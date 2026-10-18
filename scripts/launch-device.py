#!/usr/bin/env python3
"""Launch a provisioned Runner with private values in its environment, not arguments."""
import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', required=True)
    parser.add_argument('--bundle-id', required=True, help='installed runner ID including .xctrunner')
    parser.add_argument('--queue-config', type=Path, required=True)
    args = parser.parse_args()
    private = json.loads(args.queue_config.read_text())
    url = urlsplit(private['url'])
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or
            url.query or url.fragment or url.port not in (None, 443)):
        parser.error('queue must use HTTPS on port 443')
    if len(private.get('device_token', '')) < 32:
        parser.error('device_token must contain at least 32 characters')
    values = {'USE_PORT': '8100', 'USE_IP': '127.0.0.1', 'MJPEG_SERVER_PORT': '9100',
              'WDA_PRODUCT_BUNDLE_IDENTIFIER': args.bundle_id, 'IPAD_QUEUE_URL': private['url'],
              'IPAD_DEVICE_TOKEN': private['device_token'], 'IPAD_DEVICE_ID': private['device_id']}
    env = dict(os.environ)
    env.update({'DEVICECTL_CHILD_' + key: value for key, value in values.items()})
    with tempfile.TemporaryDirectory(prefix='ipad-https-launch-') as directory:
        report = Path(directory) / 'report.json'
        result = subprocess.run(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device',
                                 args.device, '--terminate-existing', '--timeout', '60',
                                 '--json-output', str(report), args.bundle_id],
                                env=env, capture_output=True, text=True, timeout=75)
        if result.returncode:
            # devicectl reports can contain launch environments. Never print the raw report.
            print('Runner launch failed. Check pairing, device unlock, developer mode and signature trust.')
        else:
            data = json.loads(report.read_text())
            print(json.dumps({'outcome': data.get('info', {}).get('outcome'),
                              'process_id': data.get('result', {}).get('process', {}).get('processIdentifier')}))
        raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
