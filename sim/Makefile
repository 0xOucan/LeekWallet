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

TESTS := test_mnemonic_entry test_pin test_passphrase test_entropy test_vault_kdf test_cbor test_session test_text_entry test_vault_crypt test_eth_tx test_eth_decode test_device_wipe test_ui

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

$(BUILD)/test_device_wipe: test_device_wipe.c esp_stubs.c ../src/device-wipe.c ../src/pin.c \
                          $(CRYPTO)/sha2.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD)/test_pin: test_pin.c esp_stubs.c ../src/pin.c \
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

$(BUILD):
	mkdir -p $(BUILD)

test: all
	@fail=0; for t in $(TESTS); do \
	  echo "== $$t"; ./$(BUILD)/$$t || fail=1; \
	done; exit $$fail

clean:
	rm -rf $(BUILD)

.PHONY: all test clean
