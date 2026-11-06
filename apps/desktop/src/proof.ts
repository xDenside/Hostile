import { app } from 'electron';

const PROOF_BUILD = process.env.HOSTILE_PROOF_BUILD === '1';

export const isProofBuild = (): boolean => PROOF_BUILD && app.isPackaged;

export const PROOF_RELAYS = ['ws://127.0.0.1:5392'];
