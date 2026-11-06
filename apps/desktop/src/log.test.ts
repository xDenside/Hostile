import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { loadFailure } from './log.js';

describe('loadFailure', () => {
  it('names the page without its query or fragment, where a code or a secret can be', () => {
    const line = loadFailure(
      -6,
      'ERR_FILE_NOT_FOUND',
      'hostile://hostile/bridge.html?code=ABCDE-FGHIJ#eyJnYXRld2F5U2VjcmV0IjoieCJ9',
    );
    assert.equal(
      line,
      'the window could not load hostile://hostile/bridge.html: ERR_FILE_NOT_FOUND (-6)',
    );
    assert.ok(!line.includes('ABCDE') && !line.includes('eyJ'));
  });

  it('does not repeat something that is not an address', () => {
    assert.equal(
      loadFailure(-2, 'ERR_FAILED', 'not a url secret'),
      'the window could not load a page with no address: ERR_FAILED (-2)',
    );
  });
});
