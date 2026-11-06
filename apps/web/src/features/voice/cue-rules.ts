import type { VoiceParticipantDTO } from '@hostile/shared';

export type Audiences = ReadonlyMap<string, ReadonlySet<string>>;

export interface ViewerPair {
  sharer: string;
  viewer: string;
}

export function audiencesOf(participants: readonly VoiceParticipantDTO[]): Audiences {
  const audiences = new Map<string, Set<string>>();
  for (const p of participants) {
    for (const sharer of p.watching) {
      let viewers = audiences.get(sharer);
      if (!viewers) audiences.set(sharer, (viewers = new Set()));
      viewers.add(p.userId);
    }
  }
  return audiences;
}

export function viewerPairsAdded(before: Audiences, after: Audiences): ViewerPair[] {
  const added: ViewerPair[] = [];
  for (const [sharer, viewers] of after) {
    const earlier = before.get(sharer);
    for (const viewer of viewers) if (!earlier?.has(viewer)) added.push({ sharer, viewer });
  }
  return added;
}

export interface ViewerCueContext {
  selfId: string;
  partOf: (sharer: string) => boolean;
  recentlyLeft: (pair: ViewerPair) => boolean;
}

export function cueViewerJoin(added: readonly ViewerPair[], ctx: ViewerCueContext): boolean {
  return added.some(
    (pair) => pair.viewer !== ctx.selfId && ctx.partOf(pair.sharer) && !ctx.recentlyLeft(pair),
  );
}
