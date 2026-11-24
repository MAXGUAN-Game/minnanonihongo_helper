export type RemoteProfile = { host: string; user: string; runtime: string; identityFile: string };
export function validateProfile(value: unknown): RemoteProfile;
export function validateArchivePaths(names: string[], listing: string): void;
export const repositoryUrl: string;
export function validateGitRelease(value: { commit: string; head: string; remoteHead: string; dirty: string }): string;
export function updateScript(value: { commit: string; version: string; unit: string; syncOnly?: boolean }): string;
