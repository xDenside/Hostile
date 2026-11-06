import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { NOTE_EVERY_MS, noteEachAsking, notificationBody, type NoteWords } from './notify.js';

describe('a nickname in a native notification', () => {
  it('is markup on no platform', () => {
    assert.equal(notificationBody('<b>&', 'linux'), '&lt;b&gt;&amp;');
    assert.equal(notificationBody('<b>&', 'darwin'), '<b>&');
  });

  it('is cut between characters', () => {
    const long = '\u{1F600}'.repeat(100);
    assert.equal([...notificationBody(long, 'win32')].length, 48);
    assert.ok(notificationBody(long, 'win32').endsWith('\u{1F600}'));
  });
});

describe('someone asking, again and again', () => {
  const start = () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const notes: NoteWords[] = [];
    return { notes, ask: noteEachAsking((words) => notes.push(words), 'darwin') };
  };

  it('tells the host at once, and then at most once in each quiet', () => {
    const { notes, ask } = start();
    try {
      for (let i = 0; i < 200; i += 1) ask({ nickname: `Spam ${i}`, waiting: 1 });
      assert.deepEqual(notes, [{ title: 'Someone is asking to join', body: 'Spam 0' }]);
      mock.timers.tick(NOTE_EVERY_MS);
      assert.equal(notes.length, 2);
      assert.equal(notes[1]!.body, 'Spam 199');
      mock.timers.tick(NOTE_EVERY_MS * 5);
      assert.equal(notes.length, 2, 'nothing more was asked');
    } finally {
      mock.timers.reset();
    }
  });

  it('says how many, when several have piled up', () => {
    const { notes, ask } = start();
    try {
      ask({ nickname: 'First', waiting: 1 });
      ask({ nickname: 'Second', waiting: 2 });
      ask({ nickname: 'Third', waiting: 3 });
      mock.timers.tick(NOTE_EVERY_MS);
      assert.equal(notes[1]!.title, '3 people are asking to join');
      assert.ok(!notes[1]!.body.includes('Third'));
    } finally {
      mock.timers.reset();
    }
  });

  it('tells the host at once again after a quiet has passed', () => {
    const { notes, ask } = start();
    try {
      ask({ nickname: 'First', waiting: 1 });
      mock.timers.tick(NOTE_EVERY_MS + 1);
      ask({ nickname: 'Later', waiting: 1 });
      assert.deepEqual(
        notes.map((n) => n.body),
        ['First', 'Later'],
      );
    } finally {
      mock.timers.reset();
    }
  });
});
