import { PassThrough, Writable } from "node:stream";

import { Unicode11Addon } from "@xterm/addon-unicode11";
import xterm from "@xterm/headless";

function streamProperty(
  property: string | symbol,
  controls: object,
  stream: object,
  target: object,
): unknown {
  const owner =
    property in controls ? controls : property in stream ? stream : target;
  const value: unknown = Reflect.get(owner, property, owner);
  return typeof value === "function" ? value.bind(owner) : value;
}

export class VirtualTerminal {
  readonly terminal: InstanceType<typeof xterm.Terminal>;
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly inputStream = new PassThrough();
  readonly output: string[] = [];

  constructor(columns = 80, rows = 24) {
    this.terminal = new xterm.Terminal({
      cols: columns,
      rows,
      convertEol: true,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = "11";

    const outputStream = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.output.push(chunk.toString());
        this.terminal.write(chunk, callback);
      },
    });
    const outputControls = { columns, rows, isTTY: true };
    this.stdout = new Proxy(process.stdout, {
      get: (target, property) =>
        streamProperty(property, outputControls, outputStream, target),
      set: (_target, property, value: unknown) =>
        Reflect.set(outputControls, property, value),
    });
    const inputControls = {
      isTTY: true,
      isRaw: false,
      setRawMode: (enabled: boolean) => {
        inputControls.isRaw = enabled;
        return this.stdin;
      },
      ref: () => this.stdin,
      unref: () => this.stdin,
    };
    this.stdin = new Proxy(process.stdin, {
      get: (target, property) =>
        streamProperty(property, inputControls, this.inputStream, target),
    });
  }

  get cursor() {
    const buffer = this.terminal.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY };
  }

  screenLine(row: number) {
    const buffer = this.terminal.buffer.active;
    return buffer.getLine(buffer.baseY + row);
  }

  bufferLines() {
    const buffer = this.terminal.buffer.active;
    return Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
    );
  }

  resize(columns: number, rows = this.stdout.rows) {
    this.terminal.resize(columns, rows);
    this.stdout.columns = columns;
    this.stdout.rows = rows;
    this.stdout.emit("resize");
  }

  async flush() {
    await new Promise<void>((resolve, reject) => {
      this.stdout.write("", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  dispose() {
    this.stdin.destroy();
    this.stdout.destroy();
    this.terminal.dispose();
  }
}
