export const OUTPUT_CAP_BYTES = 32 * 1024;

// Leaves room for the marker and for the replacement characters that a cut through a multi-byte sequence decodes to.
const KEPT_BYTES_PER_END = Math.floor((OUTPUT_CAP_BYTES - 96) / 2);

export type CappedOutput = { output: string; truncated: boolean };

function joinEnds(args: { head: Buffer; tail: Buffer; omittedBytes: number }): CappedOutput {
  const head = args.head.subarray(0, KEPT_BYTES_PER_END).toString("utf8");
  const tail = args.tail.subarray(-KEPT_BYTES_PER_END).toString("utf8");
  return { output: `${head}\n[... ${args.omittedBytes} bytes omitted ...]\n${tail}`, truncated: true };
}

export function capText(text: string): CappedOutput {
  const bytes = Buffer.from(text.toWellFormed(), "utf8");
  if (bytes.length <= OUTPUT_CAP_BYTES) {
    return { output: bytes.toString("utf8"), truncated: false };
  }
  return joinEnds({ head: bytes, tail: bytes, omittedBytes: bytes.length - 2 * KEPT_BYTES_PER_END });
}

export type OutputCollector = {
  add: (chunk: Buffer) => void;
  finish: () => CappedOutput;
};

// Holds at most one cap of bytes however much a command prints, so a runaway command cannot grow memory.
export function createOutputCollector(): OutputCollector {
  const retainedPerEnd = OUTPUT_CAP_BYTES / 2;
  let head: Buffer = Buffer.alloc(0);
  let tail: Buffer = Buffer.alloc(0);
  let totalBytes = 0;
  return {
    add(chunk) {
      totalBytes += chunk.length;
      const room = retainedPerEnd - head.length;
      const toHead = chunk.subarray(0, Math.max(room, 0));
      if (toHead.length > 0) {
        head = Buffer.concat([head, toHead]);
      }
      const rest = chunk.subarray(toHead.length);
      if (rest.length >= retainedPerEnd) {
        tail = Buffer.from(rest.subarray(-retainedPerEnd));
      } else if (rest.length > 0) {
        tail = Buffer.concat([tail, rest]).subarray(-retainedPerEnd);
      }
    },
    finish() {
      if (totalBytes <= OUTPUT_CAP_BYTES) {
        return capText(Buffer.concat([head, tail]).toString("utf8"));
      }
      return joinEnds({
        head: Buffer.from(head.toString("utf8"), "utf8"),
        tail: Buffer.from(tail.toString("utf8"), "utf8"),
        omittedBytes: totalBytes - 2 * KEPT_BYTES_PER_END,
      });
    },
  };
}
