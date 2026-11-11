import unittest, tempfile, pathlib, sqlite3, importlib.util
spec=importlib.util.spec_from_file_location('migrate', pathlib.Path(__file__).with_name('migrate.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class MigrationTests(unittest.TestCase):
 def test_copy_preserves_database_history_profiles_and_links(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);s=p/'source';s.mkdir();(s/'profile.json').write_text('{"mode":"chat","context":8192}')
   db=sqlite3.connect(s/'sessions.db');db.execute('create table messages(content)');db.execute("insert into messages values('history')");db.commit();db.close()
   (s/'profile-link').symlink_to('profile.json');m.copy_verified(s,p/'copy');self.assertEqual(m.manifest(s),m.manifest(p/'copy'))
   with self.assertRaises(RuntimeError):m.copy_verified(s,p/'copy')
 def test_migration_and_rollback_preserve_new_messages(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);s=p/'source';s.mkdir();(s/'history').write_text('old')
   plan={'configFile':str(p/'config.json'),'backup':str(p/'backup.tar.gz'),'configuration':{'dataRoot':str(p/'new'),'bulkRoot':str(p/'bulk'),'volumes':[]},'moves':[{'source':str(s),'destination':str(p/'new')}],'bulkMoves':[]}
   m.migrate(plan,p/'receipt');self.assertTrue(s.is_symlink());(s/'history').write_text('new history');m.rollback(p/'receipt');self.assertFalse(s.is_symlink());self.assertEqual((s/'history').read_text(),'new history')

class FailureSafetyTests(unittest.TestCase):
 def plan(self,p):
  source=p/'source';source.mkdir();(source/'history').write_text('preserved')
  return {'configFile':str(p/'config.json'),'backup':str(p/'backup.tar.gz'),'configuration':{'dataRoot':str(p/'new'),'bulkRoot':str(p/'bulk'),'volumes':[]},'moves':[{'source':str(source),'destination':str(p/'new')}],'bulkMoves':[]}
 def test_missing_mount_blocks_before_any_copy_or_switch(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);plan=self.plan(p);plan['configuration']['volumes']=[{'mountpoint':str(p/'missing')}]
   with self.assertRaises(RuntimeError):m.migrate(plan,p/'receipt')
   self.assertFalse((p/'backup.tar.gz').exists());self.assertFalse((p/'source').is_symlink())
 def test_can_resume_verified_copies_after_interruption(self):
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);plan=self.plan(p)
   with patch.object(m,'complete_migration',side_effect=RuntimeError('interrupted')):
    with self.assertRaises(RuntimeError):m.migrate(plan,p/'receipt')
   m.complete_migration(__import__('json').loads((p/'receipt').read_text()),p/'receipt')
   self.assertTrue((p/'source').is_symlink());self.assertEqual((p/'source/history').read_text(),'preserved')
 def test_finalize_refuses_to_delete_changed_original(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);m.migrate(self.plan(p),p/'receipt');(p/'source.migration-old/history').write_text('changed')
   with self.assertRaises(RuntimeError):m.finalize(p/'receipt')
   self.assertTrue((p/'source.migration-old/history').exists())

 def test_rollback_materializes_bulk_but_preserves_original_symlinks(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);plan=self.plan(p);cache=p/'source/cache';cache.mkdir();(cache/'item').write_text('cached');(cache/'alias').symlink_to('item')
   plan['bulkMoves']=[{'source':str(p/'new/cache'),'destination':str(p/'bulk/cache')}]
   m.migrate(plan,p/'receipt');m.rollback(p/'receipt')
   self.assertFalse((p/'source/cache').is_symlink());self.assertTrue((p/'source/cache/alias').is_symlink());self.assertEqual((p/'source/cache/alias').read_text(),'cached')

if __name__=='__main__':unittest.main()
