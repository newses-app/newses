// A feed's HTTP Basic login as the edit dialog changes it (API 1.12).

/** What the dialog's login fields hold. */
export interface LoginFields {
  needsLogin: boolean;
  login: string;
  password: string;
}

/** A login to save: with the password only when one is given, else the saved one stays. */
export interface LoginChange {
  login: string;
  password?: string;
}

/**
 * The change to send for a feed that had `saved` as its login: null removes it, a login sets it,
 * and undefined leaves it as it is. A new login always sends its password, empty or not.
 */
export function loginChange(
  saved: string | null | undefined,
  fields: LoginFields,
): LoginChange | null | undefined {
  const had = Boolean(saved);
  if (!fields.needsLogin) return had ? null : undefined;
  const login = fields.login.trim();
  if (had && login === saved && fields.password === '') return undefined;
  return { login, ...((!had || fields.password !== '') && { password: fields.password }) };
}
