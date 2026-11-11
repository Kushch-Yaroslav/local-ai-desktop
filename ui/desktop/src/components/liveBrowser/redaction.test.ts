import { expect, test } from 'vitest';
import { redactRuntimeText } from '../../../live-browser/runtime/util';
test('redacts private CDP runtime credentials from connection failures and call logs', () => {
  const token = 'a0'.repeat(24),
    input = `connectOverCDP failed ws://127.0.0.1:123/cdp?conversation=chat&token=${token}\nBearer ${token}\nhttps://user:password@example.test/?api_key=private-key&view=products`;
  const safe = redactRuntimeText(input, token);
  expect(safe).not.toContain(token);
  expect(safe).not.toContain('private-key');
  expect(safe).not.toContain('user:password');
  expect(safe).toContain('conversation=chat');
  expect(safe).toContain('view=products');
  expect(safe).toContain('connectOverCDP failed');
});
