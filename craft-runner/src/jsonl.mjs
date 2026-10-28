// Newline-delimited JSON framing with a hard per-line byte cap.
// An over-cap line is never buffered whole: only a short head and tail are kept so the JSON-RPC id can
// still be recovered and the caller can answer that request with an explanatory error.

const KEEP = 512;

/**
 * @param {{ maxBytes: number, onLine: (line: string) => void, onOverflow: (o: {head: string, tail: string, bytes: number}) => void }} o
 * @returns {(chunk: Buffer) => void}
 */
export function createLineSplitter({ maxBytes, onLine, onOverflow }) {
  /** @type {Buffer[]} */
  let parts = [];
  let size = 0;
  let overflow = null; // { head: Buffer, tail: Buffer, bytes: number }

  const addOverflow = (buf) => {
    overflow.bytes += buf.length;
    if (overflow.head.length < KEEP) {
      overflow.head = Buffer.concat([overflow.head, buf.subarray(0, KEEP - overflow.head.length)]);
    }
    const t = Buffer.concat([overflow.tail, buf]);
    overflow.tail = t.subarray(Math.max(0, t.length - KEEP));
  };

  return (chunk) => {
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, nl === -1 ? chunk.length : nl);
      if (overflow) {
        addOverflow(piece);
      } else if (size + piece.length > maxBytes) {
        const pending = Buffer.concat([...parts, piece]);
        parts = [];
        size = 0;
        overflow = { head: Buffer.alloc(0), tail: Buffer.alloc(0), bytes: 0 };
        addOverflow(pending);
      } else if (piece.length > 0) {
        parts.push(piece);
        size += piece.length;
      }
      if (nl === -1) break;
      if (overflow) {
        const o = overflow;
        overflow = null;
        onOverflow({ head: o.head.toString("utf8"), tail: o.tail.toString("utf8"), bytes: o.bytes });
      } else {
        const line = Buffer.concat(parts).toString("utf8");
        parts = [];
        size = 0;
        if (line.trim()) onLine(line);
      }
      start = nl + 1;
    }
  };
}

const ID_RE = /"id"\s*:\s*(-?\d{1,15}|"(?:[^"\\]|\\.){0,200}")/g;

/**
 * Best-effort JSON-RPC id recovery from a truncated line. Responses from rmcp put `id` near the
 * start; requests from the TypeScript MCP SDK put it last — `from` picks which end to trust.
 * @param {string} text
 * @param {"first"|"last"} from
 */
export function extractJsonRpcId(text, from) {
  const matches = [...text.matchAll(ID_RE)];
  if (matches.length === 0) return undefined;
  const m = from === "first" ? matches[0] : matches[matches.length - 1];
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

/** Write one JSON message as a line. */
export function writeJson(stream, msg) {
  if (stream.destroyed || stream.writableEnded) return false;
  return stream.write(`${JSON.stringify(msg)}\n`);
}
