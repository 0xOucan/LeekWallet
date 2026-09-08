/**
 * The privileged half of the console, as DOM.
 *
 * ---------------------------------------------------------------------------
 * Preview, then press
 *
 * Two steps, always, and the second is disabled until the first has produced a
 * screen. The reason is not caution for its own sake: the consequence line is
 * the whole contribution of this app, and a single "do it" button would spend
 * the press to find out what the press was for. So the form renders the screen
 * the device is about to draw — title, fields, effect — and only then offers to
 * ask for it.
 *
 * The preview is host text and says so. It is `describePrivilegedCall`'s
 * rendering, unsigned, from descriptors this build happens to carry; the device
 * draws its own from the same calldata and the device's is the one that counts.
 * That distinction is `DESCRIPTOR_NOTICE`'s and it is repeated here because a
 * screen that looks this much like the device's screen is exactly the place
 * somebody stops distinguishing them.
 *
 * ---------------------------------------------------------------------------
 * Why the form is rebuilt per action rather than hidden per action
 *
 * A `lock` needs an amount and an expiry, a `pause` needs nothing. Keeping
 * every input in the DOM and hiding the irrelevant ones leaves a value behind:
 * the amount typed for a lock is still there when the action becomes a mint,
 * and it is not visible. Rebuilding drops it.
 */

import { formatUnits } from "@leekwallet/core/chains.ts";
import { DESCRIPTOR_NOTICE } from "@leekwallet/core/erc7730.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { proposePrivileged, previewPrivileged, type PrivilegedIntent } from "./act.ts";
import { REFUSAL_NOTICE, type PrivilegedScreen, type SecurityFacts } from "./action.ts";
import { ROLES } from "./roles.ts";
import type { RegisterView } from "./register.ts";

/**
 * The facts a screen may use, taken from the register read and nowhere else.
 *
 * `name`, `decimals` and the control-list direction are properties of the
 * contract. Reading them off the form would let the screen describe a security
 * other than the one about to change — and the control-list direction in
 * particular inverts the meaning of the sentence, so a wrong one is not a
 * cosmetic error. An outcome that is not `ok` becomes `undefined` here, which
 * action.ts treats as "we have not read it" and refuses on where it matters.
 */
export function factsFrom(view: RegisterView): SecurityFacts {
  return {
    chainId: view.chainId,
    address: view.address,
    ...(view.name.state === "ok" && view.name.value !== undefined
      ? { name: view.name.value } : {}),
    ...(view.decimals.state === "ok" ? { decimals: view.decimals.value } : {}),
    ...(view.controlList.state === "ok"
      ? { controlListType: view.controlList.value.whitelist } : {}),
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The screen as DOM, in the plan's shape: title, fields, then the effect. */
export function screenElement(screen: PrivilegedScreen): HTMLElement {
  const box = el("div", "ats-screen");
  box.appendChild(el("div", "ats-screen-title", screen.title));
  for (const f of screen.fields) {
    const line = el("div", "ats-row");
    line.appendChild(el("span", "ats-label", f.label));
    line.appendChild(el("span", undefined, f.value));
    box.appendChild(line);
  }
  const effect = el("div", "ats-row");
  effect.appendChild(el("span", "ats-label", "Effect"));
  effect.appendChild(el("span", "ats-alarm", screen.effect));
  box.appendChild(effect);

  const provenance = el("p", "ats-muted",
    `${screen.signature} · ${screen.selector} · signature from ${screen.source}`);
  box.appendChild(provenance);
  // The preview is the host's reading. The device draws its own.
  box.appendChild(el("p", "ats-muted", DESCRIPTOR_NOTICE));
  return box;
}

/** Which inputs an action needs. One place, so the form and the intent agree. */
const NEEDS: Readonly<Record<string, readonly string[]>> = {
  grantRole: ["role", "account"],
  revokeRole: ["role", "account"],
  revokeKyc: ["account"],
  pause: [],
  unpause: [],
  freezePartialTokens: ["account", "amount"],
  unfreezePartialTokens: ["account", "amount"],
  setAddressFrozen: ["account", "frozen"],
  lock: ["account", "amount", "until"],
  setMaxSupply: ["cap"],
  mint: ["account", "amount"],
  addToControlList: ["account"],
  removeFromControlList: ["account"],
};

/** Human labels for the inputs. */
const LABEL: Readonly<Record<string, string>> = {
  role: "Role",
  account: "Address",
  amount: "Amount (raw units)",
  until: "Locked until (unix seconds)",
  cap: "New cap (raw units)",
  frozen: "Set to",
};

interface Fields {
  role?: HTMLSelectElement;
  frozen?: HTMLSelectElement;
  account?: HTMLInputElement;
  amount?: HTMLInputElement;
  until?: HTMLInputElement;
  cap?: HTMLInputElement;
}

/**
 * An intent from the form, or a sentence saying which field is wrong.
 *
 * Returns the complaint rather than throwing, and returns it for the FIRST bad
 * field only: a form that reports four problems at once is a form people stop
 * reading. Every numeric field is parsed with `BigInt`, which rejects a decimal
 * point outright — silently truncating "1.5" to 1 on a share count is the kind
 * of helpfulness that costs somebody half a share.
 */
export function intentFrom(action: string, f: Fields): PrivilegedIntent | string {
  const address = (input?: HTMLInputElement): string | undefined => {
    const v = (input?.value ?? "").trim();
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : undefined;
  };
  const uint = (input?: HTMLInputElement): bigint | undefined => {
    const v = (input?.value ?? "").trim();
    if (!/^\d+$/.test(v)) return undefined;
    return BigInt(v);
  };

  const need = NEEDS[action];
  if (need === undefined) return `${action} is not an action this console offers`;
  for (const key of need) {
    if (key === "role") {
      if (!/^0x[0-9a-f]{64}$/.test(f.role?.value ?? "")) return "Choose a role.";
    } else if (key === "account") {
      if (address(f.account) === undefined) return "That is not a 20-byte address.";
    } else if (key === "frozen") {
      if (f.frozen?.value !== "0" && f.frozen?.value !== "1") return "Choose frozen or not frozen.";
    } else if (key === "amount" && uint(f.amount) === undefined) {
      return "The amount must be a whole number of raw units.";
    } else if (key === "until" && uint(f.until) === undefined) {
      return "The expiry must be a unix timestamp in whole seconds.";
    } else if (key === "cap" && uint(f.cap) === undefined) {
      return "The cap must be a whole number of raw units.";
    }
  }

  const account = address(f.account) as string;
  switch (action) {
    case "grantRole": return { action: "grantRole", role: f.role?.value as string, account };
    case "revokeRole": return { action: "revokeRole", role: f.role?.value as string, account };
    case "revokeKyc": return { action: "revokeKyc", account };
    case "pause": return { action: "pause" };
    case "unpause": return { action: "unpause" };
    case "freezePartialTokens":
      return { action: "freezePartialTokens", account, amount: uint(f.amount) as bigint };
    case "unfreezePartialTokens":
      return { action: "unfreezePartialTokens", account, amount: uint(f.amount) as bigint };
    case "setAddressFrozen":
      return { action: "setAddressFrozen", account, frozen: f.frozen?.value === "1" };
    case "lock":
      return { action: "lock", account, amount: uint(f.amount) as bigint, until: uint(f.until) as bigint };
    case "setMaxSupply": return { action: "setMaxSupply", cap: uint(f.cap) as bigint };
    case "mint": return { action: "mint", to: account, amount: uint(f.amount) as bigint };
    case "addToControlList": return { action: "addToControlList", account };
    case "removeFromControlList": return { action: "removeFromControlList", account };
    default: return `${action} is not an action this console offers`;
  }
}

/**
 * Append the privileged controls under a register that has been read.
 *
 * `view` is required rather than optional: an action is proposed against facts
 * from a read, so there is nothing to render before one has happened.
 */
export function renderPrivilegedPanel(
  root: HTMLElement, view: RegisterView, context: AppContext,
): void {
  const section = el("section", "ats-panel");
  section.appendChild(el("h4", undefined, "Privileged actions"));

  if (!context.propose) {
    /* Not a disabled button. A control that looks like it might work, on a
     * build that cannot sign anything, is a worse answer than a sentence. */
    section.appendChild(el("p", "ats-notice",
      "No device is connected, so this console can read the register but " +
      "cannot ask for a signature. Every action below needs a physical press."));
    root.appendChild(section);
    return;
  }

  section.appendChild(el("p", "ats-muted",
    "Each of these is irreversible and affects someone other than you. The " +
    "device draws the consequence and waits for a press; this console cannot " +
    "sign anything on its own."));

  const facts = factsFrom(view);
  const form = el("div", "ats-panel");
  const chooser = el("div", "ats-row");
  chooser.appendChild(el("span", "ats-label", "Action"));
  const select = el("select");
  for (const name of Object.keys(NEEDS)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  chooser.appendChild(select);
  const inputs = el("div", "ats-panel");
  const out = el("div", "ats-panel");
  const buttons = el("div", "ats-row");
  const preview = el("button", undefined, "Preview the screen");
  const approve = el("button", undefined, "Approve on device");
  approve.disabled = true;
  buttons.append(preview, approve);
  form.append(chooser, inputs, buttons, out);
  section.appendChild(form);
  root.appendChild(section);

  let fields: Fields = {};
  /* Cleared whenever anything the preview depended on changes, so the approve
   * button can never carry an intent from a form that has since been edited. */
  let approved: PrivilegedIntent | undefined;

  const invalidate = (): void => {
    approved = undefined;
    approve.disabled = true;
  };

  const buildInputs = (): void => {
    inputs.replaceChildren();
    out.replaceChildren();
    invalidate();
    fields = {};
    const action = select.value;
    for (const key of NEEDS[action] ?? []) {
      const line = el("div", "ats-row");
      line.appendChild(el("span", "ats-label", LABEL[key] ?? key));
      if (key === "frozen") {
        const frozenSelect = el("select");
        for (const [value, label] of [["1", "frozen"], ["0", "not frozen"]] as const) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          frozenSelect.appendChild(opt);
        }
        frozenSelect.addEventListener("change", invalidate);
        fields.frozen = frozenSelect;
        line.appendChild(frozenSelect);
      } else if (key === "role") {
        const roleSelect = el("select");
        for (const r of ROLES) {
          const opt = document.createElement("option");
          opt.value = r.id;
          opt.textContent = r.privileged ? `${r.name} (privileged)` : r.name;
          roleSelect.appendChild(opt);
        }
        roleSelect.addEventListener("change", invalidate);
        fields.role = roleSelect;
        line.appendChild(roleSelect);
      } else {
        const input = el("input");
        input.type = "text";
        input.setAttribute("aria-label", LABEL[key] ?? key);
        input.addEventListener("input", invalidate);
        (fields as Record<string, HTMLInputElement>)[key] = input;
        line.appendChild(input);
        if ((key === "amount" || key === "cap") && view.decimals.state === "ok") {
          const hint = el("span", "ats-muted");
          const decimals = view.decimals.value;
          const restate = (): void => {
            hint.textContent = /^\d+$/.test(input.value.trim())
              ? `= ${formatUnits(BigInt(input.value.trim()), decimals)} shares`
              : "";
          };
          input.addEventListener("input", restate);
          line.appendChild(hint);
        }
      }
      inputs.appendChild(line);
    }
  };

  select.addEventListener("change", buildInputs);

  preview.addEventListener("click", () => {
    out.replaceChildren();
    invalidate();
    const intent = intentFrom(select.value, fields);
    if (typeof intent === "string") {
      out.appendChild(el("p", "ats-notice", intent));
      return;
    }
    const rendering = previewPrivileged(facts, intent);
    if (rendering.state === "refused") {
      /* The plan's §3 rule, on screen. Loud, and with no retry offered: the
       * refusal is a property of the call, not of the moment. */
      out.appendChild(el("p", "ats-notice", `Refused: ${rendering.why}`));
      out.appendChild(el("p", "ats-muted", REFUSAL_NOTICE));
      return;
    }
    out.appendChild(screenElement(rendering));
    approved = intent;
    approve.disabled = false;
  });

  approve.addEventListener("click", () => {
    const intent = approved;
    if (intent === undefined) return;
    /* One press per preview. Disabled before the await so a double click cannot
     * put the same irreversible action on the device twice. */
    invalidate();
    preview.disabled = true;
    void proposePrivileged(context, facts, intent)
      .then((outcome) => {
        out.replaceChildren();
        switch (outcome.kind) {
          case "sent":
            out.appendChild(el("p", "ats-notice",
              `Signed and sent. Transaction ${outcome.result}. The register above ` +
              "is now out of date — read it again before acting on it."));
            break;
          case "refused":
            out.appendChild(el("p", "ats-notice", `Refused: ${outcome.why}`));
            out.appendChild(el("p", "ats-muted", outcome.notice));
            break;
          case "declined":
            out.appendChild(el("p", "ats-notice", outcome.notice));
            break;
          case "cannot-ask":
            out.appendChild(el("p", "ats-notice", outcome.notice));
            break;
        }
      })
      .finally(() => { preview.disabled = false; });
  });

  buildInputs();
}
