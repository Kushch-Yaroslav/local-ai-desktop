#!/usr/bin/python3
"""Regression: activation must not select a path Ubuntu will sandbox-deny."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

class ActivationPolicyTest(unittest.TestCase):
    def test_check_accepts_persistent_user_package_store(self):
        with tempfile.TemporaryDirectory(prefix='lad-user-package-test-') as temp:
            root = Path(temp)
            scripts = root/'repo/scripts/dev'
            scripts.mkdir(parents=True)
            source = Path(__file__).with_name('activate-packaged-build.sh')
            shutil.copy2(source, scripts/source.name)
            data_home = root/'user-data'
            package = root/'.local/opt/local-ai-desktop-goose-dev/packages/ux-rc/Local AI Desktop-linux-x64'
            for name in ['Local AI Desktop','resources/bin/goose','resources/live-browser/bin/node','resources/live-browser/dist/live-browser.js','resources/live-browser/package.json','resources/app.asar']:
                path = package/name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('#!/bin/sh\nexit 0\n')
                path.chmod(0o755)
            result = subprocess.run(
                [str(scripts/source.name),'--check',str(package)],
                capture_output=True, text=True,
                env={**os.environ, 'HOME': str(root), 'XDG_DATA_HOME': str(data_home)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('No installation/profile changes', result.stdout)

    def test_check_accepts_forge_lowercase_executable(self):
        with tempfile.TemporaryDirectory(prefix='lad-lowercase-package-test-') as temp:
            root = Path(temp)
            scripts = root/'repo/scripts/dev'
            scripts.mkdir(parents=True)
            source = Path(__file__).with_name('activate-packaged-build.sh')
            shutil.copy2(source, scripts/source.name)
            data_home = root/'data-home'
            package = root/'.local/opt/local-ai-desktop-goose-dev/packages/ux-rc'
            for name in ['local-ai-desktop','resources/bin/goose','resources/live-browser/bin/node','resources/live-browser/dist/live-browser.js','resources/live-browser/package.json','resources/app.asar']:
                path = package/name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('#!/bin/sh\nexit 0\n')
                path.chmod(0o755)
            result = subprocess.run(
                [str(scripts/source.name),'--check',str(package)],
                capture_output=True, text=True,
                env={**os.environ, 'HOME': str(root), 'XDG_DATA_HOME': str(data_home)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(str(package/'local-ai-desktop'), result.stdout)

    @unittest.skipUnless(Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').exists() and Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').read_text().strip() == '1', 'Ubuntu userns restriction required')
    def test_uncovered_path_does_not_replace_existing_selection(self):
        with tempfile.TemporaryDirectory(prefix='lad-policy-test-') as temp:
            root = Path(temp)
            scripts = root/'scripts/dev'
            scripts.mkdir(parents=True)
            source = Path(__file__).with_name('activate-packaged-build.sh')
            shutil.copy2(source, scripts/source.name)
            package = root/'.local-work/new/Local AI Desktop-linux-x64'
            for name in ['Local AI Desktop','resources/bin/goose','resources/live-browser/bin/node','resources/live-browser/dist/live-browser.js','resources/live-browser/package.json','resources/app.asar']:
                path = package/name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('#!/bin/sh\nexit 0\n')
                path.chmod(0o755)
            pointer = root/'.local-work/desktop-selected.path'
            pointer.write_text('existing-selection\n')
            result = subprocess.run([str(scripts/source.name),'--activate',str(package)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('AppArmor', result.stderr)
            self.assertEqual(pointer.read_text(), 'existing-selection\n')

if __name__ == '__main__':
    unittest.main()
