import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('compare',Path(__file__).with_name('compare.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Metrics(unittest.TestCase):
 def test_identical(self):
  r=m.compare([1.,2.,3.],[1.,2.,3.]);self.assertEqual(r['max_abs'],0);self.assertEqual(r['total_variation'],0);self.assertEqual(r['top1_baseline'],2)
 def test_additive_offset_does_not_change_distribution(self):
  r=m.compare([1.,2.,3.],[2.,3.,4.]);self.assertEqual(r['mean_abs'],1);self.assertAlmostEqual(r['total_variation'],0);self.assertAlmostEqual(r['Jensen_Shannon_nats'],0)
 def test_ranking_change(self):
  r=m.compare([1.,2.,3.],[3.,2.,1.]);self.assertEqual(r['top1_cache'],0);self.assertGreater(r['total_variation'],0);self.assertGreater(r['Jensen_Shannon_nats'],0)
if __name__=='__main__':unittest.main()
