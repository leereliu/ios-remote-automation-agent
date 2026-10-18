#!/usr/bin/env python3
"""Make a separately signed preinstalled Runner without changing the Xcode product."""
import argparse
import plistlib
import shutil
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--identity', required=True, help='local codesign identity, never a private key')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('output already exists; original files will not be overwritten')
    if not (args.source / 'embedded.mobileprovision').exists():
        parser.error('source must be a development-signed device build')
    shutil.copytree(args.source, args.output)
    frameworks = args.output / 'Frameworks'
    for path in list(frameworks.iterdir()) if frameworks.exists() else []:
        if path.name.startswith('XC') or path.name in ['Testing.framework', 'libXCTestSwiftSupport.dylib']:
            shutil.rmtree(path) if path.is_dir() else path.unlink()
    info_path = args.output / 'Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info.setdefault('NSAppTransportSecurity', {})['NSAllowsLocalNetworking'] = True
    info_path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
    subprocess.run(['codesign', '--force', '--sign', args.identity,
                    '--preserve-metadata=identifier,entitlements,requirements', str(args.output)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(args.output)], check=True)
    print('Prepared Runner signature verified; installation was not performed.')


if __name__ == '__main__':
    main()
