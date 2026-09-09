# Host-native test harness for LeekWallet.
# Compiles firmware logic for the build machine so defects can be reproduced
# without an ESP32 attached. See README.md in this directory.

CC      ?= gcc
CRYPTO  := ../components/trezor-crypto
CFLAGS  := -O1 -g -Wall -Wextra -Wno-unused-parameter \
           -I$(CRYPTO) -I../src -I../components/leek-wallet/include -I. -Ishim \
           -DUSE_BIP39_CACHE=0 -DUSE_BIP32_CACHE=0 -DUSE_ETHEREUM=1 -DUSE_KECCAK=1
BUILD   := build

CRYPTO_SRC := $(CRYPTO)/bip39.c $(CRYPTO)/bip39_english.c $(CRYPTO)/sha2.c \
              $(CRYPTO)/pbkdf2.c $(CRYPTO)/hmac.c $(CRYPTO)/memzero.c $(CRYPTO)/rand.c

# The real vault, and the crypto it drags in. Two suites link it: the PIN
# change (for its write ordering) and the PIN gate itself, which since the
# second verifier was removed has nothing to verify against but this.
VAULT_SRC := ../components/leek-wallet/leek-wallet.c \
             ../components/leek-wallet/vault-kdf.c \
             ../components/leek-wallet/vault-crypt.c
VAULT_CRYPTO :=                 $(CRYPTO)/bip39.c $(CRYPTO)/bip39_english.c \
                $(CRYPTO)/bip32.c $(CRYPTO)/ecdsa.c $(CRYPTO)/bignum.c \
                $(CRYPTO)/secp256k1.c $(CRYPTO)/nist256p1.c \
                $(CRYPTO)/curves.c $(CRYPTO)/ripemd160.c \
                $(CRYPTO)/base58.c $(CRYPTO)/blake256.c $(CRYPTO)/blake2b.c \
                $(CRYPTO)/hasher.c $(CRYPTO)/address.c $(CRYPTO)/segwit_addr.c \
                $(CRYPTO)/base32.c \
                $(CRYPTO)/groestl.c $(CRYPTO)/sha2.c $(CRYPTO)/sha3.c \
                $(CRYPTO)/hmac.c $(CRYPTO)/pbkdf2.c $(CRYPTO)/rfc6979.c $(CRYPTO)/hmac_drbg.c \
                $(CRYPTO)/memzero.c $(CRYPTO)/rand.c \
                $(CRYPTO)/ed25519-donna/ed25519.c \
                $(CRYPTO)/ed25519-donna/curve25519-donna-32bit.c \
                $(CRYPTO)/ed25519-donna/curve25519-donna-helpers.c \
                $(CRYPTO)/ed25519-donna/curve25519-donna-scalarmult-base.c \
                $(CRYPTO)/ed25519-donna/ed25519-donna-32bit-tables.c \
                $(CRYPTO)/ed25519-donna/ed25519-donna-impl-base.c \
                $(CRYPTO)/ed25519-donna/modm-donna-32bit.c \
                $(CRYPTO)/ed25519-donna/ed25519-sha3.c $(CRYPTO)/ed25519-donna/ed25519-keccak.c \
                $(CRYPTO)/aes/aescrypt.c $(CRYPTO)/aes/aeskey.c \
                $(CRYPTO)/aes/aestab.c $(CRYPTO)/aes/aes_modes.c \
                $(CRYPTO)/aes/aesgcm.c $(CRYPTO)/aes/gf128mul.c

TESTS := test_mnemonic_entry test_pin test_passphrase test_entropy test_vault_kdf test_cbor test_session test_text_entry test_vault_crypt test_eth_tx test_eth_decode test_eip712 test_device_wipe test_ui test_button test_pin_change test_protocol test_ble_chunk test_xfp test_slip39 test_temp_seed

all: $(addprefix $(BUILD)/,$(TESTS))

$(BUILD)/test_mnemonic_entry: test_mnemonic_entry.c host_stubs.c ../src/mnemonic-entry.c $(CRYPTO_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

$(BUILD)/test_session: test_session.c host_stubs.c ../src/session.c \
                       $(CRYPTO)/ed25519-donna/curve25519-donna-scalarmult-base.c \
                       $(CRYPTO)/ed25519-donna/curve25519-donna-32bit.c \
                       $(CRYPTO)/ed25519-donna/curve25519-donna-helpers.c \
                       $(CRYPTO)/ed25519-donna/ed25519-donna-32bit-tables.c \
                       $(CRYPTO)/chacha20poly1305/chacha20poly1305.c \
                       $(CRYPTO)/chacha20poly1305/chacha_merged.c \
                       $(CRYPTO)/chacha20poly1305/poly1305-donna.c \
                       $(CRYPTO)/chacha20poly1305/rfc7539.c \
                       $(CRYPTO)/hmac.c $(CRYPTO)/sha2.c $(CRYPTO)/memzero.c \
                       $(CRYPTO)/rand.c esp_stubs.c | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -o $@ $^

$(BUILD)/test_text_entry: test_text_entry.c ../src/text-entry.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

# AES_VAR selects the variable-key-length entry point that gcm_init_and_key
# calls; without it aes_encrypt_key is compiled out and the link fails.
$(BUILD)/test_vault_crypt: CFLAGS += -DAES_VAR
$(BUILD)/test_vault_crypt: test_vault_crypt.c host_stubs.c ../components/leek-wallet/vault-crypt.c \
                           $(CRYPTO)/aes/aesgcm.c $(CRYPTO)/aes/aescrypt.c \
                           $(CRYPTO)/aes/aeskey.c $(CRYPTO)/aes/aestab.c \
                           $(CRYPTO)/aes/gf128mul.c $(CRYPTO)/memzero.c \
                           $(CRYPTO)/rand.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

$(BUILD)/test_eth_tx: test_eth_tx.c ../src/eth-tx.c $(CRYPTO)/sha3.c \
                      $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

$(BUILD)/test_eth_decode: test_eth_decode.c ../src/eth-decode.c ../src/eth-tx.c \
                          $(CRYPTO)/sha3.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

# EIP-712, driven straight from the EIP's own worked example. cbor.c is here
# because the tests build their requests with the real writer rather than
# hand-rolled hex - a vector that only passes against a bespoke encoder proves
# nothing about the bytes that arrive on the wire.
$(BUILD)/test_eip712: test_eip712.c ../src/eip712.c ../src/cbor.c ../src/eth-tx.c \
                      $(CRYPTO)/sha3.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

# BIP32/BIP39 only - the wallet wrapper needs an unlocked vault, and that
# plumbing is covered in test_pin_change.
$(BUILD)/test_xfp: test_xfp.c host_stubs.c \
                   $(CRYPTO)/bip32.c $(CRYPTO)/bip39.c $(CRYPTO)/bip39_english.c \
                   $(CRYPTO)/ecdsa.c $(CRYPTO)/bignum.c $(CRYPTO)/secp256k1.c \
                   $(CRYPTO)/nist256p1.c $(CRYPTO)/curves.c $(CRYPTO)/ripemd160.c \
                   $(CRYPTO)/base58.c $(CRYPTO)/blake256.c $(CRYPTO)/blake2b.c \
                   $(CRYPTO)/hasher.c $(CRYPTO)/address.c $(CRYPTO)/segwit_addr.c \
                   $(CRYPTO)/base32.c $(CRYPTO)/groestl.c \
                   $(CRYPTO)/sha2.c $(CRYPTO)/sha3.c $(CRYPTO)/hmac.c \
                   $(CRYPTO)/pbkdf2.c $(CRYPTO)/rfc6979.c $(CRYPTO)/hmac_drbg.c \
                   $(CRYPTO)/memzero.c $(CRYPTO)/rand.c \
                   $(CRYPTO)/ed25519-donna/ed25519.c \
                   $(CRYPTO)/ed25519-donna/curve25519-donna-32bit.c \
                   $(CRYPTO)/ed25519-donna/curve25519-donna-helpers.c \
                   $(CRYPTO)/ed25519-donna/curve25519-donna-scalarmult-base.c \
                   $(CRYPTO)/ed25519-donna/ed25519-donna-32bit-tables.c \
                   $(CRYPTO)/ed25519-donna/ed25519-donna-impl-base.c \
                   $(CRYPTO)/ed25519-donna/modm-donna-32bit.c \
                   $(CRYPTO)/ed25519-donna/ed25519-sha3.c \
                   $(CRYPTO)/ed25519-donna/ed25519-keccak.c | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -o $@ $^

# The chunking layer alone, with no transport under it. Pure C by design: this
# is the code an unpaired stranger reaches first, so it has to run on the host
# and under a sanitiser.
$(BUILD)/test_ble_chunk: test_ble_chunk.c ../src/ble-chunk.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

# SLIP-39. The core has no ESP-IDF dependency, so the host drives it directly;
# entropy.c comes along because share values must come from the entropy gate.
# shamir.c and slip39_english.c are trezor-crypto's own (the SLIP-39 authors'),
# so the wordlist and the GF(256) interpolation are not duplicated here.
$(BUILD)/test_slip39: test_slip39.c ../src/slip39-backup.c ../src/entropy.c \
                     $(CRYPTO)/shamir.c $(CRYPTO)/slip39_english.c \
                     $(CRYPTO)/sha2.c $(CRYPTO)/hmac.c $(CRYPTO)/pbkdf2.c \
                     $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD)/test_slip39_asan: test_slip39.c ../src/slip39-backup.c ../src/entropy.c \
                     $(CRYPTO)/shamir.c $(CRYPTO)/slip39_english.c \
                     $(CRYPTO)/sha2.c $(CRYPTO)/hmac.c $(CRYPTO)/pbkdf2.c \
                     $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST \
	      -fsanitize=address,undefined -fno-omit-frame-pointer -o $@ $^

$(BUILD)/test_cbor: test_cbor.c ../src/cbor.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

$(BUILD)/test_vault_kdf: test_vault_kdf.c ../components/leek-wallet/vault-kdf.c \
                         $(CRYPTO)/sha2.c $(CRYPTO)/pbkdf2.c $(CRYPTO)/hmac.c \
                         $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD)/test_entropy: test_entropy.c ../src/entropy.c \
                       $(CRYPTO)/sha2.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD)/test_passphrase: test_passphrase.c host_stubs.c $(CRYPTO_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

# wallet_stubs.c rather than the real vault: this suite defines its own
# wallet_wipe() to watch the ordering, and linking both would be a duplicate
# symbol. The stub still keeps a real salted verifier in NVS, because pin.c has
# nothing else to check a PIN against.
$(BUILD)/test_device_wipe: test_device_wipe.c esp_stubs.c host_stubs.c wallet_stubs.c \
                          ../components/leek-wallet/vault-kdf.c \
                          ../src/device-wipe.c ../src/pin.c \
                          $(CRYPTO)/sha2.c $(CRYPTO)/pbkdf2.c $(CRYPTO)/hmac.c \
                          $(CRYPTO)/memzero.c $(CRYPTO)/rand.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD)/test_button: test_button.c esp_stubs.c ../src/button.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

# Against the real vault, not a stub. src/pin.c no longer stores a verifier of
# its own, so "does this PIN open the device" is now a question only the real
# leek-wallet.c can answer - and test_no_fast_verifier_in_nvs() inspects the
# real NVS contents, which a stub's storage layout would say nothing about.
$(BUILD)/test_pin: CFLAGS += -DAES_VAR
$(BUILD)/test_pin: test_pin.c esp_stubs.c host_stubs.c \
                   $(VAULT_SRC) ../src/pin.c $(VAULT_CRYPTO) | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -DLEEK_HOST_TEST -o $@ $^

# The temporary seed (T69), against the real vault and the fake NVS. It has to
# be the real one: the feature's whole claim is about what does and does not
# reach storage, and a stubbed vault would only prove things about the stub.
$(BUILD)/test_temp_seed: CFLAGS += -DAES_VAR
$(BUILD)/test_temp_seed: test_temp_seed.c esp_stubs.c host_stubs.c \
                         $(VAULT_SRC) $(VAULT_CRYPTO) | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -DLEEK_HOST_TEST -o $@ $^

# The UI layer, against a framebuffer OLED and a fake wallet (see fake_wallet.c
# for why the real one is not linked here). The Wi-Fi/BLE/USB blocks in ui.c are
# all behind CONFIG_* macros that stay undefined on the host, so they vanish.
$(BUILD)/test_ui: test_ui.c esp_stubs.c host_stubs.c fake_oled.c fake_wallet.c \
                  fake_input.c fake_protocol.c ../src/transport.c ../src/ble.c \
                  ../src/ble-name.c ../src/ble-chunk.c \
                  ../src/ui.c ../src/pin.c ../src/mnemonic-entry.c \
                  ../src/entropy.c ../src/session.c ../src/text-entry.c \
                  ../src/eth-tx.c ../src/eth-decode.c ../src/eip712.c ../src/blind-signing.c \
                  ../src/cbor.c ../src/device-wipe.c \
                  $(CRYPTO)/bip39.c $(CRYPTO)/bip39_english.c \
                  $(CRYPTO)/sha2.c $(CRYPTO)/sha3.c $(CRYPTO)/pbkdf2.c \
                  $(CRYPTO)/hmac.c $(CRYPTO)/memzero.c $(CRYPTO)/rand.c \
                  $(CRYPTO)/ed25519-donna/curve25519-donna-scalarmult-base.c \
                  $(CRYPTO)/ed25519-donna/curve25519-donna-32bit.c \
                  $(CRYPTO)/ed25519-donna/curve25519-donna-helpers.c \
                  $(CRYPTO)/ed25519-donna/ed25519-donna-32bit-tables.c \
                  $(CRYPTO)/chacha20poly1305/chacha20poly1305.c \
                  $(CRYPTO)/chacha20poly1305/chacha_merged.c \
                  $(CRYPTO)/chacha20poly1305/poly1305-donna.c \
                  $(CRYPTO)/chacha20poly1305/rfc7539.c | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -DLEEK_HOST_TEST -o $@ $^

# The only suite that links the real components/leek-wallet.c. It has to: the
# crash-safety of a PIN change is entirely a property of that file's write
# ordering, and a fake vault would prove nothing about it. That is why the
# mbedtls and semphr shims exist.
$(BUILD)/test_pin_change: CFLAGS += -DAES_VAR
$(BUILD)/test_pin_change: test_pin_change.c esp_stubs.c host_stubs.c \
                          $(VAULT_SRC) ../src/pin.c $(VAULT_CRYPTO) | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -DLEEK_HOST_TEST -o $@ $^

# The real src/protocol.c, against an in-memory USB-Serial-JTAG pipe. This is
# the only place the wire protocol exists on the device, so it is the reference
# the mock has to match; see test_protocol.c.
PROTOCOL_SRC := test_protocol.c esp_stubs.c host_stubs.c fake_usb.c fake_wallet.c \
                ../src/protocol.c ../src/cbor.c ../src/session.c ../src/pin.c \
                ../src/ble-chunk.c ../src/ble.c ../src/ble-name.c ../src/transport.c ../src/entropy.c \
                ../src/eth-tx.c ../src/eth-decode.c ../src/eip712.c ../src/blind-signing.c \
                $(CRYPTO)/bip39.c $(CRYPTO)/bip39_english.c \
                $(CRYPTO)/sha2.c $(CRYPTO)/sha3.c $(CRYPTO)/pbkdf2.c \
                $(CRYPTO)/hmac.c $(CRYPTO)/memzero.c $(CRYPTO)/rand.c \
                $(CRYPTO)/ed25519-donna/curve25519-donna-scalarmult-base.c \
                $(CRYPTO)/ed25519-donna/curve25519-donna-32bit.c \
                $(CRYPTO)/ed25519-donna/curve25519-donna-helpers.c \
                $(CRYPTO)/ed25519-donna/ed25519-donna-32bit-tables.c \
                $(CRYPTO)/chacha20poly1305/chacha20poly1305.c \
                $(CRYPTO)/chacha20poly1305/chacha_merged.c \
                $(CRYPTO)/chacha20poly1305/poly1305-donna.c \
                $(CRYPTO)/chacha20poly1305/rfc7539.c

$(BUILD)/test_protocol: $(PROTOCOL_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -DLEEK_HOST_TEST -o $@ $^

# Sanitised build of the protocol suite, as a separate binary.
#
# Kept off the default target on purpose: `make test` has to stay the thing
# anyone runs without thinking, and ASan changes the exit codes and the runtime
# enough that a sanitiser failure and a test failure would look alike. This is
# the parser that reads attacker-controlled bytes, so it is the one place the
# extra runtime earns its keep.
#
# Known noise: UBSan reports misaligned u32 access inside trezor-crypto's
# chacha_merged.c, because protocol.c decrypts in place at rx_buf + 5 and the
# vendor code casts the buffer to u32. It is UB by the letter of C and benign
# on both hosts we build for; it is not an ASan finding and not a leak.
#
#   make -C sim asan
$(BUILD)/test_protocol_asan: $(PROTOCOL_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -DLEEK_HOST_TEST \
	      -fsanitize=address,undefined -fno-omit-frame-pointer -o $@ $^

# The chunk layer gets the same treatment, for the same reason.
$(BUILD)/test_ble_chunk_asan: test_ble_chunk.c ../src/ble-chunk.c | $(BUILD)
	$(CC) $(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer -o $@ $^

# And EIP-712, which is the newest parser and the most recursive: it walks a
# host-supplied document of maps inside arrays inside maps, borrowing pointers
# into the caller's buffer rather than copying. That is the shape of code that
# reads one item past the end.
$(BUILD)/test_eip712_asan: test_eip712.c ../src/eip712.c ../src/cbor.c ../src/eth-tx.c \
                           $(CRYPTO)/sha3.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer -o $@ $^

# SLIP-39 too: it does its own bit packing over caller-supplied strings, which
# is exactly the shape of code that reads one word past the end.
asan: $(BUILD)/test_protocol_asan $(BUILD)/test_ble_chunk_asan $(BUILD)/test_slip39_asan $(BUILD)/test_eip712_asan
	./$(BUILD)/test_protocol_asan
	./$(BUILD)/test_eip712_asan
	./$(BUILD)/test_ble_chunk_asan
	./$(BUILD)/test_slip39_asan

# What the six-digit passkey costs a relay. Measurement, not assertion, so it
# is built on request and never by `make test`. See passkey_grind.c.
$(BUILD)/passkey_grind: passkey_grind.c host_stubs.c ../src/session.c \
                        $(CRYPTO)/ed25519-donna/curve25519-donna-scalarmult-base.c \
                        $(CRYPTO)/ed25519-donna/curve25519-donna-32bit.c \
                        $(CRYPTO)/ed25519-donna/curve25519-donna-helpers.c \
                        $(CRYPTO)/ed25519-donna/ed25519-donna-32bit-tables.c \
                        $(CRYPTO)/chacha20poly1305/chacha20poly1305.c \
                        $(CRYPTO)/chacha20poly1305/chacha_merged.c \
                        $(CRYPTO)/chacha20poly1305/poly1305-donna.c \
                        $(CRYPTO)/chacha20poly1305/rfc7539.c \
                        $(CRYPTO)/hmac.c $(CRYPTO)/sha2.c $(CRYPTO)/memzero.c \
                        $(CRYPTO)/rand.c | $(BUILD)
	$(CC) $(CFLAGS) -O2 -I$(CRYPTO)/ed25519-donna -o $@ $^

# The fuzzer, over the same sources the protocol suite builds.
#
# Sanitised, always: without ASan this catches hangs and broken invariants and
# nothing else, and the whole reason to feed a parser random bytes is to find
# the read that goes one past the end. FUZZ_SEED and FUZZ_ITERS are the two
# knobs; the seed is printed on every run so a hit reproduces exactly.
#
#   make -C sim fuzz
#   make -C sim fuzz FUZZ_SEED=12345 FUZZ_ITERS=200000
FUZZ_SRC  := fuzz_transport.c $(filter-out test_protocol.c,$(PROTOCOL_SRC))
FUZZ_SEED ?= 1
FUZZ_ITERS ?= 20000

$(BUILD)/fuzz_transport: $(FUZZ_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -DLEEK_HOST_TEST \
	      -fsanitize=address,undefined -fno-omit-frame-pointer -o $@ $^

fuzz: $(BUILD)/fuzz_transport
	./$(BUILD)/fuzz_transport $(FUZZ_SEED) $(FUZZ_ITERS)

$(BUILD):
	mkdir -p $(BUILD)

test: all
	@fail=0; for t in $(TESTS); do \
	  echo "== $$t"; ./$(BUILD)/$$t || fail=1; \
	done; exit $$fail

# The mock leg of T26. The firmware's own answers, written down as bytes for
# the TypeScript suite to compare against.
#
# Regenerated rather than checked in and trusted: the file is a recording of
# what protocol.c does today, so it has to be re-made from today's protocol.c
# or the mock is being compared against a memory. check.sh runs this before the
# app tests for exactly that reason, and git will show any change in the
# firmware's answers as a diff in a reviewed file.
VECTORS := ../app/packages/core/test/conformance-vectors.json

conformance: $(BUILD)/test_protocol
	./$(BUILD)/test_protocol --emit-vectors $(VECTORS)

# The mock leg of T50 (see docs/MIRROR-GAP.md): what src/eth-decode.c actually
# does with a corpus of calldata, accepted or refused, written down for
# eth-decode.test.ts to replay. Same reasoning as $(VECTORS) above and the same
# reason it is not checked in and trusted: a corpus recorded from an older
# eth-decode.c would let the TS mirror agree with a decoder that no longer
# exists. check.sh runs this before the app tests for exactly that reason.
ETH_DECODE_VECTORS := ../app/packages/core/test/eth-decode-vectors.json

eth-decode-conformance: $(BUILD)/test_eth_decode
	./$(BUILD)/test_eth_decode --emit-vectors $(ETH_DECODE_VECTORS)

clean:
	rm -rf $(BUILD)

.PHONY: all test asan fuzz conformance eth-decode-conformance clean
