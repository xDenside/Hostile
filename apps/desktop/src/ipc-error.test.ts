import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { plainIpcError, plainIpcMessage } from './ipc-error.js';

const PERMISSION =
  'macOS is not allowing Hostile to record the screen. Allow it in System Settings → Privacy & ' +
  'Security → Screen Recording, then restart the app.';

describe('plainIpcMessage', () => {
  it("removes Electron's wrapper from a main-process error", () => {
    assert.equal(
      plainIpcMessage(`Error invoking remote method 'hostile:capture:list': Error: ${PERMISSION}`),
      PERMISSION,
    );
  });

  it('removes other error names too', () => {
    assert.equal(
      plainIpcMessage("Error invoking remote method 'hostile:room:get': TypeError: bad input"),
      'bad input',
    );
  });

  it('keeps a message that has no wrapper', () => {
    assert.equal(plainIpcMessage('Error: something else'), 'Error: something else');
    assert.equal(plainIpcMessage(PERMISSION), PERMISSION);
  });

  it('keeps the whole message when nothing would be left', () => {
    const empty = "Error invoking remote method 'hostile:info': Error: ";
    assert.equal(plainIpcMessage(empty), empty);
  });
});

describe('plainIpcError', () => {
  it('returns a new error with the plain message', () => {
    const err = plainIpcError(
      new Error(`Error invoking remote method 'hostile:capture:list': Error: ${PERMISSION}`),
    );
    assert.ok(err instanceof Error);
    assert.equal(err.message, PERMISSION);
  });

  it('returns the same error when there is nothing to remove', () => {
    const original = new Error('plain');
    assert.equal(plainIpcError(original), original);
  });

  it('passes through values that are not errors', () => {
    assert.equal(plainIpcError('text'), 'text');
    assert.equal(plainIpcError(undefined), undefined);
  });
});
