/**
 * ERC-7730 descriptors for the ATS privileged surface (plan §3, milestone E3).
 *
 * ---------------------------------------------------------------------------
 * Why these live in the app and Circle's live in core
 *
 * `erc7730-circle.ts` describes ERC-20 transfers, which any preview of any
 * transaction wants whether or not a point-of-sale app is compiled in. These
 * describe a Hashgraph Asset Tokenization Studio security and nothing else: no
 * screen outside this console has a use for "grant the Cap role". So they come
 * out with `rm -rf app/packages/apps/ats`, and the three-deletion removal
 * procedure in index.ts is unchanged — no new registry line, no new dependency.
 *
 * ---------------------------------------------------------------------------
 * Why a factory rather than a constant
 *
 * USDC has a canonical address per chain, so a descriptor can name it. An ATS
 * security does not: every issuance is a fresh diamond at a fresh address, and
 * what is stable is the *shape* of the contract, not where it lives. So the
 * caller supplies the address, and by supplying it asserts that the address is
 * an ATS security. `describePrivilegedCall` in action.ts makes that assertion
 * structural — it takes the facts a successful register read produces, so a
 * screen cannot be built for an address this console has never read.
 *
 * ---------------------------------------------------------------------------
 * Where the signatures came from, and what that is worth
 *
 * Every key below is now copied from the compiled ABI of
 * `@hashgraph/asset-tokenization-contracts` 8.0.0 — the contracts package the
 * Studio's own SDK depends on at that exact version — including the parameter
 * names, so a reviewer can diff a key against the artifact and see the same
 * string. `test/conformance.test.ts` re-extracts them from the installed
 * package and fails if any key here is not a function those contracts declare.
 * That test is the SDK doing the work: nothing in this file is a guess about
 * an argument list any more.
 *
 * An earlier version of this file WAS a guess, and the artifacts caught two
 * mistakes that are worth recording because both were invisible:
 *
 *  - `lock` was written `lock(address, uint256, uint256)`. The contracts
 *    declare `lock(uint256 _amount, address _tokenHolder, uint256
 *    _expirationTimestamp)` — amount FIRST. The wrong order hashes to a
 *    selector no ATS contract has, so the descriptor would never have fired
 *    and every lock would have refused, for a reason nobody could have found.
 *  - `grantKyc(address)` matched only `MockedExternalKycList`. The real
 *    `IKyc.grantKyc` takes five arguments including a `string`, which is why
 *    it is in UNRENDERABLE below rather than here.
 *
 * The failure mode of a wrong signature is why that was survivable rather than
 * fatal: a selector is derived from the signature by keccak, so a wrong
 * signature produces a selector that matches nothing, the descriptor never
 * fires, and `describePrivilegedCall` refuses. A wrong signature costs a
 * working screen. It cannot produce a wrong one — unless it collides with
 * another real function, which is the one thing to check before mainnet.
 *
 * What is still NOT verified: nothing here has been matched against calldata
 * from a deployed ATS security, because no testnet HBAR was available to
 * deploy one. The signatures are right; whether a given diamond has the facet
 * installed is a question only a live read answers.
 *
 * ---------------------------------------------------------------------------
 * Why the consequence text is not in the descriptor's `intent`
 *
 * ERC-7730 gives one `intent` string per format, and the plan's screen needs
 * two different things: what is being called ("Grant role") and what it does
 * to third parties ("can issue new shares to any address"). For `grantRole`
 * the second depends on an *argument*, so it cannot be a per-format constant
 * at all. The role table below carries it, keyed the same way `roles.ts` keys
 * everything, and action.ts composes the line.
 *
 * The effect wording is OURS. It was written from the role names and the
 * module list in docs/apps/HEDERA-ATS.md — not extracted from contract code —
 * and it is the part of this file most worth a second reader, because an
 * effect line that is wrong is exactly the manufactured confidence the plan
 * warns about. It is unsigned host data like every other label here, and the
 * device never sees it.
 */

import {
  parseDescriptor, parseSignature, selectorOf, type Descriptor,
} from "@leekwallet/core/erc7730.ts";
import { ROLES } from "./roles.ts";

export const ATS_DESCRIPTOR_SOURCE = "local/hedera-ats-privileged";

/**
 * How much the signature is to be trusted, per entry.
 *
 * Carried per format rather than stated once in this header, for the same
 * reason `Descriptor.source` is carried per descriptor: a reviewer should not
 * have to know which paragraph applies to which line.
 */
export type SignatureConfidence =
  /**
   * Name and argument list both re-extracted from the compiled ABI of
   * `@hashgraph/asset-tokenization-contracts` 8.0.0 by `conformance.test.ts`.
   *
   * The only remaining variant. The three it replaced — "standard",
   * "sdk-named" and "inferred" — were degrees of guessing, and keeping a
   * spectrum of confidence around after the authority was installed would
   * invite a new entry to be added at the bottom of it. An action either
   * matches the artifacts or it does not belong in ACTIONS.
   *
   * It is deliberately NOT called "verified": the signature is verified, the
   * *consequence wording* beside it is ours and is verified by nobody.
   */
  "artifact";

/* --------------------------------------------------------- role consequences */

/**
 * What a role's holder can do, as a verb phrase.
 *
 * A phrase rather than a sentence so that granting and revoking compose from
 * the same string: "can issue new shares" / "can no longer issue new shares".
 * Two independently written sentences drift, and a revoke screen that
 * described a different power than the matching grant screen would be worse
 * than either alone.
 *
 * Keyed by `RoleInfo.name`. Every role in `ROLES` must appear — a role with no
 * phrase has no consequence line, and an action with no consequence line
 * refuses. `descriptors.test.ts` asserts the table is complete, so adding a
 * role to `roles.ts` without deciding what it does breaks a test rather than
 * quietly disabling a screen.
 */
export const ROLE_POWER: Readonly<Record<string, string>> = {
  DefaultAdmin: "grant and revoke every other role, including this one",
  AdjustmentBalance: "rescale every holder's balance",
  Agent: "act on holders' behalf across the register",
  Amortization: "set the amortization schedule",
  MaturityManager: "change the maturity date",
  Cap: "raise or lower the maximum supply",
  Clearing: "operate the clearing queue",
  ClearingValidator: "approve or reject clearing operations",
  Controller: "force transfers out of any holder's balance",
  ControlList: "add and remove addresses from the control list",
  ControlListManager: "grant and revoke the control-list role",
  CorporateAction: "declare corporate actions",
  CorporateActionForceCancel: "cancel a declared corporate action",
  Deactivate: "permanently deactivate this security",
  Documenter: "attach and remove register documents",
  FreezeManager: "freeze and unfreeze any holder's balance",
  InterestRateManager: "change the coupon interest rate",
  InternalKycManager: "grant and revoke the internal KYC roles",
  Issuer: "issue new shares to any address, diluting every holder",
  KpiManager: "set KPI values",
  Kyc: "grant and revoke holders' KYC status",
  KycManager: "grant and revoke the KYC role",
  LoanManager: "manage loan terms",
  LoansPortfolioManager: "manage the loan portfolio",
  Locker: "lock any holder's balance",
  MaturityRedeemer: "redeem holdings at maturity",
  CustomDataManager: "set custom register data",
  NominalValue: "change the nominal value",
  PauseManager: "grant and revoke the pauser role",
  Pauser: "halt and resume all transfers",
  ProceedRecipientManager: "change where proceeds are paid",
  ProtectedPartitions: "enable and disable protected partitions",
  ProtectedPartitionsParticipant: "move tokens in protected partitions",
  Snapshot: "take register snapshots",
  SsiManager: "manage self-sovereign identity settings",
  TrexOwner: "exercise owner authority over the T-REX suite",
  WildCard: "bypass transfer restrictions",
};

/**
 * `roleId (decimal) → name`, for the descriptor's `enum` format.
 *
 * Decimal because the engine reads an enum field as a uint and looks the
 * decimal up; the ids stay written once, in `roles.ts`, and are converted
 * here rather than retyped in a second notation. A retyped 32-byte constant
 * is the mistake `roles.ts` exists to avoid.
 */
const ROLE_ENUM: Readonly<Record<string, string>> = Object.fromEntries(
  ROLES.map((r) => [BigInt(r.id).toString(), r.name]),
);

/* ------------------------------------------------------------ the surface */

export interface ActionSpec {
  /** ERC-7730 format key: canonical signature with parameter names. */
  key: string;
  /** Screen title, before the security's name. Upper case is the renderer's. */
  title: string;
  /** ERC-7730 `intent`. */
  intent: string;
  confidence: SignatureConfidence;
  fields: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Every privileged call this console is willing to render.
 *
 * Deliberately not "every privileged call the contracts have". A call absent
 * from this list has no descriptor and therefore refuses, which is the correct
 * default: the list grows when somebody decides what a screen should say, not
 * when a facet is discovered.
 *
 * Two omissions worth naming rather than leaving as gaps:
 *
 *  - `issueByPartition(bytes32,address,uint256,bytes)` — the ERC-1400 issuance
 *    path — takes `bytes`, and the engine drops any signature with a dynamic
 *    argument rather than following offsets it might misread. It therefore
 *    cannot be rendered here and must refuse. `mint(address,uint256)` below
 *    covers the simple path only.
 *  - Batch/`applyRoles` variants take arrays, for the same reason.
 */
export const ACTIONS: readonly ActionSpec[] = [
  {
    key: "grantRole(bytes32 _role, address _account)",
    title: "Grant role",
    intent: "Grant a role",
    confidence: "artifact",
    fields: [
      { label: "Role", path: "#._role", format: "enum", params: { $ref: "$.metadata.enums.roles" } },
      { label: "To", path: "#._account", format: "addressName" },
    ],
  },
  {
    key: "revokeRole(bytes32 _role, address _account)",
    title: "Revoke role",
    intent: "Revoke a role",
    confidence: "artifact",
    fields: [
      { label: "Role", path: "#._role", format: "enum", params: { $ref: "$.metadata.enums.roles" } },
      { label: "From", path: "#._account", format: "addressName" },
    ],
  },
  {
    key: "revokeKyc(address _account)",
    title: "Revoke KYC",
    intent: "Revoke a holder's KYC",
    confidence: "artifact",
    fields: [{ label: "Holder", path: "#._account", format: "addressName" }],
  },
  {
    key: "pause()",
    title: "Pause register",
    intent: "Pause the security",
    confidence: "artifact",
    fields: [],
  },
  {
    key: "unpause()",
    title: "Unpause register",
    intent: "Unpause the security",
    confidence: "artifact",
    fields: [],
  },
  {
    /* Amount first. That is the contracts' order, not a typo — see the header:
     * writing it the readable way round produced a selector no ATS has. */
    key: "lock(uint256 _amount, address _tokenHolder, uint256 _expirationTimestamp)",
    title: "Lock holder balance",
    intent: "Lock part of a holder's balance",
    confidence: "artifact",
    fields: [
      { label: "Holder", path: "#._tokenHolder", format: "addressName" },
      { label: "Amount", path: "#._amount", format: "raw" },
      { label: "Until", path: "#._expirationTimestamp", format: "date", params: { encoding: "timestamp" } },
    ],
  },
  {
    key: "setMaxSupply(uint256 _maxSupply)",
    title: "Set supply cap",
    intent: "Set the maximum supply",
    confidence: "artifact",
    fields: [{ label: "New cap", path: "#._maxSupply", format: "raw" }],
  },
  {
    key: "mint(address _to, uint256 _amount)",
    title: "Mint shares",
    intent: "Issue new shares",
    confidence: "artifact",
    fields: [
      { label: "To", path: "#._to", format: "addressName" },
      { label: "Amount", path: "#._amount", format: "raw" },
    ],
  },
  {
    key: "addToControlList(address _account)",
    title: "Add to control list",
    intent: "Add an address to the control list",
    confidence: "artifact",
    fields: [{ label: "Address", path: "#._account", format: "addressName" }],
  },
  {
    key: "removeFromControlList(address _account)",
    title: "Remove from control list",
    intent: "Remove an address from the control list",
    confidence: "artifact",
    fields: [{ label: "Address", path: "#._account", format: "addressName" }],
  },
];

/**
 * Privileged calls the contracts declare that this console CANNOT render, with
 * the reason, so the refusal is a diagnosis instead of a shrug.
 *
 * Every one of these is here because `erc7730.ts` drops any signature with a
 * dynamic argument rather than following offsets it might misread. That is the
 * correct behaviour and this list is not a workaround for it: nothing below
 * gets a screen, and `describePrivilegedCall` refuses each one exactly as it
 * refuses an unknown selector. The list only changes the SENTENCE — "this call
 * cannot be described, and here is the specific reason" instead of "no
 * descriptor describes this call" — because a user who has just been refused
 * deserves to know whether the fix is to add a descriptor or that no descriptor
 * is possible.
 *
 * `grantKyc` is the one that stings. Granting KYC is exactly the kind of
 * third-party-affecting action this console exists to put on a screen, and the
 * real `IKyc.grantKyc` carries a verifiable-credential id as a `string`. Until
 * either the engine grows checked dynamic decoding or the device draws the call
 * itself, granting KYC from this console is refused. Revoking is not: it is
 * `revokeKyc(address)`, entirely static, and it is the dangerous direction.
 */
export const UNRENDERABLE: ReadonlyArray<{ signature: string; why: string }> = [
  {
    signature: "grantKyc(address,string,uint256,uint256,address)",
    why:
      "granting KYC carries a credential id as a variable-length string, and " +
      "this wallet will not follow calldata offsets it cannot bounds-check",
  },
  {
    signature: "issue(address,uint256,bytes)",
    why: "the ERC-1400 issuance path carries arbitrary `bytes` of issuance data",
  },
  {
    signature: "issueByPartition((bytes32,address,uint256,bytes))",
    why: "issuance by partition takes a struct containing arbitrary `bytes`",
  },
  {
    signature: "applyRoles(bytes32[],bool[],address)",
    why: "batch role changes take arrays, whose length this wallet will not trust",
  },
  {
    signature: "controllerTransfer(address,address,uint256,bytes,bytes)",
    why: "a forced transfer carries two `bytes` fields of operator data",
  },
];

/** Selectors of the calls we know about and know we cannot draw. */
export const UNRENDERABLE_BY_SELECTOR: ReadonlyMap<string, string> = new Map(
  UNRENDERABLE.map((u) => [`0x${selectorOf(u.signature)}`, u.why]),
);

/** The function name of a spec, e.g. `grantRole`. */
export const actionName = (spec: ActionSpec): string => spec.key.slice(0, spec.key.indexOf("("));

/**
 * Lookup by selector, derived the same way the descriptor engine derives it.
 *
 * Keyed by selector rather than by name because a name is not unique — two
 * arities of `lock` would collide — and because the selector is what actually
 * arrives in the calldata. Built with the engine's own `parseSignature`, so a
 * key this map cannot resolve is a key the engine also dropped, and that
 * mismatch surfaces as a failing test rather than as a format that silently
 * never matches.
 */
export const ACTION_BY_SELECTOR: ReadonlyMap<string, ActionSpec> = new Map(
  ACTIONS.flatMap((a) => {
    const sig = parseSignature(a.key);
    return sig === null ? [] : ([[`0x${selectorOf(sig.canonical)}`, a]] as Array<[string, ActionSpec]>);
  }),
);

/* ------------------------------------------------------------- the factory */

/** The raw ERC-7730 document, before parsing. Exported so a test can break it. */
export function atsDescriptorJson(chainId: number, address: string): unknown {
  return {
    context: { contract: { deployments: [{ chainId, address }] } },
    metadata: {
      owner: "Hedera Asset Tokenization Studio security",
      contractName: "ATS security",
      enums: { roles: ROLE_ENUM },
    },
    display: {
      formats: Object.fromEntries(
        ACTIONS.map((a) => [a.key, { intent: a.intent, fields: a.fields }]),
      ),
    },
  };
}

/**
 * The descriptor set for one security.
 *
 * Throws rather than returning null on a parse failure. `parseDescriptor`
 * returning null here would mean this file is malformed — a build-time
 * mistake, not a runtime condition — and a caller that silently got an empty
 * array would produce a console where every privileged call refuses for a
 * reason nobody could find.
 */
export function atsDescriptors(chainId: number, address: string): readonly Descriptor[] {
  const parsed = parseDescriptor(atsDescriptorJson(chainId, address), ATS_DESCRIPTOR_SOURCE);
  if (parsed === null) throw new Error("the ATS descriptor set does not parse");
  return [parsed];
}
