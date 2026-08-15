// Scratch: print viem's digests for the shared vectors so they can be pasted
// into eip712-vectors.ts and sim/test_eip712.c. Not part of the suite.
import { hashTypedData, hashDomain, hashStruct } from "viem";
import { VECTORS } from "./eip712-vectors.ts";

for (const v of VECTORS) {
  console.log(v.name);
  console.log("  domainSep :", hashDomain({ domain: v.domain, types: v.types }));
  console.log("  structHash:", hashStruct({ data: v.message, primaryType: v.primaryType, types: v.types }));
  console.log("  digest    :", hashTypedData(v));
}
