import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileKey, enqueueFile, dequeueIfHead, queueRemaining } from './transfer-queue.js';

function mockFile(name, size, lastModified = 1) {
  return { name, size, lastModified };
}

describe('transfer-queue', () => {
  it('fileKey distinguishes same name different size', () => {
    const a = mockFile('a.jpg', 100);
    const b = mockFile('a.jpg', 200);
    assert.notEqual(fileKey(a), fileKey(b));
  });

  it('enqueueFile skips duplicates', () => {
    const f = mockFile('x.bin', 50);
    const q = [];
    assert.equal(enqueueFile(q, f).added, true);
    assert.equal(enqueueFile(q, f).added, false);
    assert.equal(q.length, 1);
  });

  it('enqueueFile allows same name different size', () => {
    const q = [];
    enqueueFile(q, mockFile('x.bin', 50));
    enqueueFile(q, mockFile('x.bin', 99));
    assert.equal(q.length, 2);
  });

  it('dequeueIfHead only removes matching head', () => {
    const a = mockFile('a', 1);
    const b = mockFile('b', 2);
    const q = [a, b];
    dequeueIfHead(q, b);
    assert.equal(q.length, 2);
    dequeueIfHead(q, a);
    assert.equal(q.length, 1);
    assert.equal(q[0], b);
  });

  it('queueRemaining is queue length', () => {
    const q = [mockFile('a', 1), mockFile('b', 2)];
    assert.equal(queueRemaining(q), 2);
    assert.equal(queueRemaining([]), 0);
  });
});
