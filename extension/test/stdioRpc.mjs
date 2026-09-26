import { spawn } from "node:child_process";

export class StdioRpc {
  notifications = [];
  #timeout;
  #child;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();
  #notificationWaiters = [];
  #stderr = "";

  constructor(server, timeout = 5_000) {
    this.#timeout = timeout;
    this.#child = spawn(process.execPath, [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk) => { this.#stderr += chunk.toString(); });
  }

  request(method, params) {
    const id = this.#nextId++;
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr=${this.#stderr}`));
      }, this.#timeout);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  waitForNotification(method, predicate) {
    return new Promise((resolve, reject) => {
      const entry = {
        method,
        predicate,
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
      };
      const timeout = setTimeout(() => {
        this.#notificationWaiters = this.#notificationWaiters.filter((waiter) => waiter !== entry);
        reject(new Error(`Timed out waiting for ${method}. stderr=${this.#stderr}; recent=${JSON.stringify(this.notifications.slice(-4))}`));
      }, this.#timeout);
      this.#notificationWaiters.push(entry);
    });
  }

  waitForExit() {
    if (this.#child.exitCode !== null) return Promise.resolve(this.#child.exitCode);
    return new Promise((resolve) => this.#child.once("exit", resolve));
  }

  dispose() {
    if (this.#child.exitCode === null) this.#child.kill();
  }

  #send(message) {
    const json = JSON.stringify(message);
    this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  #consume(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.#buffer.subarray(0, headerEnd).toString())?.[1]);
      const messageEnd = headerEnd + 4 + length;
      if (!Number.isFinite(length) || this.#buffer.length < messageEnd) return;
      const message = JSON.parse(this.#buffer.subarray(headerEnd + 4, messageEnd).toString());
      this.#buffer = this.#buffer.subarray(messageEnd);
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    this.notifications.push(message);
    const waiter = this.#notificationWaiters.find(
      (candidate) => candidate.method === message.method && candidate.predicate(message.params),
    );
    if (!waiter) return;
    this.#notificationWaiters = this.#notificationWaiters.filter((candidate) => candidate !== waiter);
    waiter.resolve(message.params);
  }
}
