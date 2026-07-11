import type { MediaInfo, ProjectSession, SavedSession } from '../types';

export type SessionRestoreRequest = {
  kind: 'restore' | 'relink';
  session: SavedSession;
};

export function sessionRestoreRequest(session: SavedSession): SessionRestoreRequest | null {
  if (!session.sourcePath) return null;
  return {
    kind: session.sourceExists === false ? 'relink' : 'restore',
    session
  };
}

export function buildRelinkedSession(session: SavedSession, media: MediaInfo): ProjectSession {
  const { version: _version, savedAt: _savedAt, sourceUrl: _sourceUrl, sourceExists: _sourceExists, ...project } = session;
  return {
    ...project,
    sourcePath: media.filePath,
    sourceName: media.name
  };
}
