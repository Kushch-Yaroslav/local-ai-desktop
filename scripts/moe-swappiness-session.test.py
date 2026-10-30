import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('moe-swappiness-session.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ControllerTests(unittest.TestCase):
    def exercise(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            knob, state, stop = (base / n for n in ('knob','state','stop'))
            knob.write_text('37\n')
            if mode == 'normal':
                stop.touch()
            def paths(value):
                return knob if str(value) == '/proc/sys/vm/swappiness' else Path(value)
            with patch.object(m, 'Path', side_effect=paths), patch.object(m.os, 'geteuid', return_value=0), patch.object(m.sys, 'argv', ['test',str(state),str(stop)]), patch.object(m.signal, 'signal'), patch.object(m.time, 'monotonic', side_effect=[0,601] if mode == 'timeout' else [0,1]), patch.object(m.time, 'sleep', side_effect=KeyboardInterrupt):
                if mode == 'cancel':
                    with self.assertRaises(KeyboardInterrupt):
                        m.main()
                else:
                    m.main()
            self.assertEqual(knob.read_text().strip(), '37')
            import json
            result = json.loads(state.read_text())
            self.assertEqual((result['original'],result['restored'],result['status']), (37,37,'restored'))
    def test_normal_restores_actual_value(self): self.exercise('normal')
    def test_timeout_restores(self): self.exercise('timeout')
    def test_cancellation_restores(self): self.exercise('cancel')

if __name__ == '__main__': unittest.main()
