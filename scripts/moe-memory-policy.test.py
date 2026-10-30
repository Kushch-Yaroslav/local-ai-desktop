import importlib.util
import pathlib
import unittest
spec = importlib.util.spec_from_file_location('experiment', pathlib.Path(__file__).with_name('moe-cache-experiment.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class MemoryPolicy(unittest.TestCase):
    def test_swapout_even_if_net_swap_decreases(self):
        self.assertIsNotNone(module.memory_stop_reason(40, 0, 33 * 1024**2, 'some avg10=0.0'))
    def test_existing_swap_does_not_count_as_growth(self):
        self.assertIsNone(module.memory_stop_reason(30, 0, 0, 'some avg10=0.0'))
    def test_pressure_with_memory_shortage(self):
        self.assertIsNotNone(module.memory_stop_reason(9, 0, 0, 'some avg10=11.0\nfull avg10=10.5'))
    def test_mapping_pressure_without_memory_shortage(self):
        self.assertIsNone(module.memory_stop_reason(50, 0, 0, 'some avg10=11.0'))
    def test_net_swap_growth(self):
        self.assertIsNotNone(module.memory_stop_reason(40, 129 * 1024, 0, 'some avg10=0.0'))

if __name__ == '__main__':
    unittest.main()
