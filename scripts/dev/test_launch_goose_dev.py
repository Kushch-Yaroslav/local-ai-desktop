#!/usr/bin/env python3
"""Regression: launch through a dangling relocated log-directory symlink."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class DesktopLauncherTest(unittest.TestCase):
    def test_creates_missing_log_destination_without_replacing_symlink(self):
        launcher = Path(__file__).with_name('launch-goose-dev.sh').resolve()
        with tempfile.TemporaryDirectory(prefix='lad-launcher-test-') as temporary:
            root = Path(temporary)
            scripts = root / 'repo/scripts/dev'
            scripts.mkdir(parents=True)
            shutil.copy2(launcher, scripts / launcher.name)
            (scripts / 'launch-diagnostics.py').write_text(
                'import os, pathlib, sys\n'
                'pathlib.Path(os.environ["LAD_TEST_RESULT"]).write_text(sys.argv[1])\n'
            )
            app = root / 'repo/ui/desktop/out/Local AI Desktop-linux-x64'
            (app / 'resources/bin').mkdir(parents=True)
            for file in [app / 'Local AI Desktop', app / 'resources/bin/goose']:
                file.write_text('#!/bin/sh\nexit 0\n')
                file.chmod(0o755)
            state = root / 'state'
            state.mkdir()
            link = state / 'local-ai-desktop-goose-dev'
            destination = root / 'relocated/logs/launcher'
            link.symlink_to(destination, target_is_directory=True)
            result = root / 'result'
            subprocess.run(['bash', str(scripts / launcher.name)], check=True, env={
                **os.environ, 'LOCAL_AI_DESKTOP_DEV_DETACHED': '1',
                'XDG_STATE_HOME': str(state), 'XDG_DATA_HOME': str(root / 'data'),
                'LAD_TEST_RESULT': str(result),
            })
            self.assertTrue(link.is_symlink())
            self.assertTrue((destination / 'launcher.log').is_file())
            self.assertEqual(result.read_text(), str(app / 'Local AI Desktop'))

    def test_launches_selected_persistent_user_package(self):
        launcher = Path(__file__).with_name('launch-goose-dev.sh').resolve()
        with tempfile.TemporaryDirectory(prefix='lad-selected-package-test-') as temporary:
            root = Path(temporary)
            scripts = root / 'repo/scripts/dev'
            scripts.mkdir(parents=True)
            shutil.copy2(launcher, scripts / launcher.name)
            (scripts / 'launch-diagnostics.py').write_text(
                'import os, pathlib, sys\n'
                'pathlib.Path(os.environ["LAD_TEST_RESULT"]).write_text(sys.argv[1])\n'
            )
            data_home = root / 'data-home'
            app = root / '.local/opt/local-ai-desktop-goose-dev/packages/ux-rc/Local AI Desktop-linux-x64'
            (app / 'resources/bin').mkdir(parents=True)
            for file in [app / 'local-ai-desktop', app / 'resources/bin/goose']:
                file.write_text('#!/bin/sh\nexit 0\n')
                file.chmod(0o755)
            work = root / 'repo/.local-work'
            work.mkdir(parents=True)
            (work / 'desktop-selected.path').write_text(str(app / 'local-ai-desktop') + '\n')
            result = root / 'result'
            subprocess.run(['bash', str(scripts / launcher.name)], check=True, env={
                **os.environ, 'LOCAL_AI_DESKTOP_DEV_DETACHED': '1',
                'HOME': str(root), 'XDG_DATA_HOME': str(data_home), 'LAD_TEST_RESULT': str(result),
                'XDG_STATE_HOME': str(root / 'state'),
            })
            self.assertEqual(result.read_text(), str(app / 'local-ai-desktop'))


if __name__ == '__main__':
    unittest.main()
