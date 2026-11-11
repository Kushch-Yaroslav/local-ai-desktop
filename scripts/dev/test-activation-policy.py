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

    def test_packaged_e2e_launcher_accepts_both_forge_executable_names(self):
        source = Path(__file__).with_name('check-live-browser.sh')
        for executable_name in ('Local AI Desktop', 'local-ai-desktop'):
            with self.subTest(executable_name=executable_name), tempfile.TemporaryDirectory(prefix='lad-e2e-launcher-test-') as temp:
                root = Path(temp)
                scripts = root/'repo/scripts/dev'
                scripts.mkdir(parents=True)
                launcher = scripts/source.name
                shutil.copy2(source, launcher)
                (root/'repo/ui/desktop').mkdir(parents=True)
                package = root/'.local-work/build'
                executable = package/executable_name
                node = package/'resources/live-browser/bin/node'
                executable.parent.mkdir(parents=True, exist_ok=True)
                node.parent.mkdir(parents=True, exist_ok=True)
                executable.write_text('#!/bin/sh\nexit 0\n')
                executable.chmod(0o755)
                node.write_text('#!/bin/sh\nprintf "%s\\n" "$LAD_E2E_PACKAGED_EXECUTABLE" > "$LAD_TEST_RESULT"\n')
                node.chmod(0o755)
                result_file = root/'result'
                result = subprocess.run(
                    [str(launcher), str(package), '--desktop-entry'],
                    capture_output=True, text=True,
                    env={**os.environ, 'DISPLAY': ':0', 'LAD_TEST_RESULT': str(result_file)},
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result_file.read_text().strip(), str(executable))

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
