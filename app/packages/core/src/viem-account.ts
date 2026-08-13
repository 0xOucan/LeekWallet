/**
 * viem account backed by a LeekWallet.
 *
 * `toAccount()` is the seam this whole design was pointed at: supply three
 * signing functions and the result drops into any viem `walletClient`, and by
 * extension into wagmi, RainbowKit and the dapps built on them — none of which
 * need to know a hardware wallet is involved.
 *
 * The account is deliberately thin. It translates between viem's shapes and the
 * protocol, and does nothing else. In particular it never decides what is safe
 * to sign: the device renders the transaction it computed and the user presses
 * a button, and no amount of validation here would substitute for that.
 */

import { type Address, type Hash, type Hex } from "viem";
import { toAccount } from "viem/accounts";

/**
 * A signature as the device reports it: two 32-byte halves and a parity bit.
 *
 * `yParity` is 0 or 1. It is never the legacy 27/28 form, and must not be
 * derived from one by masking the low bit — that inverts it (27 becomes 1,
 * 28 becomes 0) and the signature then recovers to an address nobody owns,
 * which the network reports as a funding problem rather than a signing one.
 */
export interface DeviceSignature {
  /** `0x`-prefixed, 32 bytes. */
  r: Hex;
  /** `0x`-prefixed, 32 bytes. */
  s: Hex;
  yParity: number;
}

/** What this adapter needs from a connected device. */
export interface SigningDevice {
  getAddress(index: number): Promise<Address>;
  signTransaction(request: Record<string, unknown>): Promise<DeviceSignature>;
  signMessage(message: string | { raw: Hex }): Promise<Hex>;
  signTypedData(typedData: Record<string, unknown>): Promise<Hex>;
}

export interface LeekAccountOptions {
  /** Address index within the active wallet — `m/44'/60'/0'/0/<index>`. */
  index?: number;
}

/**
 * Build a viem account for one address of a connected device.
 *
 * The address is fetched up front because viem requires it synchronously
 * afterwards, which means this account is bound to the device state at the
 * moment it was created. If the device locks, switches wallet, or has a
 * passphrase applied, **this object is stale and must be discarded** — the
 * address it holds may no longer be derivable. See device-state.ts.
 */
export async function createLeekAccount(
  device: SigningDevice,
  options: LeekAccountOptions = {},
) {
  const index = options.index ?? 0;
  const address = await device.getAddress(index);

  return toAccount({
    address,

    async signMessage({ message }) {
      // viem hands either a string or { raw }. The device is told which,
      // because a string is prefixed per EIP-191 and raw bytes are not, and
      // guessing would sign the wrong digest.
      return device.signMessage(
        typeof message === "string" ? message : { raw: message.raw as Hex },
      );
    },

    async signTransaction(transaction) {
      /* Structured fields, never a serialised blob. The device re-serialises
       * and re-hashes these itself and signs only what it rendered — see
       * docs/PROTOCOL.md section 1. Handing it a pre-built payload would make
       * the host the authority on what is being signed, which is the thing
       * this device exists to avoid. */
      const sig = await device.signTransaction({
        index,
        chainId: transaction.chainId,
        nonce: transaction.nonce,
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
        gas: transaction.gas,
        maxFeePerGas: transaction.maxFeePerGas,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
        gasPrice: transaction.gasPrice,
      });

      return assembleSignature(sig);
    },

    async signTypedData(typedData) {
      return device.signTypedData({ index, ...(typedData as Record<string, unknown>) });
    },
  });
}

/**
 * `r ‖ s ‖ yParity` — the 65-byte compact form, from the device's three fields.
 *
 * Assembled here rather than on the device: the signature covers the digest the
 * device computed from its own parse, so the concatenation either matches or
 * the network rejects it — no authority moves to the host by doing the
 * bookkeeping on this side.
 *
 * The parity byte is written as 0 or 1, exactly as received. Anything else is
 * an error rather than something to normalise: a 27 arriving here means the
 * device (or something in between) is speaking the legacy convention, and
 * guessing which one would be how a wrong-key signature gets shipped.
 */
export function assembleSignature(sig: DeviceSignature): Hex {
  const half = (value: Hex, name: string): string => {
    const body = value.startsWith("0x") ? value.slice(2) : value;
    if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) {
      throw new Error(`device returned a ${name} that is not 32 bytes: ${value}`);
    }
    return body.toLowerCase();
  };

  if (sig.yParity !== 0 && sig.yParity !== 1) {
    throw new Error(
      `device returned yParity ${String(sig.yParity)}, expected 0 or 1 ` +
      "(27/28 is the legacy v and must not be masked down)",
    );
  }

  return `0x${half(sig.r, "r")}${half(sig.s, "s")}0${sig.yParity}` as Hex;
}

/**
 * Reasons an account must be thrown away.
 *
 * Exported so callers have something to check against rather than inventing
 * their own rule and getting it subtly wrong.
 */
export const ACCOUNT_INVALIDATED_BY = [
  "device locked",
  "wallet switched",
  "passphrase applied or cleared",
  "device disconnected",
] as const;

export type Hash_ = Hash;
