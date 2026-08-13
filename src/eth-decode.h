/**
 * Calldata decoding — the decodable set (T50).
 *
 * A hardware wallet that renders a hash and asks for a signature is asking the
 * user to approve something they cannot read. The answer is not a better hash
 * display; it is to refuse. This module defines exactly what the device can
 * explain in words, and everything outside that set is rejected before the
 * confirmation screen is ever shown — unless the owner has turned blind
 * signing on at the device itself (T16, see blind-signing.h), which is the one
 * documented way past this gate and is off until they do.
 *
 * The set today:
 *   - no calldata at all, a native transfer
 *   - ERC-20 transfer(address,uint256)
 *   - ERC-20 approve(address,uint256)
 *   - ERC-20 transferFrom(address,address,uint256)
 *   - ERC-721/1155 setApprovalForAll(address,bool)
 *   - WETH deposit() and withdraw(uint256)
 *   - mint(address,uint256), mint(uint256) and mint(address,address,uint256),
 *     the faucet shapes
 *
 * Growing it means adding a decoder AND a screen that says what the call does.
 * A selector recognised but not rendered is worse than one refused, because it
 * looks like the device understood. Every kind below has a case in ui.c's
 * sign-confirmation pages; adding one without a screen is the bug this comment
 * exists to prevent.
 *
 * No ESP-IDF dependency, so the host suite drives it directly.
 */

#ifndef ETH_DECODE_H
#define ETH_DECODE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "eth-tx.h"

typedef enum {
    ETH_CALL_EMPTY = 0,        /* no calldata: a plain value transfer */
    ETH_CALL_ERC20_TRANSFER,   /* transfer(address to, uint256 amount)   */
    ETH_CALL_ERC20_APPROVE,    /* approve(address spender, uint256 amount) */
    ETH_CALL_ERC20_TRANSFER_FROM, /* transferFrom(address from, address to,
                                   * uint256 amount) — spends an allowance */
    ETH_CALL_SET_APPROVAL_ALL, /* setApprovalForAll(address operator, bool) */
    ETH_CALL_WETH_DEPOSIT,     /* deposit() — wrap the attached ether */
    ETH_CALL_WETH_WITHDRAW,    /* withdraw(uint256) — unwrap */
    ETH_CALL_MINT_TO,          /* mint(address to, uint256 amount) */
    ETH_CALL_MINT_TOKEN_TO,    /* mint(address token, address to, uint256) —
                                * the shape Aave's testnet faucet uses. Same
                                * argument layout as transferFrom and a wholly
                                * different meaning, which is why the decoder
                                * matches on the selector and never the length */
    ETH_CALL_MINT,             /* mint(uint256 amount) */
    ETH_CALL_UNKNOWN           /* not in the decodable set — refuse it */
} EthCallKind;

typedef struct {
    EthCallKind kind;
    /* The first address argument: recipient for transfer, spender for approve,
     * source for transferFrom, operator for setApprovalForAll. Zero when the
     * call takes no address. */
    uint8_t     address[20];
    /* The second address, only for transferFrom's destination. `has_second`
     * says whether it means anything, so a screen can never print a zero
     * address as if it were an argument. */
    uint8_t     second[20];
    bool        has_second;
    EthQuantity amount;        /* raw token units — decimals are not knowable
                                * on-device, see eth_decode_call() */
    bool        has_amount;    /* false for deposit()/setApprovalForAll */
    bool        unlimited;     /* approve only: an allowance nobody can spend
                                * through in practice, which is the pattern
                                * behind most drain incidents */
    bool        flag;          /* setApprovalForAll's bool: true grants, false
                                * revokes. Only meaningful for that kind. */
} EthCall;

/**
 * Decode `len` bytes of calldata.
 *
 * Returns the kind, also written to *out. Anything malformed — a short
 * argument block, trailing bytes, a padded address whose high 12 bytes are not
 * zero, a bool that is neither 0 nor 1 — is ETH_CALL_UNKNOWN rather than a best
 * guess. A best guess here is a lie told to someone about to sign.
 *
 * Token amounts are raw units. The device cannot call decimals() on the
 * contract, so it must not imply a scale it does not know; the screen says so.
 */
EthCallKind eth_decode_call(const uint8_t *data, size_t len, EthCall *out);

/** Short human label for a kind, for logs and screens. */
const char *eth_call_name(EthCallKind kind);

/**
 * Whether a transaction as a whole can be shown honestly and so may be signed.
 *
 * Contract creation is refused too: there is nothing to name, and the device
 * cannot tell the user what code they are deploying. That refusal is not
 * reachable by the blind-signing setting either — see blind-signing.h.
 */
bool eth_tx_is_decodable(const EthTx *tx, EthCall *out);

#endif /* ETH_DECODE_H */
