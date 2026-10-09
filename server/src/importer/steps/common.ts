import type { ImportContext, SourceUser } from '../importer.ts';
import { USERS } from '../import-map.ts';

export interface ImportedUser {
  source: SourceUser;
  /** The user's id here. */
  userId: number;
}

/** The selected TTRSS users that the users step imported or adopted. */
export async function importedUsers({ users, map }: ImportContext): Promise<ImportedUser[]> {
  const targets = await map.targets(
    USERS,
    users.map((u) => u.id),
  );
  return users.flatMap((source) => {
    const userId = targets.get(source.id);
    return userId === undefined ? [] : [{ source, userId }];
  });
}
