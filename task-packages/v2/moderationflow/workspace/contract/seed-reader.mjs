import { createReadStream } from 'node:fs';

/**
 * Parse a seed without creating one string for the entire file. The decoded JSON
 * tree is still materialized so the unchanged, complete schema can validate it.
 * Memory is O(decoded tree + largest scalar); a single string is still subject
 * to the engine's string limit. This does not perform a business import.
 */
export async function readSeedJsonFile(path, { highWaterMark = 64 * 1024 } = {}) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark });
  const stack = [];
  let root, rootSet = false, mode, parts = [], escaped = false;
  const syntax = () => { throw new SyntaxError('Invalid JSON in seed file'); };
  const scalarText = (tail = '') => {
    try { return parts.join('') + tail; }
    catch (cause) {
      if (cause instanceof RangeError && cause.message === 'Invalid string length') cause.code = 'ERR_STRING_TOO_LONG';
      throw cause;
    }
  };
  const value = item => {
    const frame = stack.at(-1);
    if (!frame) {
      if (rootSet) syntax();
      root = item; rootSet = true;
    } else if (frame.kind === 'array' && ['first', 'value'].includes(frame.state)) {
      frame.value.push(item); frame.state = 'comma';
    } else if (frame.kind === 'object' && frame.state === 'value') {
      // Match JSON.parse, including last-key-wins and a literal __proto__ key.
      Object.defineProperty(frame.value, frame.key, { value: item, enumerable: true, writable: true, configurable: true });
      frame.state = 'comma';
    } else syntax();
  };
  const token = (text, string = false) => {
    const item = JSON.parse(text), frame = stack.at(-1);
    if (string && frame?.kind === 'object' && ['first', 'key'].includes(frame.state)) {
      frame.key = item; frame.state = 'colon';
    } else value(item);
  };
  const punctuation = character => {
    const frame = stack.at(-1);
    if (character === '{' || character === '[') {
      const item = character === '{' ? {} : [];
      value(item);
      stack.push({ kind: character === '{' ? 'object' : 'array', value: item, state: 'first' });
    } else if (character === '}' || character === ']') {
      if (!frame || frame.kind !== (character === '}' ? 'object' : 'array') || !['first', 'comma'].includes(frame.state)) syntax();
      stack.pop();
    } else if (character === ':') {
      if (frame?.kind !== 'object' || frame.state !== 'colon') syntax();
      frame.state = 'value';
    } else {
      if (!frame || frame.state !== 'comma') syntax();
      frame.state = frame.kind === 'object' ? 'key' : 'value';
    }
  };
  try {
    for await (const chunk of stream) {
      let index = 0;
      while (index < chunk.length) {
        if (mode === 'string') {
          const start = index;
          let complete = false;
          for (; index < chunk.length; index++) {
            const character = chunk[index];
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') { index++; complete = true; break; }
          }
          if (complete) {
            const tail = chunk.slice(start, index);
            token(parts.length ? scalarText(tail) : tail, true);
            mode = undefined; parts = [];
          } else parts.push(chunk.slice(start));
        } else if (mode === 'literal') {
          const start = index;
          while (index < chunk.length && !/[\x20\t\r\n{}\[\],:"]/u.test(chunk[index])) index++;
          if (index < chunk.length) {
            const tail = chunk.slice(start, index);
            token(parts.length ? scalarText(tail) : tail);
            mode = undefined; parts = [];
          } else parts.push(chunk.slice(start));
        } else {
          const character = chunk[index];
          if (/[\x20\t\r\n]/u.test(character)) index++;
          else if ('{}[],:'.includes(character)) { punctuation(character); index++; }
          else if (character === '"') { mode = 'string'; parts = ['"']; index++; }
          else mode = 'literal';
        }
      }
    }
    if (mode === 'literal') token(scalarText());
    else if (mode) syntax();
    if (!rootSet || stack.length) syntax();
    return root;
  } finally { stream.destroy(); }
}
