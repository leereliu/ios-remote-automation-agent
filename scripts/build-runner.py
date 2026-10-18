#!/usr/bin/env python3
"""Build a copy of the pinned WDA, leaving the submodule and live iPad untouched."""
import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle-id', default='com.example.ipad.httpsagent')
    parser.add_argument('--team', help='Apple development team; needed for signed builds')
    parser.add_argument('--device', help='paired iPad identifier for a signed build')
    parser.add_argument('--no-sign', action='store_true', help='compile only; cannot install')
    parser.add_argument('--prepare-only', action='store_true', help='prepare source without compiling')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{2,199}', args.bundle_id):
        parser.error('invalid bundle identifier')
    if not args.no_sign and not args.prepare_only and not (args.team and args.device):
        parser.error('signed builds require --team and --device')
    source = ROOT / 'vendor/WebDriverAgent'
    lock = json.loads((ROOT / 'upstream.lock.json').read_text())
    sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if sha != lock['webdriveragent']['commit']:
        parser.error('WDA does not match upstream.lock.json; update the submodule first')
    build = ROOT / 'build'
    build.mkdir(exist_ok=True)
    target = build / 'WebDriverAgent'
    if target.exists():
        parser.error('build/WebDriverAgent already exists; move it aside before preparing a new build')
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('.git', 'node_modules', 'build'))
    subprocess.run(['git', '-C', str(target), 'init', '-q'], check=True)
    subprocess.run(['git', '-C', str(target), 'apply', str(ROOT / 'patches/wda-https-runner.patch')], check=True)
    shutil.copy2(ROOT / 'device/FBHTTPSQueueClient.m', target / 'WebDriverAgentRunner')
    project = target / 'WebDriverAgent.xcodeproj/project.pbxproj'
    project.write_text(project.read_text().replace('com.facebook.WebDriverAgentRunner', args.bundle_id))
    print('Prepared pinned WDA source with the native HTTPS client.', flush=True)
    if args.prepare_only:
        return
    command = ['xcrun', 'xcodebuild', 'build-for-testing', '-project',
               str(target / 'WebDriverAgent.xcodeproj'), '-scheme', 'WebDriverAgentRunner',
               '-destination', 'generic/platform=iOS' if args.no_sign else 'id=' + args.device,
               '-derivedDataPath', str(build / 'DerivedData')]
    if args.no_sign:
        command += ['CODE_SIGNING_ALLOWED=NO']
    else:
        command += ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration',
                    'DEVELOPMENT_TEAM=' + args.team, 'CODE_SIGN_STYLE=Automatic']
    # Host header search paths can leak macOS headers into an iOS cross-build.
    env = dict(os.environ)
    for key in ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH']:
        env.pop(key, None)
    subprocess.run(command, check=True, env=env)


if __name__ == '__main__':
    main()
