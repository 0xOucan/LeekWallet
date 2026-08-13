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

TESTS := test_mnemonic_entry test_pin test_passphrase test_entropy test_vault_kdf test_cbor test_session test_text_entry test_vault_crypt test_eth_tx test_eth_decode test_device_wipe test_ui test_button test_pin_change test_protocol

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
                       $(CRYPTO)/rand.c | $(BUILD)
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

$(BUILD)/test_device_wipe: test_device_wipe.c esp_stubs.c wallet_stubs.c ../src/device-wipe.c ../src/pin.c \
                          $(CRYPTO)/sha2.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD)/test_button: test_button.c esp_stubs.c ../src/button.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD)/test_pin: test_pin.c esp_stubs.c wallet_stubs.c ../src/pin.c \
                   $(CRYPTO)/sha2.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

# The UI layer, against a framebuffer OLED and a fake wallet (see fake_wallet.c
# for why the real one is not linked here). The Wi-Fi/BLE/USB blocks in ui.c are
# all behind CONFIG_* macros that stay undefined on the host, so they vanish.
$(BUILD)/test_ui: test_ui.c esp_stubs.c host_stubs.c fake_oled.c fake_wallet.c \
                  fake_input.c ../src/ui.c ../src/pin.c ../src/mnemonic-entry.c \
                  ../src/entropy.c ../src/session.c ../src/text-entry.c \
                  ../src/eth-tx.c ../src/eth-decode.c ../src/device-wipe.c \
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
                          ../components/leek-wallet/leek-wallet.c \
                          ../components/leek-wallet/vault-kdf.c \
                          ../components/leek-wallet/vault-crypt.c \
                          ../src/pin.c \
                          $(CRYPTO)/bip39.c $(CRYPTO)/bip39_english.c \
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
                          $(CRYPTO)/aes/aesgcm.c $(CRYPTO)/aes/gf128mul.c | $(BUILD)
	$(CC) $(CFLAGS) -I$(CRYPTO)/ed25519-donna -DLEEK_HOST_TEST -o $@ $^

# The real src/protocol.c, against an in-memory USB-Serial-JTAG pipe. This is
# the only place the wire protocol exists on the device, so it is the reference
# the mock has to match; see test_protocol.c.
PROTOCOL_SRC := test_protocol.c esp_stubs.c host_stubs.c fake_usb.c fake_wallet.c \
                ../src/protocol.c ../src/cbor.c ../src/session.c ../src/pin.c \
                ../src/eth-tx.c ../src/eth-decode.c \
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

asan: $(BUILD)/test_protocol_asan
	./$(BUILD)/test_protocol_asan

$(BUILD):
	mkdir -p $(BUILD)

test: all
	@fail=0; for t in $(TESTS); do \
	  echo "== $$t"; ./$(BUILD)/$$t || fail=1; \
	done; exit $$fail

clean:
	rm -rf $(BUILD)

.PHONY: all test asan clean
