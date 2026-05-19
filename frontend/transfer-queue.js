/** Pure helpers for multi-file send queue (unit-testable). */

export function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export function enqueueFile(queue, file) {
  const key = fileKey(file);
  if (queue.some((f) => fileKey(f) === key)) return { queue, added: false };
  queue.push(file);
  return { queue, added: true };
}

export function dequeueIfHead(queue, file) {
  if (queue.length && queue[0] === file) queue.shift();
  return queue;
}

/** Files still in the outbound queue (includes the file currently sending at head). */
export function queueRemaining(queue) {
  return queue.length;
}
