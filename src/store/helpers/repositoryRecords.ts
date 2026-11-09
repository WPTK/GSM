
import type { Repository } from '../../types';

export const areRepositoryRecordsEqual = (a: Repository, b: Repository): boolean => {
  if (a === b) return true;

  const keys = new Set<keyof Repository>([
    ...(Object.keys(a) as Array<keyof Repository>),
    ...(Object.keys(b) as Array<keyof Repository>),
  ]);

  for (const key of keys) {
    if (!Object.is(a[key], b[key])) {
      return false;
    }
  }

  return true;
};

export const replaceRepositoryInList = (
  repositories: Repository[],
  repo: Repository
): { repositories: Repository[]; changed: boolean; found: boolean } => {
  const index = repositories.findIndex((item) => item.id === repo.id);
  if (index === -1) {
    return { repositories, changed: false, found: false };
  }

  if (areRepositoryRecordsEqual(repositories[index], repo)) {
    return { repositories, changed: false, found: true };
  }

  const nextRepositories = repositories.slice();
  nextRepositories[index] = repo;
  return { repositories: nextRepositories, changed: true, found: true };
};
