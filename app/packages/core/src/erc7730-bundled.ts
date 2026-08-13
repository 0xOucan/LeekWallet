/**
 * The bundled ERC-7730 descriptor set — verbatim registry files, pinned.
 *
 * ---------------------------------------------------------------------------
 * Why these are bundled and not fetched
 *
 * Fetching a descriptor per transaction is the obvious design and it is the
 * wrong one here, for three reasons in descending order of importance.
 *
 * 1. **It leaks what you are about to sign.** A request for the descriptor of
 *    contract 0xabc… on chain 1, made at the moment the user is deciding
 *    whether to sign, tells whoever serves it exactly that. PROTOCOL.md 6c
 *    names this leak about remote ABI lookups specifically, and a descriptor
 *    lookup is the same request wearing a different name. Downloading the
 *    registry *index* first does not help: the second request is the one that
 *    talks.
 * 2. **It puts a network dependency in front of a preview.** The preview must
 *    render while the user is typing, offline, on a plane. A descriptor that
 *    sometimes arrives produces a summary that sometimes says more, which is
 *    the worst possible teaching for a screen the user is meant to compare
 *    against the device.
 * 3. **It needs a CSP origin, and this app's CSP is a reviewed boundary.** The
 *    chains.ts RPC allowlist is duplicated into tauri.conf.json by hand for
 *    exactly that reason. Adding an origin to fetch decorative text is a poor
 *    trade against adding one to fetch a nonce.
 *
 * So: no origin was added to connect-src for this feature, and none is needed.
 *
 * The cost is honestly a stale set, and a small one. That is the same trade
 * chains.ts makes for chain names and TOKEN_HINTS makes for token symbols, and
 * for the same stated reason: a short list somebody looked at beats a long one
 * you have to trust. It is also what CLEAR-SIGNING.md §6 recommends as the
 * "now" step.
 *
 * ---------------------------------------------------------------------------
 * The documented path to fetching, for whoever picks this up
 *
 * If the set outgrows the bundle, the shape that keeps the properties above is
 * a *build-time* fetch, not a runtime one:
 *
 *   1. A script pulls `index.calldata.json` plus a reviewed subset of
 *      descriptors from the registry at a pinned commit, regenerating this
 *      file. Review is of the generated diff, in the pull request, by a human
 *      — the same gate every other constant in this package goes through.
 *   2. The app ships that. No runtime origin, no leak, no offline gap.
 *
 * A runtime fetch should only ever be reached for behind an explicit, default
 * off setting that states what it discloses, with `https://raw.githubusercontent.com`
 * — that exact origin and no wildcard — added to connect-src at the same time.
 * It has not been built, and this file deliberately exposes no fetch helper
 * that would make it a one-line change to enable.
 *
 * ---------------------------------------------------------------------------
 * Provenance
 *
 * Source: github.com/ethereum/clear-signing-erc7730-registry
 * Commit: 3a397789143cf65dcff105cd074722eac9c75129
 * Files below are copied verbatim — only the `$schema` key, a relative path
 * into the registry repo that means nothing here, was dropped — so a reviewer
 * can diff them against the registry at that commit with
 * `curl .../raw/<commit>/<path>`. Do not hand-edit them: an edited "registry"
 * file is no longer a registry file, and the provenance string would then be
 * a lie. No generator script is committed yet; adding four files by hand at a
 * pinned commit did not justify one, and the reviewable artefact is this file
 * either way.
 *
 * Selection: contracts a user of this app plausibly touches, kept few enough
 * that one person can read the whole set. Two of them (WETH deposit, stETH
 * transfer/approve) overlap the firmware's own decodable set on purpose —
 * that overlap is what exercises the disagreement check in erc7730.ts.
 */

import { parseDescriptor, type Descriptor } from "./erc7730.ts";

/** Registry path → the file's contents, exactly as published. */
const RAW: ReadonlyArray<readonly [string, unknown]> = [
  [
    "registry/weth/calldata-weth.json",
    {
      "context": {
        "$id": "WETH",
        "contract": {
          "deployments": [
            {
              "chainId": 1,
              "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
            },
            {
              "chainId": 11155111,
              "address": "0xfff9976782d46cc05630d1f6ebab18b2324d6b14"
            }
          ]
        }
      },
      "metadata": {
        "owner": "WETH",
        "contractName": "WETH"
      },
      "display": {
        "formats": {
          "deposit()": {
            "intent": "Wrap",
            "fields": [
              {
                "path": "@.value",
                "label": "Amount",
                "format": "amount"
              }
            ]
          }
        }
      }
    },
  ],
  [
    "registry/lido/calldata-stETH.json",
    {
      "context": {
        "$id": "stETH",
        "contract": {
          "deployments": [
            {
              "chainId": 1,
              "address": "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"
            }
          ]
        }
      },
      "metadata": {
        "owner": "Lido DAO",
        "info": {
          "url": "https://lido.fi"
        },
        "constants": {
          "stETHaddress": "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"
        },
        "contractName": "stETH"
      },
      "display": {
        "formats": {
          "approve(address _spender, uint256 _amount)": {
            "intent": "Approve stETH",
            "interpolatedIntent": "Allow to spend {_amount}",
            "fields": [
              {
                "label": "Spender",
                "format": "addressName",
                "params": {
                  "types": [
                    "contract"
                  ],
                  "sources": [
                    "local"
                  ]
                },
                "path": "#._spender",
                "visible": "always"
              },
              {
                "label": "Amount",
                "format": "tokenAmount",
                "path": "#._amount",
                "params": {
                  "token": "$.metadata.constants.stETHaddress",
                  "threshold": "0x8000000000000000000000000000000000000000000000000000000000000000",
                  "message": "Unlimited"
                },
                "visible": "always"
              }
            ]
          },
          "submit(address _referral)": {
            "intent": "Stake ETH",
            "interpolatedIntent": "Stake {@.value}",
            "fields": [
              {
                "label": "Amount",
                "format": "amount",
                "path": "@.value"
              },
              {
                "label": "Referral",
                "path": "#._referral",
                "visible": "never"
              }
            ]
          },
          "transfer(address _recipient, uint256 _amount)": {
            "intent": "Transfer stETH",
            "interpolatedIntent": "Send {_amount} to {_recipient}",
            "fields": [
              {
                "label": "Recipient",
                "format": "addressName",
                "params": {
                  "types": [
                    "eoa",
                    "wallet"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "path": "#._recipient",
                "visible": "always"
              },
              {
                "label": "Amount",
                "format": "tokenAmount",
                "path": "#._amount",
                "params": {
                  "token": "$.metadata.constants.stETHaddress"
                },
                "visible": "always"
              }
            ]
          }
        }
      }
    },
  ],
  [
    "registry/lido/calldata-wstETH.json",
    {
      "context": {
        "$id": "wstETH",
        "contract": {
          "deployments": [
            {
              "chainId": 1,
              "address": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"
            }
          ]
        }
      },
      "metadata": {
        "owner": "Lido DAO",
        "info": {
          "url": "https://lido.fi"
        },
        "constants": {
          "stETHaddress": "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
          "wstETHaddress": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"
        },
        "contractName": "wstETH"
      },
      "display": {
        "formats": {
          "approve(address spender, uint256 amount)": {
            "intent": "Authorize spending",
            "interpolatedIntent": "Allow to spend {amount}",
            "fields": [
              {
                "label": "Spender",
                "format": "addressName",
                "params": {
                  "types": [
                    "contract"
                  ],
                  "sources": [
                    "local"
                  ]
                },
                "path": "#.spender",
                "visible": "always"
              },
              {
                "label": "Amount",
                "format": "tokenAmount",
                "path": "#.amount",
                "params": {
                  "token": "$.metadata.constants.wstETHaddress",
                  "threshold": "0x8000000000000000000000000000000000000000000000000000000000000000",
                  "message": "Unlimited"
                },
                "visible": "always"
              }
            ]
          },
          "decreaseAllowance(address spender, uint256 subtractedValue)": {
            "intent": "Decrease allowance",
            "fields": [
              {
                "label": "Spender",
                "format": "addressName",
                "params": {
                  "types": [
                    "contract"
                  ],
                  "sources": [
                    "local"
                  ]
                },
                "path": "#.spender",
                "visible": "always"
              },
              {
                "label": "Amount",
                "format": "tokenAmount",
                "path": "#.subtractedValue",
                "params": {
                  "token": "$.metadata.constants.wstETHaddress"
                },
                "visible": "always"
              }
            ]
          },
          "increaseAllowance(address spender, uint256 addedValue)": {
            "intent": "Increase allowance",
            "fields": [
              {
                "label": "Spender",
                "format": "addressName",
                "params": {
                  "types": [
                    "contract"
                  ],
                  "sources": [
                    "local"
                  ]
                },
                "path": "#.spender",
                "visible": "always"
              },
              {
                "label": "Amount",
                "format": "tokenAmount",
                "path": "#.addedValue",
                "params": {
                  "token": "$.metadata.constants.wstETHaddress",
                  "threshold": "0x8000000000000000000000000000000000000000000000000000000000000000",
                  "message": "Unlimited"
                },
                "visible": "always"
              }
            ]
          },
          "permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)": {
            "intent": "Permit spending",
            "interpolatedIntent": "Permit {value} spending",
            "fields": [
              {
                "label": "Owner",
                "format": "addressName",
                "params": {
                  "types": [
                    "eoa",
                    "wallet"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "path": "#.owner",
                "visible": "always"
              },
              {
                "label": "Spender",
                "format": "addressName",
                "params": {
                  "types": [
                    "contract"
                  ],
                  "sources": [
                    "local"
                  ]
                },
                "path": "#.spender",
                "visible": "always"
              },
              {
                "label": "Amount",
                "format": "tokenAmount",
                "path": "#.value",
                "params": {
                  "token": "$.metadata.constants.wstETHaddress",
                  "threshold": "0x8000000000000000000000000000000000000000000000000000000000000000",
                  "message": "Unlimited"
                },
                "visible": "always"
              },
              {
                "label": "Deadline",
                "format": "date",
                "params": {
                  "encoding": "timestamp"
                },
                "path": "#.deadline",
                "visible": "always"
              },
              {
                "label": "V",
                "path": "#.v",
                "visible": "never"
              },
              {
                "label": "R",
                "path": "#.r",
                "visible": "never"
              },
              {
                "label": "S",
                "path": "#.s",
                "visible": "never"
              }
            ]
          },
          "wrap(uint256 _stETHAmount)": {
            "intent": "Wrap stETH",
            "interpolatedIntent": "Wrap {_stETHAmount}",
            "fields": [
              {
                "label": "stETH amount",
                "format": "tokenAmount",
                "path": "#._stETHAmount",
                "params": {
                  "token": "$.metadata.constants.stETHaddress"
                },
                "visible": "always"
              }
            ]
          },
          "unwrap(uint256 _wstETHAmount)": {
            "intent": "Unwrap wstETH to stETH",
            "interpolatedIntent": "Unwrap {_wstETHAmount}",
            "fields": [
              {
                "label": "wstETH amount",
                "format": "tokenAmount",
                "path": "#._wstETHAmount",
                "params": {
                  "token": "$.metadata.constants.wstETHaddress"
                },
                "visible": "always"
              }
            ]
          },
          "transfer(address recipient, uint256 amount)": {
            "intent": "Transfer wstETH",
            "interpolatedIntent": "Send {amount} to {recipient}",
            "fields": [
              {
                "label": "Recipient",
                "format": "addressName",
                "params": {
                  "types": [
                    "eoa",
                    "wallet"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "path": "#.recipient",
                "visible": "always"
              },
              {
                "label": "Amount",
                "format": "tokenAmount",
                "path": "#.amount",
                "params": {
                  "token": "$.metadata.constants.wstETHaddress"
                },
                "visible": "always"
              }
            ]
          },
          "transferFrom(address sender, address recipient, uint256 amount)": {
            "intent": "Transfer wstETH",
            "interpolatedIntent": "Send {amount} to {recipient}",
            "fields": [
              {
                "label": "Sender",
                "format": "addressName",
                "params": {
                  "types": [
                    "eoa",
                    "wallet"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "path": "#.sender",
                "visible": "always"
              },
              {
                "label": "Recipient",
                "format": "addressName",
                "params": {
                  "types": [
                    "eoa",
                    "wallet"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "path": "#.recipient",
                "visible": "always"
              },
              {
                "label": "Amount",
                "format": "tokenAmount",
                "path": "#.amount",
                "params": {
                  "token": "$.metadata.constants.wstETHaddress"
                },
                "visible": "always"
              }
            ]
          }
        }
      }
    },
  ],
  [
    "registry/aave/calldata-lpv3.json",
    {
      "context": {
        "$id": "PoolInstance",
        "contract": {
          "deployments": [
            {
              "chainId": 1,
              "address": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
            },
            {
              "chainId": 8453,
              "address": "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"
            },
            {
              "chainId": 42220,
              "address": "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402"
            },
            {
              "chainId": 59144,
              "address": "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac"
            },
            {
              "chainId": 59144,
              "address": "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac"
            },
            {
              "chainId": 1088,
              "address": "0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57"
            },
            {
              "chainId": 146,
              "address": "0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3"
            },
            {
              "chainId": 100,
              "address": "0xb50201558B00496A145fE76f7424749556E326D8"
            },
            {
              "chainId": 534352,
              "address": "0x11fCfe756c05AD438e312a7fd934381537D3cFfe"
            },
            {
              "chainId": 324,
              "address": "0x78e30497a3c7527d953c6B1E3541b021A98Ac43c"
            },
            {
              "chainId": 137,
              "address": "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
            },
            {
              "chainId": 1868,
              "address": "0xDd3d7A7d03D9fD9ef45f3E587287922eF65CA38B"
            },
            {
              "chainId": 42161,
              "address": "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
            },
            {
              "chainId": 10,
              "address": "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
            },
            {
              "chainId": 43114,
              "address": "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
            },
            {
              "chainId": 9745,
              "address": "0x925a2A7214Ed92428B5b1B090F80b25700095e12"
            }
          ]
        }
      },
      "metadata": {
        "owner": "Aave DAO",
        "info": {
          "url": "https://aave.com",
          "deploymentDate": "2024-10-09T21:46:47Z"
        },
        "enums": {
          "interestRateMode": {
            "0": "none",
            "1": "deprecated",
            "2": "variable"
          }
        },
        "constants": {
          "max": "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe"
        },
        "contractName": "PoolInstance"
      },
      "display": {
        "formats": {
          "repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)": {
            "$id": "repay",
            "intent": "Repay loan",
            "fields": [
              {
                "path": "amount",
                "format": "tokenAmount",
                "label": "Amount to repay",
                "params": {
                  "tokenPath": "asset",
                  "threshold": "$.metadata.constants.max",
                  "message": "All"
                },
                "visible": "always"
              },
              {
                "path": "interestRateMode",
                "format": "enum",
                "label": "Interest rate mode",
                "params": {
                  "$ref": "$.metadata.enums.interestRateMode"
                },
                "visible": "always"
              },
              {
                "path": "onBehalfOf",
                "format": "addressName",
                "label": "For debt holder",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              }
            ]
          },
          "repayWithPermit(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS)": {
            "$id": "repayWithPermit",
            "intent": "Repay loan",
            "fields": [
              {
                "path": "amount",
                "format": "tokenAmount",
                "label": "Amount to repay",
                "params": {
                  "tokenPath": "asset",
                  "threshold": "$.metadata.constants.max",
                  "message": "All"
                },
                "visible": "always"
              },
              {
                "path": "interestRateMode",
                "format": "enum",
                "label": "Interest rate mode",
                "params": {
                  "$ref": "$.metadata.enums.interestRateMode"
                },
                "visible": "always"
              },
              {
                "path": "onBehalfOf",
                "format": "addressName",
                "label": "For debt holder",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              },
              {
                "label": "Deadline",
                "path": "deadline",
                "visible": "never"
              },
              {
                "label": "Permit V",
                "path": "permitV",
                "visible": "never"
              },
              {
                "label": "Permit R",
                "path": "permitR",
                "visible": "never"
              },
              {
                "label": "Permit S",
                "path": "permitS",
                "visible": "never"
              }
            ]
          },
          "repayWithATokens(address asset, uint256 amount, uint256 interestRateMode)": {
            "$id": "repayWithATokens",
            "intent": "Repay with aTokens",
            "fields": [
              {
                "path": "amount",
                "format": "tokenAmount",
                "label": "Amount to repay",
                "params": {
                  "tokenPath": "asset",
                  "threshold": "$.metadata.constants.max",
                  "message": "All"
                },
                "visible": "always"
              },
              {
                "path": "interestRateMode",
                "format": "enum",
                "label": "Interest rate mode",
                "params": {
                  "$ref": "$.metadata.enums.interestRateMode"
                },
                "visible": "always"
              },
              {
                "path": "@.from",
                "format": "addressName",
                "label": "For debt holder",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                }
              }
            ]
          },
          "setUserUseReserveAsCollateral(address asset, bool useAsCollateral)": {
            "intent": "Manage collateral",
            "fields": [
              {
                "path": "asset",
                "format": "addressName",
                "label": "For asset",
                "params": {
                  "types": [
                    "token"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              },
              {
                "path": "useAsCollateral",
                "format": "raw",
                "label": "Use as collateral",
                "visible": "always"
              }
            ]
          },
          "setUserUseReserveAsCollateralOnBehalfOf(address asset, bool useAsCollateral, address onBehalfOf)": {
            "intent": "Manage collateral",
            "fields": [
              {
                "path": "asset",
                "format": "addressName",
                "label": "For asset",
                "params": {
                  "types": [
                    "token"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              },
              {
                "path": "useAsCollateral",
                "format": "raw",
                "label": "Use as collateral",
                "visible": "always"
              },
              {
                "path": "onBehalfOf",
                "format": "addressName",
                "label": "Debtor",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              }
            ]
          },
          "withdraw(address asset, uint256 amount, address to)": {
            "intent": "Withdraw",
            "fields": [
              {
                "path": "amount",
                "format": "tokenAmount",
                "label": "Amount to withdraw",
                "params": {
                  "tokenPath": "asset",
                  "threshold": "$.metadata.constants.max",
                  "message": "Max"
                },
                "visible": "always"
              },
              {
                "path": "to",
                "format": "addressName",
                "label": "To recipient",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              }
            ]
          },
          "borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)": {
            "intent": "Borrow",
            "fields": [
              {
                "path": "amount",
                "format": "tokenAmount",
                "label": "Amount to borrow",
                "params": {
                  "tokenPath": "asset"
                },
                "visible": "always"
              },
              {
                "path": "interestRateMode",
                "format": "enum",
                "label": "Interest Rate mode",
                "params": {
                  "$ref": "$.metadata.enums.interestRateMode"
                },
                "visible": "always"
              },
              {
                "path": "onBehalfOf",
                "format": "addressName",
                "label": "Debtor",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              },
              {
                "label": "Referral Code",
                "path": "referralCode",
                "visible": "never"
              }
            ]
          },
          "deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)": {
            "$id": "deposit",
            "intent": "Supply",
            "fields": [
              {
                "path": "amount",
                "format": "tokenAmount",
                "label": "Amount to supply",
                "params": {
                  "tokenPath": "asset"
                },
                "visible": "always"
              },
              {
                "path": "onBehalfOf",
                "format": "addressName",
                "label": "Collateral recipient",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              },
              {
                "label": "Referral Code",
                "path": "referralCode",
                "visible": "never"
              }
            ]
          },
          "supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)": {
            "$id": "supply",
            "intent": "Supply",
            "fields": [
              {
                "path": "amount",
                "format": "tokenAmount",
                "label": "Amount to supply",
                "params": {
                  "tokenPath": "asset"
                },
                "visible": "always"
              },
              {
                "path": "onBehalfOf",
                "format": "addressName",
                "label": "Collateral recipient",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              },
              {
                "label": "Referral Code",
                "path": "referralCode",
                "visible": "never"
              }
            ]
          },
          "supplyWithPermit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS)": {
            "$id": "supplyWithPermit",
            "intent": "Supply",
            "fields": [
              {
                "path": "amount",
                "format": "tokenAmount",
                "label": "Amount to supply",
                "params": {
                  "tokenPath": "asset"
                },
                "visible": "always"
              },
              {
                "path": "onBehalfOf",
                "format": "addressName",
                "label": "Collateral recipient",
                "params": {
                  "types": [
                    "eoa"
                  ],
                  "sources": [
                    "local",
                    "ens"
                  ]
                },
                "visible": "always"
              },
              {
                "label": "Referral Code",
                "path": "referralCode",
                "visible": "never"
              },
              {
                "label": "Deadline",
                "path": "deadline",
                "visible": "never"
              },
              {
                "label": "Permit V",
                "path": "permitV",
                "visible": "never"
              },
              {
                "label": "Permit R",
                "path": "permitR",
                "visible": "never"
              },
              {
                "label": "Permit S",
                "path": "permitS",
                "visible": "never"
              }
            ]
          },
          "approvePositionManager(address positionManager, bool approve)": {
            "$id": "approvePositionManager",
            "intent": "Approve Manager",
            "fields": [
              {
                "path": "positionManager",
                "format": "addressName",
                "label": "Position manager",
                "params": {
                  "types": [
                    "eoa"
                  ]
                },
                "visible": "always"
              },
              {
                "path": "approve",
                "format": "raw",
                "label": "Approve",
                "visible": "always"
              }
            ]
          },
          "renouncePositionManagerRole(address user)": {
            "$id": "renouncePositionManagerRole",
            "intent": "Revoke Manager Role",
            "fields": [
              {
                "path": "@.from",
                "format": "addressName",
                "label": "Position manager",
                "params": {
                  "types": [
                    "eoa"
                  ]
                }
              },
              {
                "path": "user",
                "format": "addressName",
                "label": "User",
                "params": {
                  "types": [
                    "eoa"
                  ]
                },
                "visible": "always"
              }
            ]
          },
          "multicall(bytes[] data)": {
            "$id": "multicall",
            "intent": "Multicall",
            "fields": [
              {
                "path": "data.[]",
                "format": "calldata",
                "label": "Call",
                "params": {
                  "calleePath": "@.to"
                }
              }
            ]
          }
        }
      }
    },
  ],
];

const COMMIT = "3a397789143cf65dcff105cd074722eac9c75129";

/**
 * The parsed bundle.
 *
 * A descriptor that fails to parse is dropped rather than repaired — see
 * parseDescriptor. Dropping one costs a nicer label; repairing one would mean
 * describing a transaction with a rule we made up.
 */
export const BUNDLED_DESCRIPTORS: readonly Descriptor[] = RAW.flatMap(([path, raw]) => {
  const d = parseDescriptor(raw, `${path} @ ${COMMIT.slice(0, 7)}`);
  return d === null ? [] : [d];
});
