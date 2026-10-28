import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { accessOf, canManageSession, canUseHost } from '../src/server/sessions.js';

const user = (over: Record<string, unknown> = {}) =>
  ({ id: 1, username: 'junda', password_hash: '', role: 'admin', disabled: 0, see_all_sessions: 0, created_at: 0, ...over }) as any;
const otherSession = { owner_id: 2, group_id: null, share: 'none' } as any;

test('access: admins do not see other accounts sessions unless they opt in', () => {
  const admin = user();
  assert.equal(accessOf(admin, otherSession, []), 'none');
  assert.equal(canManageSession(admin, otherSession), false);

  const superAdmin = user({ see_all_sessions: 1 });
  assert.equal(accessOf(superAdmin, otherSession, []), 'control');
  assert.equal(canManageSession(superAdmin, otherSession), true);
});

test('access: ownership and explicit group sharing still work', () => {
  const admin = user();
  assert.equal(accessOf(admin, { ...otherSession, owner_id: admin.id }, []), 'control');
  assert.equal(accessOf(admin, { ...otherSession, group_id: 7, share: 'view' }, [7]), 'view');
  assert.equal(accessOf(admin, { ...otherSession, group_id: 7, share: 'control' }, [7]), 'control');
  assert.equal(accessOf(admin, { ...otherSession, group_id: 7, share: 'view' }, []), 'none');
});

test('access: private hosts follow the same admin opt-in', () => {
  const admin = user();
  const privateHost = { owner_id: 2 } as any;
  assert.equal(canUseHost(admin, privateHost), false);
  assert.equal(canUseHost(user({ see_all_sessions: 1 }), privateHost), true);
  assert.equal(canUseHost(admin, { owner_id: admin.id } as any), true);
  assert.equal(canUseHost(admin, { owner_id: null } as any), true);
});
