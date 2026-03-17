import { appendFile } from "node:fs/promises";

export class Logger {
  private filePath: string | undefined;
  private silent: boolean;

  constructor(filePath?: string, options?: { silent?: boolean }) {
    this.filePath = filePath;
    this.silent = options?.silent ?? false;
  }

  log(message: string): void {
    if (!this.silent) {
      console.log(message);
    }
    this.writeToFile(message, "LOG");
  }

  warn(message: string): void {
    if (!this.silent) {
      console.warn(message);
    }
    this.writeToFile(message, "WARN");
  }

  error(message: string): void {
    if (!this.silent) {
      console.error(message);
    }
    this.writeToFile(message, "ERROR");
  }

  private writeToFile(message: string, type: string): void {
    if (this.filePath) {
      appendFile(this.filePath, `[${new Date().toISOString()}] [${type}] ${message}\n`).catch(() => {});
    }
  }
}
