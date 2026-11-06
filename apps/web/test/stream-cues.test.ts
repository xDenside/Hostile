import { describe, expect, it } from 'vitest';
import type { VoiceParticipantDTO } from '@hostile/shared';
import {
  audiencesOf,
  cueViewerJoin,
  viewerPairsAdded,
  type ViewerCueContext,
} from '../src/features/voice/cue-rules';

function member(userId: string, watching: string[] = []): VoiceParticipantDTO {
  return {
    userId,
    identity: userId,
    joinedAt: null,
    micMuted: false,
    screenSharing: false,
    selfMuted: false,
    selfDeafened: false,
    watching,
  };
}

function context(over: Partial<ViewerCueContext> = {}): ViewerCueContext {
  return { selfId: 'alice', partOf: () => false, recentlyLeft: () => false, ...over };
}

function joined(
  before: VoiceParticipantDTO[],
  after: VoiceParticipantDTO[],
  ctx: ViewerCueContext,
) {
  return cueViewerJoin(viewerPairsAdded(audiencesOf(before), audiencesOf(after)), ctx);
}

describe('viewer-join cue', () => {
  it('plays for the sharer when someone starts watching their stream', () => {
    const ctx = context({ partOf: (sharer) => sharer === 'alice' });
    expect(
      joined(
        [member('alice'), member('carol')],
        [member('alice'), member('carol', ['alice'])],
        ctx,
      ),
    ).toBe(true);
  });

  it('plays for a fellow viewer of the same stream, and not for anyone outside it', () => {
    const before = [member('alice', ['bob']), member('bob'), member('carol')];
    const after = [member('alice', ['bob']), member('bob'), member('carol', ['bob'])];
    expect(joined(before, after, context({ partOf: (sharer) => sharer === 'bob' }))).toBe(true);
    expect(joined(before, after, context())).toBe(false);
  });

  it('never plays from the snapshot for this member arriving themselves', () => {
    const ctx = context({ partOf: () => true });
    expect(
      joined([member('alice'), member('bob')], [member('alice', ['bob']), member('bob')], ctx),
    ).toBe(false);
  });

  it('stays silent when a viewer comes back moments after dropping out', () => {
    const before = [member('alice'), member('carol')];
    const after = [member('alice'), member('carol', ['alice'])];
    const ctx = context({
      partOf: (sharer) => sharer === 'alice',
      recentlyLeft: ({ sharer, viewer }) => sharer === 'alice' && viewer === 'carol',
    });
    expect(joined(before, after, ctx)).toBe(false);
  });

  it('stays silent for viewers who were already there or who leave', () => {
    const ctx = context({ partOf: () => true });
    const watching = [member('alice'), member('carol', ['alice'])];
    expect(joined(watching, watching, ctx)).toBe(false);
    expect(joined(watching, [member('alice'), member('carol')], ctx)).toBe(false);
  });
});
