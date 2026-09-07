/**
 * The ATS role table.
 *
 * Copied verbatim, mechanically, out of `contracts/constants/roles.sol` in
 * `@hashgraph/asset-tokenization-contracts` 8.0.0 — extracted with awk rather
 * than retyped, because a role id is 32 bytes of hex whose one wrong nibble
 * produces a role that exists nowhere and therefore has no members. "No
 * members" is exactly what an empty role looks like, so the mistake would
 * render as a reassuring blank instead of an error.
 *
 * They are NOT derived. `keccak256("role Cap")` and every other obvious
 * preimage of the `@custom:hash role Cap` annotation gives a different value,
 * so whatever the Studio's generator hashes is not reconstructible from the
 * source. Deriving them from a guessed preimage would be worse than copying
 * them: it would look principled and be wrong.
 *
 * `DEFAULT_ADMIN_ROLE` is `0x00` in the Solidity, written out to a full word
 * here because that is what goes on the wire and a short bytes32 is an
 * encoding bug waiting to happen.
 *
 * `privileged` marks the roles whose holder can act on someone else's
 * property: mint into existence, freeze, force a transfer, halt the register,
 * or decide who counts as KYC'd. The read-only dashboard uses it only to order
 * and mark the display — it is the list E3 will require a rendered device
 * screen for, recorded now while the reasoning is in front of us.
 */

export interface RoleInfo {
  /** bytes32, lower-case, always a full 32-byte word. */
  id: string;
  /** The Studio's own short name, from the `@custom:hash role X` annotation. */
  name: string;
  /** The Solidity constant, so a reader can find this in the contracts. */
  constant: string;
  /** Can this role act on a holder's property without their consent? */
  privileged: boolean;
}

/** Every role the contracts define, in the order the Solidity declares them. */
export const ROLES: readonly RoleInfo[] = [
  { id: "0x0000000000000000000000000000000000000000000000000000000000000000", name: "DefaultAdmin", constant: "DEFAULT_ADMIN_ROLE", privileged: true },
  { id: "0xb246506a8ded65dd6360e8ce033fd9462936d1be64fb9f85c5f60d28cd3ca6da", name: "AdjustmentBalance", constant: "ROLE_ADJUSTMENT_BALANCE", privileged: true },
  { id: "0x9830aa071a741c08855dd42130bdb0ff50f7bdf5a4b72f12181eefded0c6542b", name: "Agent", constant: "ROLE_AGENT", privileged: true },
  { id: "0x0c8c9cf3db23765397bf525e10c9158fd2a7b58b280d5da82a642247779ae3c1", name: "Amortization", constant: "ROLE_AMORTIZATION", privileged: false },
  { id: "0xc20b7fd7efe1a2c9f69003a21c2c55c79ef84e16252b62599246ff01f6207314", name: "MaturityManager", constant: "ROLE_MATURITY_MANAGER", privileged: false },
  { id: "0x58d502b7184e1a264e0cacf1a19a6c268356c6d9fda5ad83ab3b599cd3b7f41c", name: "Cap", constant: "ROLE_CAP", privileged: true },
  { id: "0xd0fe259e861ec493f60fb83851f1a173155b0f2acc3da153de2a23fb0ad26db6", name: "Clearing", constant: "ROLE_CLEARING", privileged: false },
  { id: "0xa24ef577c383d98a9326f932c69c76129dd89a71abcb626993d9f047f4e74abb", name: "ClearingValidator", constant: "ROLE_CLEARING_VALIDATOR", privileged: false },
  { id: "0xb4d2b850c3ed8a234d390d5c157bbb1824883213c335ffe2a0f0761bb168713e", name: "Controller", constant: "ROLE_CONTROLLER", privileged: true },
  { id: "0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d", name: "ControlList", constant: "ROLE_CONTROL_LIST", privileged: true },
  { id: "0xccf29bda8369877bcc921e38f30df86156a571ca5c5b8e777bf7ff75270313ea", name: "ControlListManager", constant: "ROLE_CONTROL_LIST_MANAGER", privileged: true },
  { id: "0xa1acfc499025c99f55059195e6276f639d34a18aad7b8121b9192b7f438c55cd", name: "CorporateAction", constant: "ROLE_CORPORATE_ACTION", privileged: true },
  { id: "0x34c18461eba17dd4b2a410f90e80f2a3d6e466af7753bf1b9519c24697c199f5", name: "CorporateActionForceCancel", constant: "ROLE_CORPORATE_ACTION_FORCE_CANCEL", privileged: false },
  { id: "0x31e3e0f7cd6b1bdc19162dd52d4ce1ed67de0aff8f89b768dcbfad8776b2ae4d", name: "Deactivate", constant: "ROLE_DEACTIVATE", privileged: true },
  { id: "0xb7b1452b94e2932605f7ad2a3ceba0bafd68db64704c9bd667f27163c57ca319", name: "Documenter", constant: "ROLE_DOCUMENTER", privileged: false },
  { id: "0x71ae38482e1ab1c28e767d64766d686215b490c8c1bd7dfe6b101525187c2155", name: "FreezeManager", constant: "ROLE_FREEZE_MANAGER", privileged: true },
  { id: "0xfa80c71f8de1628faf2c0e9bd02c2f4a3da1f16823b75e61e84b90164a07b4a4", name: "InterestRateManager", constant: "ROLE_INTEREST_RATE_MANAGER", privileged: false },
  { id: "0xdd78fdcd1b38a5360405cef8d91e758ad0f42bf2ced681b803b3c2704b0a32a7", name: "InternalKycManager", constant: "ROLE_INTERNAL_KYC_MANAGER", privileged: true },
  { id: "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f", name: "Issuer", constant: "ROLE_ISSUER", privileged: true },
  { id: "0x7895574f0552ac1a42245f5d7ea23bea04d0cfbc73df53282d588fdaa00f7fb3", name: "KpiManager", constant: "ROLE_KPI_MANAGER", privileged: false },
  { id: "0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc", name: "Kyc", constant: "ROLE_KYC", privileged: true },
  { id: "0xec811504e835acf29535b5b62307b08000468f0c61ca6163ed6f17a03629b91e", name: "KycManager", constant: "ROLE_KYC_MANAGER", privileged: true },
  { id: "0xcfd49258c7f1641d56add8e8efadca919969eb6aab447ec47f2ed34c8492547a", name: "LoanManager", constant: "ROLE_LOAN_MANAGER", privileged: false },
  { id: "0x90f7adc9b7132ce9c095619ba3e77e8505f2824b906ee99892386b8349a016c6", name: "LoansPortfolioManager", constant: "ROLE_LOANS_PORTFOLIO_MANAGER", privileged: false },
  { id: "0xd327cd9a2be405896f3d4584b3b437d798833cc4aa0aafb34c870659c0d47184", name: "Locker", constant: "ROLE_LOCKER", privileged: true },
  { id: "0x433f48f8aca23480f6ab07666cbc9131d32a0b4672033453f65e18f4dd390523", name: "MaturityRedeemer", constant: "ROLE_MATURITY_REDEEMER", privileged: false },
  { id: "0x0b348f171b6004b74a59b08b77c142a65c416e0e20c855602b8b2510951101b0", name: "CustomDataManager", constant: "ROLE_CUSTOM_DATA_MANAGER", privileged: false },
  { id: "0xebf9ab6852aef7bc1e4068a64bd360845c54d5d95d4fed9fd47c52bbe7c15b8b", name: "NominalValue", constant: "ROLE_NOMINAL_VALUE", privileged: false },
  { id: "0x03e7c996eea5565d823330975718325a2eccfaf55d5ec99de9a1d9d7253c318e", name: "PauseManager", constant: "ROLE_PAUSE_MANAGER", privileged: true },
  { id: "0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f", name: "Pauser", constant: "ROLE_PAUSER", privileged: true },
  { id: "0x29baa8e752c40494481d6b4caa718d054ad999653716d39b1aa896387c68ae78", name: "ProceedRecipientManager", constant: "ROLE_PROCEED_RECIPIENT_MANAGER", privileged: false },
  { id: "0x2d40a5b0ae1bfaa74e8787cae4b47373670a5b71b3e6031c4d849ed22e376bfd", name: "ProtectedPartitions", constant: "ROLE_PROTECTED_PARTITIONS", privileged: true },
  { id: "0xda17771b6b3d06197fabbe8db1d7586004df4869992b9c7c7fccec5f36dcf604", name: "ProtectedPartitionsParticipant", constant: "ROLE_PROTECTED_PARTITIONS_PARTICIPANT", privileged: false },
  { id: "0xf7d999723d2160432933a2aeffaae83e262a5a46fe94f34614a7676d1d1f67c6", name: "Snapshot", constant: "ROLE_SNAPSHOT", privileged: true },
  { id: "0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1", name: "SsiManager", constant: "ROLE_SSI_MANAGER", privileged: false },
  { id: "0xd9e1264632ee9a37e8673a0c55a0a1d8b38c758e843084168ee08cd2d1f7e6f0", name: "TrexOwner", constant: "ROLE_TREX_OWNER", privileged: true },
  { id: "0x309337df95ff8f6d0075117d46b40fd103d8ae87db1914f1c60acb63487fb157", name: "WildCard", constant: "ROLE_WILD_CARD", privileged: true },
];

/** By id, for turning a role a contract reported back into a name. */
const BY_ID = new Map(ROLES.map((r) => [r.id.toLowerCase(), r]));

/**
 * A role id's entry, or undefined.
 *
 * Undefined on purpose rather than a synthesised "Unknown role" object: an id
 * this table does not know is shown as its raw hex, the same rule chains.ts
 * applies to an unrecognised chain. A confident wrong name is worse than a
 * number.
 */
export function roleInfo(id: string): RoleInfo | undefined {
  return BY_ID.get(id.toLowerCase());
}

/** What to put on screen for a role id: its name, or the id itself. */
export function roleLabel(id: string): string {
  const info = roleInfo(id);
  return info ? info.name : `${id.slice(0, 10)}…${id.slice(-6)}`;
}
