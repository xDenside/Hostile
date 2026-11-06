import { create } from 'zustand';

export type JoinStep = 'code' | 'meeting-point' | 'finding-host' | 'direct' | 'greeting';

export const JOIN_STEP_LABEL: Record<JoinStep, string> = {
  code: 'Checking the code',
  'meeting-point': 'Reaching a meeting point',
  'finding-host': 'Looking for the host',
  direct: 'Connecting to the host',
  greeting: 'Greeting the host',
};

export type TunnelPhase = 'idle' | 'connecting' | 'connected' | 'away' | 'failed' | 'ended';

export interface TunnelState {
  phase: TunnelPhase;
  step: JoinStep | null;
  failedStep: JoinStep | null;
  message: string | null;
  retryAt: number | null;
  code: string | null;
  hostFingerprint: string | null;
  customRelay: string;
}

export const useTunnel = create<TunnelState>(() => ({
  phase: 'idle',
  step: null,
  failedStep: null,
  message: null,
  retryAt: null,
  code: null,
  hostFingerprint: null,
  customRelay: '',
}));
