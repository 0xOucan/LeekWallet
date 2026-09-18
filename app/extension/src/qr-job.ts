/**
 * The one QR job the worker may have open, and how it ends.
 *
 * Kept free of `chrome.*` so the endings can be tested: a job must end in
 * exactly one of "accepted", "cancelled" or "tab closed", and the last two
 * must reach a waiting dapp as EIP-1193 4001. A dapp whose promise never
 * settles because a tab was closed is a spinner nobody can dismiss, and the
 * user who closed it made a decision that deserves to be reported as one.
 */

import { EIP1193, type QrDoneReply, type QrJobView } from "./protocol.ts";

/** A refusal carrying an EIP-1193 code, as the worker's RpcError does. */
export class QrJobError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "QrJobError";
  }
}

interface Open {
  view: QrJobView;
  tabId: number | null;
  /**
   * Checks what the tab scanned. Throwing keeps the job open, so a
   * signature for another request - still on the device's screen from last
   * time - is a "scan again", not the end of the dapp's request.
   */
  accept: (cbor: Uint8Array) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (e: QrJobError) => void;
}

export interface QrTabs {
  open(jobId: string): Promise<number | null>;
  close(tabId: number): void;
}

const unhex = (hex: string): Uint8Array | null => {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  return new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
};

export class QrJobs {
  private job: Open | null = null;
  private seq = 0;
  private readonly tabs: QrTabs;

  constructor(tabs: QrTabs) {
    this.tabs = tabs;
  }

  /**
   * Open a tab for `view` and wait for an accepted scan.
   *
   * One at a time. Two tabs each holding the camera, each showing a request,
   * is two requests the user can confuse on a device that shows only one.
   */
  run<T>(view: Omit<QrJobView, "id">, accept: (cbor: Uint8Array) => Promise<T>): Promise<T> {
    if (this.job !== null) {
      return Promise.reject(new QrJobError(
        EIP1193.userRejected,
        "another QR request is already open; finish or close it first",
      ));
    }
    const id = `q${++this.seq}-${Date.now()}`;
    return new Promise<T>((resolve, reject) => {
      const job: Open = {
        view: { ...view, id },
        tabId: null,
        accept,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      this.job = job;
      this.tabs.open(id).then(
        (tabId) => {
          /* Closed or cancelled before the tab id came back: close it now. */
          if (this.job !== job) { if (tabId !== null) this.tabs.close(tabId); return; }
          job.tabId = tabId;
        },
        (e: unknown) => this.end(job, new QrJobError(
          EIP1193.internal, `could not open the QR tab: ${String((e as Error)?.message ?? e)}`)),
      );
    });
  }

  /** The view for the tab, only if it names the job that is open now. */
  view(id: string): QrJobView | null {
    return this.job !== null && this.job.view.id === id ? this.job.view : null;
  }

  /** What the tab scanned. Only the open job, and only if `accept` agrees. */
  async done(id: string, cborHex: string): Promise<QrDoneReply> {
    const job = this.job;
    if (job === null || job.view.id !== id) {
      return { done: false, error: "this request is no longer waiting", retry: false };
    }
    const cbor = unhex(cborHex);
    if (cbor === null) return { done: false, error: "the scanned body was not hex", retry: true };
    let value: unknown;
    try {
      value = await job.accept(cbor);
    } catch (e) {
      return { done: false, error: String((e as Error)?.message ?? e), retry: true };
    }
    /* Cancelled while `accept` ran: the dapp has already been told no. */
    if (this.job !== job) return { done: false, error: "this request was cancelled", retry: false };
    this.job = null;
    if (job.tabId !== null) this.tabs.close(job.tabId);
    job.resolve(value);
    return { done: true };
  }

  /** The Cancel button in the tab. */
  cancel(id: string): void {
    const job = this.job;
    if (job === null || job.view.id !== id) return;
    this.end(job, new QrJobError(EIP1193.userRejected, "cancelled in the QR window"));
  }

  /** Any tab closing. Only the job's own tab counts as a refusal. */
  tabClosed(tabId: number): void {
    const job = this.job;
    if (job === null || job.tabId !== tabId) return;
    job.tabId = null;
    this.end(job, new QrJobError(EIP1193.userRejected, "the QR window was closed"));
  }

  /** Whether `id` is the open job, for keepalive pings. */
  isOpen(id: string): boolean {
    return this.job !== null && this.job.view.id === id;
  }

  private end(job: Open, why: QrJobError): void {
    if (this.job !== job) return;
    this.job = null;
    if (job.tabId !== null) this.tabs.close(job.tabId);
    job.reject(why);
  }
}
