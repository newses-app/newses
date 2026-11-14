import { describe, expect, it } from 'vitest';
import { loginChange } from './feed-login.ts';

const fields = (needsLogin: boolean, login = '', password = '') => ({
  needsLogin,
  login,
  password,
});

describe('loginChange', () => {
  it('changes nothing for a feed without a login that still needs none', () => {
    expect(loginChange(null, fields(false))).toBeUndefined();
    expect(loginChange(undefined, fields(false, 'ignored'))).toBeUndefined();
  });

  it("removes a feed's login when it no longer needs one", () => {
    expect(loginChange('ann', fields(false, 'ann'))).toBeNull();
  });

  it('sets a new login with its password, even an empty one', () => {
    expect(loginChange(null, fields(true, ' ann ', 'secret'))).toEqual({
      login: 'ann',
      password: 'secret',
    });
    expect(loginChange(null, fields(true, 'ann'))).toEqual({ login: 'ann', password: '' });
  });

  it('keeps the saved password unless another is given', () => {
    expect(loginChange('ann', fields(true, ' ann '))).toBeUndefined();
    expect(loginChange('ann', fields(true, 'bob'))).toEqual({ login: 'bob' });
    expect(loginChange('ann', fields(true, 'ann', 'new'))).toEqual({
      login: 'ann',
      password: 'new',
    });
  });
});
